import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { randomToken, sha256 } from "../security/crypto.js";
import type { Principal, Role } from "./principal.js";

// OAuth 2.1 for MCP clients: the gateway is its own authorization server.
// Public clients only (no client secret), authorization code + PKCE (S256),
// refresh-token rotation. Codes and tokens are random 256-bit values; only
// their sha256 is stored, like API keys, so a database dump gives no access.

export const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;

export interface OauthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

/** https, or http on a loopback address (desktop and CLI clients). */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(name: string, redirectUris: string[]): Promise<OauthClient> {
  const clientId = randomUUID();
  await pool.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)", [
    clientId,
    name,
    redirectUris,
  ]);
  return { clientId, clientName: name, redirectUris };
}

export async function findClient(clientId: string): Promise<OauthClient | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(clientId)) return undefined;
  const { rows } = await pool.query<{ client_id: string; client_name: string; redirect_uris: string[] }>(
    "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  const r = rows[0];
  return r && { clientId: r.client_id, clientName: r.client_name, redirectUris: r.redirect_uris };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueCode(params: {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken();
  await pool.query(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [sha256(code), params.clientId, params.userId, params.redirectUri, params.codeChallenge, CODE_TTL_S],
  );
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

async function issueTokens(clientId: string, userId: number): Promise<TokenResponse> {
  const access = randomToken();
  const refresh = randomToken();
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES
       ($1, 'access',  $3, $4, now() + make_interval(secs => $5)),
       ($2, 'refresh', $3, $4, now() + make_interval(secs => $6))`,
    [sha256(access), sha256(refresh), clientId, userId, ACCESS_TTL_S, REFRESH_TTL_S],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh };
}

export class OauthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_grant" | "unsupported_grant_type" | "invalid_client",
    message: string,
  ) {
    super(message);
  }
}

export async function exchangeCode(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  // Single-use: the UPDATE marks it used and returns it only if it was still unused and unexpired.
  const { rows } = await pool.query<{ user_id: number; redirect_uri: string; code_challenge: string }>(
    `UPDATE oauth_codes SET used_at = now()
      WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, redirect_uri, code_challenge`,
    [sha256(params.code), params.clientId],
  );
  const row = rows[0];
  if (!row) throw new OauthError("invalid_grant", "Authorization code is invalid, expired or already used");
  if (row.redirect_uri !== params.redirectUri) throw new OauthError("invalid_grant", "redirect_uri does not match");
  if (!pkceMatches(params.codeVerifier, row.code_challenge)) throw new OauthError("invalid_grant", "PKCE verification failed");
  return issueTokens(params.clientId, row.user_id);
}

export async function refreshTokens(clientId: string, refreshToken: string): Promise<TokenResponse> {
  // Rotation: the old refresh token is revoked as it is used.
  const { rows } = await pool.query<{ user_id: number }>(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(refreshToken), clientId],
  );
  if (!rows[0]) throw new OauthError("invalid_grant", "Refresh token is invalid, expired or already used");
  return issueTokens(clientId, rows[0].user_id);
}

/** Checked on every /mcp request with no cache, so disabling a user takes effect at once. */
export async function authenticateAccessToken(token: string): Promise<Principal | undefined> {
  const { rows } = await pool.query<{ id: number; email: string; role: Role }>(
    `SELECT u.id, u.email, u.role
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL
        AND t.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  const r = rows[0];
  return r && { userId: r.id, email: r.email, role: r.role };
}
