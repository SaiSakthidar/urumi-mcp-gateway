import { Router } from "express";
import { z } from "zod";
import { listAudit } from "../audit/audit.js";
import { principalOf, requireUser } from "../auth/sessions.js";
import { parseBody } from "./http.js";

// Admins see every tool call; members see only their own.

export const auditRouter = Router();
auditRouter.use(requireUser);

const querySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  server: z.string().optional(),
  outcome: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

auditRouter.get("/", async (req, res) => {
  const me = principalOf(res);
  const q = parseBody(querySchema, req.query);
  const rows = await listAudit({
    userId: me.role === "admin" ? q.userId : me.userId,
    upstreamSlug: q.server || undefined,
    outcome: q.outcome || undefined,
    limit: q.limit,
  });
  res.json(rows);
});
