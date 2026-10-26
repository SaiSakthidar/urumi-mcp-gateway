import { config } from "../config.js";
import { pool } from "../db/pool.js";
import type { Principal } from "../auth/principal.js";

// Fixed one-minute windows, counted in Postgres so the limit is shared by every
// gateway replica. Limits apply per API key (external clients) or per user
// (chat), through the same callTool() choke point as everything else.

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number; limit: number };

export async function checkRateLimit(principal: Principal): Promise<RateLimitResult> {
  const limit = config.rateLimitPerMinute;
  if (limit <= 0) return { ok: true };

  const bucket = principal.apiKeyId ? `key:${principal.apiKeyId}` : `user:${principal.userId}`;
  try {
    const { rows } = await pool.query<{ count: number; retry: number }>(
      `INSERT INTO rate_limit_counters (bucket, window_start, count)
       VALUES ($1, date_trunc('minute', now()), 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count, ceil(60 - extract(epoch FROM (now() - window_start)))::int AS retry`,
      [bucket],
    );
    const { count, retry } = rows[0];
    return count > limit ? { ok: false, retryAfterSec: Math.max(1, retry), limit } : { ok: true };
  } catch (err) {
    // A broken limiter must not take every tool call down with it.
    console.error("rate limit check failed, allowing the call", err);
    return { ok: true };
  }
}

export async function pruneRateLimitCounters(): Promise<void> {
  await pool.query("DELETE FROM rate_limit_counters WHERE window_start < now() - interval '10 minutes'");
}
