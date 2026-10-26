import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

// Same AES-256-GCM scheme and key as the gateway (apps/gateway/src/security/crypto.ts):
// the gateway encrypts hosted-server env vars and store tokens, the provisioner reads
// and writes them. Layout: ciphertext || 16-byte auth tag, with a separate 12-byte IV.

const key = Buffer.from(config.encryptionKey, "base64");
if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
const TAG_BYTES = 16;

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

export function decrypt(ciphertext: Buffer, iv: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
