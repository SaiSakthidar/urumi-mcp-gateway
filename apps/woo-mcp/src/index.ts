import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";
import { WooClient } from "./woo-client.js";

const wc = new WooClient({
  baseUrl: config.wcBaseUrl,
  publicHost: config.wcPublicHost,
  consumerKey: config.wcConsumerKey,
  consumerSecret: config.wcConsumerSecret,
  timeoutMs: config.wcTimeoutMs,
});

function buildServer(): McpServer {
  const server = new McpServer({ name: "woo-mcp", version: "0.1.0" });
  registerTools(server, wc, config.storeTimezone);
  return server;
}

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const expected = Buffer.from(`Bearer ${config.mcpToken}`);
  const got = Buffer.from(req.header("authorization") ?? "");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Stateless Streamable HTTP: a fresh server + transport per request, no session IDs.
// Nothing is lost when this pod restarts.
app.post("/mcp", requireBearer, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// No sessions, so no server-initiated SSE stream and nothing to delete.
app.all("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

const httpServer = app.listen(config.port, () => {
  console.log(`woo-mcp listening on :${config.port}`);
});

process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
