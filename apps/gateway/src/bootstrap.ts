import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { hashPassword } from "./security/crypto.js";
import { createUpstream, findUpstreamBySlug } from "./upstreams/registry.js";

// First-boot state: one admin user, and the WooCommerce MCP server already
// registered as the first upstream. Both steps are skipped once they exist.

export async function bootstrap(): Promise<void> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (rows[0].n === 0) {
    await pool.query(
      `INSERT INTO users (email, role, status, password_hash) VALUES ($1, 'admin', 'active', $2)`,
      [config.bootstrapAdminEmail.toLowerCase(), await hashPassword(config.bootstrapAdminPassword)],
    );
    console.log(`created bootstrap admin ${config.bootstrapAdminEmail}`);
  }

  if (config.seedWooMcpUrl && !(await findUpstreamBySlug("woo"))) {
    await createUpstream(
      {
        slug: "woo",
        displayName: "WooCommerce",
        url: config.seedWooMcpUrl,
        authType: config.seedWooMcpToken ? "bearer" : "none",
        credential: config.seedWooMcpToken,
        enabled: true,
      },
      null,
    );
    console.log("registered WooCommerce MCP server as upstream 'woo'");
  }
}
