import { useEffect, useState } from "react";

// Same-origin calls to the gateway (Ingress routes /api to it). The session
// cookie is sent automatically; the custom header is the gateway's CSRF check.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "urumi-dashboard",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch `path` on mount (and every `intervalMs` if set). `reload()` refetches now. */
export function useApi<T>(path: string | null, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}
