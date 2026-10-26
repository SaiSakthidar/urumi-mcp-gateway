#!/usr/bin/env bash
# Create the kind cluster and install Traefik as the ingress controller.
set -euo pipefail
CLUSTER="${1:-urumi}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# kind >= 0.24 is needed for NetworkPolicy enforcement, and the Traefik chart needs Kubernetes >= 1.30.
kind_minor="$(kind version | sed -n 's/^kind v0\.\([0-9]*\).*/\1/p')"
if [ -n "$kind_minor" ] && [ "$kind_minor" -lt 24 ]; then
  echo "kind v0.$kind_minor is too old: install kind >= 0.24" >&2
  exit 1
fi

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$ROOT/kind/kind-config.yaml"
fi

helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik --version 42.1.3 \
  -n traefik --create-namespace \
  -f "$ROOT/kind/traefik-values.yaml" --wait

echo "Cluster '$CLUSTER' ready. Ingress on http://*.127.0.0.1.sslip.io"
