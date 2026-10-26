import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { pool } from "./db.js";
import { bindStoreAdmin, get, paths, remove, upsert, type Obj } from "./k8s.js";

// Hosted MCP servers: an admin gives a container image, this runs it.
//
// Per server <slug>, in the hosted namespace, all named hs-<slug>:
//   Secret         the env vars (encrypted in Postgres, plaintext only here and in the pod)
//   Deployment     non-root, read-only root filesystem, no capabilities, no ServiceAccount token,
//                  requests and limits, probes
//   Service        ClusterIP, internal only; there is deliberately no Ingress
//   NetworkPolicy  ingress only from the gateway pods; egress DNS only, plus public
//                  internet when the admin ticked "allow internet"
// The namespace has a default-deny policy and the "restricted" Pod Security level, so a
// compromised or careless image has nowhere to go even if it misbehaves.

const LABEL = "urumi.io/hosted";
const name = (slug: string) => `hs-${slug}`;

interface HostedRow {
  upstream_id: number;
  slug: string;
  image: string;
  port: number;
  env_ciphertext: Buffer | null;
  env_iv: Buffer | null;
  allow_internet: boolean;
  status: string;
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"];

export async function ensureHostedNamespace(): Promise<void> {
  const ns = config.hostedNamespace;
  await upsert(paths.namespaces, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: ns,
      labels: {
        "app.kubernetes.io/part-of": "urumi",
        "urumi.io/mcp-network": "true", // lets the gateway's egress policy select this namespace
        "pod-security.kubernetes.io/enforce": "restricted",
      },
    },
  });
  await bindStoreAdmin(ns);
  await upsert(paths.networkPolicies(ns), {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "default-deny", namespace: ns },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  });
}

function labels(slug: string): Obj {
  return { "app.kubernetes.io/part-of": "urumi", "app.kubernetes.io/name": name(slug), [LABEL]: slug };
}

function manifests(row: HostedRow, env: Record<string, string>) {
  const ns = config.hostedNamespace;
  const n = name(row.slug);
  const secret: Obj = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: n, namespace: ns, labels: labels(row.slug) },
    type: "Opaque",
    stringData: env,
  };
  const deployment: Obj = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: n, namespace: ns, labels: labels(row.slug) },
    spec: {
      replicas: 1,
      progressDeadlineSeconds: 300,
      selector: { matchLabels: { "app.kubernetes.io/name": n } },
      template: {
        metadata: { labels: labels(row.slug) },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "server",
              image: row.image,
              imagePullPolicy: "IfNotPresent",
              ports: [{ name: "mcp", containerPort: row.port }],
              env: [{ name: "PORT", value: String(row.port) }],
              envFrom: Object.keys(env).length ? [{ secretRef: { name: n } }] : [],
              readinessProbe: { tcpSocket: { port: "mcp" }, periodSeconds: 10, failureThreshold: 3 },
              livenessProbe: { tcpSocket: { port: "mcp" }, initialDelaySeconds: 20, periodSeconds: 20 },
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
        },
      },
    },
  };
  const service: Obj = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: n, namespace: ns, labels: labels(row.slug) },
    spec: { type: "ClusterIP", selector: { "app.kubernetes.io/name": n }, ports: [{ name: "mcp", port: row.port, targetPort: "mcp" }] },
  };
  const egress: Obj[] = [
    {
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
      ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
    },
  ];
  if (row.allow_internet) {
    egress.push({
      to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE_RANGES } }],
      ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 80 }],
    });
  }
  const networkPolicy: Obj = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: n, namespace: ns, labels: labels(row.slug) },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": n } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": config.gatewayNamespace } },
              podSelector: { matchLabels: { "app.kubernetes.io/name": config.gatewayPodLabel } },
            },
          ],
          ports: [{ protocol: "TCP", port: row.port }],
        },
      ],
      egress,
    },
  };
  return { secret, deployment, service, networkPolicy };
}

async function setStatus(id: number, status: string, detail: string | null): Promise<void> {
  await pool.query(
    "UPDATE hosted_servers SET status = $2, status_detail = $3, updated_at = now() WHERE upstream_id = $1 AND (status <> $2 OR status_detail IS DISTINCT FROM $3)",
    [id, status, detail],
  );
}

async function apply(row: HostedRow): Promise<void> {
  const ns = config.hostedNamespace;
  const env = row.env_ciphertext && row.env_iv ? (JSON.parse(decrypt(row.env_ciphertext, row.env_iv)) as Record<string, string>) : {};
  const m = manifests(row, env);
  await upsert(paths.secrets(ns), m.secret);
  await upsert(paths.deployments(ns), m.deployment);
  await upsert(paths.services(ns), m.service);
  await upsert(paths.networkPolicies(ns), m.networkPolicy);

  const d = await get(`${paths.deployments(ns)}/${name(row.slug)}`);
  const available = Number(d?.status?.availableReplicas ?? 0) >= 1;
  const stuck = (d?.status?.conditions as Obj[] | undefined)?.find((c) => c.type === "Progressing" && c.status === "False");
  if (available) await setStatus(row.upstream_id, "running", null);
  else if (stuck) await setStatus(row.upstream_id, "failed", String(stuck.message ?? "deployment did not become ready").slice(0, 500));
  else await setStatus(row.upstream_id, "deploying", null);
}

async function teardown(row: HostedRow): Promise<void> {
  const ns = config.hostedNamespace;
  const n = name(row.slug);
  await remove(`${paths.networkPolicies(ns)}/${n}`);
  await remove(`${paths.services(ns)}/${n}`);
  await remove(`${paths.deployments(ns)}/${n}`);
  await remove(`${paths.secrets(ns)}/${n}`);
  // Cascades to hosted_servers. The gateway's registry reload drops it from the tool list.
  await pool.query("DELETE FROM upstreams WHERE id = $1 AND kind = 'hosted'", [row.upstream_id]);
  console.log(`hosted server ${row.slug}: removed`);
}

export async function reconcileHosted(): Promise<void> {
  const { rows } = await pool.query<HostedRow>(
    `SELECT h.upstream_id, u.slug, h.image, h.port, h.env_ciphertext, h.env_iv, h.allow_internet, h.status
       FROM hosted_servers h JOIN upstreams u ON u.id = h.upstream_id`,
  );
  for (const row of rows) {
    try {
      if (row.status === "deleting") await teardown(row);
      else await apply(row);
    } catch (err) {
      console.error(`hosted server ${row.slug}: reconcile failed`, err);
      if (row.status !== "deleting") await setStatus(row.upstream_id, "failed", err instanceof Error ? err.message.slice(0, 500) : "reconcile failed");
    }
  }
}
