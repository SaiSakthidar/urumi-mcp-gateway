import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";
import type { ApiKey, Me } from "../types";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

export function KeysPage({ me }: { me: Me }) {
  const info = useApi<{ mcpUrl: string }>("/info");
  const mine = useApi<ApiKey[]>("/keys");
  const all = useApi<ApiKey[]>(me.role === "admin" ? "/keys?all=true" : null);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string>();
  const [error, setError] = useState<string>();

  const reloadAll = () => {
    mine.reload();
    all.reload();
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ key: string }>("/keys", { method: "POST", body: { name } });
      setNewKey(res.key);
      setName("");
      reloadAll();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!confirm(`Revoke key "${key.name}" (${key.prefix})? Clients using it stop working immediately.`)) return;
    try {
      await api(`/keys/${key.id}`, { method: "DELETE" });
      reloadAll();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const mcpUrl = info.data?.mcpUrl ?? "…";
  const keyForSnippet = newKey ?? "<your-api-key>";

  return (
    <>
      <h2>API keys</h2>
      {error && <p className="alert">{error}</p>}

      <form className="card inline-form" onSubmit={(e) => void create(e)}>
        <input placeholder="Key name, e.g. laptop-claude-code" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Generate key</button>
      </form>

      {newKey && (
        <div className="card secret">
          <p>Copy your key now. It is shown only once.</p>
          <code className="mono">{newKey}</code>
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(newKey)}>
            Copy
          </button>
        </div>
      )}

      <div className="card">
        <h3>Connect an MCP client</h3>
        <p className="muted">One URL and your key give you the tools of every enabled server.</p>
        <p>Claude Code:</p>
        <pre>{`claude mcp add --transport http urumi ${mcpUrl} \\\n  --header "Authorization: Bearer ${keyForSnippet}"`}</pre>
        <p>Cursor (~/.cursor/mcp.json):</p>
        <pre>
          {JSON.stringify(
            { mcpServers: { urumi: { url: mcpUrl, headers: { Authorization: `Bearer ${keyForSnippet}` } } } },
            null,
            2,
          )}
        </pre>
        <p>No key needed with OAuth: clients that support it (Claude Code, MCP Inspector) open a browser login.</p>
        <pre>{`claude mcp add --transport http urumi ${mcpUrl}\n# then run /mcp in Claude Code and choose "Authenticate"`}</pre>
        <p className="muted">
          Many tools? Add <code>?tools=search</code> to the URL: the client then sees only <code>search_tools</code> and{" "}
          <code>run_tool</code>, and finds the real tools by keyword.
        </p>
      </div>

      <h3>My keys</h3>
      <KeyTable keys={mine.data} onRevoke={(k) => void revoke(k)} showOwner={false} />

      {me.role === "admin" && (
        <>
          <h3>All keys (admin)</h3>
          <KeyTable keys={all.data} onRevoke={(k) => void revoke(k)} showOwner />
        </>
      )}
    </>
  );
}

function KeyTable({ keys, onRevoke, showOwner }: { keys?: ApiKey[]; onRevoke: (k: ApiKey) => void; showOwner: boolean }) {
  if (!keys?.length) return <p className="muted">No keys.</p>;
  return (
    <table>
      <thead>
        <tr>
          {showOwner && <th>Owner</th>}
          <th>Name</th>
          <th>Key</th>
          <th>Created</th>
          <th>Last used</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} className={k.revoked_at ? "revoked" : ""}>
            {showOwner && <td>{k.user_email}</td>}
            <td>{k.name}</td>
            <td className="mono">urumi_{k.prefix}_…</td>
            <td>{formatDate(k.created_at)}</td>
            <td>{formatDate(k.last_used_at)}</td>
            <td>{k.revoked_at ? `revoked ${formatDate(k.revoked_at)}` : "active"}</td>
            <td>
              {!k.revoked_at && (
                <button className="danger" onClick={() => onRevoke(k)}>
                  Revoke
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
