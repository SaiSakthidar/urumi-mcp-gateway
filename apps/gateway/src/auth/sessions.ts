import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { randomToken, sha256 } from "../security/crypto.js";
import type { Principal, Role } from "./principal.js";

// Dashboard sessions: a random token in an httpOnly, SameSite=Strict cookie.
// Only sha256(token) is stored, like API keys.

const COOKIE = "urumi_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomToken();
  await pool.query("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    sha256(token),
    userId,
    new Date(Date.now() + TTL_MS),
  ]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    maxAge: TTL_MS,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query("DELETE FROM sessions WHERE id_hash = $1", [sha256(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

type SessionRow = { id: number; email: string; role: Role };

async function sessionPrincipal(req: Request): Promise<Principal | undefined> {
  const token = readCookie(req, COOKIE);
  if (!token) return undefined;
  const { rows } = await pool.query<SessionRow>(
    `SELECT u.id, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  const row = rows[0];
  return row && { userId: row.id, email: row.email, role: row.role };
}

/** The logged-in user, set by requireUser. */
export function principalOf(res: Response): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new Error("principalOf() used on a route without requireUser");
  return principal;
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const principal = await sessionPrincipal(req);
  if (!principal) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  res.locals.principal = principal;
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if (principalOf(res).role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  next();
}
