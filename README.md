# Voice Memo Transcriber

A small personal Next.js app. Drop an audio file to get a transcript from OpenAI (whisper-1 by default), and optionally a short summary (gpt-4o-mini by default). Transcripts are kept in your browser's localStorage; the server stores nothing.

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
| `ACCESS_PASSWORD` | Yes in production | Password both API routes require. Type it into the page's password field. A production server without it answers every API call with HTTP 503 (unless `ALLOW_PUBLIC=1`), because otherwise anyone with the URL could spend your OpenAI credit. `next dev` runs without it. Use at least 20 random characters (`openssl rand -base64 24`). Surrounding whitespace is ignored; a whitespace-only value is treated as a misconfiguration (HTTP 503). |
| `OPENAI_TRANSCRIBE_MODEL` | No | Transcription model. Defaults to `whisper-1`. See [Models](#models). |
| `OPENAI_SUMMARY_MODEL` | No | Summary model. Defaults to `gpt-4o-mini`. See [Models](#models). |
| `ALLOW_PUBLIC` | No | Set to `1` only if you deliberately want a production deploy with no `ACCESS_PASSWORD` to accept API calls from anyone. Ignored when a password is set. |

## Models

Both default models are on OpenAI's [deprecation schedule](https://developers.openai.com/api/docs/deprecations) (checked 2026-10-14). After a shutdown date every request that uses the model fails, and the app shows "OpenAI model not available".

| Variable | Default | Shutdown | OpenAI's replacement |
| --- | --- | --- | --- |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | 2027-02-26 | `gpt-transcribe` (or `gpt-live-transcribe`) |
| `OPENAI_SUMMARY_MODEL` | `gpt-4o-mini` (snapshot `gpt-4o-mini-2024-07-18`) | 2027-01-14 | `gpt-6-luna` |

Test a replacement before switching:

1. Set the variable in `.env.local` and run `npm run dev`.
2. For transcription, try an iPhone `.m4a` that goes up directly and a recording long enough to be split into 16 kHz WAV chunks. A replacement can accept different formats or have lower size or duration limits.
3. For summaries, summarize one long real transcript and check that it is complete. The route caps output with `max_completion_tokens: 1000`; reasoning models spend part of that budget on reasoning, so a summary marked `[summary cut off]` means the cap is too low for that model.
4. Set the variable in Vercel for Production and Preview, and redeploy.

## Deploying to Vercel

- **Request size cap.** Vercel limits a function's request body to about 4.5 MB. That is why long recordings are decoded in the browser and uploaded as 2-minute, 16 kHz mono WAV chunks (about 3.8 MB each), one request per chunk.
- **Set `ACCESS_PASSWORD`** for both Production and Preview under Project → Settings → Environment Variables, then redeploy.
- **Set a monthly budget** on the OpenAI project that owns the key, so a leaked URL or password has a bounded cost.
- **Rate limiting (optional).** The app has no built-in rate limit. If your Vercel plan includes Firewall rate limiting, add a rule on `/api/*`, for example 30 requests per minute per IP.
- **Time limits.** The transcribe function may run for 60 s and summarize for 30 s (`maxDuration`). Each gives up on OpenAI 5 s before that and returns a "took too long" error instead of the platform's plain-text timeout.
- The page asks search engines not to index it. That does not hide the URL from anyone who already has it.
