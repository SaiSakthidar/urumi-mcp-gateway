#!/usr/bin/env bash
# End-to-end checks against a running deployment (kind or k3s). It drives the same HTTP
# APIs a user or an MCP client would, so it exercises the real stack, not mocks.
#
#   APP=http://app.1.2.3.4.sslip.io ADMIN_PASSWORD=... \
#   KUBECTL="ssh -i ~/.ssh/urumi-aws ubuntu@1.2.3.4 sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl" \
#   ./scripts/e2e.sh [phase ...]
#
# Phases (default: all, in this order):
#   core    login, API key, woo tools, permissions, revoke
#   search  ?tools=search, search_tools, run_tool
#   oauth   discovery, register, authorize (PKCE), token, refresh rotation, reuse is rejected
#   rate    exceed the per-key limit, see rate_limited
#   hosted  host an image: rejects bad images, deploys, calls it, removes it
#   store   provision a store, call its tools, prove isolation, delete it
#   recover restart the provisioner in the middle of an install; the store must still become Ready
#
# KUBECTL is only needed for the hosted and store phases (to inspect the cluster). Requires curl and python3.
set -uo pipefail

: "${APP:?APP is the dashboard URL, e.g. http://app.1.2.3.4.sslip.io}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is the bootstrap admin password}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@urumi.local}"
KUBECTL="${KUBECTL:-kubectl}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
check() { # check "name" <condition command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
has() { grep -q -- "$1" <<<"$2"; }                       # has PATTERN TEXT
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

H=(-H "X-Requested-With: urumi-dashboard" -H "Content-Type: application/json")
api()  { curl -sS -m 60 "${H[@]}" -b "$JAR" -c "$JAR" "$@"; }       # api [-X M] URL [-d body]
mcp()  { # mcp KEY JSON [query]
  curl -sS -m 90 "$APP/mcp${3:-}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $1" -d "$2"
}
call() { # call KEY tool-name json-args
  mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":${3:-{\}}}}"
}
names() { json "' '.join(sorted(t['name'] for t in d['result']['tools']))"; }
wait_for() { # wait_for SECONDS "description" command...
  local limit="$1" what="$2"; shift 2
  local end=$((SECONDS+limit))
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -ge $end ] && { bad "timed out waiting for: $what"; return 1; }
    sleep 5
  done
  return 0
}

login() {
  api -X POST "$APP/api/auth/login" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | grep -q '"ok":true'
}
new_key() { api -X POST "$APP/api/keys" -d "{\"name\":\"e2e-$1-$RANDOM\"}" | json "d['key']"; }

phase_core() {
  echo "== core"
  check "admin can log in" login
  KEY=$(new_key core)
  check "API key issued" test -n "$KEY"
  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'woo__list_products' "$out" && ok "tools/list shows woo tools" || bad "tools/list shows woo tools" "$out"
  out=$(call "$KEY" woo__list_products)
  has 'Urumi' "$out" && ok "woo__list_products returns store data" || bad "woo__list_products returns store data" "$out"
  out=$(curl -sS -m 30 -i "$APP/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer bogus" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has ' 401' "$out" && has 'resource_metadata' "$out" && ok "bad key -> 401 with OAuth discovery hint" || bad "bad key -> 401 with discovery hint"
  # Revocation
  # A key looks like urumi_<prefix>_<secret>; the prefix identifies it in the key list.
  pfx=$(cut -d_ -f2 <<<"$KEY")
  id=$(api "$APP/api/keys" | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x['prefix']==sys.argv[1]][0]['id'])" "$pfx")
  api -X DELETE "$APP/api/keys/$id" >/dev/null
  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'revoked' "$out" && ok "revoked key is rejected at once" || bad "revoked key is rejected at once" "$out"
}

phase_search() {
  echo "== tool search"
  login; KEY=$(new_key search)
  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "?tools=search")
  [ "$(names <<<"$out")" = "run_tool search_tools" ] && ok "?tools=search lists only run_tool and search_tools" || bad "?tools=search lists only the two meta tools" "$(names <<<"$out")"
  out=$(call "$KEY" search_tools '{"query":"orders"}')
  has 'woo__list_orders' "$out" && ok "search_tools finds woo__list_orders" || bad "search_tools finds woo__list_orders" "$out"
  out=$(call "$KEY" run_tool '{"name":"woo__list_orders","arguments":{"date":"today"}}')
  has 'count' "$out" && has 'orders' "$out" && ok "run_tool runs it" || bad "run_tool runs it" "$out"
  out=$(call "$KEY" run_tool '{"name":"nope__x","arguments":{}}')
  has 'Unknown server' "$out" && ok "run_tool still rejects unknown servers" || bad "run_tool rejects unknown servers" "$out"
  rows=$(api "$APP/api/audit?limit=20")
  has 'run_tool\|list_orders' "$rows" && ok "the real tool call is in the audit log" || bad "audit has the real tool call"
}

b64url() { python3 -c "import sys,base64; print(base64.urlsafe_b64encode(sys.stdin.buffer.read()).rstrip(b'=').decode())"; }

phase_oauth() {
  echo "== OAuth"
  out=$(curl -sS -m 30 "$APP/.well-known/oauth-protected-resource")
  has 'authorization_servers' "$out" && ok "protected-resource metadata" || bad "protected-resource metadata" "$out"
  out=$(curl -sS -m 30 "$APP/.well-known/oauth-authorization-server")
  has 'S256' "$out" && ok "authorization-server metadata advertises S256" || bad "authorization-server metadata" "$out"

  out=$(curl -sS -m 30 -X POST "$APP/oauth/register" -H "Content-Type: application/json" -d '{"client_name":"e2e client","redirect_uris":["http://evil.example.com/cb"]}')
  has 'invalid_redirect_uri' "$out" && ok "plain-http non-loopback redirect is refused" || bad "plain-http redirect refused" "$out"
  CID=$(curl -sS -m 30 -X POST "$APP/oauth/register" -H "Content-Type: application/json" -d '{"client_name":"e2e client","redirect_uris":["http://localhost:9/cb"]}' | json "d['client_id']")
  check "client registered" test -n "$CID"

  VER=$(head -c 48 /dev/urandom | b64url)
  CHAL=$(printf '%s' "$VER" | python3 -c "import sys,hashlib,base64; print(base64.urlsafe_b64encode(hashlib.sha256(sys.stdin.buffer.read()).digest()).rstrip(b'=').decode())")
  Q="response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9%2Fcb&code_challenge=$CHAL&code_challenge_method=S256&state=xyz"

  out=$(curl -sS -m 30 "$APP/oauth/authorize?$Q")
  has 'Connect e2e client' "$out" && ok "consent page names the client" || bad "consent page" "${out:0:200}"
  out=$(curl -sS -m 30 "$APP/oauth/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9%2Fcb")
  has 'PKCE' "$out" && ok "request without PKCE is refused" || bad "request without PKCE refused"
  out=$(curl -sS -m 30 "$APP/oauth/authorize?${Q/localhost%3A9/localhost%3A10}")
  has 'not registered' "$out" && ok "unregistered redirect_uri is refused (no open redirect)" || bad "unregistered redirect_uri refused"

  loc=$(curl -sS -m 30 -o /dev/null -D - -X POST "$APP/oauth/authorize" -d "$(echo "$Q" | sed 's/&/\&/g')&decision=allow&email=$ADMIN_EMAIL&password=wrong" | tr -d '\r')
  has '401' "$loc" && ok "wrong password does not issue a code" || bad "wrong password rejected" "$loc"
  loc=$(curl -sS -m 30 -o /dev/null -D - -X POST "$APP/oauth/authorize" -d "$Q&decision=allow&email=$ADMIN_EMAIL&password=$ADMIN_PASSWORD" | tr -d '\r' | grep -i '^location:' | awk '{print $2}')
  CODE=$(python3 -c "import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$loc")
  check "login + Allow redirects back with a code and the state" bash -c "[[ '$loc' == http://localhost:9/cb?* && '$loc' == *state=xyz* && -n '$CODE' ]]"

  tok() { curl -sS -m 30 -X POST "$APP/oauth/token" -d "$1"; }
  out=$(tok "grant_type=authorization_code&client_id=$CID&code=$CODE&redirect_uri=http://localhost:9/cb&code_verifier=wrong-verifier")
  has 'invalid_grant' "$out" && ok "wrong PKCE verifier is rejected" || bad "wrong verifier rejected" "$out"
  # That attempt consumed the code (single use), so get a fresh one for the real exchange.
  loc=$(curl -sS -m 30 -o /dev/null -D - -X POST "$APP/oauth/authorize" -d "$Q&decision=allow&email=$ADMIN_EMAIL&password=$ADMIN_PASSWORD" | tr -d '\r' | grep -i '^location:' | awk '{print $2}')
  CODE=$(python3 -c "import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$loc")
  out=$(tok "grant_type=authorization_code&client_id=$CID&code=$CODE&redirect_uri=http://localhost:9/cb&code_verifier=$VER")
  AT=$(json "d['access_token']" <<<"$out"); RT=$(json "d['refresh_token']" <<<"$out")
  check "code + correct verifier gives tokens" test -n "$AT" -a -n "$RT"
  out=$(tok "grant_type=authorization_code&client_id=$CID&code=$CODE&redirect_uri=http://localhost:9/cb&code_verifier=$VER")
  has 'invalid_grant' "$out" && ok "authorization code is single-use" || bad "code single-use" "$out"

  out=$(mcp "$AT" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'woo__list_products' "$out" && ok "OAuth access token works on /mcp" || bad "access token works on /mcp" "$out"
  out=$(call "$AT" woo__list_orders '{"date":"today"}')
  has 'count' "$out" && has 'orders' "$out" && ok "tool call with an OAuth token" || bad "tool call with OAuth token" "$out"

  out=$(tok "grant_type=refresh_token&client_id=$CID&refresh_token=$RT")
  AT2=$(json "d['access_token']" <<<"$out"); RT2=$(json "d['refresh_token']" <<<"$out")
  check "refresh token gives new tokens" test -n "$AT2" -a "$RT2" != "$RT"
  out=$(tok "grant_type=refresh_token&client_id=$CID&refresh_token=$RT")
  has 'invalid_grant' "$out" && ok "old refresh token is dead after rotation" || bad "refresh rotation" "$out"
}

phase_rate() {
  echo "== rate limit"
  login; KEY=$(new_key rate)
  limit=$($KUBECTL -n platform get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RATE_LIMIT_PER_MINUTE")].value}' 2>/dev/null || echo 120)
  limit=${limit:-120}
  n=$((limit + 25))
  # Windows are fixed one-minute buckets: start the burst early in a minute so it cannot straddle two.
  sec=$((10#$(date +%S))); [ "$sec" -gt 30 ] && { echo "  (waiting $((61 - sec))s for the next minute window)"; sleep $((61 - sec)); }
  tmp=$(mktemp)
  export -f call mcp; export APP KEY
  seq "$n" | xargs -P 20 -I{} bash -c 'call "$KEY" woo__list_products 2>/dev/null | grep -o "Rate limit[^\"]*" | head -c 60; echo' >"$tmp"
  limited=$(grep -c "Rate limit" "$tmp"); rm -f "$tmp"
  [ "$limited" -ge 1 ] && ok "$limited of $n calls rejected once past $limit/min" || bad "no call was rate limited ($n sent, limit $limit)"
  rows=$(api "$APP/api/audit?outcome=rate_limited&limit=5")
  has 'rate_limited' "$rows" && ok "rate_limited is in the audit log" || bad "audit has rate_limited"
  stats=$(api "$APP/api/stats")
  has '"server"' "$stats" && ok "stats API reports per-server numbers" || bad "stats API" "$stats"
}

phase_hosted() {
  echo "== hosted server"
  login
  body() { printf '{"slug":"%s","displayName":"Hosted test","image":"%s","port":3001}' "$1" "$2"; }
  out=$(api -X POST "$APP/api/servers/hosted" -d "$(body bad1 urumi/everything-mcp:latest)")
  has 'Pin the image' "$out" && ok "image tagged :latest is rejected" || bad ":latest rejected" "$out"
  out=$(api -X POST "$APP/api/servers/hosted" -d "$(body bad2 evil.example.com/x:1.0)")
  has 'not allowed' "$out" && ok "registry off the allowlist is rejected" || bad "registry allowlist" "$out"

  out=$(api -X POST "$APP/api/servers/hosted" -d "$(body hostedt urumi/everything-mcp:dev)")
  has '"id"' "$out" && ok "hosted server accepted" || { bad "hosted server accepted" "$out"; return; }
  st() { api "$APP/api/servers" | python3 -c "import json,sys; s=[x for x in json.load(sys.stdin) if x['slug']=='hostedt']; print(s[0]['hosted']['deployStatus'], s[0]['status']) if s else print('none')"; }
  for _ in $(seq 60); do [ "$(st)" = "running connected" ] && break; sleep 4; done
  [ "$(st)" = "running connected" ] && ok "provisioner deployed it; gateway sees it connected" || bad "hosted server running+connected" "$(st)"

  KEY=$(new_key hosted)
  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'hostedt__echo' "$out" && ok "its tools appear as hostedt__*" || bad "hosted tools listed"
  out=$(call "$KEY" hostedt__echo '{"message":"hi"}')
  has 'Echo: hi' "$out" && ok "tool call reaches the hosted pod" || bad "hosted tool call" "$out"

  if [ "$KUBECTL" != "kubectl" ] || command -v kubectl >/dev/null; then
    pod=$($KUBECTL -n mcp-hosted get deploy hs-hostedt -o jsonpath='{.spec.template.spec}' 2>/dev/null)
    has '"runAsNonRoot":true' "$pod" && has '"readOnlyRootFilesystem":true' "$pod" && ok "pod is non-root with a read-only root filesystem" || bad "pod hardening"
    has '"automountServiceAccountToken":false' "$pod" && ok "no service-account token mounted" || bad "no SA token"
    np=$($KUBECTL -n mcp-hosted get netpol -o name 2>/dev/null | tr '\n' ' ')
    has 'default-deny' "$np" && has 'hs-hostedt' "$np" && ok "default-deny plus a per-server NetworkPolicy" || bad "netpols" "$np"
    # A hosted pod must not be reachable from another namespace's pods, nor reach the store.
    out=$($KUBECTL -n mcp-hosted exec deploy/hs-hostedt -- node -e "fetch('http://wordpress.store.svc.cluster.local',{signal:AbortSignal.timeout(4000)}).then(r=>console.log('REACHED')).catch(e=>console.log('blocked'))" 2>&1)
    has 'blocked' "$out" && ok "hosted pod cannot reach the store (default-deny egress)" || bad "hosted egress blocked" "$out"
  fi

  id=$(api "$APP/api/servers" | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x['slug']=='hostedt'][0]['id'])")
  api -X DELETE "$APP/api/servers/$id" >/dev/null
  gone() { api "$APP/api/servers" | python3 -c "import json,sys; import sys; sys.exit(0 if not [x for x in json.load(sys.stdin) if x['slug']=='hostedt'] else 1)"; }
  for _ in $(seq 40); do gone && break; sleep 3; done
  gone && ok "removing it deletes the server and its tools" || bad "hosted server removed"
  if command -v kubectl >/dev/null || [ "$KUBECTL" != kubectl ]; then
    left=$($KUBECTL -n mcp-hosted get deploy,svc,secret,netpol -o name 2>/dev/null | grep hs-hostedt || true)
    [ -z "$left" ] && ok "its Deployment, Service, Secret and NetworkPolicy are gone" || bad "hosted resources cleaned up" "$left"
  fi
}

phase_store() {
  echo "== store provisioning"
  login; KEY=$(new_key store)
  sts() { api "$APP/api/stores" | python3 -c "import json,sys; s=[x for x in json.load(sys.stdin) if x['slug']=='acmetest']; print(s[0]['status']+'|'+(s[0]['statusDetail'] or '')) if s else print('none|')"; }
  if [ "$(sts)" = "none|" ]; then
    out=$(api -X POST "$APP/api/stores" -d '{"name":"Acme Test","slug":"acmetest"}')
    has '"slug":"acmetest"' "$out" && ok "store creation accepted (202)" || { bad "store creation accepted" "$out"; return; }
    out=$(api -X POST "$APP/api/stores" -d '{"name":"Acme Test","slug":"acmetest"}')
    has 'already exists' "$out" && ok "creating the same store again is a clean 409" || bad "duplicate store -> 409" "$out"
  else
    echo "  (store acmetest already exists from an earlier run: reusing it)"
  fi
  echo "  ... provisioning (WordPress + WooCommerce install takes a few minutes)"
  last=""
  for _ in $(seq 240); do
    cur=$(sts); [ "$cur" != "$last" ] && { echo "      status: ${cur%%|*}"; last=$cur; }
    case "$cur" in ready*|failed*) break;; esac
    sleep 5
  done
  case "$cur" in
    ready*) ok "store reached Ready";;
    *) bad "store reached Ready" "$cur"; return;;
  esac

  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'acmetest__list_orders' "$out" && ok "store's tools registered automatically as acmetest__*" || bad "store tools registered" "$(names <<<"$out")"
  out=$(call "$KEY" acmetest__list_products)
  has 'Urumi' "$out" && ok "store's own MCP server reads its own catalog" || bad "store tool call" "$out"
  out=$(call "$KEY" acmetest__create_product '{"name":"Only In Acme","regular_price":"10"}')
  out2=$(call "$KEY" woo__list_products)
  has 'Only In Acme' "$out2" && bad "stores are isolated (product leaked into woo)" || ok "a product created in acmetest does not appear in woo"

  ns=store-acmetest
  if command -v kubectl >/dev/null || [ "$KUBECTL" != kubectl ]; then
    has 'ResourceQuota\|store-quota' "$($KUBECTL -n $ns get resourcequota -o name 2>&1)" && ok "ResourceQuota applied to the namespace" || bad "ResourceQuota"
    has 'store-limits' "$($KUBECTL -n $ns get limitrange -o name 2>&1)" && ok "LimitRange applied" || bad "LimitRange"
    has 'mariadb' "$($KUBECTL -n $ns get pvc -o name 2>&1)" || has 'wordpress-data' "$($KUBECTL -n $ns get pvc -o name 2>&1)" && ok "own persistent volumes" || bad "PVCs"
    has 'woo-mcp' "$($KUBECTL -n $ns get secret -o name 2>&1)" && ok "own Secrets (db, admin, wc-api, woo-mcp)" || bad "Secrets"
    # Isolation: this store's MCP server may reach only its own WordPress.
    probe() { $KUBECTL -n $ns exec deploy/woo-mcp -- node -e "fetch('$1',{signal:AbortSignal.timeout(4000)}).then(r=>console.log('REACHED '+r.status)).catch(e=>console.log('blocked'))" 2>&1; }
    has 'REACHED' "$(probe http://wordpress)" && ok "its woo-mcp reaches its own WordPress" || bad "own WordPress reachable"
    has 'blocked' "$(probe http://wordpress.store.svc.cluster.local)" && ok "its woo-mcp cannot reach the main store's WordPress" || bad "isolation from main WordPress"
    has 'blocked' "$(probe http://mariadb.store.svc.cluster.local:3306)" && ok "nor the main store's MariaDB" || bad "isolation from main MariaDB"
    has 'blocked' "$(probe http://mariadb:3306)" && ok "nor even its own database (only WordPress may)" || bad "own MariaDB blocked for woo-mcp"
  fi

  if [ -n "${LLM_CHECK:-1}" ]; then
    out=$(api -X POST "$APP/api/chat" -d '{"messages":[{"role":"user","content":"Compare how many products the woo store and the acmetest store have. Use the tools."}]}')
    calls=$(json "' '.join(t['name'] for t in d.get('toolCalls',[]))" <<<"$out")
    has 'woo__' "$calls" && has 'acmetest__' "$calls" && ok "chat agent called tools of both stores ($calls)" || bad "chat compares two stores" "${out:0:300}"
  fi

  api -X DELETE "$APP/api/stores/$(api "$APP/api/stores" | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x['slug']=='acmetest'][0]['id'])")" >/dev/null
  for _ in $(seq 120); do [ "$(sts)" = "none|" ] && break; sleep 5; done
  [ "$(sts)" = "none|" ] && ok "delete removed the store record" || bad "store deleted" "$(sts)"
  out=$(mcp "$KEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  has 'acmetest__' "$out" && bad "its tools are gone" || ok "its tools are gone from the tool list"
  if command -v kubectl >/dev/null || [ "$KUBECTL" != kubectl ]; then
    has 'NotFound\|not found' "$($KUBECTL get ns $ns 2>&1)" && ok "namespace (volumes, Secrets, everything in it) is gone" || bad "namespace removed" "$($KUBECTL get ns $ns 2>&1 | tail -1)"
  fi
}

phase_recover() {
  echo "== provisioner restart mid-install"
  login
  sts() { api "$APP/api/stores" | python3 -c "import json,sys; s=[x for x in json.load(sys.stdin) if x['slug']=='recov']; print(s[0]['status']+'|'+(s[0]['statusDetail'] or '')) if s else print('none|')"; }
  api -X POST "$APP/api/stores" -d '{"name":"Recovery Test","slug":"recov"}' | grep -q '"slug":"recov"' && ok "store creation accepted" || { bad "store creation accepted"; return; }
  # Wait until the install is genuinely under way (the store's workloads exist), then kill the provisioner.
  for _ in $(seq 60); do [ "$($KUBECTL -n store-recov get deploy,sts -o name 2>/dev/null | wc -l)" -gt 0 ] && break; sleep 3; done
  case "$(sts)" in failed*) bad "no permission race: the store must not fail before the restart" "$(sts)"; return;; esac
  $KUBECTL -n platform delete pod -l app.kubernetes.io/name=provisioner --wait=false >/dev/null 2>&1
  ok "provisioner pod killed mid-install"
  cur=""
  for _ in $(seq 240); do cur=$(sts); case "$cur" in ready*|failed*) break;; esac; sleep 5; done
  case "$cur" in
    ready*) ok "the store still reached Ready after the restart (resumed, not duplicated)";;
    *) bad "the store reached Ready after a provisioner restart" "$cur";;
  esac
  [ "$($KUBECTL -n store-recov get deploy wordpress -o name 2>/dev/null | wc -l)" = 1 ] && ok "exactly one WordPress deployment (no duplicate install)" || bad "single install"
  id=$(api "$APP/api/stores" | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x['slug']=='recov'][0]['id'])")
  api -X DELETE "$APP/api/stores/$id" >/dev/null
  for _ in $(seq 120); do [ "$(sts)" = "none|" ] && break; sleep 5; done
  [ "$(sts)" = "none|" ] && ok "cleaned up" || bad "cleaned up" "$(sts)"
}

PHASES=("$@"); [ ${#PHASES[@]} -eq 0 ] && PHASES=(core search oauth rate hosted store recover)
for p in "${PHASES[@]}"; do "phase_$p"; done
echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
