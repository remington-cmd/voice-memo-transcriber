import { NextResponse } from "next/server";

/**
 * Shared access check for the API routes. When ACCESS_PASSWORD is set, the
 * x-access-password header must match it. Returns the 401 response to send,
 * or null when the request may proceed.
 */
export function checkAccess(request: Request): NextResponse | null {
  const expected = process.env.ACCESS_PASSWORD;
  if (expected) {
    const provided = request.headers.get("x-access-password") ?? "";
    if (provided !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  return null;
}
