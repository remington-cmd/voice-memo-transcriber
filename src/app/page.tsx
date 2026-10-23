"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { chunkAudioFile } from "./audio-chunker";

const DIRECT_LIMIT = 24 * 1024 * 1024;
const MAX_SIZE = 500 * 1024 * 1024;
const LS_KEY = "vmt_results";

interface Result {
  id?: string;
  synced?: boolean;
  filename: string;
  transcript: string;
  at: string; // ISO string for serialization
  summary?: string;
}

export default function Home() {
  // null = not yet loaded from sessionStorage (avoid hydration mismatch)
  const [password, setPassword] = useState<string | null>(null);
  const [pwInput, setPwInput] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [summarizing, setSummarizing] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);

  // Load password from sessionStorage and transcripts from localStorage on mount
  useEffect(() => {
    const savedPw = sessionStorage.getItem("vmt_pw") ?? "";
    setPassword(savedPw);
    setPwInput(savedPw);
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const stored = JSON.parse(saved) as Result[];
        if (Array.isArray(stored)) {
          setResults(stored.map((r) => ({ ...r, id: r.id || crypto.randomUUID() })));
        }
      }
    } catch {}
  }, []);

  // Persist transcripts whenever results change (skip before mount completes)
  useEffect(() => {
    if (password !== null) {
      localStorage.setItem(LS_KEY, JSON.stringify(results));
    }
  }, [results, password]);

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

  function authHeaders(): Record<string, string> {
    return password ? { "x-access-password": password } : {};
  }

  async function transcribeBlob(blob: Blob, filename: string): Promise<string> {
    const fd = new FormData();
    fd.append("file", blob, filename);
    const res = await fetch("/api/transcribe", { method: "POST", headers: authHeaders(), body: fd });
    const data = await res.json();
    if (res.status === 401) throw new Error("Access denied — check your password.");
    if (!res.ok) throw new Error(data.error ?? "Transcription failed");
    return data.transcript as string;
  }

  // No browser transcript gets removed if cloud storage is unavailable.
  async function saveCloudResult(result: Result) {
    const response = await fetch("/api/transcripts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(result),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Cloud save failed");
  }

  // Explicit user action to migrate existing browser-only transcripts.
  async function syncLocal() {
    setSyncing(true);
    let saved = 0;
    try {
      for (const item of results.filter((r) => !r.synced)) {
        const normalized = { ...item, id: item.id || crypto.randomUUID() };
        await saveCloudResult(normalized);
        setResults((prev) => prev.map((r) =>
          r.id === item.id ? { ...r, id: normalized.id, synced: true } : r
        ));
        saved++;
      }
      setCloudNotice(saved ? `Synced ${saved} transcript(s) to private storage.` : "Nothing new to sync.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Cloud storage unavailable.";
      setCloudNotice(`Synced ${saved}; remaining transcripts are only in this browser. ${reason}`);
    } finally {
      setSyncing(false);
    }
  }

  async function loadCloud() {
    setLoadingCloud(true);
    try {
      const response = await fetch("/api/transcripts?limit=25", { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Cloud listing failed");
      const remote: Result[] = [];
      for (const item of data.items as { id: string }[]) {
        const detail = await fetch(`/api/transcripts/${encodeURIComponent(item.id)}`, {
          headers: authHeaders(),
        });
        if (!detail.ok) throw new Error("A stored transcript could not be retrieved.");
        remote.push({ ...(await detail.json()), synced: true });
      }
      setResults((prev) => {
        const known = new Set(prev.map((r) => r.id));
        return [...remote.filter((r) => !known.has(r.id)), ...prev];
      });
      setCloudNotice(`Loaded ${remote.length} records. Older pages can be retrieved through MCP.`);
    } catch (error) {
      setCloudNotice(error instanceof Error ? error.message : "Could not load cloud records.");
    } finally {
      setLoadingCloud(false);
    }
  }

  async function run() {
    if (!file) return;
    sessionStorage.setItem("vmt_pw", password ?? "");
    setStatus("working");
    setError(null);

    try {
      let fullTranscript: string;

      if (file.size <= DIRECT_LIMIT) {
        setProgress("Transcribing…");
        fullTranscript = await transcribeBlob(file, file.name);
      } else {
        setProgress("Preparing audio (splitting into chunks)…");
        const chunks = await chunkAudioFile(file);
        const parts: string[] = [];
        for (const chunk of chunks) {
          setProgress(`Transcribing chunk ${chunk.index + 1} of ${chunks.length}…`);
          const text = await transcribeBlob(
            chunk.blob,
            `${file.name}.part${chunk.index + 1}.wav`
          );
          parts.push(text.trim());
        }
        fullTranscript = parts.join("\n\n");
      }

      const record: Result = {
        id: crypto.randomUUID(),
        filename: file.name,
        transcript: fullTranscript,
        at: new Date().toISOString(),
        synced: false,
      };
      setResults((prev) => [record, ...prev]);
      setFile(null);
      setStatus("idle");
      setProgress("");
      try {
        await saveCloudResult(record);
        setResults((prev) => prev.map((r) =>
          r.id === record.id ? { ...r, synced: true } : r
        ));
        setCloudNotice(null);
      } catch (cloudError) {
        setCloudNotice("Transcript saved on this browser only. " +
          (cloudError instanceof Error ? cloudError.message : "Cloud storage unavailable."));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStatus("error");
      setProgress("");
    }
  }

  async function summarize(i: number) {
    setSummarizing(i);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ transcript: results[i].transcript }),
      });
      const data = await res.json();
      if (res.status === 401) throw new Error("Access denied — check your password.");
      if (!res.ok) throw new Error(data.error ?? "Summary failed");
      setResults((prev) =>
        prev.map((r, idx) => (idx === i ? { ...r, summary: data.summary as string } : r))
      );
      if (results[i].synced && results[i].id) {
        const response = await fetch(`/api/transcripts/${encodeURIComponent(results[i].id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ summary: data.summary }),
        });
        if (!response.ok) {
          setCloudNotice("Summary saved in browser, but cloud summary update failed.");
        }
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Summary failed");
    } finally {
      setSummarizing(null);
    }
  }

  async function deleteResult(i: number) {
    const record = results[i];
    if (record.synced && record.id) {
      if (!window.confirm("Delete from private cloud storage AND this browser?")) return;
      try {
        const response = await fetch(`/api/transcripts/${encodeURIComponent(record.id)}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (!response.ok) throw new Error("Could not delete the cloud record.");
      } catch {
        setCloudNotice("Cloud deletion failed; the transcript remains in this browser.");
        return;
      }
    }
    setResults((prev) => prev.filter((r) => r.id !== record.id));
  }

  async function copy(text: string, i: number) {
    await navigator.clipboard.writeText(text);
    setCopied(i);
    setTimeout(() => setCopied(null), 2000);
  }

  function download(r: Result) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.transcript], { type: "text/plain" }));
    a.download = r.filename.replace(/\.[^.]+$/, "") + "-transcript.txt";
    a.click();
  }

  // Avoid hydration mismatch — render nothing until localStorage is loaded
  if (password === null) return null;

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
          value={pwInput}
          onChange={(e) => {
            setPwInput(e.target.value);
            setPassword(e.target.value);
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

      <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
        <button onClick={syncLocal} disabled={syncing || status === "working"} style={btn("outline")}>
          {syncing ? "Syncing…" : "Sync local transcripts"}
        </button>
        <button onClick={loadCloud} disabled={loadingCloud || status === "working"} style={btn("outline")}>
          {loadingCloud ? "Loading…" : "Load cloud transcripts"}
        </button>
      </div>
      {cloudNotice && (
        <div role="status" style={{ marginTop: 12, color: "#e5bb69", fontSize: 13 }}>
          {cloudNotice}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Transcripts</h2>
          {results.map((r, i) => (
            <div
              key={i}
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
                  <button onClick={() => copy(r.transcript, i)} style={btn("outline")}>
                    {copied === i ? "✓ Copied" : "Copy"}
                  </button>
                  <button onClick={() => download(r)} style={btn("outline")}>↓ .txt</button>
                  <button
                    onClick={() => summarize(i)}
                    disabled={summarizing === i}
                    style={btn("outline")}
                  >
                    {summarizing === i ? "Summarizing…" : r.summary ? "Re-summarize" : "✦ Summarize"}
                  </button>
                  <button
                    onClick={() => deleteResult(i)}
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
