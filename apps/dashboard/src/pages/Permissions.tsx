import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";
import type { Server, ToolRule } from "../types";

export function PermissionsPage() {
  const rules = useApi<ToolRule[]>("/permissions");
  const servers = useApi<Server[]>("/servers");
  const [upstreamSlug, setUpstreamSlug] = useState("*");
  const [toolPattern, setToolPattern] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("deny");
  const [error, setError] = useState<string>();

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      rules.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("/permissions", { method: "POST", body: { upstreamSlug, toolPattern, effect } });
      setToolPattern("");
    });
  };

  return (
    <>
      <h2>Tool permissions</h2>
      <p className="muted">
        Rules apply to <b>members</b>; admins can always use every tool. Everything is allowed by default, and the last
        matching rule wins. Denied tools are hidden from the tool list and rejected if called directly, for MCP clients and
        the chat agent alike.
      </p>
      {(rules.error ?? error) && <p className="alert">{rules.error ?? error}</p>}

      <form className="card inline-form" onSubmit={add}>
        <select value={upstreamSlug} onChange={(e) => setUpstreamSlug(e.target.value)}>
          <option value="*">Any server</option>
          {servers.data?.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.displayName} ({s.slug})
            </option>
          ))}
        </select>
        <input
          value={toolPattern}
          onChange={(e) => setToolPattern(e.target.value)}
          placeholder='Tool name or pattern, e.g. create_* or "*"'
          required
        />
        <select value={effect} onChange={(e) => setEffect(e.target.value as "allow" | "deny")}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </select>
        <button type="submit">Add rule</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Role</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Effect</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.data?.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.role}</td>
              <td>{r.upstream_slug}</td>
              <td className="mono">{r.tool_pattern}</td>
              <td>
                <span className={`badge outcome-${r.effect === "allow" ? "ok" : "bad"}`}>{r.effect}</span>
              </td>
              <td>
                <button className="danger" onClick={() => void act(() => api(`/permissions/${r.id}`, { method: "DELETE" }))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rules.data?.length === 0 && <p className="muted">No rules: members can use every tool.</p>}
    </>
  );
}
