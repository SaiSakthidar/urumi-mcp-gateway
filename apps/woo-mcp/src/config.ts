// All configuration comes from env vars (set by the Helm chart from values + Secrets).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Bearer token the gateway must present (defense in depth on top of NetworkPolicy).
  mcpToken: required("MCP_TOKEN"),
  // In-cluster WordPress Service, e.g. http://wordpress.store.svc.cluster.local
  wcBaseUrl: required("WC_BASE_URL"),
  // The store's public host (its WP_HOME). Sent as the Host header and used
  // for OAuth signatures, because WordPress verifies against its home URL.
  wcPublicHost: required("WC_PUBLIC_HOST"),
  wcConsumerKey: required("WC_CONSUMER_KEY"),
  wcConsumerSecret: required("WC_CONSUMER_SECRET"),
  wcTimeoutMs: Number(process.env.WC_TIMEOUT_MS ?? 10_000),
  storeTimezone: process.env.STORE_TIMEZONE ?? "UTC",
};
