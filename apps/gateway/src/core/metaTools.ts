import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { recordAudit } from "../audit/audit.js";
import type { Principal } from "../auth/principal.js";
import { visibleTools } from "./catalog.js";
import { callTool, type CallSource } from "./router.js";

// Handling many tools: instead of listing hundreds of tools (too many to hand
// to a model), the gateway can expose just two:
//
//   search_tools { query }          -> the best matching tools, with their input schemas
//   run_tool { name, arguments }    -> runs one through callTool()
//
// run_tool goes through the same choke point as every other call, so routing,
// permissions, rate limits and the audit log still apply to the real tool.
// search_tools only sees tools the caller's role may use.

export const SEARCH_TOOL = "search_tools";
export const RUN_TOOL = "run_tool";

export function isMetaTool(name: string): boolean {
  return name === SEARCH_TOOL || name === RUN_TOOL;
}

export const metaTools: Tool[] = [
  {
    name: SEARCH_TOOL,
    description:
      "Search the tools available through this gateway by keyword (e.g. 'orders', 'create product', 'github issue'). " +
      "Returns matching tool names, descriptions and input schemas. Call run_tool with a returned name to use it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing what you want to do." },
        limit: { type: "number", description: "Maximum number of results (default 8, max 25)." },
      },
      required: ["query"],
    },
  },
  {
    name: RUN_TOOL,
    description: "Run a tool found with search_tools. Pass its exact name and an arguments object matching its input schema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name as returned by search_tools, e.g. woo__list_orders." },
        arguments: { type: "object", description: "Arguments for that tool." },
      },
      required: ["name"],
    },
  },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Simple keyword scoring: name hits weigh more than description hits. No dependencies, no index to keep in sync. */
export function searchTools(principal: Principal, query: string, limit: number): Tool[] {
  const words = tokenize(query);
  const all = visibleTools(principal);
  if (words.length === 0) return all.slice(0, limit);

  const scored = all
    .map((tool) => {
      const name = tokenize(tool.name);
      const description = tokenize(tool.description ?? "");
      let score = 0;
      for (const w of words) {
        if (name.some((n) => n === w)) score += 5;
        else if (name.some((n) => n.includes(w) || w.includes(n))) score += 3;
        if (description.some((d) => d === w)) score += 2;
        else if (description.some((d) => d.includes(w))) score += 1;
      }
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tool);
}

function text(value: unknown, isError = false): CallToolResult {
  return { isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** Handles search_tools / run_tool. Returns undefined for any other tool name. */
export async function executeMetaTool(
  principal: Principal,
  source: CallSource,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name === SEARCH_TOOL) {
    const started = Date.now();
    const query = typeof args.query === "string" ? args.query : "";
    const limit = Math.min(25, Math.max(1, Number(args.limit) || 8));
    const found = searchTools(principal, query, limit);
    await recordAudit({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId ?? null,
      source,
      toolName: SEARCH_TOOL,
      durationMs: Date.now() - started,
      outcome: "ok",
    });
    if (found.length === 0) return text("No matching tools. Try different keywords.");
    return text(found.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
  }

  if (name === RUN_TOOL) {
    const target = args.name;
    if (typeof target !== "string") return text("run_tool needs a string 'name'.", true);
    const inner = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments : {};
    return callTool(principal, source, target, inner as Record<string, unknown>);
  }
  return undefined;
}
