import { NextRequest, NextResponse } from "next/server";
import { isBrowserAuthorized, storageCredentialsAvailable } from "@/lib/api-auth";
import { listTranscripts, saveTranscript } from "@/lib/transcript-store";
import { parseTranscriptDraft } from "@/lib/transcript-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function guard(request: NextRequest): NextResponse | null {
  if (!process.env.ACCESS_PASSWORD) {
    return NextResponse.json({ error: "Set ACCESS_PASSWORD before enabling private transcripts." }, { status: 503 });
  }
  if (!isBrowserAuthorized(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!storageCredentialsAvailable()) {
    return NextResponse.json({ error: "Connect a private Vercel Blob store first." }, { status: 503 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  const param = request.nextUrl.searchParams;
  const limit = Number(param.get("limit") || "20");
  const cursor = param.get("cursor") || undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || (cursor && cursor.length > 2000)) {
    return NextResponse.json({ error: "Invalid pagination." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listTranscripts({ limit, cursor }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Could not retrieve transcripts." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  if (Number(request.headers.get("content-length") || 0) > 2_000_000) {
    return NextResponse.json({ error: "Transcript payload too large." }, { status: 413 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 1_500_000) {
      return NextResponse.json({ error: "Transcript payload too large." }, { status: 413 });
    }
    const draft = parseTranscriptDraft(JSON.parse(raw) as unknown);
    if (!draft) return NextResponse.json({ error: "Invalid transcript record." }, { status: 400 });
    const record = await saveTranscript(draft);
    return NextResponse.json({ id: record.id, at: record.at }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Transcript id already exists.") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Could not save transcript." }, { status: 500 });
  }
}
