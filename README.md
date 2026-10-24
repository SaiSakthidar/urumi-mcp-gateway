# Urumi: MCP Gateway on Kubernetes

A WooCommerce store on Kubernetes plus a team MCP gateway. An admin registers MCP servers once in a dashboard. Every team member then uses all of them through **one MCP endpoint** with their own API key, or through a **chat agent** in the dashboard. Upstream credentials never leave the gateway, and every tool call is audited.

> Status: all milestones are written but have not been deployed or tested yet. See [`docs/PLAN.md`](docs/PLAN.md) for the original plan.

**Docs:**

- [Design and tradeoffs](docs/design-and-tradeoffs.md)
- [Threat model](docs/threat-model.md)
- [VPS / k3s deployment](docs/vps.md)
- [Upgrades and rollbacks](docs/operations.md)
- [Demo script](docs/demo-script.md)

## Layout

| Path | What |
|---|---|
| `apps/woo-mcp` | WooCommerce MCP server (TypeScript, Streamable HTTP, stateless). Cluster-internal only |
| `apps/gateway` | Gateway: one `/mcp` endpoint aggregating every upstream, dashboard API, chat agent |
| `apps/dashboard` | React + Vite dashboard, served by nginx-unprivileged |
| `apps/everything-mcp` | Image for the official MCP reference server (an in-cluster upstream) |
| `charts/store` | WordPress + WooCommerce + MariaDB + setup Job → namespace `store` |
| `charts/mcp-servers` | woo-mcp + everything-mcp → namespace `mcp` |
| `charts/platform` | gateway + dashboard + Postgres → namespace `platform` |
| `kind/` | kind cluster config and Traefik values (local only) |
| `deploy/` | cert-manager ClusterIssuer (prod, optional) |
| `scripts/` | Cluster bring-up, secrets, image push, MCP smoke test |

Each app is a standalone npm project with its own lockfile and Dockerfile.

## Local setup (kind)

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/) ≥ 0.24, kubectl, Helm 3, Node 22, openssl.

```bash
make up        # kind cluster + Traefik, Secrets, build + load images, 3 helm releases
make status
```

| URL | What |
|---|---|
| http://shop.127.0.0.1.sslip.io | Storefront (`/wp-admin` for WooCommerce admin) |
| http://app.127.0.0.1.sslip.io | Dashboard |
| http://app.127.0.0.1.sslip.io/mcp | Gateway MCP endpoint |

### Local domains

`*.127.0.0.1.sslip.io` resolves to `127.0.0.1` through public DNS, so no `/etc/hosts` edits are needed. kind maps host ports 80/443 to Traefik, which routes by host name. Offline, add `shop.127.0.0.1.sslip.io` and `app.127.0.0.1.sslip.io` to `/etc/hosts` pointing at `127.0.0.1`.

### Secrets

Charts never create Secrets; they only reference them by name. `scripts/create-secrets.sh <env>` creates the namespaces and every Secret from `.secrets/<env>.env` (gitignored), generating random values on first run. Put your LLM API key in that file (`LLM_API_KEY`) and re-run `make secrets`.

The chat agent works with any OpenAI-compatible endpoint. The default is Gemini's free tier; to switch provider, change `gateway.llm.baseUrl` and `gateway.llm.model` in `charts/platform/values*.yaml`.

### First login

The gateway creates one admin on first boot: `admin@urumi.local`, with password `BOOTSTRAP_ADMIN_PASSWORD` from `.secrets/local.env`. WordPress admin is user `admin` with `WP_ADMIN_PASSWORD`.

## Using it

### Place an order

The `store-setup` Job installs WooCommerce, seeds three products, enables cash on delivery and disables shipping. Open the storefront, add a product to the cart, and check out with **Cash on delivery**. The order appears under WooCommerce → Orders.

### Register the other MCP servers

The WooCommerce server is registered automatically as `woo`. Add the others in **Servers → Add server**:

| Slug | URL | Auth |
|---|---|---|
| `everything` | `http://everything-mcp.mcp.svc.cluster.local:3001/mcp` | none |
| `github` | `https://api.githubcopilot.com/mcp/` | Bearer token = a fine-grained GitHub PAT, scoped to one repo |

Every tool is exposed as `<slug>__<tool>` (e.g. `woo__list_orders`), so two servers can have tools with the same name. URLs pointing at private or cluster-internal addresses are rejected, except the in-cluster MCP servers listed in `gateway.allowedInternalHosts`.

### Invite a teammate and connect an MCP client

1. **Members → Invite** creates the user and shows a one-time invite link. The teammate opens it and sets a password.
2. The teammate opens **API keys → Generate key** (shown once).
3. Connect a client with only the gateway URL and that key:

```bash
claude mcp add --transport http urumi http://app.127.0.0.1.sslip.io/mcp \
  --header "Authorization: Bearer urumi_xxxxxxxx_..."
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "urumi": { "url": "http://app.127.0.0.1.sslip.io/mcp", "headers": { "Authorization": "Bearer urumi_..." } } } }
```

MCP Inspector: `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", same URL, plus an `Authorization` header. Raw curl: `scripts/smoke.sh <url> <key> woo__list_orders '{"date":"today"}'`.

The gateway is stateless (no MCP sessions), so clients see a disabled server's tools disappear on their next tool listing (Inspector: "List Tools"; Claude Code: `/mcp` → reconnect). Calling a removed tool directly is rejected right away.

### Use the chat agent

Open **Chat** and ask, for example, "What orders came in today?" or "Create a product called Demo Mug priced at 199". Each answer shows the tools called (expand a chip for its arguments and result). The agent acts as you: same tools and permissions as your API key, and every call is in the audit log under your name.

### Permissions and audit

- **Permissions** (admin): rules hide and block tools for members. By default, members can't use `woo__create_product` or `woo__update_order_status`.
- **Audit log:** every tool call with user, source (`mcp`/`chat`), server, tool, time, duration and outcome. Admins see everyone; members see their own. Calls with a revoked key show up as `auth_revoked` under the key's owner.

## Production (k3s VPS)

Same charts; only `charts/*/values-prod.yaml` and the Secrets differ. Steps are in [docs/vps.md](docs/vps.md):

```bash
make push REGISTRY=ghcr.io/<user> TAG=0.1.0   # multi-arch images
make secrets ENV=prod                          # on the VPS
make deploy ENV=prod
```

Upgrades and rollbacks (`helm upgrade`, `helm history`, `helm rollback`) are in [docs/operations.md](docs/operations.md).

## Development

```bash
cd apps/gateway && npm install && npm run dev      # needs PG* env vars, ENCRYPTION_KEY, BOOTSTRAP_ADMIN_PASSWORD
cd apps/woo-mcp && npm install && npm run dev      # needs WC_* env vars and MCP_TOKEN
cd apps/dashboard && npm install && npm run dev    # proxies /api and /mcp to :8080
```

## Stand-out items attempted

| Item | Where |
|---|---|
| **Security hardening** | Default-deny NetworkPolicies in all namespaces with explicit allows (`charts/*/templates/networkpolicy.yaml`); SSRF guard on upstream URLs at save and at every connect, no redirects (`apps/gateway/src/security/ssrf.ts`), backed by an egress policy that blocks private ranges; upstream credentials encrypted at rest with AES-256-GCM (`apps/gateway/src/security/crypto.ts`); non-root, read-only containers with no capabilities and no service-account tokens |
| **Tool permissions** | Per-role rules, hidden from the list and rejected on call (`apps/gateway/src/core/permissions.ts`, Permissions page) |
| **Production-like VPS deployment** | `values-prod.yaml`, multi-arch image push, cert-manager issuer, [docs/vps.md](docs/vps.md) |
| **Upgrades and rollback** | [docs/operations.md](docs/operations.md): three independent releases, additive migrations, kept PVCs |
| Observability (partial) | Dashboard shows why an upstream is unreachable (last error), and the audit log records per-call duration and outcome |
