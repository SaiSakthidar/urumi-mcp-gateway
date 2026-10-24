import { useState } from "react";
import { useApi } from "../api";
import type { AuditRow, Me, Member, Server } from "../types";

const OUTCOMES = ["ok", "tool_error", "timeout", "unreachable", "disabled", "not_found", "error", "denied", "auth_revoked"];

export function AuditPage({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  const [userId, setUserId] = useState("");
  const [server, setServer] = useState("");
  const [outcome, setOutcome] = useState("");

  const params = new URLSearchParams();
  if (userId) params.set("userId", userId);
  if (server) params.set("server", server);
  if (outcome) params.set("outcome", outcome);

  const { data, error } = useApi<AuditRow[]>(`/audit?${params.toString()}`, 5000);
  const members = useApi<Member[]>(isAdmin ? "/members" : null);
  const servers = useApi<Server[]>("/servers");

  return (
    <>
      <h2>Audit log</h2>
      <p className="muted">
        {isAdmin ? "Every tool call by every user" : "Your tool calls"}, from MCP clients and the chat agent. Refreshes every 5
        seconds.
      </p>
      {error && <p className="alert">{error}</p>}

      <div className="inline-form">
        {isAdmin && (
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All users</option>
            {members.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.email}
              </option>
            ))}
          </select>
        )}
        <select value={server} onChange={(e) => setServer(e.target.value)}>
          <option value="">All servers</option>
          {servers.data?.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.displayName}
            </option>
          ))}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Via</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Duration</th>
            <th>Outcome</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.user_email ?? "—"}</td>
              <td>
                {r.source}
                {r.api_key_prefix && <span className="muted mono"> {r.api_key_prefix}</span>}
              </td>
              <td>{r.upstream_slug ?? "—"}</td>
              <td className="mono">{r.tool_name ?? "—"}</td>
              <td>{r.duration_ms != null ? `${r.duration_ms} ms` : "—"}</td>
              <td>
                <span className={`badge outcome-${r.outcome === "ok" ? "ok" : "bad"}`}>{r.outcome}</span>
              </td>
              <td className="error-text">{r.error_message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p className="muted">No tool calls yet.</p>}
    </>
  );
}
