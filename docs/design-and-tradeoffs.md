# System design and tradeoffs

## Architecture

```
 Claude Code / Cursor / Inspector             Browser (dashboard + chat)
   POST /mcp  Bearer <api key>                  /api/*  session cookie
            │                                            │
            ▼          ── public: Traefik Ingress ──     ▼
   ┌──────────────────────────── platform ns ───────────────────────────┐
   │ gateway (Node/TS)                                                   │
   │   /mcp ──► authn (sha256 key lookup) ──┐   /api/chat ──► agent loop │
   │                                        ▼               ◄──► LLM     │
   │                ToolRouter.callTool(principal, "woo__list_orders")   │
   │                  split name → permission check → upstream client    │
   │                  → timeout → audit row                              │
   │   health poller (5 s): connect + tools/list per upstream → catalog  │
   │ dashboard (nginx, static)        postgres (users, keys, upstreams,  │
   │                                            rules, audit)            │
   └──────────────┬──────────────────────────────────────┬──────────────┘
      internal only (NetworkPolicy)                     │ public HTTPS only
                  ▼                                     ▼
   mcp ns: woo-mcp, everything-mcp            remote MCP (e.g. GitHub)
                  │ OAuth1-signed REST
                  ▼
   store ns: wordpress ──► mariadb
```

| Component | Responsibility | State |
|---|---|---|
| WordPress + WooCommerce | The store | MariaDB PVC + wp-content PVC |
| store-setup Job | Install and configure WooCommerce, create the REST key, seed products. Idempotent | none |
| woo-mcp | Our MCP server: 5 store tools over Streamable HTTP | none (stateless) |
| everything-mcp | Reference MCP server, in-cluster upstream for demos | none |
| gateway | MCP server to clients, MCP client to upstreams, dashboard API, chat agent | Postgres + in-memory upstream status |
| dashboard | React SPA | none |

Namespaces split the system by trust: `store` (customer data), `mcp` (tool servers), `platform` (identity and secrets). Each namespace is default-deny, with explicit allows.

## Tool aggregation

- The gateway keeps **one MCP client per enabled upstream**, created lazily and recreated after any transport error. That covers upstream restarts and expired upstream sessions.
- A **health poller** connects to and runs `tools/list` against every upstream every 5 s. The result is a cached catalog plus a status per server.
- `tools/list` on the gateway is served **from that cache**: tools of every enabled, connected upstream, filtered by the caller's role, renamed `<slug>__<tool>`, with descriptions prefixed by the server's name. A slow upstream can never make listing slow.

## Routing

`tools/call woo__list_orders` → split on the **first** `__` → upstream `woo`, tool `list_orders`. Slugs match `^[a-z0-9-]{1,16}$`, so they can't contain `_` and the split is unambiguous. Slugs are immutable because renaming one would rename every tool clients know.

All calls, from `/mcp` and from the chat agent, go through one function, `core/router.ts:callTool`. In order, it:

1. checks that the server exists, is enabled and is not unreachable,
2. checks that the tool exists and the role may use it,
3. calls the upstream with the decrypted credential injected as a header,
4. applies the timeout,
5. writes the audit row.

### Collision scheme

Every tool is always prefixed, even with no collision. Alternative: prefix only on collision. Rejected because adding a server would silently rename existing tools.

## Failure handling

| Situation | Behavior |
|---|---|
| Upstream dead (pod killed, DNS fails, connection refused) | Status goes Unreachable after 2 failed checks in a row (a new server: after 1). Its tools disappear from the list, and calls fail fast with the last error. Other upstreams are unaffected; checks run in parallel with `Promise.allSettled`. |
| Upstream slow | Each check is bounded at 3 s and each call at 15 s (configurable). A timeout returns an `isError` result saying which server timed out. The connection is kept, since slow doesn't mean broken. |
| Upstream comes back | Next check succeeds and the server is Connected again. No restart needed. |
| Tool error from upstream | Passed through unchanged (`isError: true`) and audited as `tool_error`. |
| Postgres down | Gateway readiness fails and the pod leaves the Service. Liveness never depends on dependencies. |
| WooCommerce down | woo-mcp stays Ready (its probes check only itself); its tools return clear errors. |

## Key decisions

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Gateway MCP transport | Stateless Streamable HTTP (new server per POST, no session id) | Stateful sessions + `tools/list_changed` | Nothing to lose on restart, and scales to more replicas. Cost: clients re-list to see changes. |
| API key storage | SHA-256 of a 256-bit random key | bcrypt/argon2 | Random keys can't be brute-forced, and a deterministic hash allows an indexed lookup. Passwords (low entropy) use scrypt. |
| Revocation | Soft delete (`revoked_at`), checked on every request with no cache | Delete row | Immediate effect, and calls with a revoked key are still attributed to the owner (`auth_revoked`). |
| Upstream credentials | AES-256-GCM in Postgres, key in a K8s Secret | One K8s Secret per upstream | No Kubernetes API access or RBAC needed, and a DB dump alone reveals nothing. |
| Chat agent identity | In-process call to `callTool` with the session's principal | Agent mints a key and calls `/mcp` over HTTP | Same choke point, so same checks and audit, without token minting. The model never chooses who it acts as. |
| woo-mcp → store | WooCommerce REST v3, OAuth 1.0a signed | WP-CLI via `kubectl exec`, direct SQL | Versioned API that runs WooCommerce's own logic, with no Kubernetes privileges. OAuth1 because WooCommerce only allows Basic auth over HTTPS, and in-cluster traffic is plain HTTP. |
| Store setup | Helm post-install/upgrade Job running WP-CLI | Custom WordPress image | Uses official images only, and re-runs safely on every upgrade. |
| Charts | Three charts / releases, one per namespace | Umbrella chart | Independent upgrade and rollback per layer. |
| Secrets | Created out-of-band by a script; charts only reference them | Chart-generated secrets | Same flow locally and in prod; nothing secret in values or git. |
| Ingress | Traefik on kind and k3s | ingress-nginx (retired) | One ingress class in both environments. |
| LLM | Any OpenAI-compatible endpoint | Provider SDK | Changing provider is a values change. |

## What changes for production

- **DNS:** `domain` in values. sslip.io needs no DNS setup; a real domain needs an A record for `shop.` and `app.`.
- **Ingress / TLS:** k3s's Traefik; `ingress.tls.enabled: true` plus a cert-manager ClusterIssuer (HTTP-01).
- **Storage class:** `local-path` on k3s (`standard` on kind). Both are node-local, so single node.
- **Secrets:** `scripts/create-secrets.sh prod`; back up `.secrets/prod.env`.
- **Images:** GHCR, multi-arch, pinned tags.

Full steps: [vps.md](vps.md). Upgrades and rollbacks: [operations.md](operations.md).

## Known limitations

- **Single gateway replica:** upstream status lives in memory. More replicas would each run their own poller, which works but duplicates checks. A shared cache would be needed for consistent status across replicas.
- **No `tools/list_changed`:** clients re-list after a server is disabled. Calling a removed tool by name is rejected anyway.
- **Many tools:** all permitted tools go to the model at once. Fine for three servers; ten would need tool search.
- **WordPress and MariaDB run their entrypoints as root** (official images). Our own containers are non-root with read-only root filesystems.
