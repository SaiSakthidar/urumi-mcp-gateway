import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Me } from "./types";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { AuditPage } from "./pages/Audit";
import { ChatPage } from "./pages/Chat";
import { KeysPage } from "./pages/Keys";
import { LoginPage } from "./pages/Login";
import { MembersPage } from "./pages/Members";
import { MetricsPage } from "./pages/Metrics";
import { PermissionsPage } from "./pages/Permissions";
import { ServersPage } from "./pages/Servers";
import { StoresPage } from "./pages/Stores";

// Hash routing (#/servers, #/invite/<token>) keeps nginx config trivial and
// lets invite links work without any server-side routes.
function useHashPath(): string {
  const read = () => window.location.hash.slice(1) || "/servers";
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

const NAV = [
  { path: "/servers", label: "Servers", adminOnly: false },
  { path: "/stores", label: "Stores", adminOnly: false },
  { path: "/members", label: "Members", adminOnly: true },
  { path: "/permissions", label: "Permissions", adminOnly: true },
  { path: "/keys", label: "API keys", adminOnly: false },
  { path: "/audit", label: "Audit log", adminOnly: false },
  { path: "/metrics", label: "Metrics", adminOnly: false },
  { path: "/chat", label: "Chat", adminOnly: false },
];

export function App() {
  const path = useHashPath();
  const [me, setMe] = useState<Me | null>();

  const loadMe = useCallback(() => {
    api<Me>("/auth/me")
      .then(setMe)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setMe(null);
        else console.error(err);
      });
  }, []);

  useEffect(loadMe, [loadMe]);

  const goHome = () => {
    window.location.hash = "#/servers";
    loadMe();
  };

  if (path.startsWith("/invite/")) {
    return <AcceptInvitePage token={path.slice("/invite/".length)} onDone={goHome} />;
  }
  if (me === undefined) return <p className="center muted">Loading…</p>;
  if (me === null) return <LoginPage onLogin={loadMe} />;

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setMe(null);
  };

  let page;
  if (path === "/members" && me.role === "admin") page = <MembersPage me={me} />;
  else if (path === "/permissions" && me.role === "admin") page = <PermissionsPage />;
  else if (path === "/keys") page = <KeysPage me={me} />;
  else if (path === "/audit") page = <AuditPage me={me} />;
  else if (path === "/stores") page = <StoresPage />;
  else if (path === "/metrics") page = <MetricsPage />;
  else if (path === "/chat") page = <ChatPage />;
  else page = <ServersPage me={me} />;

  return (
    <div className="layout">
      <nav>
        <h1>Urumi</h1>
        {NAV.filter((n) => !n.adminOnly || me.role === "admin").map((n) => (
          <a key={n.path} href={`#${n.path}`} className={path === n.path ? "active" : ""}>
            {n.label}
          </a>
        ))}
        <div className="nav-footer">
          <div className="muted">{me.email}</div>
          <div className="muted">{me.role}</div>
          <button className="link" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </nav>
      <main>{page}</main>
    </div>
  );
}
