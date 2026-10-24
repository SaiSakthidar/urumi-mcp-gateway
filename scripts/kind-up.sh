#!/usr/bin/env bash
# Create the kind cluster and install Traefik as the ingress controller.
set -euo pipefail
CLUSTER="${1:-urumi}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$ROOT/kind/kind-config.yaml"
fi

helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik \
  -n traefik --create-namespace \
  -f "$ROOT/kind/traefik-values.yaml" --wait

echo "Cluster '$CLUSTER' ready. Ingress on http://*.127.0.0.1.sslip.io"
