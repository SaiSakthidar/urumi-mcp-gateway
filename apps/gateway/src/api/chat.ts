import { Router } from "express";
import { z } from "zod";
import { principalOf, requireUser } from "../auth/sessions.js";
import { runAgent } from "../chat/agent.js";
import { llmConfigured, LlmError } from "../chat/llm.js";
import { HttpError, parseBody } from "./http.js";

// POST /api/chat with the conversation so far (user/assistant text turns).
// Stateless: the browser keeps the history. The agent acts as the session user.

export const chatRouter = Router();
chatRouter.use(requireUser);

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === "user", "The last message must be from the user"),
});

chatRouter.post("/", async (req, res) => {
  if (!llmConfigured()) {
    throw new HttpError(503, "The chat agent is not configured: set LLM_API_KEY, LLM_BASE_URL and LLM_MODEL");
  }
  const { messages } = parseBody(chatSchema, req.body);
  try {
    res.json(await runAgent(principalOf(res), messages));
  } catch (err) {
    if (err instanceof LlmError) throw new HttpError(502, err.message);
    throw err;
  }
});
