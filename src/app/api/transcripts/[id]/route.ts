import { NextRequest, NextResponse } from "next/server";
import { isBrowserAuthorized, storageCredentialsAvailable } from "@/lib/api-auth";
import {
  deleteTranscript,
  getTranscript,
  setTranscriptSummary,
} from "@/lib/transcript-store";
import { MAX_SUMMARY_CHARACTERS, validTranscriptId } from "@/lib/transcript-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function guard(request: NextRequest): NextResponse | null {
  if (!process.env.ACCESS_PASSWORD) {
    return NextResponse.json({ error: "Private transcript access is not configured." }, { status: 503 });
  }
  if (!isBrowserAuthorized(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!storageCredentialsAvailable()) {
    return NextResponse.json({ error: "Private transcript storage is not configured." }, { status: 503 });
  }
  return null;
}

async function readId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return validTranscriptId(id) ? id : null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const denied = guard(request);
  if (denied) return denied;
  const id = await readId(context);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    const record = await getTranscript(id);
    if (!record) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not retrieve transcript." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const denied = guard(request);
  if (denied) return denied;
  const id = await readId(context);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("summary" in body) ||
        typeof body.summary !== "string" || body.summary.length > MAX_SUMMARY_CHARACTERS) {
      return NextResponse.json({ error: "Invalid summary." }, { status: 400 });
    }
    const record = await setTranscriptSummary(id, body.summary);
    return record
      ? NextResponse.json({ id: record.id, updated: true }, { headers: { "Cache-Control": "no-store" } })
      : NextResponse.json({ error: "Not found." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Could not update summary." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const denied = guard(request);
  if (denied) return denied;
  const id = await readId(context);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  try {
    await deleteTranscript(id);
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not delete transcript." }, { status: 500 });
  }
}
