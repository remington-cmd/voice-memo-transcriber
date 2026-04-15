"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

const MAX_SIZE = 25 * 1024 * 1024;

interface Result {
  filename: string;
  transcript: string;
  duration?: number;
  language?: string;
  at: Date;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "transcribing" | "error">("idle");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const onDrop = useCallback((accepted: File[], rejected: {file: File}[]) => {
    if (rejected.length > 0) {
      setError("File too large or unsupported type. Max 25 MB. Use .m4a, .mp3, .wav, or .mp4.");
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
    disabled: status === "transcribing",
  });

  async function transcribe() {
    if (!file) return;
    setStatus("transcribing");
    setError(null);

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Transcription failed");
        setStatus("error");
        return;
      }

      setResults((prev) => [
        { filename: file.name, transcript: data.transcript, duration: data.duration, language: data.language, at: new Date() },
        ...prev,
      ]);
      setFile(null);
      setStatus("idle");
    } catch {
      setError("Network error. Check your connection.");
      setStatus("error");
    }
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

  function fmt(s: number) {
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>🎙 Voice Memo Transcriber</h1>
        <p style={{ color: "#999", marginTop: 8 }}>Drop an audio file from your iPhone and get a full transcript instantly.</p>
      </div>

      {/* Drop zone */}
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
          opacity: status === "transcribing" ? 0.5 : 1,
        }}
      >
        <input {...getInputProps()} />
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎵</div>
        <p style={{ margin: 0, color: "#ccc", fontWeight: 500 }}>
          {isDragActive ? "Drop it here…" : "Drag & drop your voice memo here"}
        </p>
        <p style={{ margin: "8px 0 16px", color: "#555", fontSize: 14 }}>
          .m4a · .mp3 · .wav · .mp4 · max 25 MB
        </p>
        <button style={btnStyle("outline")}>Browse files</button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "#2a1515", border: "1px solid #5a2020", borderRadius: 8, color: "#f87171", fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Selected file */}
      {file && (
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}>
          <div>
            <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{file.name}</p>
            <p style={{ margin: 0, color: "#666", fontSize: 12 }}>{(file.size / 1024 / 1024).toFixed(1)} MB</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {status !== "transcribing" && (
              <button onClick={() => setFile(null)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            )}
            <button onClick={transcribe} disabled={status === "transcribing"} style={btnStyle("primary")}>
              {status === "transcribing" ? "Transcribing…" : "Transcribe"}
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Transcripts</h2>
          {results.map((r, i) => (
            <div key={i} style={{ marginBottom: 20, border: "1px solid #333", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "14px 16px", background: "#1a1a1a" }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{r.filename}</p>
                  <p style={{ margin: 0, color: "#666", fontSize: 12, marginTop: 2 }}>
                    {r.at.toLocaleString()}{r.duration ? ` · ${fmt(r.duration)}` : ""}{r.language ? ` · ${r.language}` : ""}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => copy(r.transcript, i)} style={btnStyle("outline")}>
                    {copied === i ? "✓ Copied" : "Copy"}
                  </button>
                  <button onClick={() => download(r)} style={btnStyle("outline")}>↓ .txt</button>
                </div>
              </div>
              <div style={{ padding: "16px", background: "#111", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 400, overflowY: "auto", color: "#ddd" }}>
                {r.transcript}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* iPhone tip */}
      <div style={{ marginTop: 40, padding: "16px", border: "1px dashed #333", borderRadius: 8, fontSize: 13, color: "#666" }}>
        <strong style={{ color: "#999" }}>From your iPhone:</strong> Voice Memos → tap recording → ··· → Share → Save to Files. Then open this page in Chrome and tap Browse files.
      </div>
    </main>
  );
}

function btnStyle(variant: "primary" | "outline"): React.CSSProperties {
  return variant === "primary"
    ? { background: "#4f8ef7", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontWeight: 500, fontSize: 14 }
    : { background: "none", color: "#ccc", border: "1px solid #444", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13 };
}
