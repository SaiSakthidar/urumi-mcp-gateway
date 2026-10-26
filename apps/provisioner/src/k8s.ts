import { readFileSync } from "node:fs";
import https from "node:https";

// A tiny Kubernetes API client (no dependency): in-cluster config only, JSON in and out.
// The ServiceAccount token is re-read on every request because Kubernetes rotates it.

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const host = process.env.KUBERNETES_SERVICE_HOST;
const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";

let agent: https.Agent | undefined;
function getAgent(): https.Agent {
  agent ??= new https.Agent({ ca: readFileSync(`${SA_DIR}/ca.crt`), keepAlive: true });
  return agent;
}

export type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ApiResult {
  status: number;
  body: Obj;
}

export function api(method: string, path: string, body?: Obj): Promise<ApiResult> {
  if (!host) return Promise.reject(new Error("Not running in a cluster (KUBERNETES_SERVICE_HOST is not set)"));
  const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path,
        method,
        agent: getAgent(),
        timeout: 20_000,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Obj = {};
          try {
            parsed = text ? (JSON.parse(text) as Obj) : {};
          } catch {
            parsed = { message: text };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Kubernetes API timeout: ${method} ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fail(what: string, r: ApiResult): never {
  throw new Error(`${what} failed (${r.status}): ${String(r.body.message ?? JSON.stringify(r.body)).slice(0, 300)}`);
}

/** Create, or replace if it already exists: reconciling must be safe to repeat. */
export async function upsert(collectionPath: string, obj: Obj): Promise<void> {
  const name = String(obj.metadata?.name);
  let r = await api("POST", collectionPath, obj);
  if (r.status === 409) {
    const current = await api("GET", `${collectionPath}/${name}`);
    if (current.status !== 200) fail(`GET ${name}`, current);
    obj.metadata.resourceVersion = current.body.metadata.resourceVersion;
    // A Service's clusterIP is immutable and must be sent back unchanged.
    if (obj.kind === "Service" && current.body.spec?.clusterIP) obj.spec.clusterIP = current.body.spec.clusterIP;
    r = await api("PUT", `${collectionPath}/${name}`, obj);
  }
  if (r.status >= 300) fail(`apply ${obj.kind ?? ""} ${name}`, r);
}

/** Create only if missing; never overwrites (used for generated secrets, which must stay stable). */
export async function createIfMissing(collectionPath: string, obj: Obj): Promise<boolean> {
  const r = await api("POST", collectionPath, obj);
  if (r.status === 409) return false;
  if (r.status >= 300) fail(`create ${obj.kind ?? ""} ${String(obj.metadata?.name)}`, r);
  return true;
}

export async function remove(path: string): Promise<void> {
  const r = await api("DELETE", `${path}${path.includes("?") ? "&" : "?"}propagationPolicy=Background`);
  if (r.status >= 300 && r.status !== 404) fail(`DELETE ${path}`, r);
}

export async function get(path: string): Promise<Obj | undefined> {
  const r = await api("GET", path);
  if (r.status === 404) return undefined;
  if (r.status >= 300) fail(`GET ${path}`, r);
  return r.body;
}

export const paths = {
  namespaces: "/api/v1/namespaces",
  secrets: (ns: string) => `/api/v1/namespaces/${ns}/secrets`,
  services: (ns: string) => `/api/v1/namespaces/${ns}/services`,
  deployments: (ns: string) => `/apis/apps/v1/namespaces/${ns}/deployments`,
  networkPolicies: (ns: string) => `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
  roleBindings: (ns: string) => `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
};

/**
 * Lets the provisioner act inside one namespace it manages, with the urumi-store-admin role
 * (namespaced permissions only). The ClusterRole only permits binding that one role.
 */
export async function bindStoreAdmin(namespace: string): Promise<void> {
  await upsert(paths.roleBindings(namespace), {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: "urumi-provisioner", namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "urumi-store-admin" },
    subjects: [{ kind: "ServiceAccount", name: "provisioner", namespace: process.env.POD_NAMESPACE ?? "platform" }],
  });
  await waitForAccess(namespace);
}

/**
 * A new RoleBinding is not effective at once: the API server's authorizer needs a moment to
 * see it, and acting too soon fails with 403. Ask the API server whether we are allowed yet,
 * and carry on only when it says yes.
 */
async function waitForAccess(namespace: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { namespace, verb: "create", resource: "secrets" } },
    });
    if (r.status < 300 && r.body.status?.allowed === true) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for permissions in namespace ${namespace} to take effect`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
