import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { principalOf, requireAdmin, requireUser } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { randomToken, sha256 } from "../security/crypto.js";
import { HttpError, idParam, isUniqueViolation, parseBody } from "./http.js";

// Team management (admins only). Users are disabled, never deleted, so their
// audit history stays attributed.

export const membersRouter = Router();
membersRouter.use(requireUser, requireAdmin);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type MemberRow = {
  id: number;
  email: string;
  role: string;
  status: string;
  created_at: Date;
  active_keys: number;
};

membersRouter.get("/", async (_req, res) => {
  const { rows } = await pool.query<MemberRow>(
    `SELECT u.id, u.email, u.role, u.status, u.created_at,
            count(k.id) FILTER (WHERE k.revoked_at IS NULL)::int AS active_keys
       FROM users u LEFT JOIN api_keys k ON k.user_id = u.id
      GROUP BY u.id
      ORDER BY u.id`,
  );
  res.json(rows);
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

membersRouter.post("/", async (req, res) => {
  const { email, role } = parseBody(inviteSchema, req.body);
  const token = randomToken();
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (email, role, status, invite_token_hash, invite_expires_at)
       VALUES ($1, $2, 'invited', $3, $4)
       RETURNING id`,
      [email, role, sha256(token), new Date(Date.now() + INVITE_TTL_MS)],
    );
    // No email sending: the admin copies the link (shown once) to the invitee.
    res.status(201).json({ id: rows[0].id, inviteUrl: `${config.publicUrl}/#/invite/${token}` });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `${email} is already a member`);
    throw err;
  }
});

const patchSchema = z.object({
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

membersRouter.patch("/:id", async (req, res) => {
  const id = idParam(req);
  const { role, status } = parseBody(patchSchema, req.body);
  if (id === principalOf(res).userId) throw new HttpError(400, "You can't change your own role or status");

  const { rows } = await pool.query<{ id: number }>(
    `UPDATE users
        SET role = COALESCE($1, role),
            -- an invited user only becomes active by accepting the invite
            status = CASE WHEN $2::text IS NULL OR status = 'invited' AND $2 = 'active' THEN status ELSE $2 END
      WHERE id = $3
      RETURNING id`,
    [role ?? null, status ?? null, id],
  );
  if (!rows[0]) throw new HttpError(404, "User not found");
  // Disabling logs the user out everywhere; their API keys stop working via the status check.
  if (status === "disabled") await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
  res.json({ ok: true });
});
