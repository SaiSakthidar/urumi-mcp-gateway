import { config } from "../config.js";

// Container image rules for hosted MCP servers. An admin supplies an image
// reference and the platform runs it in the cluster, so:
//   - the registry must be on the allowlist (no arbitrary hosts to pull from)
//   - the image must be pinned to a tag other than "latest", or to a digest, so
//     what runs is what was reviewed
// The pod itself is also locked down by the provisioner: non-root, read-only
// filesystem, no capabilities, no service-account token, default-deny network.

export class ImageError extends Error {}

export function parseImage(ref: string): { registry: string; pinned: boolean } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/.test(ref)) throw new ImageError("Image reference contains invalid characters");

  const [name, digest] = ref.split("@");
  const slash = name.indexOf("/");
  const first = slash === -1 ? "" : name.slice(0, slash);
  // The first path segment is a registry only if it looks like a host (dot, port, or localhost).
  const hasRegistry = first.includes(".") || first.includes(":") || first === "localhost";
  const registry = hasRegistry ? first.toLowerCase() : "docker.io";

  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  const tag = lastSegment.includes(":") ? lastSegment.split(":")[1] : undefined;
  const pinned = Boolean(digest) || (tag !== undefined && tag !== "latest");
  return { registry, pinned };
}

export function assertAllowedImage(ref: string): void {
  const { registry, pinned } = parseImage(ref);
  const allowed = config.hostedImageRegistries;
  if (!allowed.includes("*") && !allowed.includes(registry)) {
    throw new ImageError(`Registry "${registry}" is not allowed. Allowed: ${allowed.join(", ")}`);
  }
  if (!pinned) throw new ImageError('Pin the image to a version tag (not "latest") or a digest');
}
