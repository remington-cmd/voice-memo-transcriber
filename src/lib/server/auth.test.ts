import { beforeEach, describe, expect, it, vi } from "vitest";
import { authHeaders } from "@/lib/api-client";

type AuthModule = typeof import("./auth");
let checkAccess: AuthModule["checkAccess"];
let FAIL_CLOSED_IN_PRODUCTION: AuthModule["FAIL_CLOSED_IN_PRODUCTION"];

const FAIL_CLOSED = { failClosedInProduction: true };
const FAIL_OPEN = { failClosedInProduction: false };

beforeEach(async () => {
  // Warnings are logged once per module instance, so each test gets a fresh one.
  vi.resetModules();
  ({ checkAccess, FAIL_CLOSED_IN_PRODUCTION } = await import("./auth"));
});

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/transcribe", { method: "POST", headers });
}

function withPassword(header: string): Request {
  return request({ "x-access-password": header });
}

function silenceWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

async function expectError(res: Response | null, status: number, code: string) {
  expect(res).not.toBeNull();
  expect(res!.status).toBe(status);
  expect(await res!.json()).toMatchObject({ code });
}

describe("checkAccess without a password", () => {
  it("defaults to failing closed in production and open in development", async () => {
    expect(FAIL_CLOSED_IN_PRODUCTION).toBe(true);
    await expectError(checkAccess(request(), { NODE_ENV: "production" }), 503, "misconfigured");
    expect(checkAccess(request(), { NODE_ENV: "development" })).toBeNull();
  });

  it("allows an unset password, warning once in production", () => {
    const warn = silenceWarn();

    expect(checkAccess(request(), { NODE_ENV: "development" }, FAIL_OPEN)).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    expect(checkAccess(request(), { NODE_ENV: "production" }, FAIL_OPEN)).toBeNull();
    expect(checkAccess(request(), { NODE_ENV: "production" }, FAIL_OPEN)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("open to anyone");
  });

  it("treats an empty string like an unset password", async () => {
    const warn = silenceWarn();
    const env = { ACCESS_PASSWORD: "", NODE_ENV: "production" };

    expect(checkAccess(request(), env, FAIL_OPEN)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    await expectError(checkAccess(request(), env, FAIL_CLOSED), 503, "misconfigured");
  });

  it("rejects a whitespace-only password as misconfigured", async () => {
    const env = { ACCESS_PASSWORD: "  \t ", NODE_ENV: "development" };

    const res = checkAccess(withPassword("anything"), env, FAIL_OPEN);

    await expectError(res, 503, "misconfigured");
    expect(checkAccess(request(), env, FAIL_OPEN)?.status).toBe(503);
  });

  it("returns 503 in production when failing closed", async () => {
    const res = checkAccess(request(), { NODE_ENV: "production" }, FAIL_CLOSED);

    expect(res?.status).toBe(503);
    const body = await res!.json();
    expect(body.code).toBe("misconfigured");
    expect(body.error).toContain("ALLOW_PUBLIC=1");
    // A configuration error never passes on its own, so the client must not retry it.
    expect(body.retryable).toBe(false);
  });

  it("allows production without a password when ALLOW_PUBLIC=1", () => {
    silenceWarn();
    const env = { NODE_ENV: "production", ALLOW_PUBLIC: "1" };
    expect(checkAccess(request(), env, FAIL_CLOSED)).toBeNull();
  });

  it("stays open in development when failing closed", () => {
    expect(checkAccess(request(), { NODE_ENV: "development" }, FAIL_CLOSED)).toBeNull();
  });
});

describe("checkAccess with a password", () => {
  const env = { ACCESS_PASSWORD: "correct-horse-battery-staple", NODE_ENV: "production" };

  it("returns 401 bad_password when the header is missing", async () => {
    await expectError(checkAccess(request(), env), 401, "bad_password");
  });

  it("returns 401 for a wrong password", async () => {
    const res = checkAccess(withPassword("correct-horse-battery"), env);
    await expectError(res, 401, "bad_password");
    expect(await checkAccess(withPassword("nope"), env)!.json()).toEqual({
      code: "bad_password",
      error: "Unauthorized",
      retryable: false,
    });
  });

  it("allows the correct password", () => {
    expect(checkAccess(withPassword("correct-horse-battery-staple"), env)).toBeNull();
    expect(checkAccess(request(authHeaders("correct-horse-battery-staple")), env)).toBeNull();
  });

  it("ignores stray whitespace around the configured password", () => {
    silenceWarn();
    expect(checkAccess(withPassword("secret"), { ACCESS_PASSWORD: "secret " })).toBeNull();
    expect(checkAccess(withPassword("secret"), { ACCESS_PASSWORD: "\nsecret" })).toBeNull();
  });

  it("ignores stray whitespace around the typed password", () => {
    silenceWarn();
    const res = checkAccess(request(authHeaders(" secret ")), { ACCESS_PASSWORD: "secret" });
    expect(res).toBeNull();
  });

  it("accepts a non-Latin-1 password sent through authHeaders", () => {
    silenceWarn();
    const password = "café€’";
    const env = { ACCESS_PASSWORD: password };

    expect(checkAccess(request(authHeaders(password)), env)).toBeNull();
    expect(checkAccess(request(authHeaders("café€'")), env)?.status).toBe(401);
  });

  it("decodes percent signs sent by the client", () => {
    silenceWarn();
    const env = { ACCESS_PASSWORD: "100%sure" };
    expect(checkAccess(request(authHeaders("100%sure")), env)).toBeNull();
    // A tab loaded before the encoding change sends the raw value.
    expect(checkAccess(withPassword("100%sure"), env)).toBeNull();
  });

  it("returns 401 without throwing for a malformed percent header", async () => {
    silenceWarn();
    const env = { ACCESS_PASSWORD: "secret-but-long-enough" };
    await expectError(checkAccess(withPassword("%E0%A4%A"), env), 401, "bad_password");
  });

  it("warns once when the password is shorter than 16 characters", () => {
    const warn = silenceWarn();
    const env = { ACCESS_PASSWORD: "8charsPW" };

    checkAccess(withPassword("8charsPW"), env);
    checkAccess(withPassword("wrong"), env);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("shorter than 16 characters");
  });

  it("does not warn for a long password", () => {
    const warn = silenceWarn();
    checkAccess(withPassword("x"), { ACCESS_PASSWORD: "sixteen-chars-ok" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads process.env by default", () => {
    vi.stubEnv("ACCESS_PASSWORD", "from-process-env-123");
    expect(checkAccess(withPassword("from-process-env-123"))).toBeNull();
    expect(checkAccess(withPassword("wrong"))?.status).toBe(401);
  });
});
