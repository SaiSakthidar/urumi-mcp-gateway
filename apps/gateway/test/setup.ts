// The gateway reads required config at import time, so tests set it first.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.BOOTSTRAP_ADMIN_PASSWORD ??= "test-password";
process.env.PUBLIC_URL ??= "https://app.example.com";
process.env.ALLOWED_INTERNAL_HOSTS ??= "woo-mcp.mcp.svc.cluster.local";
