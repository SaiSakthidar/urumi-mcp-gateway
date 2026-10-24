import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireUser } from "../auth/sessions.js";
import { listRules, loadRules } from "../core/permissions.js";
import { pool } from "../db/pool.js";
import { HttpError, idParam, parseBody } from "./http.js";

// Tool permission rules (admins only). See core/permissions.ts for the semantics.

export const permissionsRouter = Router();
permissionsRouter.use(requireUser, requireAdmin);

permissionsRouter.get("/", (_req, res) => {
  res.json(listRules());
});

const ruleSchema = z.object({
  // Rules only apply to members: admins can always use every tool.
  role: z.literal("member").default("member"),
  upstreamSlug: z.string().regex(/^(\*|[a-z0-9-]{1,16})$/, 'A server slug or "*"'),
  toolPattern: z.string().regex(/^[A-Za-z0-9_*.-]{1,64}$/, 'A tool name, optionally with "*" wildcards'),
  effect: z.enum(["allow", "deny"]),
});

permissionsRouter.post("/", async (req, res) => {
  const rule = parseBody(ruleSchema, req.body);
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO tool_rules (role, upstream_slug, tool_pattern, effect) VALUES ($1, $2, $3, $4) RETURNING id",
    [rule.role, rule.upstreamSlug, rule.toolPattern, rule.effect],
  );
  await loadRules();
  res.status(201).json({ id: rows[0].id });
});

permissionsRouter.delete("/:id", async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM tool_rules WHERE id = $1", [idParam(req)]);
  if (rowCount !== 1) throw new HttpError(404, "Rule not found");
  await loadRules();
  res.json({ ok: true });
});
