import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";
import type { Store, StoreStatus } from "../types";

const LABEL: Record<StoreStatus, string> = {
  provisioning: "Provisioning",
  ready: "Ready",
  failed: "Failed",
  deleting: "Deleting",
};

export function StoresPage() {
  // Poll: provisioning takes a couple of minutes and several stores can be in flight.
  const { data, error, reload } = useApi<Store[]>("/stores", 4000);
  const [name, setName] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await act(async () => {
      await api("/stores", { method: "POST", body: { name } });
      setName("");
    });
    setBusy(false);
  };

  return (
    <>
      <h2>Stores</h2>
      <p className="muted">
        Each store is its own WooCommerce in its own namespace, with its own database, Secrets and volumes, and its own MCP server
        registered in the gateway automatically. Its tools are prefixed with the store's id (for example <code>acme__list_orders</code>),
        so you can ask the chat agent to compare stores.
      </p>
      {error && <p className="alert">{error}</p>}
      {actionError && <p className="alert">{actionError}</p>}

      <form className="inline-form" onSubmit={(e) => void create(e)}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New store name" minLength={2} maxLength={40} required />
        <button type="submit" disabled={busy}>
          Create store
        </button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Status</th>
            <th>URL</th>
            <th>Tools</th>
            <th>Owner</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.id}>
              <td>
                <strong>{s.name}</strong>
                <div className="muted mono">{s.namespace}</div>
              </td>
              <td>
                <span className={`badge badge-${s.status}`}>{LABEL[s.status]}</span>
                {s.statusDetail && <div className="error-text">{s.statusDetail}</div>}
              </td>
              <td>
                {s.status === "ready" ? (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.url.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="muted">{s.url.replace(/^https?:\/\//, "")}</span>
                )}
              </td>
              <td className="mono">{s.toolPrefix}*</td>
              <td>{s.owner ?? "—"}</td>
              <td>{new Date(s.createdAt).toLocaleString()}</td>
              <td className="actions">
                {s.canManage && s.status === "failed" && (
                  <button className="secondary" onClick={() => void act(() => api(`/stores/${s.id}/retry`, { method: "POST" }))}>
                    Retry
                  </button>
                )}
                {s.canManage && s.status !== "deleting" && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Delete ${s.name}? Its namespace, database, volumes, Secrets and tools are removed.`)) {
                        void act(() => api(`/stores/${s.id}`, { method: "DELETE" }));
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p className="muted">No stores yet. Create one above; the first install downloads WooCommerce and takes a couple of minutes.</p>}
    </>
  );
}
