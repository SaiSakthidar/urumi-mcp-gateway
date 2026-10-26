import { Router } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { recordAudit } from "../audit/audit.js";
import { authenticateApiKey } from "../auth/apiKeys.js";
import { authenticateAccessToken } from "../auth/oauth.js";
import { resourceMetadataUrl } from "../api/oauth.js";
import { splitToolName, visibleTools } from "../core/catalog.js";
import { executeMetaTool, metaTools } from "../core/metaTools.js";
import { callTool } from "../core/router.js";

// The single MCP endpoint clients connect to: POST /mcp with
// "Authorization: Bearer <api key>".
//
// Stateless Streamable HTTP: every POST gets a fresh Server + transport and no
// Mcp-Session-Id, so nothing breaks when the pod restarts. The tradeoff: we
// can't push tools/list_changed, so clients re-list to see changes.

export const mcpRouter = Router();

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

type RpcBody = { method?: unknown; params?: { name?: unknown } } | undefined;

mcpRouter.post("/", async (req, res) => {
  // API keys look like urumi_<prefix>_<secret>; anything else is tried as an OAuth access token.
  const authorization = req.header("authorization");
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  let auth = await authenticateApiKey(authorization);
  if (!auth.ok && auth.reason === "invalid" && bearer && !bearer.startsWith("urumi_")) {
    const principal = await authenticateAccessToken(bearer);
    if (principal) auth = { ok: true, principal };
  }

  if (!auth.ok) {
    if (auth.reason === "revoked") {
      // We know whose key it was, so the rejected attempt is attributed to them.
      const body = req.body as RpcBody;
      const toolName =
        body?.method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : undefined;
      const parts = toolName ? splitToolName(toolName) : null;
      await recordAudit({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        source: "mcp",
        upstreamSlug: parts?.slug ?? null,
        toolName: parts?.tool ?? toolName ?? `(${typeof body?.method === "string" ? body.method : "request"})`,
        outcome: "auth_revoked",
        errorMessage: "API key revoked or user disabled",
      });
    }
    const message =
      auth.reason === "missing"
        ? "Missing API key. Send 'Authorization: Bearer <key>'."
        : auth.reason === "revoked"
          ? "This API key has been revoked."
          : "Invalid API key.";
    // Tells OAuth-capable MCP clients where to start the browser login (RFC 9728).
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json(jsonRpcError(-32001, message));
    return;
  }

  const principal = auth.principal;
  const server = new Server({ name: "urumi-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  // Search mode (header "X-Urumi-Tool-Mode: search" or "?tools=search") lists only
  // search_tools and run_tool, for clients that can't cope with hundreds of tools.
  // Both meta tools also work in the normal mode.
  const searchMode = req.header("x-urumi-tool-mode") === "search" || req.query.tools === "search";
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: searchMode ? metaTools : visibleTools(principal),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    return (
      (await executeMetaTool(principal, "mcp", request.params.name, args)) ??
      callTool(principal, "mcp", request.params.name, args)
    );
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true, // plain JSON responses: easy to debug with curl
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed", err);
    if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal error"));
  }
});

// No sessions, so no server-initiated SSE stream (GET) and nothing to DELETE.
mcpRouter.all("/", (_req, res) => {
  res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed"));
});
