# Urumi: MCP Gateway on Kubernetes

A WooCommerce store on Kubernetes plus a team MCP gateway. An admin registers MCP servers once in a dashboard. Every team member then uses all of them through **one MCP endpoint** with their own API key, or through a chat agent in the dashboard.

> Status: early scaffold. See [`docs/PLAN.md`](docs/PLAN.md) for the architecture, milestones and design decisions.

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

- [ ] Placing an order on the storefront
- [ ] Connecting Claude Code / Cursor / MCP Inspector to the gateway
- [ ] Using the chat agent
- [ ] Upgrade and rollback with Helm
- [ ] Design and tradeoffs note, threat model note
