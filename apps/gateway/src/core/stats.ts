import { pool } from "../db/pool.js";

// Cluster-wide numbers for the dashboard, computed from the audit table so they
// are the same whichever gateway replica answers.

export interface ServerStats {
  server: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number | null;
  p95Ms: number | null;
  lastError: string | null;
}

export async function serverStats(hours = 24): Promise<ServerStats[]> {
  const { rows } = await pool.query<{
    server: string;
    calls: string;
    errors: string;
    avg_ms: number | null;
    p95_ms: number | null;
    last_error: string | null;
  }>(
    `SELECT COALESCE(upstream_slug, 'gateway') AS server,
            count(*) AS calls,
            count(*) FILTER (WHERE outcome NOT IN ('ok')) AS errors,
            avg(duration_ms) AS avg_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
            (array_agg(error_message ORDER BY ts DESC) FILTER (WHERE outcome NOT IN ('ok') AND error_message IS NOT NULL))[1] AS last_error
       FROM audit_events
      WHERE ts > now() - make_interval(hours => $1)
      GROUP BY 1
      ORDER BY calls DESC`,
    [hours],
  );
  return rows.map((r) => {
    const calls = Number(r.calls);
    const errors = Number(r.errors);
    return {
      server: r.server,
      calls,
      errors,
      errorRate: calls ? errors / calls : 0,
      avgMs: r.avg_ms === null ? null : Math.round(r.avg_ms),
      p95Ms: r.p95_ms === null ? null : Math.round(r.p95_ms),
      lastError: r.last_error,
    };
  });
}
