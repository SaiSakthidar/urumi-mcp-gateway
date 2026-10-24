import express from "express";
import { auditRouter } from "./api/audit.js";
import { authRouter } from "./api/auth.js";
import { errorHandler, requireCsrfHeader } from "./api/http.js";
import { keysRouter } from "./api/keys.js";
import { membersRouter } from "./api/members.js";
import { serversRouter } from "./api/servers.js";
import { bootstrap } from "./bootstrap.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { mcpRouter } from "./mcp/endpoint.js";
import { upstreams } from "./upstreams/manager.js";

const app = express();
app.disable("x-powered-by");
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

// MCP clients (Claude Code, Cursor, Inspector) authenticate with an API key.
app.use("/mcp", mcpRouter);

// Dashboard API: session cookie + CSRF header.
app.use("/api", requireCsrfHeader);
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "gateway" });
});
app.get("/api/info", (_req, res) => {
  res.json({ mcpUrl: `${config.publicUrl}/mcp` });
});
app.use("/api/auth", authRouter);
app.use("/api/servers", serversRouter);
app.use("/api/members", membersRouter);
app.use("/api/keys", keysRouter);
app.use("/api/audit", auditRouter);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

async function main() {
  await migrate();
  await bootstrap();
  await upstreams.start();
  const httpServer = app.listen(config.port, () => {
    console.log(`gateway listening on :${config.port}`);
  });
  process.on("SIGTERM", () => {
    httpServer.close(() => {
      void upstreams
        .stop()
        .then(() => pool.end())
        .then(() => process.exit(0));
    });
  });
}

main().catch((err) => {
  console.error("gateway failed to start", err);
  process.exit(1);
});
