import { Router } from "express";
import { z } from "zod";
import { createSession, destroySession, principalOf, requireUser } from "../auth/sessions.js";
import type { Role } from "../auth/principal.js";
import { pool } from "../db/pool.js";
import { hashPassword, sha256, verifyPassword } from "../security/crypto.js";
import { HttpError, parseBody } from "./http.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

type LoginRow = { id: number; password_hash: string | null; status: string };

authRouter.post("/login", async (req, res) => {
  const { email, password } = parseBody(loginSchema, req.body);
  const { rows } = await pool.query<LoginRow>("SELECT id, password_hash, status FROM users WHERE email = $1", [email]);
  const user = rows[0];
  const valid = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid || user.status !== "active") throw new HttpError(401, "Invalid email or password");
  await createSession(res, user.id);
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, (_req, res) => {
  res.json(principalOf(res));
});

// ---- Invites: admin creates a user with a one-time token; the invitee sets a password.

type InviteRow = { email: string; role: Role };

authRouter.get("/invite/:token", async (req, res) => {
  const { rows } = await pool.query<InviteRow>(
    `SELECT email, role FROM users
      WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status = 'invited'`,
    [sha256(req.params.token)],
  );
  if (!rows[0]) throw new HttpError(404, "This invite link is invalid or has expired");
  res.json(rows[0]);
});

const acceptSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(10, "Use at least 10 characters"),
});

authRouter.post("/accept-invite", async (req, res) => {
  const { token, password } = parseBody(acceptSchema, req.body);
  const { rows } = await pool.query<{ id: number }>(
    `UPDATE users
        SET password_hash = $1, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL
      WHERE invite_token_hash = $2 AND invite_expires_at > now() AND status = 'invited'
      RETURNING id`,
    [await hashPassword(password), sha256(token)],
  );
  if (!rows[0]) throw new HttpError(400, "This invite link is invalid or has expired");
  await createSession(res, rows[0].id);
  res.json({ ok: true });
});
