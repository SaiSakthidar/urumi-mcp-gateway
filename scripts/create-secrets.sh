#!/usr/bin/env bash
# Creates namespaces and every Kubernetes Secret the charts reference.
# Charts never create secrets themselves; local and prod use the same flow.
#
#   ./scripts/create-secrets.sh local|prod
#
# Values come from .secrets/<env>.env (gitignored). Missing random values are
# generated on first run and written back, so re-runs are stable.
# LLM_API_KEY and GITHUB_PAT must be filled in by hand.
set -euo pipefail
ENV="${1:-local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/.secrets/$ENV.env"
mkdir -p "$ROOT/.secrets"
touch "$FILE"
chmod 600 "$FILE"

ensure() { # ensure KEY <generator>
  if ! grep -q "^$1=" "$FILE"; then echo "$1=$($2)" >>"$FILE"; fi
}
rand() { openssl rand -hex 24; }
rand32b64() { openssl rand -base64 32; }
wc_key() { echo "ck_$(openssl rand -hex 20)"; }
wc_secret() { echo "cs_$(openssl rand -hex 20)"; }
empty() { echo ""; }

ensure MARIADB_ROOT_PASSWORD rand
ensure MARIADB_PASSWORD rand
ensure WP_ADMIN_PASSWORD rand
ensure WC_CONSUMER_KEY wc_key
ensure WC_CONSUMER_SECRET wc_secret
ensure WOO_MCP_TOKEN rand
ensure POSTGRES_PASSWORD rand
ensure GATEWAY_ENCRYPTION_KEY rand32b64
ensure BOOTSTRAP_ADMIN_PASSWORD rand
ensure LLM_API_KEY empty
ensure GITHUB_PAT empty

set -a; source "$FILE"; set +a

apply_secret() { # ns name key=value...
  local ns="$1" name="$2"; shift 2
  local args=()
  for kv in "$@"; do args+=(--from-literal="$kv"); done
  kubectl create secret generic "$name" -n "$ns" "${args[@]}" \
    --dry-run=client -o yaml | kubectl apply -f -
}

for ns in store mcp platform; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done

apply_secret store store-db \
  "root-password=$MARIADB_ROOT_PASSWORD" "password=$MARIADB_PASSWORD"
apply_secret store store-admin \
  "admin-password=$WP_ADMIN_PASSWORD"
apply_secret store store-wc-api \
  "consumer-key=$WC_CONSUMER_KEY" "consumer-secret=$WC_CONSUMER_SECRET"

apply_secret mcp woo-mcp \
  "wc-consumer-key=$WC_CONSUMER_KEY" "wc-consumer-secret=$WC_CONSUMER_SECRET" \
  "mcp-token=$WOO_MCP_TOKEN"

apply_secret platform platform-db \
  "password=$POSTGRES_PASSWORD"
apply_secret platform gateway \
  "encryption-key=$GATEWAY_ENCRYPTION_KEY" \
  "bootstrap-admin-password=$BOOTSTRAP_ADMIN_PASSWORD" \
  "woo-mcp-token=$WOO_MCP_TOKEN" \
  "llm-api-key=$LLM_API_KEY" \
  "github-pat=$GITHUB_PAT"

[ -z "$LLM_API_KEY" ] && echo "WARN: LLM_API_KEY is empty in $FILE (chat agent will not work)"
echo "Secrets applied for env '$ENV' from $FILE"
