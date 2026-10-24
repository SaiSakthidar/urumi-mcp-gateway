import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { listUpstreamRows, toConfig, type UpstreamConfig } from "./registry.js";

// Keeps one MCP client per enabled upstream, plus its live status and tool list.
//
// - A background poller connects to and lists the tools of every upstream on a
//   fixed interval. tools/list on the gateway reads this cache, so a slow or
//   dead upstream can never slow down listing.
// - Status: connected after one successful check; a connected upstream goes
//   unreachable after `healthFailThreshold` failed checks in a row (no flapping
//   on a single blip). A new or reconfigured upstream that fails is unreachable at once.
// - On any transport error the client is dropped and rebuilt on next use. That
//   covers upstream restarts and expired upstream sessions.
// - Status lives in memory, which is why the gateway runs as a single replica.

export type UpstreamStatus = "connecting" | "connected" | "unreachable" | "disabled";

export interface UpstreamState {
  config: UpstreamConfig;
  status: UpstreamStatus;
  tools: Tool[];
  lastError?: string;
  lastCheckedAt?: Date;
  consecutiveFailures: number;
  client?: Client;
  connecting?: Promise<Client>;
  checkInFlight?: Promise<void>;
  // Bumped whenever the client is reset, so a connect that finishes afterwards is discarded.
  generation: number;
}

export class UpstreamTimeoutError extends Error {}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch failures hide the useful part (ECONNREFUSED, ENOTFOUND, ...) in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

function isTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

/** Anything that changes how we connect. A display-name edit does not need a reconnect. */
function connectionKey(c: UpstreamConfig): string {
  return JSON.stringify([c.url, c.enabled, c.headers]);
}

async function listAllTools(client: Client, timeout: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor && tools.length < 1000);
  return tools;
}

export class UpstreamManager {
  private readonly states = new Map<string, UpstreamState>();
  private timer?: NodeJS.Timeout;

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.checkAll(), config.healthPollIntervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled(this.all().map((s) => this.resetClient(s)));
  }

  all(): UpstreamState[] {
    return [...this.states.values()];
  }

  get(slug: string): UpstreamState | undefined {
    return this.states.get(slug);
  }

  /** Re-read the registry after any admin change, then check everything right away. */
  async reload(): Promise<void> {
    const rows = await listUpstreamRows();
    const seen = new Set<string>();

    for (const row of rows) {
      const cfg = toConfig(row);
      seen.add(cfg.slug);
      const existing = this.states.get(cfg.slug);
      if (existing && connectionKey(existing.config) === connectionKey(cfg)) {
        existing.config = cfg;
        continue;
      }
      if (existing) await this.resetClient(existing);
      this.states.set(cfg.slug, {
        config: cfg,
        status: cfg.enabled ? "connecting" : "disabled",
        tools: [],
        consecutiveFailures: 0,
        generation: 0,
      });
    }

    for (const [slug, state] of this.states) {
      if (!seen.has(slug)) {
        await this.resetClient(state);
        this.states.delete(slug);
      }
    }

    await this.checkAll();
  }

  checkAll(): Promise<void> {
    return Promise.allSettled(this.all().map((s) => this.check(s))).then(() => undefined);
  }

  /** Route one tool call to the upstream, bounded by the call timeout. */
  async callTool(state: UpstreamState, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const client = await this.getClient(state);
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: config.upstreamCallTimeoutMs,
      });
      return result as CallToolResult;
    } catch (err) {
      if (isTimeout(err)) {
        // A slow upstream is not a broken connection: keep the client.
        throw new UpstreamTimeoutError(
          `Server "${state.config.slug}" did not answer within ${config.upstreamCallTimeoutMs} ms`,
        );
      }
      await this.resetClient(state);
      throw err;
    }
  }

  private check(state: UpstreamState): Promise<void> {
    state.checkInFlight ??= this.runCheck(state).finally(() => {
      state.checkInFlight = undefined;
    });
    return state.checkInFlight;
  }

  private async runCheck(state: UpstreamState): Promise<void> {
    state.lastCheckedAt = new Date();
    if (!state.config.enabled) {
      state.status = "disabled";
      state.tools = [];
      await this.resetClient(state);
      return;
    }
    try {
      const client = await this.getClient(state);
      state.tools = await listAllTools(client, config.healthTimeoutMs);
      state.status = "connected";
      state.consecutiveFailures = 0;
      state.lastError = undefined;
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastError = isTimeout(err) ? `no answer within ${config.healthTimeoutMs} ms` : describeError(err);
      await this.resetClient(state);
      if (state.status !== "connected" || state.consecutiveFailures >= config.healthFailThreshold) {
        state.status = "unreachable";
      }
    }
  }

  private getClient(state: UpstreamState): Promise<Client> {
    if (state.client) return Promise.resolve(state.client);
    if (!state.connecting) {
      const generation = state.generation;
      state.connecting = this.connect(state.config)
        .then(async (client) => {
          if (generation !== state.generation) {
            await client.close().catch(() => undefined);
            throw new Error("upstream was reconfigured while connecting");
          }
          state.client = client;
          return client;
        })
        .finally(() => {
          state.connecting = undefined;
        });
    }
    return state.connecting;
  }

  private async connect(cfg: UpstreamConfig): Promise<Client> {
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    // The decrypted credential is injected here, per upstream. It never leaves this process.
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
    });
    try {
      await client.connect(transport, { timeout: config.healthTimeoutMs });
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  private async resetClient(state: UpstreamState): Promise<void> {
    state.generation += 1;
    const client = state.client;
    state.client = undefined;
    await client?.close().catch(() => undefined);
  }
}

export const upstreams = new UpstreamManager();
