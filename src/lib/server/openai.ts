import { NextResponse } from "next/server";

export type OpenAIKind = "transcribe" | "summarize";

export type OpenAIResult = { ok: true; data: unknown } | { ok: false; response: NextResponse };

export interface CallOptions {
  /** Give up on OpenAI this long after the call starts, so the route can still answer. */
  timeoutMs: number;
  kind: OpenAIKind;
}

/** How much of an upstream error body to log. */
const LOG_LIMIT = 500;

const RETRYABLE = { retryable: true };

const MODEL_ENV: Record<OpenAIKind, string> = {
  transcribe: "OPENAI_TRANSCRIBE_MODEL",
  summarize: "OPENAI_SUMMARY_MODEL",
};

/** JSON error body shared by the API routes: a stable code for the client and a fixed message. */
export function errorResponse(
  status: number,
  code: string,
  error: string,
  { retryable = false, retryAfter }: { retryable?: boolean; retryAfter?: string | null } = {}
): NextResponse {
  const headers = retryAfter ? { "Retry-After": retryAfter } : undefined;
  return NextResponse.json({ code, error, retryable }, { status, headers });
}

// OpenAI puts the specific reason in error.code, and for quota errors in error.type as well.
function upstreamCodes(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return [];
  const { code, type } = error as { code?: unknown; type?: unknown };
  return [code, type].filter((value): value is string => typeof value === "string");
}

/**
 * Turn a non-OK OpenAI response into the route's own error. Messages are fixed
 * and never echo upstream text, because a 401 body contains the masked key.
 * An upstream 401/403 becomes a 502 so the client never mistakes it for a
 * wrong access password.
 */
export function mapOpenAIError(
  status: number,
  body: unknown,
  kind: OpenAIKind,
  retryAfter: string | null = null
): NextResponse {
  const codes = upstreamCodes(body);

  if (status === 401 || status === 403) {
    return errorResponse(
      502,
      "upstream_auth",
      "OpenAI rejected the server API key (OPENAI_API_KEY)."
    );
  }
  if (status === 404) {
    return errorResponse(
      502,
      "upstream_model",
      `OpenAI model not available. Check ${MODEL_ENV[kind]}.`
    );
  }
  if (status === 400 && codes.includes("audio_too_short")) {
    return errorResponse(422, "audio_too_short", "The audio is too short to transcribe.");
  }
  if (status === 400) {
    return errorResponse(
      400,
      "upstream_rejected",
      kind === "transcribe"
        ? "OpenAI could not read this audio (unsupported or corrupt format)."
        : "OpenAI rejected the summary request."
    );
  }
  if (status === 413) {
    return errorResponse(
      413,
      "too_large",
      kind === "transcribe"
        ? "OpenAI rejected the file as too large."
        : "OpenAI rejected the transcript as too large."
    );
  }
  if (status === 429 && codes.includes("insufficient_quota")) {
    return errorResponse(402, "insufficient_quota", "OpenAI account is out of credit.");
  }
  if (status === 429) {
    return errorResponse(429, "rate_limited", "OpenAI rate limit reached. Try again shortly.", {
      ...RETRYABLE,
      retryAfter,
    });
  }
  if (status >= 500) {
    return errorResponse(
      502,
      "upstream_unavailable",
      "OpenAI is unavailable right now. Try again.",
      {
        ...RETRYABLE,
        retryAfter,
      }
    );
  }
  return errorResponse(502, "upstream_error", `OpenAI error (HTTP ${status}).`);
}

function fail(response: NextResponse): OpenAIResult {
  return { ok: false, response };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Call an OpenAI endpoint with a timeout and parse its JSON. Every failure,
 * including network errors, timeouts and unreadable bodies, comes back as a
 * JSON error response for the route to return as is.
 */
export async function callOpenAI(
  url: string,
  init: RequestInit,
  { timeoutMs, kind }: CallOptions
): Promise<OpenAIResult> {
  let res: Response;
  let text: string;
  try {
    // The signal also covers reading the body.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    if (isTimeout(err)) {
      console.error(`OpenAI ${kind} timed out after ${timeoutMs} ms`);
      return fail(
        errorResponse(
          504,
          "upstream_timeout",
          "OpenAI took too long to respond. Try again.",
          RETRYABLE
        )
      );
    }
    console.error(`OpenAI ${kind} request failed:`, err);
    return fail(
      errorResponse(502, "upstream_unreachable", "Could not reach OpenAI. Try again.", RETRYABLE)
    );
  }

  let data: unknown;
  let parsed = true;
  try {
    data = JSON.parse(text);
  } catch {
    parsed = false;
  }

  if (!res.ok) {
    // Server logs only: the body can contain the masked API key.
    console.error(`OpenAI ${kind} error (HTTP ${res.status}):`, text.slice(0, LOG_LIMIT));
    return fail(mapOpenAIError(res.status, data, kind, res.headers.get("retry-after")));
  }

  if (!parsed) {
    console.error(`OpenAI ${kind} sent a non-JSON response:`, text.slice(0, LOG_LIMIT));
    return fail(badResponse());
  }
  return { ok: true, data };
}

/** A 200 from OpenAI that the route cannot use. */
export function badResponse(): NextResponse {
  return errorResponse(
    502,
    "upstream_bad_response",
    "OpenAI sent an unexpected response. Try again.",
    RETRYABLE
  );
}
