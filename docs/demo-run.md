# Demo run sheet (minimal, about 12 minutes, AWS)

Admin (user A): `admin@urumi.local`. Member (user B) is already invited and has a key.
Passwords live in `/opt/urumi/.secrets/aws.env` on the server. Keep that file off screen.

| What | URL |
|---|---|
| Dashboard | http://app.54.66.41.192.sslip.io |
| Storefront | http://shop.54.66.41.192.sslip.io |
| WooCommerce admin | http://shop.54.66.41.192.sslip.io/wp-admin (`WP_ADMIN_PASSWORD` in `aws.env`) |

## Before you press record

1. Tunnel up and k9s working:
   ```bash
   ssh -i ~/.ssh/urumi-aws -f -N -L 16443:127.0.0.1:6443 ubuntu@54.66.41.192
   export KUBECONFIG=~/.kube/urumi-aws.yaml
   kubectl get nodes
   ```
2. Browser 1 is logged in as A; browser 2 (another profile) is logged in as B.
3. Claude Code has B's key registered:
   ```bash
   claude mcp add --transport http urumi http://app.54.66.41.192.sslip.io/mcp \
     --header "Authorization: Bearer <B key>"
   ```
4. Open in tabs: the storefront, Chat, Servers, Audit. In the editor: `design-and-tradeoffs.md`, `core/router.ts`, `chat/agent.ts`.
5. Terminal font large. Close anything showing keys or `.secrets`.

## 1. Architecture (1.5 min)

Open `docs/design-and-tradeoffs.md` and the diagram. Say:

- Dashboard (React) and gateway (Node) in `platform`. Postgres holds users, hashed keys, encrypted upstream credentials, audit and desired state.
- The gateway is stateless. It speaks MCP over HTTP to upstreams: woo-mcp (in `mcp`), the everything server, and GitHub.
- A separate **provisioner** is the only pod with Kubernetes API access. The gateway only writes desired state to Postgres.
- Open `apps/gateway/src/core/router.ts`: every call, from chat or from Claude Code, goes through `callTool()`, which does routing, permissions, rate limit, timeout and audit in one place.

## 2. Kubernetes tour (2 min)

In k9s (`KUBECONFIG=~/.kube/urumi-aws.yaml k9s`):

1. `:ns`. Say: `store` (WordPress and MariaDB), `mcp` (woo-mcp, everything), `platform` (gateway, dashboard, Postgres, provisioner).
2. `:pvc`. Say: MariaDB, WordPress and Postgres have volumes (`local-path` on k3s).
3. `:secret`, namespace `platform`. Say: names only, never values. Passwords, the encryption key and tokens are Kubernetes Secrets created by script, not in Git.
4. `:ingress`. Say: only two hosts are public, `app.*` and `shop.*`, through Traefik.
5. `:pods` in `mcp`, select woo-mcp, press `d`. Point at Limits, Requests, Liveness and Readiness.
6. `:netpol`. Say: default-deny in every namespace; woo-mcp accepts traffic only from the gateway; MariaDB only from WordPress and the store-setup job.

Isolation proof (terminal):
```bash
kubectl run tmp -n default --rm -it --restart=Never --image=curlimages/curl -- \
  curl -m 5 http://woo-mcp.mcp.svc.cluster.local:3000/healthz
```
It times out. Say: the policy is enforced by the network layer, not just hidden.

## 3. Definition-of-done flow, two users (3 min)

1. **Order.** Storefront, add a product to the cart, checkout with Cash on delivery. In wp-admin, WooCommerce → Orders shows it.
2. **Servers page (A).** `woo`, `everything` and `github` show connected. Click Edit on one: the credential field is write-only.
3. **Chat as A.** "Create a product called Demo Mug priced at 199". A tool chip `woo__create_product` appears. Refresh the storefront to see it. Then ask: "What orders came in today?"
4. **Claude Code as B.** Run `/mcp` to show the tools. Ask: "What orders came in today?". It answers.
5. **Denial.** As B: "Create a product called Test Mug priced at 50". It is denied. Say: B's role has no `create_product` permission, and the tool is hidden from B's list and rejected on call.
6. **Cross-server (optional).** As B: "Summarize today's orders and open a GitHub issue in <you>/urumi-demo with that summary". Open the issue.

## 4. Chat agent (1 min)

Open `apps/gateway/src/chat/agent.ts`. Say:

- The browser sends a message with A's session cookie. The agent builds the tool list from the tools **A** is allowed to use.
- Loop: the model proposes a tool call, the gateway runs it through `callTool()` as A, the result goes back to the model, repeat until the model answers.
- It acts as the logged-in user, not a service account. Open Audit to show the chat calls attributed to A.

## 5. Failures: collision, dead upstream, timeout (1.5 min)

- **Collision.** Servers → Add server, slug `woo2`, same woo URL and token. Both `woo__list_orders` and `woo2__list_orders` exist. Delete `woo2` afterwards. Say: tools are namespaced `<slug>__<tool>`, so collisions can't happen.
- **Dead upstream.** In k9s `:deploy`, namespace `mcp`, select `everything-mcp`, press `s`, set 0. The Servers page shows it Unreachable. In chat, a woo question still works. Scale it back to 1. Say: a health poller marks it down; a dead upstream never blocks the others.
- **Timeout.** The audit log has no `timeout` rows yet, so make one live. The upstream call limit is 15 s. In Claude Code as B: "Use the everything server's long-running operation tool with a duration of 40 seconds." It returns a timeout error after about 15 s, and `woo` still answers right after. In Audit, a `timeout` row appears. (Do this once in your dry run so you know the exact tool name.)

## 6. Security (1.5 min)

1. Audit page: A's chat calls, B's `denied` row. Filter by user.
2. Database proof (terminal):
   ```bash
   kubectl -n platform exec postgres-0 -- psql -U urumi -d urumi -c \
     "select prefix, left(key_hash,12) as hash from api_keys limit 3;"
   ```
   Say: keys are stored as SHA-256 hashes, so the database never holds a usable key. Keys are random 256-bit strings, so a fast hash is fine.
3. Say: upstream credentials are AES-256-GCM encrypted in Postgres, decrypted only inside the gateway when it calls the upstream, never sent to the browser or to clients.
4. **Malicious server.** Servers → Add server with URL `http://169.254.169.254/`. It is rejected. Try `http://postgres.platform.svc:5432`: rejected. Say: SSRF guard at save and at connect, no redirects, plus an egress NetworkPolicy.
5. Say, from `docs/threat-model.md`: a hostile server can write tool descriptions that manipulate the model; mitigations are permissions, the audit log, and that members never see credentials.
6. Say what a member can do: use allowed tools, make their own keys, see their own audit. Cannot: add servers, see credentials, see other users' keys, change permissions.

## 7. Local to VPS, upgrade, rollback (1.5 min)

```bash
diff charts/platform/values-local.yaml charts/platform/values-prod.yaml
```
Say what changes: domain (`127.0.0.1.sslip.io` vs the real host), TLS (cert-manager issuer), StorageClass, replicas and resources, and Secrets (created by script from `.secrets/<env>.env`, not in Git). Mention that Terraform builds the server and Ansible installs k3s and runs Helm (`infra/`).

Upgrade and rollback (platform release, same chart):
```bash
helm history platform -n platform
helm upgrade platform charts/platform -n platform --reuse-values --set gateway.rateLimitPerMinute=240
kubectl -n platform rollout status deploy/gateway
helm history platform -n platform
helm rollback platform <previous revision> -n platform --wait
helm history platform -n platform
```
Say: three independent releases (`store`, `mcp`, `platform`); rollback restores manifests only, so Postgres and store volumes are untouched; migrations are additive so an older gateway still runs.

## If you have 30 seconds extra

Revoke B's key on the Keys page, then B's next call is rejected (`auth_revoked` in Audit).

## Questions to answer out loud

- How does a tool call travel from Claude Code to MariaDB and back? Client → `/mcp` with key → hash lookup → `callTool()` (permissions, rate limit) → upstream woo-mcp with its own token → WooCommerce REST → MariaDB, then the reverse, with an audit row.
- Why aren't client tokens forwarded? A client token would give an upstream power over the client's identity, and one compromised upstream could replay it elsewhere. Upstreams only ever see the gateway's own credential.
- What if an admin adds a malicious server? SSRF guard, no credential leakage to clients, descriptions treated as untrusted, everything audited.
- What changes between kind and k3s? Values only: domain, scheme, StorageClass, ingress namespace, resources.
