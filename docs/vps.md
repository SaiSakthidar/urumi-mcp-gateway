# Production-like deployment: k3s on a VPS

The same three Helm charts deploy unchanged. Every difference from local lives in `charts/*/values-prod.yaml` and in the Secrets.

## What changes between local and prod

| Concern | Local (kind) | Prod (k3s VPS) | Where |
|---|---|---|---|
| Domain | `*.127.0.0.1.sslip.io` | `*.<VPS_IP>.sslip.io` or a real domain | `domain` in store + platform values, `wooMcp.store.publicHost` |
| Scheme / TLS | http, no TLS | https via cert-manager + Let's Encrypt | `scheme`, `ingress.tls.*` |
| Ingress controller | Traefik installed by `scripts/kind-up.sh` (ns `traefik`) | Traefik bundled with k3s (ns `kube-system`) | `networkPolicy.ingressController.namespace` |
| Storage class | `standard` (kind local-path) | `local-path` (k3s) | `persistence.storageClass` |
| Images | `urumi/<app>:dev`, loaded with `kind load`, `pullPolicy: Never` | `ghcr.io/<user>/urumi-<app>:<version>`, pinned tag | `*.image.*` |
| Secrets | `scripts/create-secrets.sh local` (random values) | `scripts/create-secrets.sh prod` (random values + your LLM key) | `.secrets/<env>.env`, never committed |
| Cookies | not `Secure` | `Secure` (derived from https `PUBLIC_URL`) | automatic |
| Resources | small requests | slightly larger WordPress requests | `*.resources` |

Templates, probes, NetworkPolicies and Secret names are identical in both environments.

## Steps

**1. VPS.** Ubuntu 24.04, at least 2 vCPU / 4 GB RAM (8 GB is comfortable), ports 80 and 443 open. ARM is fine: images are built for amd64 and arm64.

**2. k3s and Helm.**

```bash
curl -sfL https://get.k3s.io | sh -
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER ~/.kube/config
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

k3s ships Traefik (ingress), local-path (storage), CoreDNS, metrics-server and a NetworkPolicy controller, so nothing else is required.

**3. TLS (optional).**

```bash
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
# set your email in the file first
kubectl apply -f deploy/cert-manager/cluster-issuer.yaml
```

If you skip TLS, set `scheme: http` and `ingress.tls.enabled: false` in the store and platform `values-prod.yaml`. sslip.io names share Let's Encrypt rate limits with everyone else; use a real domain if issuance fails.

**4. Images.** From your machine:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u <user> --password-stdin
make push REGISTRY=ghcr.io/<user> TAG=0.1.0
```

Make the four GHCR packages public (simplest), or add an `imagePullSecret`.

**5. Values.** In the three `values-prod.yaml` files, replace `<VPS_IP>` and `<GHCR_USER>`, and set the image tag you pushed.

**6. Secrets.** On the VPS (or anywhere with its kubeconfig):

```bash
make secrets ENV=prod                 # creates .secrets/prod.env with random values
# edit .secrets/prod.env: set LLM_API_KEY
make secrets ENV=prod                 # apply again
```

Back up `.secrets/prod.env` somewhere safe. It holds the key that decrypts upstream credentials.

**7. Deploy.**

```bash
make deploy ENV=prod
kubectl get pods -A
```

Open `https://shop.<VPS_IP>.sslip.io` and `https://app.<VPS_IP>.sslip.io`.

## Gotchas

- **WordPress behind TLS:** Traefik terminates TLS and forwards plain http. The chart's `WORDPRESS_CONFIG_EXTRA` trusts `X-Forwarded-Proto: https`, so WordPress builds https links without redirect loops.
- **woo-mcp signatures:** woo-mcp signs requests against the store's public host over http (internal calls are not SSL). If tools fail with 401, check that `wooMcp.store.publicHost` equals the store's host exactly.
- **Single node:** WordPress and the setup Job share a ReadWriteOnce volume, which works because there is one node.

See [operations.md](operations.md) for upgrades and rollbacks.
