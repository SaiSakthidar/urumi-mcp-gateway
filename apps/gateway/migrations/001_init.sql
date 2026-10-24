-- Core schema. See docs/PLAN.md section 1.3.

CREATE TABLE users (
  id                 bigserial PRIMARY KEY,
  email              text NOT NULL UNIQUE,
  role               text NOT NULL CHECK (role IN ('admin', 'member')),
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  password_hash      text,             -- scrypt; null until the invite is accepted
  invite_token_hash  text UNIQUE,      -- sha256 of the one-time invite token
  invite_expires_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash     text PRIMARY KEY,        -- sha256 of the cookie value
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,         -- shown in the UI, e.g. "ab12cd34"
  key_hash      text NOT NULL UNIQUE,  -- sha256 of the full key
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz            -- soft delete: revoked calls stay attributable
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

CREATE TABLE upstreams (
  id                     bigserial PRIMARY KEY,
  -- Tool names are exposed as <slug>__<tool>; slugs can't contain "_", so the
  -- first "__" always separates slug from tool. Slugs are immutable.
  slug                   text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,16}$'),
  display_name           text NOT NULL,
  url                    text NOT NULL,
  auth_type              text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name       text,
  credential_ciphertext  bytea,        -- AES-256-GCM (ciphertext || auth tag)
  credential_iv          bytea,
  enabled                boolean NOT NULL DEFAULT true,
  created_by             bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  user_id        bigint REFERENCES users(id) ON DELETE SET NULL,
  source         text NOT NULL CHECK (source IN ('mcp', 'chat')),
  api_key_id     bigint REFERENCES api_keys(id) ON DELETE SET NULL,
  upstream_slug  text,
  tool_name      text,
  duration_ms    integer,
  -- ok: upstream returned a result | tool_error: upstream returned isError
  -- timeout / unreachable / disabled / not_found / error: gateway-side failures
  -- denied: blocked by tool permissions | auth_revoked: revoked key or disabled user
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'tool_error', 'timeout', 'unreachable', 'disabled',
                                                  'not_found', 'error', 'denied', 'auth_revoked')),
  error_message  text
);
CREATE INDEX audit_events_ts_idx ON audit_events (ts DESC);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, ts DESC);

CREATE TABLE tool_rules (
  id             bigserial PRIMARY KEY,
  role           text NOT NULL CHECK (role IN ('admin', 'member')),
  upstream_slug  text NOT NULL,
  tool_pattern   text NOT NULL,        -- glob, e.g. "create_*"
  effect         text NOT NULL CHECK (effect IN ('allow', 'deny'))
);
