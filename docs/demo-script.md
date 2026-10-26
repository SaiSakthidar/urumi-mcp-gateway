# Demo video script (~15–18 min)

**Before recording:**

- `make up` is done.
- WooCommerce, everything and GitHub servers are registered.
- User B was invited in a second browser profile.
- Terminal font is large.
- `.secrets/local.env` is not on screen.

User A = admin, user B = member.

| # | Segment | What to show | Commands / clicks | Covers |
|---|---|---|---|---|
| 1 | Architecture (1.5 min) | Diagram in `design-and-tradeoffs.md`; three namespaces; the one choke point `core/router.ts` | open the file | System design |
| 2 | Kubernetes tour (2.5 min) | Workloads, PVCs, Secrets (names only), Ingress, NetworkPolicies; probes and limits on one pod | `make status`; `kubectl get netpol -A`; `kubectl describe pod -n mcp -l app.kubernetes.io/name=woo-mcp` | What runs where, probes, limits |
| 3 | Isolation proof (1 min) | woo-mcp and MariaDB are unreachable from other pods; the storefront is reachable from outside | `kubectl run tmp -n default --rm -it --image=curlimages/curl -- curl -m 5 http://woo-mcp.mcp.svc.cluster.local:3000/healthz` (times out) | Public vs internal, enforcement |
| 4 | Store (1.5 min) | Storefront → add to cart → Cash on delivery → order in WooCommerce admin | browser | **DoD: Store** |
| 5 | Admin dashboard (1.5 min) | Servers: 3 connected, `woo` pre-registered, tool lists; Edit form shows the credential as write-only; DevTools network tab has no credential | browser | Admin stories |
| 6 | Team (1 min) | Members → invite B → link → B sets password (second profile) → B generates a key | browser | Roles, keys |
| 7 | Chat as A (2 min) | "Create a product called Demo Mug priced at 199" → tool chip `woo__create_product` → storefront shows it → buy it by hand → "What orders came in today?" | browser | **DoD: Chat agent** |
| 8 | External client as B (2.5 min) | Claude Code with only URL + B's key → `/mcp` lists `woo__*`, `everything__*`, `github__*` → "What orders came in today?" → cross-server prompt: "Summarize today's orders and open a GitHub issue in <repo> with that summary" → open the issue. B asks to create a product: denied | `claude mcp add --transport http urumi http://app.127.0.0.1.sslip.io/mcp --header "Authorization: Bearer <B key>"` | **DoD: External client**, permissions |
| 9 | MCP internals (2 min) | `router.ts` walk-through; collision: add woo-mcp again as slug `woo2` → `woo__list_orders` and `woo2__list_orders` both work → remove it. Timeout: `everything__…` long-running tool with a long duration → clear timeout while woo still answers | dashboard + client | Collisions, timeouts |
| 10 | Control (2 min) | Revoke B's key → B's next call is rejected. Disable `everything` → gone from chat and from Claude Code after `/mcp` reconnect. `kubectl scale deploy/everything-mcp -n mcp --replicas=0` (and/or `kubectl delete pod`) → dashboard shows Unreachable, woo still works → scale back → Connected | dashboard + terminal | **DoD: Team and control** |
| 11 | Audit (0.5 min) | Filter by user A (`chat`) and B (`mcp`); `denied`, `auth_revoked`, `timeout` rows | Audit log page | **DoD: audit attribution** |
| 12 | Security posture (1.5 min) | Key hashing and why SHA-256; AES-GCM credentials; member vs admin; malicious upstream: try adding `http://169.254.169.254/` and `http://postgres.platform.svc:5432` → rejected; prompt-injection notes from `threat-model.md` | dashboard | Security posture |
| 13 | Prod story (1.5 min) | `diff charts/platform/values-local.yaml charts/platform/values-prod.yaml`; VPS URLs; `helm upgrade` with a new tag → `helm history` → `helm rollback` | terminal | Local→VPS, upgrade/rollback |

**Questions to answer out loud while recording:**

- How does a tool call travel from Claude Code to MariaDB and back?
- Why aren't client tokens forwarded to upstreams?
- What happens if an admin adds a malicious MCP server?
- What changes between kind and k3s?

## Bonus segments (add after segment 13 if time allows)

| # | Segment | What to show | Commands / clicks |
|---|---|---|---|
| 14 | OAuth (1.5 min) | Connect Claude Code with only the URL: `/mcp` → Authenticate → browser login → Allow → tools appear. Mention PKCE and that API keys still work | `claude mcp add --transport http urumi <url>` |
| 15 | Many tools (1 min) | Same URL with `?tools=search`: only `search_tools` and `run_tool`. Ask for "orders", then run the tool; show both in the audit log | client + Audit page |
| 16 | Rate limit + metrics (1.5 min) | Lower `gateway.rateLimitPerMinute` to 5, fire 8 calls, see `rate_limited` rows; open Metrics (error rate, p95); `curl /metrics` through a port-forward | `helm upgrade ... --set gateway.rateLimitPerMinute=5` |
| 17 | Scaling (1.5 min) | `--set gateway.replicas=2`; keep a client calling; `kubectl delete pod` one gateway; calls keep working, both pods in the audit log | `kubectl get pods -l app.kubernetes.io/name=gateway -w` |
| 18 | Multi-store (4 min) | Stores → create `acme` (shows Provisioning → Ready), place an order there; ask chat "compare today's orders across woo and acme"; show the isolation `exec` test; kill the provisioner pod mid-install and show it resume; delete the store and show `kubectl get ns` and its tools are gone | Stores page + terminal |
| 19 | Hosted server (1.5 min) | Servers → Host from image (e.g. an MCP reference server image, pinned tag) → Running → its tools appear → show its NetworkPolicy and the rejected `:latest` and disallowed registry | Servers page + `kubectl -n mcp-hosted get all,netpol` |
| 20 | Upgrade and rollback (1 min) | `make upgrade-demo` | terminal |
