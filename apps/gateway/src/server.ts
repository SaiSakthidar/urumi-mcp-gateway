import express from "express";
import { auditRouter } from "./api/audit.js";
import { requireUser } from "./auth/sessions.js";
import { authRouter } from "./api/auth.js";
import { chatRouter } from "./api/chat.js";
import { errorHandler, requireCsrfHeader } from "./api/http.js";
import { keysRouter } from "./api/keys.js";
import { membersRouter } from "./api/members.js";
import { permissionsRouter } from "./api/permissions.js";
import { serversRouter } from "./api/servers.js";
import { storesRouter } from "./api/stores.js";
import { bootstrap } from "./bootstrap.js";
import { config } from "./config.js";
import { loadRules } from "./core/permissions.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { oauthRouter } from "./api/oauth.js";
import { pruneRateLimitCounters } from "./core/rateLimit.js";
import { serverStats } from "./core/stats.js";
import { renderMetrics } from "./metrics/metrics.js";
import { mcpRouter } from "./mcp/endpoint.js";
import { upstreams } from "./upstreams/manager.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Traefik: use the real client address (rate limits, login throttling)
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

// Prometheus scrape endpoint. Not routed through the ingress: reach it in-cluster or with kubectl port-forward.
app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4").send(renderMetrics());
});

// OAuth discovery, client registration, login and token endpoints for MCP clients.
app.use(oauthRouter);

// MCP clients (Claude Code, Cursor, Inspector) authenticate with an API key or an OAuth token.
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
app.use("/api/permissions", permissionsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/stores", storesRouter);
app.get("/api/stats", requireUser, async (_req, res) => {
  res.json(await serverStats(24));
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

// The pod can start before the cluster network or Postgres is ready, so retry
// the first connection instead of crash-looping.
async function waitForDatabase(attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`waiting for database (${i}/${attempts}): ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  await waitForDatabase();
  await migrate();
  await bootstrap();
  await loadRules();
  await upstreams.start();
  setInterval(() => void pruneRateLimitCounters().catch((err: unknown) => console.error("prune failed", err)), 5 * 60_000);
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
