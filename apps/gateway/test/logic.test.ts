import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./setup.js";

const { splitToolName, exposedToolName } = await import("../src/core/catalog.js");
const { parseImage, assertAllowedImage } = await import("../src/security/image.js");
const { assertSafeUpstreamUrl, SsrfError } = await import("../src/security/ssrf.js");
const { isAllowedRedirectUri } = await import("../src/auth/oauth.js");
const { encrypt, decrypt, sha256, hashPassword, verifyPassword } = await import("../src/security/crypto.js");
const { searchTools, metaTools } = await import("../src/core/metaTools.js");
const { upstreams } = await import("../src/upstreams/manager.js");
const { renderMetrics, observeToolCall } = await import("../src/metrics/metrics.js");

describe("tool names", () => {
  it("splits on the first double underscore", () => {
    assert.deepEqual(splitToolName("woo__list_orders"), { slug: "woo", tool: "list_orders" });
    // A tool name may itself contain "__": only the first one separates the slug.
    assert.deepEqual(splitToolName("a__b__c"), { slug: "a", tool: "b__c" });
  });
  it("rejects names without a slug or tool", () => {
    assert.equal(splitToolName("list_orders"), null);
    assert.equal(splitToolName("__x"), null);
    assert.equal(splitToolName("woo__"), null);
  });
  it("round-trips", () => {
    assert.deepEqual(splitToolName(exposedToolName("gh", "create_issue")), { slug: "gh", tool: "create_issue" });
  });
  it("meta tools never look like server tools", () => {
    for (const t of metaTools) assert.equal(splitToolName(t.name), null);
  });
});

describe("hosted image rules", () => {
  it("reads the registry", () => {
    assert.equal(parseImage("ghcr.io/org/app:1.0").registry, "ghcr.io");
    assert.equal(parseImage("nginx:1.27").registry, "docker.io");
    assert.equal(parseImage("org/app:1.0").registry, "docker.io");
    assert.equal(parseImage("localhost:5000/app:1").registry, "localhost:5000");
  });
  it("requires a pinned version", () => {
    assert.throws(() => assertAllowedImage("ghcr.io/org/app"), /Pin the image/);
    assert.throws(() => assertAllowedImage("ghcr.io/org/app:latest"), /Pin the image/);
    assert.doesNotThrow(() => assertAllowedImage("ghcr.io/org/app:1.2.3"));
    assert.doesNotThrow(() => assertAllowedImage(`ghcr.io/org/app@sha256:${"a".repeat(64)}`));
  });
  it("enforces the registry allowlist", () => {
    assert.throws(() => assertAllowedImage("evil.example.com/app:1.0"), /not allowed/);
  });
  it("rejects shell-ish characters", () => {
    assert.throws(() => assertAllowedImage("ghcr.io/org/app:1.0; rm -rf /"), /invalid characters/);
  });
});

describe("SSRF guard", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:8080/mcp",
    "http://10.0.0.5/mcp",
    "http://192.168.1.1/mcp",
    "http://[::1]/mcp",
    "http://localhost/mcp",
    "http://postgres.platform.svc.cluster.local:5432/",
    "http://thing.internal/",
  ]) {
    it(`blocks ${url}`, async () => {
      await assert.rejects(() => assertSafeUpstreamUrl(url), SsrfError);
    });
  }
  it("allows the explicitly allowlisted in-cluster host", async () => {
    await assert.doesNotReject(() => assertSafeUpstreamUrl("http://woo-mcp.mcp.svc.cluster.local:3000/mcp"));
  });
  it("allows a public address literal", async () => {
    await assert.doesNotReject(() => assertSafeUpstreamUrl("https://93.184.216.34/mcp"));
  });
});

describe("OAuth redirect URIs", () => {
  it("accepts https and loopback http", () => {
    assert.ok(isAllowedRedirectUri("https://client.example.com/cb"));
    assert.ok(isAllowedRedirectUri("http://localhost:33418/callback"));
    assert.ok(isAllowedRedirectUri("http://127.0.0.1:8080/cb"));
  });
  it("rejects plain http elsewhere, fragments and junk", () => {
    assert.ok(!isAllowedRedirectUri("http://client.example.com/cb"));
    assert.ok(!isAllowedRedirectUri("https://client.example.com/cb#frag"));
    assert.ok(!isAllowedRedirectUri("javascript:alert(1)"));
    assert.ok(!isAllowedRedirectUri("not a url"));
  });
});

describe("crypto", () => {
  it("encrypts and decrypts, with a fresh IV each time", () => {
    const a = encrypt("secret-token");
    const b = encrypt("secret-token");
    assert.equal(decrypt(a.ciphertext, a.iv), "secret-token");
    assert.notDeepEqual(a.iv, b.iv);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });
  it("detects tampering", () => {
    const e = encrypt("secret-token");
    e.ciphertext[0] ^= 1;
    assert.throws(() => decrypt(e.ciphertext, e.iv));
  });
  it("hashes passwords with a salt and verifies them", async () => {
    const h = await hashPassword("correct horse");
    assert.ok(await verifyPassword("correct horse", h));
    assert.ok(!(await verifyPassword("wrong", h)));
    assert.notEqual(h, await hashPassword("correct horse"));
  });
  it("sha256 is deterministic", () => {
    assert.equal(sha256("x"), sha256("x"));
    assert.notEqual(sha256("x"), sha256("y"));
  });
});

describe("tool search", () => {
  const principal = { userId: 1, email: "a@b.c", role: "admin" as const };
  const tools = (names: [string, string][]) =>
    names.map(([name, description]) => ({ name, description, inputSchema: { type: "object" as const } }));

  // Seed the manager's in-memory catalog directly: no network, no database.
  const seed = (slug: string, displayName: string, list: [string, string][]) =>
    (upstreams as unknown as { states: Map<string, unknown> }).states.set(slug, {
      config: { slug, displayName, enabled: true, kind: "remote", headers: {}, id: 1, url: "http://x" },
      status: "connected",
      tools: tools(list),
      consecutiveFailures: 0,
      generation: 0,
    });
  seed("woo", "WooCommerce", [
    ["list_orders", "List orders, newest first."],
    ["create_product", "Create a simple product."],
    ["get_order", "Get one order by its ID."],
  ]);
  seed("gh", "GitHub", [
    ["create_issue", "Open an issue in a repository."],
    ["list_pull_requests", "List pull requests."],
  ]);

  it("ranks name matches first", () => {
    const found = searchTools(principal, "orders", 5).map((t) => t.name);
    assert.equal(found[0], "woo__list_orders");
    assert.ok(found.includes("woo__get_order"));
  });
  it("finds by description and across servers", () => {
    assert.deepEqual(searchTools(principal, "repository issue", 5).map((t) => t.name)[0], "gh__create_issue");
  });
  it("returns nothing for nonsense and respects the limit", () => {
    assert.equal(searchTools(principal, "zzzzqqq", 5).length, 0);
    assert.equal(searchTools(principal, "list", 1).length, 1);
  });
});

describe("metrics", () => {
  it("renders counters and a latency histogram per server", () => {
    observeToolCall("woo", "ok", 40);
    observeToolCall("woo", "timeout", 15000);
    const text = renderMetrics();
    assert.match(text, /urumi_tool_calls_total\{server="woo",outcome="ok"\} 1/);
    assert.match(text, /urumi_tool_calls_total\{server="woo",outcome="timeout"\} 1/);
    assert.match(text, /urumi_tool_call_duration_ms_count\{server="woo"\} 2/);
    assert.match(text, /le="\+Inf"\} 2/);
  });
});
