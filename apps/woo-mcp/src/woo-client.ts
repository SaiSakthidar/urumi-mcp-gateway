import http from "node:http";
import https from "node:https";
import { rfc3986, signRequest, type OAuthCredentials } from "./oauth1.js";

// Thin client for the WooCommerce REST API v3 (/wp-json/wc/v3).
//
// Requests go to the in-cluster Service (baseUrl), but WordPress knows itself
// by its public host, so we send that as the Host header and sign against it.

export class WooApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WooClientOptions extends OAuthCredentials {
  baseUrl: string; // e.g. http://wordpress.store.svc.cluster.local
  publicHost: string; // e.g. shop.127.0.0.1.sslip.io
  timeoutMs: number;
}

type Query = Record<string, string | number | boolean | undefined>;

export class WooClient {
  constructor(private readonly opts: WooClientOptions) {}

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, {}, body);
  }

  private request<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    const apiPath = `/wp-json/wc/v3${path}`;

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params[k] = String(v);
    }
    // WordPress signs against its home URL; internal calls are not SSL, so scheme is http.
    const oauth = signRequest(method, `http://${this.opts.publicHost}${apiPath}`, params, this.opts);
    const qs = Object.entries({ ...params, ...oauth })
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join("&");

    const url = new URL(`${apiPath}?${qs}`, this.opts.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;

    return new Promise<T>((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method,
          timeout: this.opts.timeoutMs,
          headers: {
            Host: this.opts.publicHost,
            Accept: "application/json",
            ...(payload !== undefined
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              reject(new WooApiError(res.statusCode ?? 0, `Non-JSON response from WooCommerce (HTTP ${res.statusCode})`));
              return;
            }
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const message = (json as { message?: string }).message ?? `HTTP ${status}`;
              reject(new WooApiError(status, message));
              return;
            }
            resolve(json as T);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`WooCommerce did not respond within ${this.opts.timeoutMs} ms`)));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
