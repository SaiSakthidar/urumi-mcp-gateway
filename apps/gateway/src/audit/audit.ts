import { pool } from "../db/pool.js";

export type Outcome =
  | "ok"
  | "tool_error"
  | "timeout"
  | "unreachable"
  | "disabled"
  | "not_found"
  | "error"
  | "denied"
  | "auth_revoked"
  | "rate_limited";

export interface AuditEvent {
  userId: number | null;
  source: "mcp" | "chat";
  apiKeyId?: number | null;
  upstreamSlug?: string | null;
  toolName?: string | null;
  durationMs?: number | null;
  outcome: Outcome;
  errorMessage?: string | null;
}

/** Never throws: a broken audit write is logged but must not fail the tool call. */
export async function recordAudit(e: AuditEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_events
         (user_id, source, api_key_id, upstream_slug, tool_name, duration_ms, outcome, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.userId,
        e.source,
        e.apiKeyId ?? null,
        e.upstreamSlug ?? null,
        e.toolName ?? null,
        e.durationMs ?? null,
        e.outcome,
        e.errorMessage?.slice(0, 1000) ?? null,
      ],
    );
  } catch (err) {
    console.error("failed to write audit event", e, err);
  }
}

export interface AuditFilters {
  userId?: number;
  upstreamSlug?: string;
  outcome?: string;
  limit: number;
}

export type AuditRow = {
  id: number;
  ts: Date;
  user_id: number | null;
  user_email: string | null;
  source: string;
  api_key_prefix: string | null;
  upstream_slug: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  outcome: string;
  error_message: string | null;
};

export async function listAudit(filters: AuditFilters): Promise<AuditRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (filters.userId !== undefined) add("a.user_id = ?", filters.userId);
  if (filters.upstreamSlug) add("a.upstream_slug = ?", filters.upstreamSlug);
  if (filters.outcome) add("a.outcome = ?", filters.outcome);
  values.push(filters.limit);

  const { rows } = await pool.query<AuditRow>(
    `SELECT a.id, a.ts, a.user_id, u.email AS user_email, a.source, k.prefix AS api_key_prefix,
            a.upstream_slug, a.tool_name, a.duration_ms, a.outcome, a.error_message
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN api_keys k ON k.id = a.api_key_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.ts DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}
