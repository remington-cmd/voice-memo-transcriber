import { createHash, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { errorResponse } from "./openai";

/**
 * When true, a production server with no ACCESS_PASSWORD refuses API calls
 * with a 503 unless ALLOW_PUBLIC=1, so a missing password can never turn the
 * routes into an open proxy for the OpenAI key. `next dev` stays open.
 */
export const FAIL_CLOSED_IN_PRODUCTION: boolean = true;

/** Shorter passwords still work but log a warning (F18). */
const MIN_RECOMMENDED_LENGTH = 16;

type Env = Readonly<Record<string, string | undefined>>;

export interface AccessOptions {
  failClosedInProduction: boolean;
}

// Each warning is logged at most once per server instance.
const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Not retryable: no retry fixes a deploy's configuration.
function misconfigured(error: string): NextResponse {
  return errorResponse(503, "misconfigured", error);
}

/**
 * Shared access check for the API routes. Returns the error response to send,
 * or null when the request may proceed.
 *
 * ACCESS_PASSWORD is trimmed. The client sends the x-access-password header
 * through encodeURIComponent so any Unicode password is a legal header value;
 * it is decoded here, falling back to the raw value for older clients. The
 * comparison hashes both sides and uses timingSafeEqual, so it leaks neither
 * the length nor a matching prefix.
 */
export function checkAccess(
  request: Request,
  env: Env = process.env,
  opts: AccessOptions = { failClosedInProduction: FAIL_CLOSED_IN_PRODUCTION }
): NextResponse | null {
  const raw = env.ACCESS_PASSWORD ?? "";
  const expected = raw.trim();
  const production = env.NODE_ENV === "production";

  if (raw && !expected) {
    // A whitespace-only password could never be matched, so stay closed.
    return misconfigured("Server misconfigured: ACCESS_PASSWORD is blank.");
  }

  if (!expected) {
    if (opts.failClosedInProduction && production && env.ALLOW_PUBLIC !== "1") {
      return misconfigured(
        "Server misconfigured: ACCESS_PASSWORD is not set (set ALLOW_PUBLIC=1 to run without one)."
      );
    }
    if (production) {
      warnOnce(
        "open",
        "ACCESS_PASSWORD is not set: /api/transcribe and /api/summarize are open to anyone with the URL."
      );
    }
    return null;
  }

  if (expected.length < MIN_RECOMMENDED_LENGTH) {
    warnOnce(
      "short",
      `ACCESS_PASSWORD is shorter than ${MIN_RECOMMENDED_LENGTH} characters. Use at least 20 random characters (openssl rand -base64 24).`
    );
  }

  const header = request.headers.get("x-access-password") ?? "";
  let provided: string;
  try {
    provided = decodeURIComponent(header);
  } catch {
    provided = header;
  }

  if (!timingSafeEqual(sha256(provided.trim()), sha256(expected))) {
    return errorResponse(401, "bad_password", "Unauthorized");
  }
  return null;
}
