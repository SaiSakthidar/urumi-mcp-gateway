// All configuration comes from env vars (set by the Helm chart from values + Secrets).
// Postgres connection uses the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE vars,
// which the `pg` library reads on its own.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, "");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Public URL of the dashboard/gateway host, used for invite links and the MCP URL shown in the UI.
  publicUrl,
  cookieSecure: publicUrl.startsWith("https://"),
  // 32-byte key (base64) for AES-256-GCM encryption of upstream credentials.
  encryptionKey: required("ENCRYPTION_KEY"),
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@urumi.local",
  bootstrapAdminPassword: required("BOOTSTRAP_ADMIN_PASSWORD"),
  // The WooCommerce MCP server is seeded as the first upstream on boot.
  seedWooMcpUrl: process.env.SEED_WOO_MCP_URL,
  seedWooMcpToken: process.env.SEED_WOO_MCP_TOKEN,
  // Per tool call.
  upstreamCallTimeoutMs: Number(process.env.UPSTREAM_CALL_TIMEOUT_MS ?? 15_000),
  // Health poller: connect + tools/list per upstream every interval, each step bounded by the timeout.
  healthPollIntervalMs: Number(process.env.HEALTH_POLL_INTERVAL_MS ?? 5_000),
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 3_000),
  // A connected upstream is marked unreachable after this many failed checks in a row.
  healthFailThreshold: Number(process.env.HEALTH_FAIL_THRESHOLD ?? 2),
  llm: {
    baseUrl: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    apiKey: process.env.LLM_API_KEY,
  },
};
