import { randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { sha256 } from "../security/crypto.js";
import type { Principal, Role } from "./principal.js";

// Key format: urumi_<8 hex prefix>_<43 chars base64url = 256 random bits>
// Only sha256(key) is stored. The prefix is stored in plain text so users can
// tell their keys apart in the UI. The full key is shown exactly once.

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const key = `urumi_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: sha256(key) };
}

export type ApiKeyAuth =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "missing" | "invalid" }
  // Revoked key or disabled user: we still know who it was, so the attempt can be audited.
  | { ok: false; reason: "revoked"; userId: number; apiKeyId: number };

type KeyRow = {
  id: number;
  user_id: number;
  revoked_at: Date | null;
  email: string;
  role: Role;
  status: string;
};

/** Checked on every request, with no cache, so revocation takes effect immediately. */
export async function authenticateApiKey(authorization: string | undefined): Promise<ApiKeyAuth> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return { ok: false, reason: "missing" };

  const { rows } = await pool.query<KeyRow>(
    `SELECT k.id, k.user_id, k.revoked_at, u.email, u.role, u.status
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1`,
    [sha256(match[1])],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };
  if (row.revoked_at || row.status !== "active") {
    return { ok: false, reason: "revoked", userId: row.user_id, apiKeyId: row.id };
  }

  pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]).catch((err: unknown) => {
    console.error("failed to update last_used_at", err);
  });
  return { ok: true, principal: { userId: row.user_id, email: row.email, role: row.role, apiKeyId: row.id } };
}
