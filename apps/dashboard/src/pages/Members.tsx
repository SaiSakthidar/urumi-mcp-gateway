import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";
import type { Me, Member, Role } from "../types";

export function MembersPage({ me }: { me: Me }) {
  const { data, error, reload } = useApi<Member[]>("/members");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [inviteUrl, setInviteUrl] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const res = await api<{ inviteUrl: string }>("/members", { method: "POST", body: { email, role } });
      setInviteUrl(res.inviteUrl);
      setEmail("");
    });
  };

  return (
    <>
      <h2>Members</h2>
      {(error || actionError) && <p className="alert">{error ?? actionError}</p>}

      <form className="card inline-form" onSubmit={invite}>
        <input type="email" placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Invite</button>
      </form>

      {inviteUrl && (
        <div className="card secret">
          <p>Send this invite link to your teammate. It is shown only once and expires in 7 days.</p>
          <code className="mono">{inviteUrl}</code>
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>
            Copy
          </button>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Active keys</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((m) => {
            const self = m.id === me.userId;
            return (
              <tr key={m.id}>
                <td>
                  {m.email} {self && <span className="muted">(you)</span>}
                </td>
                <td>
                  <select
                    value={m.role}
                    disabled={self}
                    onChange={(e) => void act(() => api(`/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{m.status}</td>
                <td>{m.active_keys}</td>
                <td>
                  {!self && m.status !== "disabled" && (
                    <button
                      className="danger"
                      onClick={() => void act(() => api(`/members/${m.id}`, { method: "PATCH", body: { status: "disabled" } }))}
                    >
                      Disable
                    </button>
                  )}
                  {!self && m.status === "disabled" && (
                    <button
                      className="secondary"
                      onClick={() => void act(() => api(`/members/${m.id}`, { method: "PATCH", body: { status: "active" } }))}
                    >
                      Enable
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
