-- OAuth 2.1 authorization server for MCP clients (authorization code + PKCE, public clients).
-- Codes and tokens are random 256-bit values; only their sha256 is stored, like API keys.
CREATE TABLE oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text NOT NULL,
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,        -- PKCE, method S256
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE oauth_tokens (
  token_hash   text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id    text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_user_idx ON oauth_tokens (user_id);
