# Private transcript retrieval and MCP

**Review branch only.** No production deployment, credentials, or storage resources have been changed.

## Set up private storage

1. In Vercel's `voice-memo-transcriber` project, create/attach a **private** Vercel Blob store, after approving storage costs and data retention. Never use public Blob for transcripts.
2. In Vercel environment settings, configure `ACCESS_PASSWORD` for the browser, a separate random `MCP_AUTH_TOKEN` of 32+ characters for Codex, and the private store's `BLOB_READ_WRITE_TOKEN` (or OIDC `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`). Keep real values out of source and chat.
3. Preview-test, then review the pull request before merging or deploying.
4. In the browser, click **Sync local transcripts** to migrate existing `localStorage` records. Existing recordings are never uploaded without using this control. New transcriptions attempt to save privately and retain their local copy if sync fails.
5. Click **Load cloud transcripts** to import a page of cloud records on another browser.

The private store uses `transcripts/v1/<uuid>.json`, one record per file. The design is **single-owner**. Anyone with the browser passphrase can access the entire store. Do not use for multiple customers or staff without an identity provider and per-user authorization.

## Connect Codex after deploying a verified endpoint

Set local `VMT_MCP_AUTH_TOKEN` via a secret manager to match the server's dedicated token; do not paste it into commands or config files.

```bash
codex mcp add voice-memo --url https://voice-memo-transcriber-ecru.vercel.app/mcp --bearer-token-env-var VMT_MCP_AUTH_TOKEN
codex mcp list
```

Call `list_transcripts`, then `get_transcript` by id. Follow `nextOffset` until null to read a complete long transcript. Pages are limited to 20,000 characters.

## ChatGPT needs OAuth before connection

**Do not configure ChatGPT as No authentication.** ChatGPT custom MCP plugins cannot present a user-provided bearer key. The current MCP endpoint intentionally supports only a dedicated Codex bearer token, and requires an OAuth 2.1 provider with PKCE, discovery, refresh tokens, and user authorization before it can be securely connected to ChatGPT. Use a supported identity provider/gateway; do not invent an insecure ad-hoc OAuth flow. Once added, configure ChatGPT Plugins > Add custom MCP server with OAuth.

## Guardrails and verification

- The new private REST and MCP routes fail closed if any required credentials are missing. The paid transcription/summarization APIs also fail closed without ACCESS_PASSWORD. **Configure ACCESS_PASSWORD before merge**, or the browser will correctly return 503 instead of making unauthenticated API calls.
- Audio chunking in the browser and the existing Whisper transcription endpoint are unchanged; MCP is currently **read-only** and does not download Spotify embeds.
- When a synced transcript is deleted in the web UI, private-cloud deletion must also succeed before removing the local record.
- Review retention, audit logs and jurisdiction before processing confidential third-party content.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Test unauthorized/disabled status, authenticated listing, pagination, cross-session retrieval, import of old browser records, and copy deletion with a dummy recording. No success claim should be made before preview tests pass.
