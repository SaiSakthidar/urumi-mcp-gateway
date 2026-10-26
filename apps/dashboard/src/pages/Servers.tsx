import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";
import type { AuthType, Me, Server, ServerStatus } from "../types";

const STATUS_LABEL: Record<ServerStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  unreachable: "Unreachable",
  disabled: "Disabled",
};

export function StatusBadge({ status }: { status: ServerStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ServersPage({ me }: { me: Me }) {
  // Poll so status changes (e.g. a killed pod) show up without a refresh.
  const { data, error, reload } = useApi<Server[]>("/servers", 5000);
  const [editing, setEditing] = useState<Server | "new" | "hosted" | null>(null);
  const [actionError, setActionError] = useState<string>();
  const isAdmin = me.role === "admin";

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <>
      <div className="page-header">
        <h2>MCP servers</h2>
        {isAdmin && editing === null && (
          <div className="actions">
            <button onClick={() => setEditing("new")}>Add server</button>
            <button className="secondary" onClick={() => setEditing("hosted")}>
              Host from image
            </button>
          </div>
        )}
      </div>
      {error && <p className="alert">{error}</p>}
      {actionError && <p className="alert">{actionError}</p>}

      {editing === "hosted" && (
        <HostedForm
          onDone={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing !== null && editing !== "hosted" && (
        <ServerForm
          server={editing === "new" ? undefined : editing}
          onDone={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {data?.map((s) => (
        <div key={s.id} className="card">
          <div className="row">
            <div>
              <strong>{s.displayName}</strong> <code>{s.slug}</code> <StatusBadge status={s.status} />{" "}
              {s.kind !== "remote" && <span className={`badge badge-${s.kind}`}>{s.kind === "hosted" ? "hosted" : "store"}</span>}
              {s.url && <div className="muted mono">{s.url}</div>}
              {s.kind === "remote" && (
                <div className="muted">
                  Auth: {s.authType === "none" ? "none" : s.authType === "bearer" ? "bearer token" : `header ${s.authHeaderName}`}
                  {s.authType !== "none" && (s.hasCredential ? " (set)" : " (missing)")}
                </div>
              )}
              {s.hosted && (
                <div className="muted">
                  Image <code>{s.hosted.image}</code> · port {s.hosted.port} ·{" "}
                  <span className={`badge badge-${s.hosted.deployStatus}`}>{s.hosted.deployStatus}</span>
                  {s.hosted.allowInternet ? " · internet allowed" : " · no network access"}
                  {s.hosted.deployDetail && <div className="error-text">{s.hosted.deployDetail}</div>}
                </div>
              )}
              {s.kind === "store" && <div className="muted">Managed by the Stores page.</div>}
              {s.status === "unreachable" && s.lastError && <div className="error-text">{s.lastError}</div>}
            </div>
            {isAdmin && (
              <div className="actions">
                {s.kind === "remote" && (
                  <button className="secondary" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={() =>
                    void act(() => api(`/servers/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))
                  }
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                {s.kind !== "store" && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Remove ${s.displayName}? Its tools disappear for everyone.`)) {
                        void act(() => api(`/servers/${s.id}`, { method: "DELETE" }));
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
          <details>
            <summary>{s.tools.length} tools</summary>
            <ul className="tools">
              {s.tools.map((t) => (
                <li key={t.name}>
                  <code>{t.name}</code> <span className="muted">{t.description}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ))}
      {data?.length === 0 && <p className="muted">No servers registered yet.</p>}
    </>
  );
}

function HostedForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [image, setImage] = useState("");
  const [port, setPort] = useState("3000");
  const [env, setEnv] = useState("");
  const [allowInternet, setAllowInternet] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // One NAME=value per line.
    const vars: Record<string, string> = {};
    for (const line of env.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf("=");
      if (i <= 0) return setError(`Bad environment line: "${t}". Use NAME=value.`);
      vars[t.slice(0, i)] = t.slice(i + 1);
    }
    try {
      await api("/servers/hosted", {
        method: "POST",
        body: { slug, displayName, image, port: Number(port), env: vars, allowInternet },
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>Host an MCP server from a container image</h3>
      <p className="muted">
        The platform runs it inside the cluster, non-root and read-only, with its own Secret, resource limits and a NetworkPolicy
        that only lets the gateway reach it. It must serve MCP over Streamable HTTP at <code>/mcp</code>.
      </p>
      {error && <p className="alert">{error}</p>}
      <label>
        Slug (tool prefix, can't be changed later)
        <input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9-]{1,16}" placeholder="fetch" required />
      </label>
      <label>
        Name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Fetch" required />
      </label>
      <label>
        Image (pinned tag or digest, no "latest")
        <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/org/server:1.2.3" required />
      </label>
      <label>
        Port the server listens on (1024 or higher)
        <input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
      </label>
      <label>
        Environment variables (one NAME=value per line, stored encrypted)
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder="API_TOKEN=..." autoComplete="off" />
      </label>
      <label className="check">
        <input type="checkbox" checked={allowInternet} onChange={(e) => setAllowInternet(e.target.checked)} /> Allow outbound internet
        (HTTPS/HTTP to public addresses only)
      </label>
      <div className="actions">
        <button type="submit">Deploy</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ServerForm({ server, onDone, onCancel }: { server?: Server; onDone: () => void; onCancel: () => void }) {
  const [slug, setSlug] = useState(server?.slug ?? "");
  const [displayName, setDisplayName] = useState(server?.displayName ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? "none");
  const [authHeaderName, setAuthHeaderName] = useState(server?.authHeaderName ?? "");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      displayName,
      url,
      authType,
      authHeaderName: authType === "header" ? authHeaderName : null,
      // Write-only: an empty field keeps the stored credential.
      ...(credential ? { credential } : {}),
    };
    try {
      if (server) await api(`/servers/${server.id}`, { method: "PATCH", body });
      else await api("/servers", { method: "POST", body: { ...body, slug } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>{server ? `Edit ${server.displayName}` : "Add MCP server"}</h3>
      {error && <p className="alert">{error}</p>}
      <label>
        Slug (tool prefix, can't be changed later)
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={!!server}
          pattern="[a-z0-9-]{1,16}"
          placeholder="github"
          required
        />
      </label>
      <label>
        Name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="GitHub" required />
      </label>
      <label>
        URL (Streamable HTTP endpoint)
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" required />
      </label>
      <label>
        Authentication
        <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      {authType === "header" && (
        <label>
          Header name
          <input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="X-API-Key" required />
        </label>
      )}
      {authType !== "none" && (
        <label>
          Credential
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={server?.hasCredential ? "Leave blank to keep the current one" : ""}
            autoComplete="off"
          />
        </label>
      )}
      <p className="muted">Credentials are encrypted on the server and never shown again.</p>
      <div className="actions">
        <button type="submit">{server ? "Save" : "Add server"}</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
