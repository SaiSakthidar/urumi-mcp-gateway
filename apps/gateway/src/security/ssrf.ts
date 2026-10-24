import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { config } from "../config.js";

// SSRF guard for admin-supplied upstream URLs.
//
// The gateway sits inside the cluster, so a URL like http://postgres.platform.svc
// or http://169.254.169.254/ (cloud metadata) would let anyone who can register a
// server probe internal services through it. Rules:
//   - hosts in ALLOWED_INTERNAL_HOSTS (our own in-cluster MCP servers) are allowed
//   - cluster-internal / local names are rejected outright
//   - every address the name resolves to must be public
// Checked when an upstream is saved AND before every (re)connect (DNS can change),
// and the client refuses HTTP redirects. The egress NetworkPolicy on the gateway
// pod is the second layer: it blocks private ranges even if this check is bypassed.

const blocked = new BlockList();
const V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

export class SsrfError extends Error {}

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4-mapped IPv6
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

function isInternalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".svc") ||
    host.includes(".svc.") ||
    host.endsWith(".cluster.local") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

export async function assertSafeUpstreamUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (config.allowedInternalHosts.includes(host)) return;
  if (isInternalName(host)) throw new SsrfError(`"${host}" is a cluster-internal or local name`);

  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new SsrfError(`Could not resolve "${host}"`);
      });

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`"${host}" resolves to ${address}, which is a private or internal address`);
    }
  }
}
