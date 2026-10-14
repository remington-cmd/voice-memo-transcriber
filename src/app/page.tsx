"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { chunkAudioFile, type AudioChunk } from "./audio-chunker";
import { requestSummary, transcribeBlob } from "@/lib/api-client";
import { MAX_SIZE, shouldChunk } from "@/lib/limits";
import { ChunkError, partialTranscript, transcribeChunks } from "@/lib/pipeline";
import { applySummary, createResult, loadResults, removeResult, type Result } from "@/lib/results";
import { withRetry } from "@/lib/retry";
import { safeGet, safeSet } from "@/lib/storage";
import { chunkFilename, joinTranscripts, transcriptFilename } from "@/lib/transcript";

const LS_KEY = "vmt_results";
const PW_KEY = "vmt_pw";

const SAVE_ERROR =
  "Browser storage is full or blocked: the newest transcript is shown but NOT saved. Download it (↓ .txt), then delete old transcripts.";

// Calls per upload. A 504 on a long direct file tends to repeat, so that gets
// one retry; a 2-minute chunk gets three.
const DIRECT_ATTEMPTS = 2;
const CHUNK_ATTEMPTS = 4;

/**
 * Work kept between runs on the same file, so Resume continues at the chunk
 * that failed without decoding again or paying for finished chunks twice.
 */
interface Job {
  /** Which file this belongs to: name, size and lastModified. */
  key: string;
  /** Decoded chunks, kept after a failure until success or another file. */
  chunks?: AudioChunk[];
  /** Transcript of each finished chunk, by index. */
  parts: (string | undefined)[];
  /** Id of the partial result saved for this job, replaced on each stop. */
  partialId?: string;
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

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
  const job = useRef<Job | null>(null);
  // Where Resume would continue, shown on the button. Null when there is nothing to resume.
  const [resume, setResume] = useState<{ chunk: number; total: number } | null>(null);
  // Aborts the running job; null when no job is running.
  const jobAbort = useRef<AbortController | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

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

  // While a job runs, warn before the page is closed or reloaded, and get the
  // screen wake lock back when the page is shown again (hiding it releases the lock).
  useEffect(() => {
    if (status !== "working") return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") acquireWakeLock();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [status]);

  // Best effort: keep a phone's screen on while a job runs, since a locked iPhone
  // suspends the page mid-upload. Unsupported or refused requests are ignored.
  function acquireWakeLock() {
    if (wakeLock.current && !wakeLock.current.released) return;
    try {
      navigator.wakeLock?.request("screen").then(
        (lock) => {
          // The job may have ended while the request was pending.
          if (!jobAbort.current) {
            lock.release().catch(() => {});
            return;
          }
          wakeLock.current?.release().catch(() => {});
          wakeLock.current = lock;
        },
        () => {}
      );
    } catch {}
  }

  function releaseWakeLock() {
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }

  function forgetJob() {
    job.current = null;
    setResume(null);
  }

  const onDrop = useCallback((accepted: File[], rejected: { file: File }[]) => {
    if (rejected.length > 0) {
      setError("File too large (max 500 MB) or unsupported type. Use .m4a, .mp3, .wav, .mp4, .ogg.");
      return;
    }
    setError(null);
    const next = accepted[0] ?? null;
    // Dropping the same file again keeps its finished chunks for Resume.
    if (!next || job.current?.key !== fileKey(next)) forgetJob();
    setFile(next);
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
    const controller = new AbortController();
    const { signal } = controller;
    jobAbort.current = controller;
    // Before the first await, while the click still counts as a user gesture.
    acquireWakeLock();

    const key = fileKey(file);
    if (job.current?.key !== key) job.current = { key, parts: [] };
    const current = job.current;

    setStatus("working");
    setError(null);
    setResume(null);

    try {
      let fullTranscript: string;

      if (!shouldChunk(file.size)) {
        setProgress("Transcribing…");
        fullTranscript = await withRetry(
          () => transcribeBlob(file, file.name, password, { signal }),
          {
            attempts: DIRECT_ATTEMPTS,
            signal,
            onRetry: ({ attempt, attempts }) =>
              setProgress(`Transcribing… retrying (attempt ${attempt} of ${attempts})`),
          }
        );
      } else {
        if (!current.chunks) {
          setProgress("Preparing audio (splitting into chunks)…");
          current.chunks = await chunkAudioFile(file);
        }
        const chunks = current.chunks;
        const parts = await transcribeChunks({
          chunks,
          parts: current.parts,
          signal,
          onProgress: setProgress,
          upload: (chunk) =>
            withRetry(
              () =>
                transcribeBlob(chunk.blob, chunkFilename(file.name, chunk.index), password, {
                  signal,
                }),
              {
                attempts: CHUNK_ATTEMPTS,
                signal,
                onRetry: ({ attempt, attempts }) =>
                  setProgress(
                    `Transcribing chunk ${chunk.index + 1} of ${chunks.length}… retrying (attempt ${attempt} of ${attempts})`
                  ),
              }
            ),
        });
        fullTranscript = joinTranscripts(parts);
      }

      const { partialId } = current;
      forgetJob();
      setFile(null);
      setStatus("idle");
      setProgress("");
      if (!fullTranscript.trim()) {
        setError("No speech detected. Nothing was saved.");
        return;
      }
      setError(null);
      // The full transcript replaces the partial one saved by an earlier stop.
      setResults((prev) => [
        createResult(file.name, fullTranscript),
        ...(partialId ? removeResult(prev, partialId) : prev),
      ]);
    } catch (e) {
      if (e instanceof ChunkError) {
        // Save what is done as one partial result per file, replacing the last one.
        const text = partialTranscript(current.parts, e);
        if (text) {
          const partial: Result = { ...createResult(file.name, text), partial: true };
          const previousId = current.partialId;
          current.partialId = partial.id;
          setResults((prev) => [partial, ...(previousId ? removeResult(prev, previousId) : prev)]);
        }
        setError(`${e.message} Click Resume to continue from chunk ${e.index + 1}.`);
        setResume({ chunk: e.index + 1, total: e.total });
      } else if (signal.aborted) {
        setError("Cancelled. Nothing was saved.");
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
      setStatus("error");
      setProgress("");
    } finally {
      jobAbort.current = null;
      releaseWakeLock();
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
            {status === "working" ? (
              <button onClick={() => jobAbort.current?.abort()} style={btn("outline")}>
                Cancel
              </button>
            ) : (
              <button
                onClick={() => {
                  setFile(null);
                  forgetJob();
                }}
                style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
              >
                ×
              </button>
            )}
            <button onClick={run} disabled={status === "working"} style={btn("primary")}>
              {status === "working"
                ? "Working…"
                : resume
                  ? `Resume (chunk ${resume.chunk} of ${resume.total})`
                  : "Transcribe"}
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
                    {r.partial && " · Partial"}
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
                    disabled={summarizing.has(r.id) || !r.transcript.trim()}
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
