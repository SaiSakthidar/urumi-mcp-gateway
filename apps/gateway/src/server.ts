import express from "express";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Liveness: the process is up. Never depends on Postgres or upstreams.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: we can serve requests, which needs the database.
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "db unavailable" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

// TODO(M3): stateless MCP endpoint backed by ToolRouter.callTool.
app.all("/mcp", (_req, res) => {
  res.status(501).json({ jsonrpc: "2.0", error: { code: -32601, message: "Not implemented yet" }, id: null });
});

async function main() {
  await migrate();
  const httpServer = app.listen(config.port, () => {
    console.log(`gateway listening on :${config.port}`);
  });
  process.on("SIGTERM", () => {
    httpServer.close(() => void pool.end().then(() => process.exit(0)));
  });
}

main().catch((err) => {
  console.error("gateway failed to start", err);
  process.exit(1);
});
