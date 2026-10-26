import { useApi } from "../api";
import type { ServerStats } from "../types";

export function MetricsPage() {
  const { data, error } = useApi<ServerStats[]>("/stats", 5000);

  return (
    <>
      <h2>Metrics</h2>
      <p className="muted">
        Tool calls per server over the last 24 hours, across every gateway replica. Prometheus can scrape the same data (plus live
        upstream status) from the gateway's <code>/metrics</code> endpoint inside the cluster.
      </p>
      {error && <p className="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Server</th>
            <th className="num">Calls</th>
            <th className="num">Errors</th>
            <th className="num">Error rate</th>
            <th className="num">Avg latency</th>
            <th className="num">p95 latency</th>
            <th>Last failure reason</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.server}>
              <td>
                <code>{s.server}</code>
              </td>
              <td className="num">{s.calls}</td>
              <td className="num">{s.errors}</td>
              <td className="num">
                <span className={`badge outcome-${s.errorRate > 0.1 ? "bad" : "ok"}`}>{(s.errorRate * 100).toFixed(1)}%</span>
              </td>
              <td className="num">{s.avgMs != null ? `${s.avgMs} ms` : "—"}</td>
              <td className="num">{s.p95Ms != null ? `${s.p95Ms} ms` : "—"}</td>
              <td className="error-text">{s.lastError}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p className="muted">No tool calls in the last 24 hours.</p>}
    </>
  );
}
