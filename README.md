# Urumi: MCP Gateway on Kubernetes

A WooCommerce store on Kubernetes plus a team MCP gateway. An admin registers MCP servers once in a dashboard. Every team member then uses all of them through **one MCP endpoint** with their own API key, or through a **chat agent** in the dashboard. Upstream credentials never leave the gateway, and every tool call is audited.

> Status: tested end to end on a local kind cluster and on a real k3s server on AWS (EC2, Terraform and Ansible), including store provisioning, OAuth, hosted servers, rate limits, two gateway replicas, and upgrade and rollback. `scripts/e2e.sh` runs the whole suite. Not exercised: the cert-manager TLS path.

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
| `apps/provisioner` | Reconciles stores and hosted MCP servers into Kubernetes. The only component with Kubernetes API access |
| `apps/everything-mcp` | Image for the official MCP reference server (an in-cluster upstream) |
| `charts/store` | WordPress + WooCommerce + MariaDB + setup Job → namespace `store` |
| `charts/mcp-servers` | woo-mcp + everything-mcp → namespace `mcp` |
| `charts/platform` | gateway + dashboard + Postgres + provisioner → namespace `platform` |
| `kind/` | kind cluster config and Traefik values (local only) |
| `deploy/` | cert-manager ClusterIssuer (prod, optional) |
| `scripts/` | Cluster bring-up, secrets, image push, MCP smoke test |

Each app is a standalone npm project with its own lockfile and Dockerfile.

## Local setup (kind)

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/) ≥ 0.24, kubectl, Helm 3, Node 22 (only for running the apps outside Docker), openssl. Host ports 80 and 443 must be free, because kind publishes them for Traefik. Check that `kubectl config current-context` is `kind-urumi` before running `make deploy`, since Helm uses the current context.

```bash
make up        # kind cluster + Traefik, Secrets, build + load images, 3 helm releases
make status
```

If host port 80 is taken (Apache, another web server), create the cluster on other ports and tell the charts about it:

```bash
# in kind/kind-config.yaml use hostPort 8080 / 8443, then:
make up PORT=8080          # URLs become http://app.127.0.0.1.sslip.io:8080 ...
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

### Connect with OAuth instead of a key

Clients that support the MCP authorization spec (Claude Code, MCP Inspector) need no key. Add only the URL, then authenticate:

```bash
claude mcp add --transport http urumi http://app.127.0.0.1.sslip.io/mcp
# in Claude Code: /mcp → urumi → Authenticate (a browser tab opens, sign in, Allow)
```

The gateway answers an unauthenticated call with `401` and a `WWW-Authenticate` header pointing at its discovery document (`/.well-known/oauth-protected-resource`). The client registers itself (`/oauth/register`), sends you to the gateway's login page with PKCE, and exchanges the code for tokens (`/oauth/token`). API keys keep working.

### Many tools: search instead of list

Add `?tools=search` to the MCP URL and a client sees only two tools, `search_tools` and `run_tool`. It finds the real tool by keyword, then runs it; permissions, rate limits and audit still apply to the real tool. The chat agent switches to this on its own when a user can see more than 30 tools.

```bash
claude mcp add --transport http urumi "http://app.127.0.0.1.sslip.io/mcp?tools=search" --header "Authorization: Bearer urumi_..."
```

### Create stores from the dashboard

**Stores → Create store** provisions a whole new store in its own namespace (WordPress, MariaDB, its own WooCommerce MCP server, Secrets, volumes, an Ingress host `shop-<id>.<domain>`). It shows *Provisioning* for a couple of minutes, then *Ready* with the URL. Its tools appear as `<id>__list_orders` and so on, so you can ask the chat agent: "Compare today's orders across `acme` and `woo`". **Delete** removes the namespace, volumes, Secrets and the tools. Limits: 2 stores per user and 6 in total by default (`gateway.maxStoresPerUser`, `gateway.maxStoresTotal`), a ResourceQuota per store, and a 15-minute provisioning timeout.

Prove the isolation:

```bash
kubectl -n store-acme exec deploy/woo-mcp -- node -e "fetch('http://wordpress.store.svc.cluster.local',{signal:AbortSignal.timeout(4000)}).then(r=>console.log('REACHED',r.status)).catch(e=>console.log('blocked'))"
```

### Host an MCP server from a container image

**Servers → Host from image**: give an image (pinned tag, from an allowed registry), its port and any environment variables. The provisioner runs it in the `mcp-hosted` namespace with its own Secret, resource limits and a NetworkPolicy that lets only the gateway reach it, and removes all of it when you remove the server. The server must speak Streamable HTTP at `/mcp`.

### Metrics

The **Metrics** page shows calls, error rate and latency per server. Prometheus text is at `/metrics` on the gateway (inside the cluster only): `kubectl -n platform port-forward deploy/gateway 8080 && curl localhost:8080/metrics`. Calls over the per-key limit (120 a minute by default) are rejected as `rate_limited` and audited.

### Run more than one gateway

```bash
helm upgrade platform charts/platform -n platform -f charts/platform/values-local.yaml --set gateway.replicas=2 --set port=8080
```

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

### AWS with Terraform and Ansible

`infra/` builds the whole thing on one EC2 instance (default VPC, Elastic IP, security group limited to your IP, encrypted disk):

```bash
cd infra
make up        # terraform apply: the server
make deploy    # ansible: k3s, images, secrets, helm install
make verify    # checks from outside and inside
make down      # destroys everything (the server bills while it runs)
```

Set your IP in `infra/terraform/terraform.tfvars` (`ssh_cidrs`, `web_cidrs`). Once deployed, `scripts/e2e.sh` runs the end-to-end suite against it (phases: core, search, oauth, rate, hosted, store, recover). Details in [docs/vps.md](docs/vps.md).

Upgrades and rollbacks (`helm upgrade`, `helm history`, `helm rollback`) are in [docs/operations.md](docs/operations.md).

## Tests

```bash
cd apps/gateway && npm test    # tool names, SSRF guard, image rules, OAuth redirects, crypto, tool search, metrics
make lint                      # helm lint, local values
make lint-prod                 # render + check the production values
```

Everything that needs Postgres or Kubernetes (OAuth flow, rate limits, stores, hosted servers) is exercised on a real cluster; see the demo script.

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
| **Production-like VPS deployment** (tooling) | `make lint-prod` renders and checks the prod values offline; `scripts/build-and-push.sh` builds all five images multi-arch |
| **OAuth on the gateway** | `apps/gateway/src/auth/oauth.ts`, `api/oauth.ts`; discovery, dynamic client registration, PKCE, refresh rotation; works alongside API keys |
| **Handling many tools** | `apps/gateway/src/core/metaTools.ts`: `search_tools` + `run_tool`, `?tools=search`, automatic in the chat agent |
| **Hosted MCP servers** | `apps/provisioner/src/hosted.ts`, `POST /api/servers/hosted`; image allowlist, restricted pod security, per-server NetworkPolicy |
| **Scaling** | `gateway.replicas`, PodDisruptionBudget; shared rate limits in Postgres; stateless MCP; per-key rate limits in `core/rateLimit.ts` |
| **Observability** | `/metrics` (`metrics/metrics.ts`), Metrics page (`core/stats.ts`), failure reasons in the audit log and server status |
| **Upgrades and rollback** | [docs/operations.md](docs/operations.md), `make upgrade-demo` |
| **Bonus: multi-store provisioning** | `apps/provisioner/src/stores.ts`, `api/stores.ts`, `charts/store` (per-store woo-mcp, ResourceQuota, LimitRange, NetworkPolicies), Stores page |
