import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { pool } from "./db.js";
import { helm, releaseStatus } from "./helm.js";
import { bindStoreAdmin, createIfMissing, get, paths, remove, upsert, type Obj } from "./k8s.js";
import { writeFile, unlink } from "node:fs/promises";

// Store provisioning: one namespace per store, containing its own WordPress +
// MariaDB, its own WooCommerce MCP server, its own Secrets, volumes and Ingress host,
// all installed from the same Helm chart as the main store.
//
// Reconciled from the stores table:
//   provisioning -> namespace + Secrets + RBAC + helm install, then register the store's MCP server
//                   in the gateway's registry and mark ready (or failed, with the reason)
//   deleting     -> unregister, helm uninstall, delete the namespace (which removes volumes and Secrets),
//                   then delete the row
// Every step is idempotent, so a restart at any point just resumes: re-creating a store that
// is half-built converges instead of failing, and Secrets are only generated once.

const RELEASE = "store";
const rand = (bytes = 18) => randomBytes(bytes).toString("hex");

interface StoreRow {
  id: number;
  slug: string;
  name: string;
  namespace: string;
  status: "provisioning" | "deleting";
  created_at: Date;
}

const inFlight = new Set<number>();

async function setStatus(id: number, status: string, detail: string | null): Promise<void> {
  await pool.query("UPDATE stores SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1", [id, status, detail]);
}

async function ensureNamespace(row: StoreRow): Promise<void> {
  await upsert(paths.namespaces, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: row.namespace,
      labels: {
        "app.kubernetes.io/part-of": "urumi",
        "urumi.io/store": row.slug,
        "urumi.io/mcp-network": "true", // the gateway's egress policy selects namespaces with this label
        "pod-security.kubernetes.io/enforce": "baseline",
      },
    },
  });
  // The ResourceQuota and LimitRange guardrails come with the store chart. Here we bind RBAC:
  // helm runs with the permissions of one namespaced role in this namespace and nowhere else.
  await bindStoreAdmin(row.namespace);
}

/** Generated once per store and never overwritten: changing them would lock WordPress out of its own database. */
async function ensureSecrets(row: StoreRow): Promise<{ mcpToken: string }> {
  const ns = row.namespace;
  const secret = (name: string, data: Record<string, string>): Obj => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace: ns, labels: { "app.kubernetes.io/part-of": "urumi" } },
    type: "Opaque",
    stringData: data,
  });
  const consumerKey = `ck_${rand(20)}`;
  const consumerSecret = `cs_${rand(20)}`;
  const mcpToken = rand(24);

  await createIfMissing(paths.secrets(ns), secret("store-db", { "root-password": rand(), password: rand() }));
  await createIfMissing(paths.secrets(ns), secret("store-admin", { "admin-password": rand() }));
  await createIfMissing(paths.secrets(ns), secret("store-wc-api", { "consumer-key": consumerKey, "consumer-secret": consumerSecret }));
  // The woo-mcp secret holds the same WooCommerce key plus the bearer token the gateway sends.
  // If it already exists, read the token back instead of inventing a new one.
  const created = await createIfMissing(
    paths.secrets(ns),
    secret("woo-mcp", { "wc-consumer-key": consumerKey, "wc-consumer-secret": consumerSecret, "mcp-token": mcpToken }),
  );
  if (created) return { mcpToken };
  const existing = await get(`${paths.secrets(ns)}/woo-mcp`);
  const token = existing?.data?.["mcp-token"] as string | undefined;
  if (!token) throw new Error("woo-mcp secret exists without an mcp-token");
  return { mcpToken: Buffer.from(token, "base64").toString("utf8") };
}

async function registerUpstream(row: StoreRow, mcpToken: string): Promise<void> {
  const enc = encrypt(mcpToken);
  await pool.query(
    `INSERT INTO upstreams (slug, display_name, url, auth_type, credential_ciphertext, credential_iv, enabled, kind)
     VALUES ($1, $2, $3, 'bearer', $4, $5, true, 'store')
     ON CONFLICT (slug) DO UPDATE
       SET display_name = EXCLUDED.display_name, url = EXCLUDED.url, auth_type = 'bearer',
           credential_ciphertext = EXCLUDED.credential_ciphertext, credential_iv = EXCLUDED.credential_iv,
           enabled = true, updated_at = now()
     WHERE upstreams.kind = 'store'`,
    [row.slug, row.name, `http://woo-mcp.${row.namespace}.svc.cluster.local:3000/mcp`, enc.ciphertext, enc.iv],
  );
}

async function provision(row: StoreRow): Promise<void> {
  const elapsed = Date.now() - row.created_at.getTime();
  if (elapsed > config.provisionTimeoutMs) {
    await setStatus(row.id, "failed", `Provisioning timed out after ${Math.round(config.provisionTimeoutMs / 60000)} minutes`);
    return;
  }

  await ensureNamespace(row);
  const { mcpToken } = await ensureSecrets(row);

  // A release left "pending-*" by a restart mid-install blocks every later helm call; clear it.
  const status = await releaseStatus(RELEASE, row.namespace);
  if (status?.startsWith("pending")) {
    await helm(["uninstall", RELEASE, "-n", row.namespace, "--no-hooks", "--wait"], 120_000);
  }

  // Per-store values go in a file, so the store name can contain any character.
  const valuesPath = `/tmp/store-${row.slug}.json`;
  await writeFile(
    valuesPath,
    JSON.stringify({
      hostPrefix: `shop-${row.slug}`,
      wordpress: { siteTitle: row.name },
      wooMcp: { enabled: true },
    }),
  );
  try {
    const remaining = Math.max(60_000, config.provisionTimeoutMs - elapsed);
    const r = await helm(
      [
        "upgrade", "--install", RELEASE, config.storeChartDir,
        "-n", row.namespace,
        "-f", config.storeValuesFile,
        "-f", valuesPath,
        "--wait", "--timeout", `${Math.ceil(remaining / 1000)}s`,
      ],
      remaining + 30_000,
    );
    if (!r.ok) {
      await setStatus(row.id, "failed", `helm install failed: ${r.output.slice(-400)}`);
      return;
    }
  } finally {
    await unlink(valuesPath).catch(() => undefined);
  }

  await registerUpstream(row, mcpToken);
  await setStatus(row.id, "ready", null);
  console.log(`store ${row.slug}: ready`);
}

async function destroy(row: StoreRow): Promise<void> {
  // Unregister first so no new tool call can reach a store that is going away.
  await pool.query("DELETE FROM upstreams WHERE slug = $1 AND kind = 'store'", [row.slug]);

  const ns = await get(`${paths.namespaces}/${row.namespace}`);
  if (!ns) {
    await pool.query("DELETE FROM stores WHERE id = $1", [row.id]);
    console.log(`store ${row.slug}: removed`);
    return;
  }
  // Safety: only ever delete namespaces this component created for a store.
  if (ns.metadata?.labels?.["urumi.io/store"] !== row.slug) {
    await setStatus(row.id, "failed", `Refusing to delete namespace ${row.namespace}: it is not labelled as this store's`);
    return;
  }
  if (!ns.metadata?.deletionTimestamp) {
    await helm(["uninstall", RELEASE, "-n", row.namespace, "--no-hooks"], 120_000); // best effort; the namespace delete is the real cleanup
    await remove(`${paths.namespaces}/${row.namespace}`);
  }
  // Namespace deletion is asynchronous; later ticks see it gone and finish.
}

/** Errors that usually clear up on their own: API hiccups, a permission still propagating, a busy node. */
function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\((403|409|429|500|502|503|504)\)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|timed out waiting/i.test(message);
}

async function run(row: StoreRow): Promise<void> {
  try {
    if (row.status === "deleting") await destroy(row);
    else await provision(row);
  } catch (err) {
    console.error(`store ${row.slug}: ${row.status} failed`, err);
    if (row.status !== "provisioning") return; // a failed delete is retried on the next tick
    // A transient error while there is still time is retried on the next tick (provision() is idempotent
    // and fails the store itself once the provisioning timeout passes). Anything else is reported to the user now.
    const withinTime = Date.now() - row.created_at.getTime() < config.provisionTimeoutMs;
    if (isTransient(err) && withinTime) return;
    await setStatus(row.id, "failed", err instanceof Error ? err.message.slice(0, 500) : "unknown error");
  }
}

export async function reconcileStores(): Promise<void> {
  const { rows } = await pool.query<StoreRow>(
    "SELECT id, slug, name, namespace, status, created_at FROM stores WHERE status IN ('provisioning', 'deleting')",
  );
  for (const row of rows) {
    if (inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    // Not awaited: several stores provision at the same time, one slow install never blocks the others.
    void run(row).finally(() => inFlight.delete(row.id));
  }
}
