import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set." }, { status: 500 });
  }

  const accessPassword = process.env.ACCESS_PASSWORD;
  if (accessPassword) {
    const provided = request.headers.get("x-access-password") ?? "";
    if (provided !== accessPassword) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { transcript?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!body.transcript) {
    return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
  }

  // Truncate to ~8 000 words to keep costs low (~$0.001 per summary)
  const words = body.transcript.split(/\s+/);
  const text =
    words.length > 8000
      ? words.slice(0, 8000).join(" ") + "\n\n[transcript truncated]"
      : body.transcript;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a meeting notes assistant. Summarize the transcript concisely using this structure:\n\n**Key Topics**\n- ...\n\n**Decisions / Action Items**\n- ...\n\n**People Mentioned**\n- ...\n\nOmit a section if nothing applies. Be direct and brief.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("OpenAI summarize error:", err);
    return NextResponse.json({ error: "Summary failed." }, { status: response.status });
  }

  const result = await response.json();
  const summary = result.choices?.[0]?.message?.content as string;
  return NextResponse.json({ summary });
}
