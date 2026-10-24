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
  // Public host of the store; sent as Host header so WordPress doesn't redirect.
  wcHostHeader: process.env.WC_HOST_HEADER,
  wcConsumerKey: required("WC_CONSUMER_KEY"),
  wcConsumerSecret: required("WC_CONSUMER_SECRET"),
  storeTimezone: process.env.STORE_TIMEZONE ?? "UTC",
};
