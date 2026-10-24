import { config } from "../config.js";

// Minimal client for any OpenAI-compatible /chat/completions endpoint
// (Gemini, Groq, OpenAI, Ollama, ...). Switching provider = changing Helm values.

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface LlmReply {
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export class LlmError extends Error {}

export function llmConfigured(): boolean {
  return Boolean(config.llm.baseUrl && config.llm.model && config.llm.apiKey);
}

export async function chatCompletion(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmReply> {
  const baseUrl = config.llm.baseUrl ?? "";
  const endpoint = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        tools: tools.length ? tools : undefined,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) throw new LlmError(`LLM returned HTTP ${res.status}: ${text.slice(0, 300)}`);

  let body: { choices?: { message?: LlmReply }[] };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new LlmError("LLM returned invalid JSON");
  }
  const message = body.choices?.[0]?.message;
  if (!message) throw new LlmError("LLM response had no message");
  return message;
}
