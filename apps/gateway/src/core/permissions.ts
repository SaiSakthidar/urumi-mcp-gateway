import type { Role } from "../auth/principal.js";
import { pool } from "../db/pool.js";

// Per-role tool permissions.
//
// - Admins can use every tool (so an admin can never lock themselves out).
// - For other roles: default allow; rules are checked in order (by id) and the
//   last matching rule decides. A rule matches a server slug ("*" = any) and a
//   tool name glob ("create_*", "*").
// - Restricted tools are hidden from tools/list AND rejected in tools/call,
//   for MCP clients and the chat agent alike.
//
// Rules are cached in memory and reloaded after every change.

export type ToolRule = {
  id: number;
  role: Role;
  upstream_slug: string;
  tool_pattern: string;
  effect: "allow" | "deny";
};

let rules: ToolRule[] = [];

export async function loadRules(): Promise<void> {
  const { rows } = await pool.query<ToolRule>(
    "SELECT id, role, upstream_slug, tool_pattern, effect FROM tool_rules ORDER BY id",
  );
  rules = rows;
}

export function listRules(): ToolRule[] {
  return rules;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`);
}

export function isToolAllowed(role: Role, slug: string, tool: string): boolean {
  if (role === "admin") return true;
  let allowed = true;
  for (const rule of rules) {
    if (rule.role !== role) continue;
    if (rule.upstream_slug !== "*" && rule.upstream_slug !== slug) continue;
    if (!globToRegExp(rule.tool_pattern).test(tool)) continue;
    allowed = rule.effect === "allow";
  }
  return allowed;
}
