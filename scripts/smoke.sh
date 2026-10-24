#!/usr/bin/env bash
# Talks raw MCP (JSON-RPC over Streamable HTTP) to the gateway with curl.
# Handy to show what a client actually sends, and to check a key quickly.
#
#   ./scripts/smoke.sh <gateway-mcp-url> <api-key> [tool-name] [json-args]
#   ./scripts/smoke.sh http://app.127.0.0.1.sslip.io/mcp urumi_xxx woo__list_orders '{"date":"today"}'
set -euo pipefail
URL="${1:?gateway MCP url}"
KEY="${2:?api key}"
TOOL="${3:-}"
ARGS="${4:-}"
[ -n "$ARGS" ] || ARGS="{}"

rpc() {
  curl -sS "$URL" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    -d "$1"
  echo
}

echo "== initialize"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

echo "== tools/list (names only)"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[^"]*"' || true

if [ -n "$TOOL" ]; then
  echo "== tools/call $TOOL"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"
fi
