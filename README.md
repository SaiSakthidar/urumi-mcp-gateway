# Urumi: MCP Gateway on Kubernetes

A WooCommerce store on Kubernetes plus a team MCP gateway. An admin registers MCP servers once in a dashboard. Every team member then uses all of them through **one MCP endpoint** with their own API key, or through a chat agent in the dashboard.

> Status: milestones M1–M5 are written (store setup, WooCommerce MCP server, gateway, team management, dashboard), but nothing has been deployed or tested yet. The chat agent (M6) is next. See [`docs/PLAN.md`](docs/PLAN.md) for the architecture, milestones and design decisions.

## Layout

| Path | What |
|---|---|
| `apps/woo-mcp` | WooCommerce MCP server (TypeScript, Streamable HTTP, stateless). Cluster-internal only |
| `apps/gateway` | Gateway backend: one `/mcp` endpoint aggregating every upstream, dashboard API, chat agent |
| `apps/dashboard` | React + Vite dashboard, served by nginx-unprivileged |
| `apps/everything-mcp` | Image for the official MCP reference server (an in-cluster upstream) |
| `charts/store` | WordPress + WooCommerce + MariaDB → namespace `store` |
| `charts/mcp-servers` | woo-mcp + everything-mcp → namespace `mcp` |
| `charts/platform` | gateway + dashboard + Postgres → namespace `platform` |
| `kind/` | kind cluster config and Traefik values (local only) |
| `scripts/` | Cluster bring-up and secret creation |

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

`*.127.0.0.1.sslip.io` resolves to `127.0.0.1` through public DNS, so no `/etc/hosts` edits are needed. kind maps host ports 80/443 to Traefik. If you're offline, add the two hosts to `/etc/hosts` pointing at `127.0.0.1`.

### Secrets

Charts never create Secrets. `scripts/create-secrets.sh <env>` creates the namespaces and every Secret from `.secrets/<env>.env` (gitignored). Random values are generated on first run. Put your LLM key and GitHub PAT in that file by hand, then re-run `make secrets`.

### First login

The gateway creates one admin on first boot:

```bash
# email: admin@urumi.local (charts/platform values: gateway.bootstrapAdminEmail)
grep BOOTSTRAP_ADMIN_PASSWORD .secrets/local.env
```

WordPress admin (`http://shop.127.0.0.1.sslip.io/wp-admin`) is user `admin`, password `WP_ADMIN_PASSWORD` in the same file.

### Place an order

The `store-setup` Job installs WooCommerce, seeds three products, enables cash on delivery and disables shipping. Open the storefront, add a product to the cart, check out with **Cash on delivery**, then find the order under WooCommerce → Orders.

### Register the other MCP servers

The WooCommerce server is registered automatically as `woo`. Add the others in **Servers → Add server**:

| Slug | URL | Auth |
|---|---|---|
| `everything` | `http://everything-mcp.mcp.svc.cluster.local:3001/mcp` | none |
| `github` | `https://api.githubcopilot.com/mcp/` | Bearer token = a fine-grained GitHub PAT |

Every tool is exposed as `<slug>__<tool>` (e.g. `woo__list_orders`), so two servers can have tools with the same name.

### Invite a teammate and connect an MCP client

1. **Members → Invite** creates the user and shows a one-time invite link. The teammate opens it and sets a password.
2. The teammate opens **API keys → Generate key** (shown once).
3. Connect a client with only the gateway URL and that key:

```bash
claude mcp add --transport http urumi http://app.127.0.0.1.sslip.io/mcp \
  --header "Authorization: Bearer urumi_xxxxxxxx_..."
```

Or use MCP Inspector (`npx @modelcontextprotocol/inspector`) with transport "Streamable HTTP", the same URL, and an `Authorization` header.

The gateway is stateless (no MCP sessions), so after a server is disabled, clients see the change on their next tool listing (Inspector: "List Tools"; Claude Code: `/mcp` → reconnect).

### Audit log

**Audit log** shows every tool call with user, server, tool, time, duration and outcome. Admins see everyone; members see their own. Calls with a revoked key show up as `auth_revoked` under the key's owner.

## Development

```bash
cd apps/gateway && npm install && npm run dev      # needs PG* env vars pointing at a Postgres
cd apps/woo-mcp && npm install && npm run dev
cd apps/dashboard && npm install && npm run dev    # proxies /api and /mcp to :8080
```

## Production (k3s VPS)

Same charts, different values: `charts/*/values-prod.yaml` (domain, TLS, storage class, image registry). Images are pushed to GHCR.

```bash
make secrets ENV=prod
make deploy ENV=prod
```

Full instructions arrive with milestone M8.

## Still to document

- [ ] Using the chat agent (M6)
- [ ] Upgrade and rollback with Helm
- [ ] Design and tradeoffs note, threat model note
