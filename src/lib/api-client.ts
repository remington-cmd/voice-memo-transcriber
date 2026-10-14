// Browser-side calls to the app's own API routes.

export interface SummaryResponse {
  summary: string;
}

// Header values must be Latin-1, so the password is percent-encoded and the
// server decodes it. This keeps passwords like "café€" from making fetch throw.
export function authHeaders(password: string): Record<string, string> {
  return password ? { "x-access-password": encodeURIComponent(password) } : {};
}

export async function transcribeBlob(
  blob: Blob,
  filename: string,
  password: string
): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, filename);
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: authHeaders(password),
    body: fd,
  });
  const data = await res.json();
  if (res.status === 401) throw new Error("Access denied — check your password.");
  if (!res.ok) throw new Error(data.error ?? "Transcription failed");
  return data.transcript as string;
}

export async function requestSummary(
  transcript: string,
  password: string
): Promise<SummaryResponse> {
  const res = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(password) },
    body: JSON.stringify({ transcript }),
  });
  const data = await res.json();
  if (res.status === 401) throw new Error("Access denied — check your password.");
  if (!res.ok) throw new Error(data.error ?? "Summary failed");
  return { summary: data.summary as string };
}
