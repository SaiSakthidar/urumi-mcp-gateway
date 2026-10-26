import { upstreams } from "../upstreams/manager.js";

// Prometheus metrics, hand-rolled (no dependency). Counters are per replica, as
// Prometheus expects; it sums them across pods. The dashboard's numbers come
// from the audit table instead (core/stats.ts), so they are cluster-wide.

const BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 15000];

interface Series {
  byOutcome: Map<string, number>;
  buckets: number[];
  sumMs: number;
  count: number;
}

const series = new Map<string, Series>();
let rateLimited = 0;

function seriesFor(server: string): Series {
  let s = series.get(server);
  if (!s) {
    s = { byOutcome: new Map(), buckets: BUCKETS_MS.map(() => 0), sumMs: 0, count: 0 };
    series.set(server, s);
  }
  return s;
}

/** Called once per tool call from core/router.ts. `server` is "gateway" for calls that never reached one. */
export function observeToolCall(server: string, outcome: string, durationMs: number): void {
  const s = seriesFor(server);
  s.byOutcome.set(outcome, (s.byOutcome.get(outcome) ?? 0) + 1);
  s.count += 1;
  s.sumMs += durationMs;
  BUCKETS_MS.forEach((le, i) => {
    if (durationMs <= le) s.buckets[i] += 1;
  });
  if (outcome === "rate_limited") rateLimited += 1;
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderMetrics(): string {
  const out: string[] = [];
  out.push("# HELP urumi_tool_calls_total Tool calls by server and outcome.", "# TYPE urumi_tool_calls_total counter");
  for (const [server, s] of series) {
    for (const [outcome, n] of s.byOutcome) {
      out.push(`urumi_tool_calls_total{server="${esc(server)}",outcome="${esc(outcome)}"} ${n}`);
    }
  }
  out.push(
    "# HELP urumi_tool_call_duration_ms Tool call latency in milliseconds.",
    "# TYPE urumi_tool_call_duration_ms histogram",
  );
  for (const [server, s] of series) {
    BUCKETS_MS.forEach((le, i) => out.push(`urumi_tool_call_duration_ms_bucket{server="${esc(server)}",le="${le}"} ${s.buckets[i]}`));
    out.push(`urumi_tool_call_duration_ms_bucket{server="${esc(server)}",le="+Inf"} ${s.count}`);
    out.push(`urumi_tool_call_duration_ms_sum{server="${esc(server)}"} ${s.sumMs}`);
    out.push(`urumi_tool_call_duration_ms_count{server="${esc(server)}"} ${s.count}`);
  }
  out.push("# HELP urumi_rate_limited_total Calls rejected by the rate limiter.", "# TYPE urumi_rate_limited_total counter");
  out.push(`urumi_rate_limited_total ${rateLimited}`);

  out.push("# HELP urumi_upstream_up 1 when the upstream is connected.", "# TYPE urumi_upstream_up gauge");
  for (const u of upstreams.all()) {
    out.push(`urumi_upstream_up{server="${esc(u.config.slug)}",status="${u.status}"} ${u.status === "connected" ? 1 : 0}`);
  }
  out.push("# HELP urumi_upstream_tools Tools exposed by each upstream.", "# TYPE urumi_upstream_tools gauge");
  for (const u of upstreams.all()) {
    out.push(`urumi_upstream_tools{server="${esc(u.config.slug)}"} ${u.tools.length}`);
  }
  return out.join("\n") + "\n";
}
