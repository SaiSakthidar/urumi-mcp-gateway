import { createHmac, randomBytes } from "node:crypto";

// WooCommerce only accepts Basic auth over HTTPS. Inside the cluster we call
// WordPress over plain HTTP, so requests are signed with OAuth 1.0a
// "one-legged" signatures instead (consumer key + secret, no user token).
//
// What WooCommerce verifies (class-wc-rest-authentication.php):
//   base string = METHOD & enc(url) & enc(sorted "k=v" pairs joined by "&")
//   url         = WordPress home URL + request path, scheme http (not SSL)
//   key         = consumer_secret + "&"
// It also rejects timestamps older than 15 minutes and reused nonces.

// RFC 3986 percent-encoding (encodeURIComponent leaves !'()* unescaped,
// PHP's rawurlencode does not).
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/**
 * Returns the oauth_* query parameters (including the signature) to add to a request.
 * `query` must contain every other query parameter that will be sent, since they
 * are all part of the signature. JSON bodies are not signed.
 */
export function signRequest(
  method: string,
  signingUrl: string,
  query: Record<string, string>,
  creds: OAuthCredentials,
): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };

  const all = { ...query, ...oauth };
  const normalized = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(all[k])}`)
    .join("&");

  const baseString = [method.toUpperCase(), rfc3986(signingUrl), rfc3986(normalized)].join("&");
  const signature = createHmac("sha256", `${creds.consumerSecret}&`).update(baseString).digest("base64");

  return { ...oauth, oauth_signature: signature };
}
