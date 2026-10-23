import { createHash, timingSafeEqual } from "node:crypto";

function equalSecrets(provided: string, expected: string): boolean {
  // Equal-length hashes avoid leaking a secret's length through comparison.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Cloud transcript access intentionally fails closed if ACCESS_PASSWORD is unset. */
export function isBrowserAuthorized(headers: Headers): boolean {
  const secret = process.env.ACCESS_PASSWORD;
  if (!secret) return false;
  const provided = headers.get("x-access-password");
  return provided !== null && equalSecrets(provided, secret);
}

/** Dedicated machine credential: never reuse the browser access password. */
export function isMcpAuthorized(headers: Headers): boolean {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret || secret.length < 32) return false;
  const value = headers.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return !!match && equalSecrets(match[1], secret);
}

export function storageCredentialsAvailable(): boolean {
  return !!(process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID));
}
