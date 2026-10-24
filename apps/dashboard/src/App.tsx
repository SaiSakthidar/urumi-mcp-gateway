import { useEffect, useState } from "react";

// Pages to build (milestones M5/M6): Servers, Members, Keys, Audit, Chat.
const pages = ["Servers", "Members", "Keys", "Audit", "Chat"] as const;
type Page = (typeof pages)[number];

export function App() {
  const [page, setPage] = useState<Page>("Servers");
  const [backend, setBackend] = useState("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((body: { status: string }) => setBackend(body.status))
      .catch(() => setBackend("unreachable"));
  }, []);

  return (
    <div className="layout">
      <nav>
        <h1>Urumi</h1>
        {pages.map((p) => (
          <button key={p} className={p === page ? "active" : ""} onClick={() => setPage(p)}>
            {p}
          </button>
        ))}
        <p className="muted">Gateway: {backend}</p>
      </nav>
      <main>
        <h2>{page}</h2>
        <p className="muted">Not built yet.</p>
      </main>
    </div>
  );
}
