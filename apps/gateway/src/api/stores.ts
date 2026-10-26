import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { principalOf, requireUser } from "../auth/sessions.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { upstreams } from "../upstreams/manager.js";
import { HttpError, idParam, isUniqueViolation, parseBody } from "./http.js";

// Store provisioning (bonus). This API only records what should exist; the
// provisioner (apps/provisioner) reconciles it: namespace, Secrets, the store
// Helm release with its own WooCommerce MCP server, and registration in the
// gateway. Because the desired state is a row in Postgres, a restart of either
// component picks up where it left off.

export const storesRouter = Router();
storesRouter.use(requireUser);

const RESERVED = new Set(["woo", "everything", "github", "gateway", "search", "run"]);

type StoreRow = {
  id: number;
  slug: string;
  name: string;
  owner_id: number | null;
  owner_email: string | null;
  namespace: string;
  status: "provisioning" | "ready" | "failed" | "deleting";
  status_detail: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Storefront URL: the dashboard host with "app." swapped for "shop-<slug>.". */
function storeUrl(slug: string): string {
  const url = new URL(config.publicUrl);
  url.hostname = url.hostname.replace(/^app\./, `shop-${slug}.`);
  return url.origin;
}

function view(r: StoreRow, caller: { userId: number; role: string }) {
  // "Ready" must mean usable. The provisioner marks a store ready as soon as its MCP server is
  // registered in Postgres, but this gateway only learns of it on its next registry poll and then has
  // to connect. Until it has, say so instead of promising tools that are not there yet.
  const live = upstreams.get(r.slug)?.status === "connected";
  const waitingForGateway = r.status === "ready" && !live;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    owner: r.owner_email,
    status: waitingForGateway ? "provisioning" : r.status,
    statusDetail: waitingForGateway ? "Registering the store's tools with the gateway" : r.status_detail,
    url: storeUrl(r.slug),
    namespace: r.namespace,
    createdAt: r.created_at,
    canManage: caller.role === "admin" || r.owner_id === caller.userId,
    // What to ask the chat agent / MCP clients to use for this store.
    toolPrefix: `${r.slug}__`,
  };
}

const SELECT = `SELECT s.*, u.email AS owner_email FROM stores s LEFT JOIN users u ON u.id = s.owner_id`;

storesRouter.get("/", async (_req, res) => {
  const caller = principalOf(res);
  const { rows } = await pool.query<StoreRow>(`${SELECT} ORDER BY s.id DESC`);
  res.json(rows.map((r) => view(r, caller)));
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(40),
  slug: z
    .string()
    .regex(/^[a-z0-9]{3,10}$/, "3-10 lowercase letters or digits")
    .optional(),
});

function slugFromName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  return `${base.length >= 3 ? base : `st${base}`}${randomBytes(2).toString("hex")}`.slice(0, 10);
}

storesRouter.post("/", async (req, res) => {
  const caller = principalOf(res);
  const input = parseBody(createSchema, req.body);
  const slug = input.slug ?? slugFromName(input.name);
  if (RESERVED.has(slug)) throw new HttpError(400, `"${slug}" is reserved`);

  // Guardrails: a per-user and a total cap, so one user cannot fill the cluster.
  const { rows: counts } = await pool.query<{ mine: number; total: number }>(
    `SELECT count(*) FILTER (WHERE owner_id = $1)::int AS mine, count(*)::int AS total FROM stores`,
    [caller.userId],
  );
  if (counts[0].mine >= config.maxStoresPerUser) {
    throw new HttpError(429, `You already have ${counts[0].mine} stores (limit ${config.maxStoresPerUser}). Delete one first.`);
  }
  if (counts[0].total >= config.maxStoresTotal) {
    throw new HttpError(429, `The cluster is at its limit of ${config.maxStoresTotal} stores.`);
  }
  if (upstreams.get(slug)) throw new HttpError(409, `A server with slug "${slug}" already exists`);

  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO stores (slug, name, owner_id, namespace) VALUES ($1, $2, $3, $4) RETURNING id`,
      [slug, input.name, caller.userId, `store-${slug}`],
    );
    res.status(202).json({ id: rows[0].id, slug });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `A store with slug "${slug}" already exists`);
    throw err;
  }
});

async function loadManageable(req: Request, caller: { userId: number; role: string }): Promise<StoreRow> {
  const { rows } = await pool.query<StoreRow>(`${SELECT} WHERE s.id = $1`, [idParam(req)]);
  const store = rows[0];
  if (!store) throw new HttpError(404, "Store not found");
  if (caller.role !== "admin" && store.owner_id !== caller.userId) throw new HttpError(403, "Only the owner or an admin can change this store");
  return store;
}

// Retrying a failed store is safe: provisioning is idempotent.
storesRouter.post("/:id/retry", async (req, res) => {
  const store = await loadManageable(req, principalOf(res));
  if (store.status !== "failed") throw new HttpError(409, "Only failed stores can be retried");
  await pool.query(
    "UPDATE stores SET status = 'provisioning', status_detail = NULL, created_at = now(), updated_at = now() WHERE id = $1",
    [store.id],
  );
  res.status(202).json({ ok: true });
});

storesRouter.delete("/:id", async (req, res) => {
  const store = await loadManageable(req, principalOf(res));
  await pool.query("UPDATE stores SET status = 'deleting', status_detail = NULL, updated_at = now() WHERE id = $1", [store.id]);
  // Stop routing to the store's tools right away; the provisioner removes the rest.
  await pool.query("UPDATE upstreams SET enabled = false, updated_at = now() WHERE slug = $1 AND kind = 'store'", [store.slug]);
  await upstreams.reload();
  res.status(202).json({ ok: true });
});
