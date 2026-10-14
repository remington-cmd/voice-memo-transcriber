import { NextRequest, NextResponse } from "next/server";
import { checkAccess } from "@/lib/server/auth";
import { callOpenAI, errorResponse } from "@/lib/server/openai";
import { truncateWords } from "@/lib/text";

export const maxDuration = 30;

// Stop waiting 5 s before the platform kills the function, so the client still gets JSON.
const UPSTREAM_TIMEOUT_MS = (maxDuration - 5) * 1000;

// About 55 minutes of speech, at roughly $0.001 per summary. Raising it is cheap, but time a
// long summary against maxDuration first.
const MAX_SUMMARY_WORDS = 8000;

const SYSTEM_PROMPT =
  "You are a meeting notes assistant. Summarize the transcript concisely using this structure:\n\nKEY TOPICS:\n- ...\n\nDECISIONS / ACTION ITEMS:\n- ...\n\nPEOPLE MENTIONED:\n- ...\n\nOmit a section if nothing applies. Be direct and brief. Write plain text with no Markdown formatting.";

// The parts of a chat completion the route reads. Nothing in it is trusted.
interface ChatCompletion {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
}

export async function POST(request: NextRequest) {
  // Auth first, so anonymous callers cannot probe the server configuration.
  const denied = checkAccess(request);
  if (denied) return denied;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set." }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const transcript =
    typeof body === "object" && body !== null
      ? (body as { transcript?: unknown }).transcript
      : undefined;
  if (typeof transcript !== "string" || !transcript.trim()) {
    return errorResponse(400, "no_transcript", "No transcript provided");
  }

  const { text, truncated, wordsUsed, totalWords } = truncateWords(transcript, MAX_SUMMARY_WORDS);
  const model = process.env.OPENAI_SUMMARY_MODEL?.trim() || "gpt-4o-mini";

  const result = await callOpenAI(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        // Newer model families reject the older output-limit parameter and require this one.
        max_completion_tokens: 1000,
      }),
    },
    { timeoutMs: UPSTREAM_TIMEOUT_MS, kind: "summarize" }
  );
  if (!result.ok) return result.response;

  const choice = (result.data as ChatCompletion | null)?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    console.error(
      "OpenAI summarize response has no content, finish_reason:",
      choice?.finish_reason
    );
    return errorResponse(502, "empty_summary", "OpenAI returned an empty summary.");
  }

  // The model hit the output cap, so say so instead of passing it off as complete.
  const incomplete = choice?.finish_reason === "length";
  const summary = incomplete ? content.trimEnd() + "\n\n[summary cut off]" : content;

  return NextResponse.json({ summary, truncated, wordsUsed, totalWords, incomplete });
}
