"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { chunkAudioFile } from "./audio-chunker";
import { requestSummary, transcribeBlob } from "@/lib/api-client";
import { MAX_SIZE, shouldChunk } from "@/lib/limits";
import { transcribeChunks } from "@/lib/pipeline";
import { applySummary, createResult, loadResults, removeResult, type Result } from "@/lib/results";
import { safeGet, safeSet } from "@/lib/storage";
import { chunkFilename, joinTranscripts, transcriptFilename } from "@/lib/transcript";

const LS_KEY = "vmt_results";
const PW_KEY = "vmt_pw";

const SAVE_ERROR =
  "Browser storage is full or blocked: the newest transcript is shown but NOT saved. Download it (↓ .txt), then delete old transcripts.";

export default function Home() {
  // false until storage has been read on mount (avoids a hydration mismatch)
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ids of the transcripts with a summary request in flight
  const [summarizing, setSummarizing] = useState<ReadonlySet<string>>(() => new Set());
  const transcriptsHeading = useRef<HTMLHeadingElement>(null);

  // Load password from sessionStorage and transcripts from localStorage on mount.
  // Storage may be blocked or hold anything, so none of this can throw.
  useEffect(() => {
    setPassword(safeGet(() => sessionStorage, PW_KEY) ?? "");
    const raw = safeGet(() => localStorage, LS_KEY);
    const { results: saved, corrupt } = loadResults(raw);
    // The persist effect is about to overwrite an unreadable value, so keep a copy.
    if (corrupt && raw) safeSet(() => localStorage, `${LS_KEY}_corrupt_${Date.now()}`, raw);
    setResults(saved);
    setLoaded(true);
    // Best effort: ask the browser not to evict saved transcripts. Most tabs are refused.
    try {
      navigator.storage?.persist?.().catch(() => {});
    } catch {}
  }, []);

  // Persist transcripts whenever they change, once loaded. A failed write keeps
  // everything on screen and says it is not saved.
  useEffect(() => {
    if (!loaded) return;
    const ok = safeSet(() => localStorage, LS_KEY, JSON.stringify(results));
    setSaveError(ok ? null : SAVE_ERROR);
  }, [results, loaded]);

  // Adopt the list another tab saved, so a stale tab never writes over newer
  // transcripts. The key is null when another tab cleared storage. Writing the
  // same value back fires no event, so this cannot loop.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS_KEY || e.key === null) setResults(loadResults(e.newValue).results);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const onDrop = useCallback((accepted: File[], rejected: { file: File }[]) => {
    if (rejected.length > 0) {
      setError("File too large (max 500 MB) or unsupported type. Use .m4a, .mp3, .wav, .mp4, .ogg.");
      return;
    }
    setError(null);
    setFile(accepted[0] ?? null);
    setStatus("idle");
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "audio/x-m4a": [".m4a"],
      "audio/mp4": [".mp4", ".m4a"],
      "audio/mpeg": [".mp3"],
      "audio/wav": [".wav"],
      "audio/webm": [".webm"],
      "audio/ogg": [".ogg"],
      "video/mp4": [".mp4"],
    },
    maxSize: MAX_SIZE,
    maxFiles: 1,
    disabled: status === "working",
  });

  async function run() {
    if (!file) return;
    setStatus("working");
    setError(null);

    try {
      let fullTranscript: string;

      if (!shouldChunk(file.size)) {
        setProgress("Transcribing…");
        fullTranscript = await transcribeBlob(file, file.name, password);
      } else {
        setProgress("Preparing audio (splitting into chunks)…");
        const chunks = await chunkAudioFile(file);
        const parts = await transcribeChunks(
          chunks,
          (chunk) => transcribeBlob(chunk.blob, chunkFilename(file.name, chunk.index), password),
          setProgress
        );
        fullTranscript = joinTranscripts(parts);
      }

      setResults((prev) => [createResult(file.name, fullTranscript), ...prev]);
      setFile(null);
      setStatus("idle");
      setProgress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStatus("error");
      setProgress("");
    }
  }

  // Matched by id throughout: the list can change while the request runs.
  async function summarize(id: string) {
    const target = results.find((r) => r.id === id);
    if (!target) return;
    setSummarizing((prev) => new Set(prev).add(id));
    try {
      const data = await requestSummary(target.transcript, password);
      setResults((prev) => applySummary(prev, id, data));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Summary failed");
    } finally {
      setSummarizing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function deleteResult(id: string) {
    const target = results.find((r) => r.id === id);
    if (!target) return;
    if (!window.confirm(`Delete transcript "${target.filename}"? This cannot be undone.`)) return;
    setResults((prev) => removeResult(prev, id));
    // Not the next card's ×, so a repeated Enter cannot delete that one too.
    transcriptsHeading.current?.focus();
  }

  async function copy(id: string, text: string) {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Permission denied, document not focused, or no clipboard over plain http.
      ok = false;
    }
    setCopied({ id, ok });
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  }

  function download(r: Result) {
    const url = URL.createObjectURL(new Blob([r.transcript], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = transcriptFilename(r.filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a moment rather than at once, or Safari may not start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Avoid a hydration mismatch: render nothing until storage is loaded
  if (!loaded) return null;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>🎙 Voice Memo Transcriber</h1>
        <p style={{ color: "#999", marginTop: 8 }}>
          Drop an audio file — voice memos, podcasts, conference recordings — and get a full transcript. Long files are split and transcribed automatically.
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 13, color: "#666", display: "block", marginBottom: 6 }}>
          Access password <span style={{ color: "#444" }}>(leave blank if none is set)</span>
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            safeSet(() => sessionStorage, PW_KEY, e.target.value);
          }}
          placeholder="••••••••"
          style={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 6,
            padding: "8px 12px",
            color: "#f0f0f0",
            fontSize: 14,
            width: "100%",
            boxSizing: "border-box",
          }}
        />
      </div>

      <div
        {...getRootProps()}
        style={{
          border: `2px dashed ${isDragActive ? "#4f8ef7" : "#333"}`,
          borderRadius: 12,
          padding: "48px 24px",
          textAlign: "center",
          cursor: "pointer",
          background: isDragActive ? "rgba(79,142,247,0.05)" : "#1a1a1a",
          transition: "all 0.2s",
          opacity: status === "working" ? 0.5 : 1,
        }}
      >
        <input {...getInputProps()} />
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎵</div>
        <p style={{ margin: 0, color: "#ccc", fontWeight: 500 }}>
          {isDragActive ? "Drop it here…" : "Drag & drop your audio file here"}
        </p>
        <p style={{ margin: "8px 0 16px", color: "#555", fontSize: 14 }}>
          .m4a · .mp3 · .wav · .mp4 · .ogg · up to 500 MB
        </p>
        <button style={btn("outline")}>Browse files</button>
      </div>

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: "12px 16px",
            background: "#2a1515",
            border: "1px solid #5a2020",
            borderRadius: 8,
            color: "#f87171",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {file && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
          }}
        >
          <div>
            <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{file.name}</p>
            <p style={{ margin: 0, color: "#666", fontSize: 12 }}>
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {status !== "working" && (
              <button
                onClick={() => setFile(null)}
                style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
              >
                ×
              </button>
            )}
            <button onClick={run} disabled={status === "working"} style={btn("primary")}>
              {status === "working" ? "Working…" : "Transcribe"}
            </button>
          </div>
        </div>
      )}

      {status === "working" && progress && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 16px",
            background: "#15203a",
            border: "1px solid #243a66",
            borderRadius: 8,
            color: "#9dc0ff",
            fontSize: 13,
          }}
        >
          {progress}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2
            ref={transcriptsHeading}
            tabIndex={-1}
            style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, outline: "none" }}
          >
            Transcripts
          </h2>
          <p style={{ margin: "0 0 16px", color: "#666", fontSize: 12 }}>
            Saved only in this browser. Safari may clear it after ~7 days without a visit, so
            download anything you want to keep.
          </p>
          {saveError && (
            <div
              style={{
                marginBottom: 16,
                padding: "12px 16px",
                background: "#2a1515",
                border: "1px solid #5a2020",
                borderRadius: 8,
                color: "#f87171",
                fontSize: 14,
              }}
            >
              {saveError}
            </div>
          )}
          {results.map((r) => (
            <div
              key={r.id}
              style={{ marginBottom: 20, border: "1px solid #333", borderRadius: 10, overflow: "hidden" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  padding: "14px 16px",
                  background: "#1a1a1a",
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{r.filename}</p>
                  <p style={{ margin: 0, color: "#666", fontSize: 12, marginTop: 2 }}>
                    {new Date(r.at).toLocaleString()}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button onClick={() => copy(r.id, r.transcript)} style={btn("outline")}>
                    {copied?.id === r.id
                      ? copied.ok
                        ? "✓ Copied"
                        : "Copy failed. Select the text"
                      : "Copy"}
                  </button>
                  <button onClick={() => download(r)} style={btn("outline")}>↓ .txt</button>
                  <button
                    onClick={() => summarize(r.id)}
                    disabled={summarizing.has(r.id)}
                    style={btn("outline")}
                  >
                    {summarizing.has(r.id) ? "Summarizing…" : r.summary ? "Re-summarize" : "✦ Summarize"}
                  </button>
                  <button
                    onClick={() => deleteResult(r.id)}
                    style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "6px 4px" }}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              </div>

              {r.summary && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: "#141e14",
                    borderBottom: "1px solid #2a3a2a",
                    fontSize: 13,
                    lineHeight: 1.8,
                    color: "#a3d9a3",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  <strong style={{ display: "block", marginBottom: 6, color: "#6dbf6d", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    AI Summary
                  </strong>
                  {r.summaryCoverage && (
                    <span style={{ display: "block", marginBottom: 6, color: "#6b8f6b", fontSize: 12 }}>
                      {`Covers the first ~${r.summaryCoverage.wordsUsed.toLocaleString()} of ${r.summaryCoverage.totalWords.toLocaleString()} words`}
                    </span>
                  )}
                  {r.summary}
                </div>
              )}

              <div
                style={{
                  padding: "16px",
                  background: "#111",
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  maxHeight: 400,
                  overflowY: "auto",
                  color: "#ddd",
                }}
              >
                {r.transcript}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 40,
          padding: "16px",
          border: "1px dashed #333",
          borderRadius: 8,
          fontSize: 13,
          color: "#666",
        }}
      >
        <strong style={{ color: "#999" }}>Tip:</strong> For Spotify/podcast audio, record it with
        Audacity (Mac: BlackHole, Windows: WASAPI loopback) and export an .mp3 — then drop it here.
        Long files transcribe in 2-minute chunks automatically.
      </div>
    </main>
  );
}

function btn(variant: "primary" | "outline"): React.CSSProperties {
  return variant === "primary"
    ? {
        background: "#4f8ef7",
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: "8px 16px",
        cursor: "pointer",
        fontWeight: 500,
        fontSize: 14,
      }
    : {
        background: "none",
        color: "#ccc",
        border: "1px solid #444",
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        fontSize: 13,
      };
}
