import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/auth/login", { method: "POST", body: { email, password } });
      onLogin();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h2>Sign in to Urumi</h2>
        {error && <p className="alert">{error}</p>}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
