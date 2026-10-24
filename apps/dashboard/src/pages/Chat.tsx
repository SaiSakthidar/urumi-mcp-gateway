import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";

// The chat agent runs on the gateway, as the logged-in user. The browser keeps
// the conversation and sends it with each question; the reply lists the tools called.

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  preview: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

const EXAMPLES = [
  "What orders came in today?",
  "Create a product called Urumi Mug priced at 299",
  "List the 5 newest products",
];

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const history: Message[] = [...messages, { role: "user", content: text.trim() }];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ reply: string; toolCalls: ToolCall[] }>("/chat", {
        method: "POST",
        body: { messages: history.map(({ role, content }) => ({ role, content })) },
      });
      setMessages([...history, { role: "assistant", content: res.reply, toolCalls: res.toolCalls }]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="chat">
      <div className="page-header">
        <h2>Chat</h2>
        {messages.length > 0 && (
          <button className="secondary" onClick={() => setMessages([])}>
            New chat
          </button>
        )}
      </div>
      <p className="muted">
        The agent uses the same tools as your API key, acts as you, and every call it makes appears in the audit log.
      </p>

      <div className="chat-log">
        {messages.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="secondary" onClick={() => void send(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="tool-calls">
                {m.toolCalls.map((t, j) => (
                  <details key={j} className={`tool-chip ${t.isError ? "failed" : ""}`}>
                    <summary>
                      {t.isError ? "✗" : "✓"} {t.name}
                    </summary>
                    <div className="mono">args: {JSON.stringify(t.arguments)}</div>
                    <pre>{t.preview}</pre>
                  </details>
                ))}
              </div>
            )}
            <div className="bubble-text">{m.content}</div>
          </div>
        ))}
        {busy && <div className="bubble assistant muted">Thinking…</div>}
        {error && <p className="alert">{error}</p>}
        <div ref={bottom} />
      </div>

      <form className="inline-form" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about orders, products…" disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
