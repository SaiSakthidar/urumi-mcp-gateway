import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "../auth/principal.js";
import { upstreams } from "../upstreams/manager.js";
import { isToolAllowed } from "./permissions.js";

// Tool naming: every tool is exposed as <slug>__<tool>, always, not only on
// collisions. Names stay stable when servers are added, and since slugs can't
// contain "_", the first "__" in a name always separates slug from tool.

export const SEPARATOR = "__";

// What Claude and most clients accept for tool names.
const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function exposedToolName(slug: string, tool: string): string {
  return `${slug}${SEPARATOR}${tool}`;
}

export function splitToolName(name: string): { slug: string; tool: string } | null {
  const i = name.indexOf(SEPARATOR);
  if (i <= 0 || i + SEPARATOR.length >= name.length) return null;
  return { slug: name.slice(0, i), tool: name.slice(i + SEPARATOR.length) };
}

const warnedNames = new Set<string>();

/**
 * Tools of every enabled, connected upstream that this user's role may use,
 * prefixed. Read from the poller's cache, so it never waits on an upstream.
 */
export function visibleTools(principal: Principal): Tool[] {
  const tools: Tool[] = [];
  for (const state of upstreams.all()) {
    if (!state.config.enabled || state.status !== "connected") continue;
    for (const tool of state.tools) {
      if (!isToolAllowed(principal.role, state.config.slug, tool.name)) continue;
      const name = exposedToolName(state.config.slug, tool.name);
      if (!VALID_NAME.test(name)) {
        if (!warnedNames.has(name)) {
          warnedNames.add(name);
          console.warn(`skipping tool with unsupported name: ${name}`);
        }
        continue;
      }
      tools.push({
        ...tool,
        name,
        // Say where a tool comes from, so neither people nor models confuse servers.
        description: `[${state.config.displayName}] ${tool.description ?? ""}`.trim(),
      });
    }
  }
  return tools;
}
