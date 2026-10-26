import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { recordAudit, type Outcome } from "../audit/audit.js";
import { observeToolCall } from "../metrics/metrics.js";
import { checkRateLimit } from "./rateLimit.js";
import type { Principal } from "../auth/principal.js";
import { describeError, upstreams, UpstreamTimeoutError } from "../upstreams/manager.js";
import { splitToolName } from "./catalog.js";
import { isToolAllowed } from "./permissions.js";

// THE choke point. Every tool call, from an external MCP client or from the
// dashboard chat agent, goes through callTool(). Routing, checks, timeouts and
// the audit log all live here, so the two entry points can't behave differently.

export type CallSource = "mcp" | "chat";

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function firstText(result: CallToolResult): string | undefined {
  return result.content.find((c): c is TextContent => c.type === "text")?.text;
}

export async function callTool(
  principal: Principal,
  source: CallSource,
  exposedName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const parts = splitToolName(exposedName);

  const finish = async (outcome: Outcome, result: CallToolResult, errorMessage?: string) => {
    observeToolCall(parts?.slug ?? "gateway", outcome, Date.now() - started);
    await recordAudit({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId ?? null,
      source,
      upstreamSlug: parts?.slug ?? null,
      toolName: parts?.tool ?? exposedName,
      durationMs: Date.now() - started,
      outcome,
      errorMessage: errorMessage ?? null,
    });
    return result;
  };
  const reject = (outcome: Outcome, message: string) => finish(outcome, errorResult(message), message);

  if (!parts) {
    return reject("not_found", `Unknown tool "${exposedName}". Gateway tools are named <server>__<tool>.`);
  }
  const { slug, tool } = parts;

  const limit = await checkRateLimit(principal);
  if (!limit.ok) {
    return reject(
      "rate_limited",
      `Rate limit of ${limit.limit} calls per minute exceeded. Try again in ${limit.retryAfterSec} s.`,
    );
  }

  const state = upstreams.get(slug);
  if (!state) return reject("not_found", `Unknown server "${slug}".`);
  if (!state.config.enabled) return reject("disabled", `Server "${slug}" is disabled by an admin.`);
  if (state.status === "unreachable") {
    // Fail fast instead of waiting for a timeout on a server we already know is down.
    return reject("unreachable", `Server "${slug}" is unreachable (${state.lastError ?? "no response"}).`);
  }
  if (!state.tools.some((t) => t.name === tool)) {
    return reject("not_found", `Server "${slug}" has no tool "${tool}".`);
  }
  // Hidden tools are also rejected when called directly by name.
  if (!isToolAllowed(principal.role, slug, tool)) {
    return reject("denied", `Your role (${principal.role}) is not allowed to use ${exposedName}.`);
  }

  try {
    const result = await upstreams.callTool(state, tool, args);
    if (result.isError) return finish("tool_error", result, firstText(result));
    return finish("ok", result);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) return reject("timeout", err.message);
    return reject("error", `Server "${slug}" failed: ${describeError(err)}`);
  }
}
