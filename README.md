# Voice Memo Transcriber

A small personal Next.js app. Drop an audio file to get a transcript from OpenAI Whisper, and optionally a short summary from gpt-4o-mini. Transcripts are kept in your browser's localStorage; the server stores nothing.

## Setup

Node 22 (the version CI uses).

```sh
npm ci
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Checks: `npm test`, `npm run typecheck`, `npm run build`.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Server-side key for transcription and summaries. Never sent to the browser. |
| `ACCESS_PASSWORD` | Strongly recommended | Password both API routes require. Type it into the page's password field. Without it, anyone with the URL can spend your OpenAI credit, and a production server logs a warning. Use at least 20 random characters (`openssl rand -base64 24`). Surrounding whitespace is ignored; a whitespace-only value is treated as a misconfiguration (HTTP 503). |
| `ALLOW_PUBLIC` | No | Only read when fail-closed mode is on (`FAIL_CLOSED_IN_PRODUCTION` in `src/lib/server/auth.ts`, off by default). In that mode a production server without `ACCESS_PASSWORD` answers 503 unless `ALLOW_PUBLIC=1`. |

## Deploying to Vercel

- **Request size cap.** Vercel limits a function's request body to about 4.5 MB. That is why long recordings are decoded in the browser and uploaded as 2-minute, 16 kHz mono WAV chunks (about 3.8 MB each), one request per chunk.
- **Set `ACCESS_PASSWORD`** for both Production and Preview under Project → Settings → Environment Variables, then redeploy.
- **Set a monthly budget** on the OpenAI project that owns the key, so a leaked URL or password has a bounded cost.
- **Rate limiting (optional).** The app has no built-in rate limit. If your Vercel plan includes Firewall rate limiting, add a rule on `/api/*`, for example 30 requests per minute per IP.
- The page asks search engines not to index it. That does not hide the URL from anyone who already has it.
