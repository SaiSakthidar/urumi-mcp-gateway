#!/usr/bin/env bash
# Demonstrates a safe Helm upgrade and rollback of the platform release against the current
# cluster, and checks the gateway still serves between the steps.
#
#   ./scripts/upgrade-demo.sh [values-file]   (default charts/platform/values-local.yaml)
#
# The upgrade changes a harmless setting (rate limit), so the revision, the rollout and
# the rollback are all visible in `helm history`. Run it on a cluster whose kubectl
# context is the one you intend (it prints the context first).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALUES="${1:-$ROOT/charts/platform/values-local.yaml}"
NS=platform

echo "kubectl context: $(kubectl config current-context)"
read -r -p "Continue against this context? [y/N] " ok
[ "$ok" = y ] || exit 1

ready() { kubectl -n "$NS" rollout status deploy/gateway --timeout=180s; }

before=$(helm history platform -n "$NS" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["revision"])')
echo "== current revision: $before"

echo "== upgrade: rate limit 120 -> 240 per minute"
helm upgrade platform "$ROOT/charts/platform" -n "$NS" -f "$VALUES" --reuse-values --set gateway.rateLimitPerMinute=240
ready
kubectl -n "$NS" exec deploy/gateway -- sh -c 'echo "gateway now runs RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE"'

echo "== rollback to revision $before"
helm rollback platform "$before" -n "$NS" --wait
ready
kubectl -n "$NS" exec deploy/gateway -- sh -c 'echo "gateway runs RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE"'

helm history platform -n "$NS"
echo "Data (Postgres, store volumes) was untouched: rollback only restores manifests."
