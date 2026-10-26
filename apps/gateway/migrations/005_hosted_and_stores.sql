-- Desired state for the provisioner. The gateway only writes these rows; the
-- provisioner (apps/provisioner) reconciles them into Kubernetes resources, so a
-- restart of either component can never lose track of what should exist.

-- 'remote' = registered by URL | 'hosted' = deployed from a container image | 'store' = a provisioned store's MCP server
ALTER TABLE upstreams ADD COLUMN kind text NOT NULL DEFAULT 'remote' CHECK (kind IN ('remote', 'hosted', 'store'));

CREATE TABLE hosted_servers (
  upstream_id    bigint PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE,
  image          text NOT NULL,
  port           integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  env_ciphertext bytea,                   -- AES-256-GCM of the env JSON (secret values), same key as upstream credentials
  env_iv         bytea,
  allow_internet boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'deploying' CHECK (status IN ('deploying', 'running', 'failed', 'deleting')),
  status_detail  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id             bigserial PRIMARY KEY,
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]{3,10}$'),  -- also the MCP server slug: <slug>__list_orders
  name           text NOT NULL,
  owner_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  namespace      text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  status_detail  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
