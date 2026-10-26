# Demo: definition of done only

A = admin (`admin@urumi.local`). B = member, already invited.
Passwords: `ssh -i ~/.ssh/urumi-aws ubuntu@54.66.41.192 "sudo grep -E 'BOOTSTRAP_ADMIN_PASSWORD|WP_ADMIN_PASSWORD' /opt/urumi/.secrets/aws.env"`

| Link | URL |
|---|---|
| Dashboard | http://app.54.66.41.192.sslip.io |
| Servers | http://app.54.66.41.192.sslip.io/#/servers |
| Chat | http://app.54.66.41.192.sslip.io/#/chat |
| API keys | http://app.54.66.41.192.sslip.io/#/keys |
| Audit | http://app.54.66.41.192.sslip.io/#/audit |
| Storefront | http://shop.54.66.41.192.sslip.io |
| WooCommerce admin | http://shop.54.66.41.192.sslip.io/wp-admin (user `admin`) |
| MCP endpoint | http://app.54.66.41.192.sslip.io/mcp |

## Before recording

1. Tunnel and k9s (needed for the pod-kill step):
   ```bash
   ssh -i ~/.ssh/urumi-aws -f -N -L 16443:127.0.0.1:6443 -o ServerAliveInterval=30 ubuntu@54.66.41.192
   export KUBECONFIG=~/.kube/urumi-aws.yaml
   kubectl get nodes
   ```
2. Browser 1: logged in as A. Browser 2 (other profile): logged in as B.
3. Claude Code connected as B:
   ```bash
   claude mcp add --transport http urumi http://app.54.66.41.192.sslip.io/mcp \
     --header "Authorization: Bearer <B key>"
   ```
4. Servers page shows `woo` and `everything` Connected.
5. Large terminal font. No keys or passwords on screen.

## 1. Store

1. Open the storefront. Add a product to the cart.
2. Checkout, choose **Cash on delivery**, place the order.
3. Open wp-admin → WooCommerce → Orders. The order is there.

## 2. Chat agent as A

1. Open Chat (browser 1). Type: `Create a product called Demo Mug priced at 199`.
   A `woo__create_product` tool chip shows.
2. Refresh the storefront. Demo Mug is listed.
3. Buy Demo Mug by hand (Cash on delivery).
4. In Chat: `What orders came in today?`. The answer includes the Demo Mug order.

## 3. External client as B

In the terminal running Claude Code:

1. Run `/mcp`, open `urumi`, show the tools: `woo__*` and `everything__*`.
2. Ask: `What orders came in today?`. It answers.
3. Two-server prompt:
   `List today's orders from the store, then use the echo tool from the everything server to echo the number of orders.`
   One tool from `woo`, one from `everything`.

## 4. Team and control

**Disable a server**
1. Servers page (A): click **Disable** on `everything`.
2. Chat (A): ask `What tools do you have from the everything server?`. None.
3. Claude Code (B): `/mcp`, reconnect `urumi`. `everything__*` is gone, `woo__*` stays.
4. Servers page: click **Enable** on `everything`.

**Kill an upstream pod**
1. k9s: `:ns` → `mcp`, then `:deploy`. Select `everything-mcp`, press `s`, set 0.
2. Servers page: `everything` shows **Unreachable**.
3. Chat or Claude Code: `What orders came in today?`. `woo` still answers.
4. Scale `everything-mcp` back to 1.

**Revoke B's key** (last, because it ends B's session)
1. API keys page (A): find B's key (Owner column), click **Revoke**, confirm.
2. In Claude Code (B): ask `What orders came in today?` again. It is rejected.

**Audit log**
1. Open Audit. Show A's chat calls (Via = chat) and B's calls (Via = mcp).
2. Point at: the `auth_revoked` row, and the failed rows for `everything` while it was down.
3. Filter with **All users** to show A, then B.

## If something goes wrong

- Page won't load: your IP changed. Check with `curl -s https://checkip.amazonaws.com` and update `infra/terraform/terraform.tfvars`.
- k9s or kubectl refuses: the tunnel dropped. Rerun the `ssh -f -N -L` command above.
- The pod comes back too fast to see Unreachable: scale the deployment to 0 instead of deleting the pod.
- The model won't use the `everything` tool: name them: `call woo list orders, then everything echo`.
