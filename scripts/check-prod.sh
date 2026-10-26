#!/usr/bin/env bash
# Renders and lints all three charts with the production values, with no cluster needed.
# Catches template and values mistakes before a VPS deploy. Placeholders such as <VPS_IP>
# are substituted with dummy values for the render only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for chart in store mcp-servers platform; do
  sed -e 's/<VPS_IP>/203.0.113.10/g' -e 's/<GHCR_USER>/example/g' \
    "$ROOT/charts/$chart/values-prod.yaml" >"$TMP/$chart.yaml"
  helm lint "$ROOT/charts/$chart" -f "$TMP/$chart.yaml" >/dev/null
  helm template "$chart" "$ROOT/charts/$chart" -f "$TMP/$chart.yaml" >"$TMP/$chart.rendered.yaml"
  echo "ok  $chart  ($(grep -c '^kind:' "$TMP/$chart.rendered.yaml") objects)"
done

# The things a prod deploy must have, checked on the rendered output.
grep -q 'secretName: app-tls' "$TMP/platform.rendered.yaml" || { echo "FAIL: platform ingress has no TLS" >&2; exit 1; }
grep -q 'kind: NetworkPolicy' "$TMP/platform.rendered.yaml" || { echo "FAIL: no NetworkPolicies" >&2; exit 1; }
! grep -q 'imagePullPolicy: Never' "$TMP/platform.rendered.yaml" || { echo "FAIL: pullPolicy Never in prod" >&2; exit 1; }
echo "prod values render cleanly"
