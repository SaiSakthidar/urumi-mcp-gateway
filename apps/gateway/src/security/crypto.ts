import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";

const scrypt = promisify(scryptCallback) as (password: BinaryLike, salt: BinaryLike, keylen: number) => Promise<Buffer>;

// ---- Upstream credentials: AES-256-GCM ----------------------------------
// The key lives in a Kubernetes Secret, the ciphertext in Postgres, so a
// database dump alone does not reveal any upstream credential. GCM's auth tag
// also detects tampering with the stored ciphertext.

const encryptionKey = Buffer.from(config.encryptionKey, "base64");
if (encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
}

const TAG_BYTES = 16;

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(12); // fresh IV for every encryption
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

export function decrypt(ciphertext: Buffer, iv: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---- Tokens: API keys, session ids, invite tokens -----------------------
// These are 256-bit random values, so brute force is not a concern and a fast
// hash is enough. A deterministic hash also allows an indexed lookup.

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ---- Passwords: scrypt --------------------------------------------------
// Passwords are low-entropy, so they get a slow, memory-hard, salted hash.
// scrypt ships with Node, so there is no native dependency.

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}
