import { execFile } from "node:child_process";

// Thin wrapper around the helm binary. execFile with an argument array, never a shell,
// so nothing user-supplied is ever parsed as shell syntax.

export interface HelmResult {
  ok: boolean;
  output: string;
}

export function helm(args: string[], timeoutMs: number): Promise<HelmResult> {
  return new Promise((resolve) => {
    execFile("helm", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, HOME: "/tmp" } }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

/** helm status of a release: undefined if it does not exist. */
export async function releaseStatus(release: string, namespace: string): Promise<string | undefined> {
  const r = await helm(["status", release, "-n", namespace, "-o", "json"], 30_000);
  if (!r.ok) return undefined;
  try {
    return (JSON.parse(r.output) as { info?: { status?: string } }).info?.status;
  } catch {
    return undefined;
  }
}
