// Configuration from env vars (set by the Helm chart). Postgres uses the standard PG* vars.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  encryptionKey: required("ENCRYPTION_KEY"),
  // Hosted MCP servers run here.
  hostedNamespace: process.env.HOSTED_NAMESPACE ?? "mcp-hosted",
  // Where the gateway runs: the only pods allowed to call hosted servers and store MCP servers.
  gatewayNamespace: process.env.GATEWAY_NAMESPACE ?? "platform",
  gatewayPodLabel: process.env.GATEWAY_POD_LABEL ?? "gateway",
  // The store chart (copied into the image) and the values every store shares (domain, ingress, storage...).
  storeChartDir: process.env.STORE_CHART_DIR ?? "/charts/store",
  storeValuesFile: process.env.STORE_VALUES_FILE ?? "/config/store-values.yaml",
  // A store still provisioning after this long is marked failed.
  provisionTimeoutMs: Number(process.env.PROVISION_TIMEOUT_MIN ?? 15) * 60_000,
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 5_000),
  healthPort: Number(process.env.HEALTH_PORT ?? 8081),
};
