import { NextRequest, NextResponse } from "next/server";
import { checkAccess } from "@/lib/server/auth";
import { badResponse, callOpenAI, errorResponse } from "@/lib/server/openai";

export const maxDuration = 60;

// Stop waiting 5 s before the platform kills the function, so the client still gets JSON.
const UPSTREAM_TIMEOUT_MS = (maxDuration - 5) * 1000;

// OpenAI's per-file limit for transcription uploads.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function POST(request: NextRequest) {
  // Auth first, so anonymous callers cannot probe the server configuration.
  const denied = checkAccess(request);
  if (denied) return denied;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to your environment variables." },
      { status: 500 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return errorResponse(400, "no_file", "No file provided");
  }
  if (file.size > MAX_FILE_BYTES) {
    return errorResponse(413, "too_large", "File exceeds the 25 MB transcription limit.");
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1";

  // No response_format: the default json carries `text`, which is all we use.
  const whisperForm = new FormData();
  whisperForm.append("file", file);
  whisperForm.append("model", model);

  const result = await callOpenAI(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: whisperForm,
    },
    { timeoutMs: UPSTREAM_TIMEOUT_MS, kind: "transcribe" }
  );
  if (!result.ok) return result.response;

  const text = (result.data as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    console.error("OpenAI transcribe response has no text field");
    return badResponse();
  }
  return NextResponse.json({ transcript: text });
}
