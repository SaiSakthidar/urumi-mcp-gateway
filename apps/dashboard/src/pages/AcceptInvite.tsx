import { useState, type FormEvent } from "react";
import { api, errorMessage, useApi } from "../api";

export function AcceptInvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const invite = useApi<{ email: string; role: string }>(`/auth/invite/${encodeURIComponent(token)}`);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    try {
      await api("/auth/accept-invite", { method: "POST", body: { token, password } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (invite.error) {
    return (
      <div className="center">
        <p className="alert">{invite.error}</p>
      </div>
    );
  }
  if (!invite.data) return <p className="center muted">Loading…</p>;

  return (
    <div className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h2>Join Urumi</h2>
        <p className="muted">
          You were invited as <b>{invite.data.email}</b> ({invite.data.role}). Choose a password.
        </p>
        {error && <p className="alert">{error}</p>}
        <label>
          Password (at least 10 characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <button type="submit">Create account</button>
      </form>
    </div>
  );
}
