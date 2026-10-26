import { pool } from "../db/pool.js";
import { decrypt, encrypt } from "../security/crypto.js";

// Upstream MCP servers as stored in Postgres. Credentials are encrypted at rest
// and only ever decrypted into request headers inside the gateway process.

export type AuthType = "none" | "bearer" | "header";
// remote: registered by URL | hosted: deployed from an image | store: a provisioned store's MCP server
export type UpstreamKind = "remote" | "hosted" | "store";

export type UpstreamRow = {
  id: number;
  slug: string;
  display_name: string;
  url: string;
  auth_type: AuthType;
  auth_header_name: string | null;
  credential_ciphertext: Buffer | null;
  credential_iv: Buffer | null;
  enabled: boolean;
  kind: UpstreamKind;
  created_at: Date;
  updated_at: Date;
};

/** Server-side only: contains the decrypted credential in `headers`. */
export interface UpstreamConfig {
  id: number;
  slug: string;
  displayName: string;
  url: string;
  enabled: boolean;
  /** Hosted and store servers are created by the platform itself, not from an admin-typed URL. */
  kind: UpstreamKind;
  headers: Record<string, string>;
}

export interface HostedInput {
  image: string;
  port: number;
  env: Record<string, string>;
  allowInternet: boolean;
}

export interface UpstreamInput {
  slug: string;
  displayName: string;
  url: string;
  authType: AuthType;
  authHeaderName?: string | null;
  credential?: string;
  enabled: boolean;
}

/** Slug is immutable: renaming it would rename every tool clients already know. */
export type UpstreamPatch = Partial<Omit<UpstreamInput, "slug">>;

export async function listUpstreamRows(): Promise<UpstreamRow[]> {
  const { rows } = await pool.query<UpstreamRow>("SELECT * FROM upstreams ORDER BY id");
  return rows;
}

export async function findUpstreamBySlug(slug: string): Promise<UpstreamRow | undefined> {
  const { rows } = await pool.query<UpstreamRow>("SELECT * FROM upstreams WHERE slug = $1", [slug]);
  return rows[0];
}

export function toConfig(row: UpstreamRow): UpstreamConfig {
  const headers: Record<string, string> = {};
  if (row.credential_ciphertext && row.credential_iv) {
    const credential = decrypt(row.credential_ciphertext, row.credential_iv);
    if (row.auth_type === "bearer") headers.Authorization = `Bearer ${credential}`;
    if (row.auth_type === "header" && row.auth_header_name) headers[row.auth_header_name] = credential;
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    url: row.url,
    enabled: row.enabled,
    kind: row.kind,
    headers,
  };
}

export async function createUpstream(input: UpstreamInput, createdBy: number | null): Promise<number> {
  const secret = input.authType !== "none" && input.credential ? encrypt(input.credential) : null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO upstreams
       (slug, display_name, url, auth_type, auth_header_name, credential_ciphertext, credential_iv, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.slug,
      input.displayName,
      input.url,
      input.authType,
      input.authType === "header" ? input.authHeaderName : null,
      secret?.ciphertext ?? null,
      secret?.iv ?? null,
      input.enabled,
      createdBy,
    ],
  );
  return rows[0].id;
}

/**
 * The credential is write-only: an omitted or empty `credential` keeps the
 * stored one, a new value replaces it, and authType "none" clears it.
 */
export async function updateUpstream(id: number, patch: UpstreamPatch): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.displayName !== undefined) set("display_name", patch.displayName);
  if (patch.url !== undefined) set("url", patch.url);
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.authType !== undefined) {
    set("auth_type", patch.authType);
    set("auth_header_name", patch.authType === "header" ? (patch.authHeaderName ?? null) : null);
  }
  if (patch.authType === "none") {
    set("credential_ciphertext", null);
    set("credential_iv", null);
  } else if (patch.credential) {
    const { ciphertext, iv } = encrypt(patch.credential);
    set("credential_ciphertext", ciphertext);
    set("credential_iv", iv);
  }
  set("updated_at", new Date());

  values.push(id);
  const result = await pool.query(`UPDATE upstreams SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
  return result.rowCount === 1;
}

export async function deleteUpstream(id: number): Promise<boolean> {
  const result = await pool.query("DELETE FROM upstreams WHERE id = $1", [id]);
  return result.rowCount === 1;
}

/** A hosted server: the upstream row plus the desired state the provisioner reconciles. One transaction. */
export async function createHostedUpstream(
  input: { slug: string; displayName: string; url: string; hosted: HostedInput },
  createdBy: number,
): Promise<number> {
  const env = Object.keys(input.hosted.env).length ? encrypt(JSON.stringify(input.hosted.env)) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO upstreams (slug, display_name, url, auth_type, enabled, kind, created_by)
       VALUES ($1, $2, $3, 'none', true, 'hosted', $4) RETURNING id`,
      [input.slug, input.displayName, input.url, createdBy],
    );
    await client.query(
      `INSERT INTO hosted_servers (upstream_id, image, port, env_ciphertext, env_iv, allow_internet)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rows[0].id, input.hosted.image, input.hosted.port, env?.ciphertext ?? null, env?.iv ?? null, input.hosted.allowInternet],
    );
    await client.query("COMMIT");
    return rows[0].id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type HostedStatus = { image: string; port: number; status: string; status_detail: string | null; allow_internet: boolean };

export async function hostedStatusByUpstream(): Promise<Map<number, HostedStatus>> {
  const { rows } = await pool.query<HostedStatus & { upstream_id: number }>(
    "SELECT upstream_id, image, port, status, status_detail, allow_internet FROM hosted_servers",
  );
  return new Map(rows.map((r) => [r.upstream_id, r]));
}

/** Hosted servers are removed by the provisioner once their Kubernetes resources are gone. */
export async function markHostedDeleting(id: number): Promise<boolean> {
  const { rowCount } = await pool.query("UPDATE hosted_servers SET status = 'deleting', updated_at = now() WHERE upstream_id = $1", [id]);
  if (rowCount) await pool.query("UPDATE upstreams SET enabled = false, updated_at = now() WHERE id = $1", [id]);
  return rowCount === 1;
}
