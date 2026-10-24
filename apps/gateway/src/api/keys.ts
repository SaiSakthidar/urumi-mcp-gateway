import { Router } from "express";
import { z } from "zod";
import { generateApiKey } from "../auth/apiKeys.js";
import { principalOf, requireUser } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { HttpError, idParam, parseBody } from "./http.js";

// API keys for the MCP endpoint. Every user manages their own; admins can
// also list and revoke anyone's (?all=true).

export const keysRouter = Router();
keysRouter.use(requireUser);

type KeyRow = {
  id: number;
  user_id: number;
  user_email: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

keysRouter.get("/", async (req, res) => {
  const me = principalOf(res);
  const all = req.query.all === "true" && me.role === "admin";
  const { rows } = await pool.query<KeyRow>(
    `SELECT k.id, k.user_id, u.email AS user_email, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE $1 OR k.user_id = $2
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
    [all, me.userId],
  );
  res.json(rows);
});

const createSchema = z.object({ name: z.string().trim().min(1).max(64) });

keysRouter.post("/", async (req, res) => {
  const { name } = parseBody(createSchema, req.body);
  const { key, prefix, hash } = generateApiKey();
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id",
    [principalOf(res).userId, name, prefix, hash],
  );
  // The only time the full key is ever returned.
  res.status(201).json({ id: rows[0].id, name, prefix, key });
});

// Revoke = soft delete. The row stays so later attempts with the key are still attributed.
keysRouter.delete("/:id", async (req, res) => {
  const me = principalOf(res);
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND (user_id = $2 OR $3)`,
    [idParam(req), me.userId, me.role === "admin"],
  );
  if (rowCount !== 1) throw new HttpError(404, "Key not found or already revoked");
  res.json({ ok: true });
});
