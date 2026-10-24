# Operations: upgrades, rollbacks, backups

There are three Helm releases, one per namespace, so each layer upgrades and rolls back on its own:

| Release | Namespace | Contents |
|---|---|---|
| `store` | `store` | WordPress, MariaDB, setup Job |
| `mcp` | `mcp` | woo-mcp, server-everything |
| `platform` | `platform` | gateway, dashboard, Postgres |

## Upgrade

```bash
# New gateway version
make push REGISTRY=ghcr.io/<user> TAG=0.2.0
helm upgrade platform charts/platform -n platform -f charts/platform/values-prod.yaml \
  --set gateway.image.tag=0.2.0 --set dashboard.image.tag=0.2.0

# New WooCommerce MCP server
helm upgrade mcp charts/mcp-servers -n mcp -f charts/mcp-servers/values-prod.yaml --set wooMcp.image.tag=0.2.0

# New WordPress / WooCommerce (bump wordpress.image or setup.woocommerce.version in values first)
helm upgrade store charts/store -n store -f charts/store/values-prod.yaml --timeout 15m
```

What happens:

- **Stateless Deployments** (gateway, dashboard, woo-mcp) roll: the new pod must pass its readiness probe before the old one is removed.
- **WordPress** uses the `Recreate` strategy because its volume is ReadWriteOnce, so the storefront has a short gap.
- **The store setup Job** re-runs after every upgrade. Every step is idempotent, so it only fixes drift.
- **The gateway runs database migrations at startup.** Migrations are additive only (new tables or columns, never drop or rename in the same release). That's what keeps the previous version working against the newer schema after a rollback.

## Rollback

```bash
make history                          # helm history of all three releases
helm rollback platform 3 -n platform  # back to revision 3
```

Rollback restores the previous manifests (image tags, config). It does not touch data:

- PVCs are not part of the rollback. The WordPress PVC has `helm.sh/resource-policy: keep`, and StatefulSet volume claims are never deleted by Helm.
- Database migrations are not reverted. Additive migrations are what make this safe.

## Backups

```bash
# Store database
kubectl exec -n store mariadb-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress' > store.sql
# Gateway database (users, keys, upstreams, audit log)
kubectl exec -n platform postgres-0 -- pg_dump -U urumi urumi > gateway.sql
```

Also back up `.secrets/<env>.env`. Without `GATEWAY_ENCRYPTION_KEY`, stored upstream credentials can't be decrypted. Re-enter them in the dashboard if the key is lost.

## Rotating secrets

- **Upstream credential:** edit the server in the dashboard and paste the new value. The gateway reconnects immediately.
- **API key:** revoke it in the dashboard and generate a new one.
- **woo-mcp token / WooCommerce API key:** change the values in `.secrets/<env>.env`, run `make secrets`, then `helm upgrade` the `store` release (the setup Job syncs the WooCommerce key). Restart woo-mcp (`kubectl rollout restart deploy/woo-mcp -n mcp`), and update the `woo` server's credential in the dashboard.
