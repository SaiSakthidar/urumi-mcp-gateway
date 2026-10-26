import { createServer } from "node:http";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ensureHostedNamespace, reconcileHosted } from "./hosted.js";
import { reconcileStores } from "./stores.js";

// The provisioner is the only component with Kubernetes API access. The gateway (which
// takes user input and talks to an LLM) never gets it: it only writes desired state to
// Postgres, and this process makes it so.
//
// Single active instance: whoever holds the Postgres advisory lock reconciles; any other
// replica idles and takes over if the holder dies (the lock is released with its connection).

const LOCK_ID = 7_373_001;
let leader = false;

createServer((req, res) => {
  const ok = req.url === "/healthz" || req.url === "/readyz";
  res.statusCode = ok ? 200 : 404;
  res.end(JSON.stringify({ status: ok ? "ok" : "not found", leader }));
}).listen(config.healthPort);

async function main(): Promise<void> {
  const lockClient = await pool.connect();
  lockClient.on("error", (err) => {
    console.error("lost the leader-lock connection, exiting", err);
    process.exit(1);
  });

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!leader) {
        const { rows } = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
        leader = rows[0].ok;
        if (leader) {
          console.log("provisioner: acquired the lock, reconciling");
          await ensureHostedNamespace();
        }
      }
      if (leader) {
        await reconcileStores();
        await reconcileHosted();
      }
    } catch (err) {
      console.error("reconcile tick failed", err);
    } finally {
      busy = false;
    }
  };

  await tick();
  setInterval(() => void tick(), config.reconcileIntervalMs);
}

main().catch((err) => {
  console.error("provisioner failed to start", err);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
