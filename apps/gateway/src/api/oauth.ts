import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  ACCESS_TTL_S,
  OauthError,
  exchangeCode,
  findClient,
  isAllowedRedirectUri,
  issueCode,
  refreshTokens,
  registerClient,
} from "../auth/oauth.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { verifyPassword } from "../security/crypto.js";

// OAuth endpoints per the MCP authorization spec:
//   /.well-known/oauth-protected-resource      (RFC 9728)  which authorization server protects /mcp
//   /.well-known/oauth-authorization-server    (RFC 8414)  endpoints and capabilities
//   POST /oauth/register                       (RFC 7591)  dynamic client registration
//   GET/POST /oauth/authorize                  browser login + consent, PKCE required
//   POST /oauth/token                          code and refresh-token exchange
//
// Mounted at the root, outside the dashboard's CSRF header rule: these are
// called by OAuth clients, not by the dashboard SPA.

export const oauthRouter = Router();
const issuer = config.publicUrl;

// Metadata and token endpoints carry no cookies, so browser-based clients
// (e.g. MCP Inspector) may call them cross-origin.
oauthRouter.use((req, res, next) => {
  if (req.path.startsWith("/oauth/authorize")) return next();
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

export const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource`;

function protectedResource(_req: Request, res: Response) {
  res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
}
oauthRouter.get("/.well-known/oauth-protected-resource", protectedResource);
oauthRouter.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

function authorizationServer(_req: Request, res: Response) {
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
oauthRouter.get("/.well-known/oauth-authorization-server", authorizationServer);
oauthRouter.get("/.well-known/oauth-authorization-server/mcp", authorizationServer);

// ---- Dynamic client registration -----------------------------------------

const registerSchema = z.object({
  client_name: z.string().trim().min(1).max(100).default("MCP client"),
  redirect_uris: z.array(z.string()).min(1).max(5),
});

oauthRouter.post("/oauth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "Provide 1-5 redirect_uris: https, or http on localhost/127.0.0.1.",
    });
    return;
  }
  const client = await registerClient(parsed.data.client_name, parsed.data.redirect_uris);
  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// ---- Authorization: browser login + consent ------------------------------

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const authorizeSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(512).optional(),
});
type AuthorizeParams = z.infer<typeof authorizeSchema>;

function page(res: Response, status: number, body: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", // a login form must not be framed (clickjacking)
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://localhost:* http://127.0.0.1:* https:",
    })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Urumi: sign in</title><style>
body{font:16px system-ui,sans-serif;background:#f6f7f9;color:#1b1f24;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #d8dde3;border-radius:10px;padding:28px;width:min(380px,92vw)}
h1{font-size:1.2rem;margin:0 0 6px} p{color:#4a5560;margin:0 0 16px} label{display:block;font-size:.85rem;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #b9c1ca;border-radius:6px;font:inherit}
.row{display:flex;gap:10px;margin-top:18px} button{flex:1;padding:10px;border-radius:6px;border:1px solid #1b1f24;font:inherit;cursor:pointer}
.allow{background:#1b1f24;color:#fff} .deny{background:#fff} .err{color:#b3261e;margin-top:12px}
</style></head><body><main>${body}</main></body></html>`);
}

async function validateAuthorizeRequest(
  source: Record<string, unknown>,
): Promise<{ params: AuthorizeParams; clientName: string } | { error: string }> {
  const parsed = authorizeSchema.safeParse(source);
  if (!parsed.success) return { error: "The authorization request is invalid or incomplete (PKCE S256 is required)." };
  const client = await findClient(parsed.data.client_id);
  if (!client) return { error: "Unknown client." };
  // Exact match only: an open redirect here would leak authorization codes.
  if (!client.redirectUris.includes(parsed.data.redirect_uri)) return { error: "redirect_uri is not registered for this client." };
  return { params: parsed.data, clientName: client.clientName };
}

function hidden(params: AuthorizeParams): string {
  return Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join("");
}

function consentForm(params: AuthorizeParams, clientName: string, error?: string): string {
  return `<h1>Connect ${esc(clientName)}</h1>
<p>Sign in to let <strong>${esc(clientName)}</strong> use your Urumi tools as you. It can call the same tools your API key can, and every call is audited under your name.</p>
<form method="post" action="/oauth/authorize">${hidden(params)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<div class="row"><button class="deny" name="decision" value="deny" formnovalidate>Deny</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form>`;
}

oauthRouter.get("/oauth/authorize", async (req, res) => {
  const checked = await validateAuthorizeRequest(req.query);
  if ("error" in checked) {
    page(res, 400, `<h1>Cannot continue</h1><p>${esc(checked.error)}</p>`);
    return;
  }
  page(res, 200, consentForm(checked.params, checked.clientName));
});

function redirectWith(res: Response, params: AuthorizeParams, extra: Record<string, string>): void {
  const url = new URL(params.redirect_uri);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  if (params.state) url.searchParams.set("state", params.state);
  res.redirect(302, url.toString());
}

// Slows down password guessing through this form, per client address.
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

oauthRouter.post("/oauth/authorize", express.urlencoded({ extended: false }), async (req, res) => {
  const checked = await validateAuthorizeRequest(req.body as Record<string, unknown>);
  if ("error" in checked) {
    page(res, 400, `<h1>Cannot continue</h1><p>${esc(checked.error)}</p>`);
    return;
  }
  const { params, clientName } = checked;
  const body = req.body as Record<string, string>;

  if (body.decision !== "allow") {
    redirectWith(res, params, { error: "access_denied" });
    return;
  }
  if (tooManyAttempts(req.ip ?? "unknown")) {
    page(res, 429, consentForm(params, clientName, "Too many attempts. Try again in a few minutes."));
    return;
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const { rows } = await pool.query<{ id: number; password_hash: string | null; status: string }>(
    "SELECT id, password_hash, status FROM users WHERE email = $1",
    [email],
  );
  const user = rows[0];
  const valid = user?.password_hash ? await verifyPassword(String(body.password ?? ""), user.password_hash) : false;
  if (!user || !valid || user.status !== "active") {
    page(res, 401, consentForm(params, clientName, "Invalid email or password."));
    return;
  }

  const code = await issueCode({
    clientId: params.client_id,
    userId: user.id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
  });
  redirectWith(res, params, { code });
});

// ---- Token endpoint --------------------------------------------------------

oauthRouter.post("/oauth/token", express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = (req.body ?? {}) as Record<string, string | undefined>;
  try {
    const clientId = b.client_id ?? "";
    if (!(await findClient(clientId))) throw new OauthError("invalid_client", "Unknown client");
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.redirect_uri || !b.code_verifier) throw new OauthError("invalid_request", "code, redirect_uri and code_verifier are required");
      res.json(await exchangeCode({ clientId, code: b.code, redirectUri: b.redirect_uri, codeVerifier: b.code_verifier }));
    } else if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) throw new OauthError("invalid_request", "refresh_token is required");
      res.json(await refreshTokens(clientId, b.refresh_token));
    } else {
      throw new OauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
    }
  } catch (err) {
    if (err instanceof OauthError) {
      res.status(err.code === "invalid_client" ? 401 : 400).json({ error: err.code, error_description: err.message });
      return;
    }
    throw err;
  }
});

export { ACCESS_TTL_S };
