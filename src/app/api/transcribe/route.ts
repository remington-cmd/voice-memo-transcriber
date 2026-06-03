import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to your environment variables." },
      { status: 500 }
    );
  }

  const accessPassword = process.env.ACCESS_PASSWORD;
  if (accessPassword) {
    const provided = request.headers.get("x-access-password") ?? "";
    if (provided !== accessPassword) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const whisperForm = new FormData();
  whisperForm.append("file", file);
  whisperForm.append("model", "whisper-1");
  whisperForm.append("response_format", "verbose_json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: whisperForm,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Whisper error:", err);
    return NextResponse.json(
      { error: "Transcription failed. Check your API key." },
      { status: response.status }
    );
  }

  const result = await response.json();
  return NextResponse.json({
    transcript: result.text as string,
    duration: result.duration as number | undefined,
    language: result.language as string | undefined,
  });
}
