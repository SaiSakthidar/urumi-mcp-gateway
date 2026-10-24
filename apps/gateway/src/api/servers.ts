import { Router } from "express";
import { z } from "zod";
import { principalOf, requireAdmin, requireUser } from "../auth/sessions.js";
import { exposedToolName } from "../core/catalog.js";
import { assertSafeUpstreamUrl, SsrfError } from "../security/ssrf.js";
import { upstreams } from "../upstreams/manager.js";
import {
  createUpstream,
  deleteUpstream,
  listUpstreamRows,
  updateUpstream,
  type UpstreamRow,
} from "../upstreams/registry.js";
import { HttpError, idParam, isUniqueViolation, parseBody } from "./http.js";

// Upstream MCP servers. Everyone can see servers, their status and tools;
// only admins can change them. Credentials are write-only: the API only ever
// says whether one is set.

export const serversRouter = Router();
serversRouter.use(requireUser);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Headers the gateway controls itself and must not be overridden by a credential.
const RESERVED_HEADERS = ["host", "content-type", "content-length", "accept", "mcp-session-id", "mcp-protocol-version"];

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name")
  .refine((h) => !RESERVED_HEADERS.includes(h.toLowerCase()), "This header is reserved");

const fields = {
  displayName: z.string().trim().min(1).max(64),
  url: z.string().trim().refine(isHttpUrl, "Must be an http(s) URL"),
  authType: z.enum(["none", "bearer", "header"]),
  authHeaderName: headerName.nullish(),
  credential: z.string().max(4096).optional(),
  enabled: z.boolean(),
};

const createSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{1,16}$/, "Lowercase letters, digits and dashes, max 16 characters"),
    ...fields,
    authType: fields.authType.default("none"),
    enabled: fields.enabled.default(true),
  })
  .refine((v) => v.authType !== "header" || v.authHeaderName, {
    message: "Header name is required for header auth",
    path: ["authHeaderName"],
  });

const patchSchema = z.object(fields).partial();

async function checkUrl(url: string): Promise<void> {
  try {
    await assertSafeUpstreamUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) throw new HttpError(400, `URL rejected: ${err.message}`);
    throw err;
  }
}

function view(row: UpstreamRow, isAdmin: boolean) {
  const state = upstreams.get(row.slug);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    // The URL may embed a token, so only admins see it.
    url: isAdmin ? row.url : undefined,
    authType: row.auth_type,
    authHeaderName: row.auth_header_name,
    hasCredential: row.credential_ciphertext !== null,
    enabled: row.enabled,
    status: state?.status ?? (row.enabled ? "connecting" : "disabled"),
    lastError: state?.lastError ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? null,
    tools: (state?.tools ?? []).map((t) => ({
      name: exposedToolName(row.slug, t.name),
      description: t.description ?? "",
    })),
  };
}

serversRouter.get("/", async (_req, res) => {
  const isAdmin = principalOf(res).role === "admin";
  const rows = await listUpstreamRows();
  res.json(rows.map((row) => view(row, isAdmin)));
});

serversRouter.post("/", requireAdmin, async (req, res) => {
  const input = parseBody(createSchema, req.body);
  await checkUrl(input.url);
  try {
    const id = await createUpstream(input, principalOf(res).userId);
    await upstreams.reload();
    res.status(201).json({ id });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `A server with slug "${input.slug}" already exists`);
    throw err;
  }
});

serversRouter.patch("/:id", requireAdmin, async (req, res) => {
  const patch = parseBody(patchSchema, req.body);
  if (patch.authType === "header" && patch.authHeaderName === undefined) {
    throw new HttpError(400, "authHeaderName: required for header auth");
  }
  if (patch.url !== undefined) await checkUrl(patch.url);
  if (!(await updateUpstream(idParam(req), patch))) throw new HttpError(404, "Server not found");
  await upstreams.reload();
  res.json({ ok: true });
});

serversRouter.delete("/:id", requireAdmin, async (req, res) => {
  if (!(await deleteUpstream(idParam(req)))) throw new HttpError(404, "Server not found");
  await upstreams.reload();
  res.json({ ok: true });
});
