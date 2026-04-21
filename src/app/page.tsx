"use client";

import { useCallback, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";

const MAX_DROPZONE = 500 * 1024 * 1024; // 500 MB — no frontend gate; server handles via compression
const WHISPER_LIMIT = 24 * 1024 * 1024; // compress anything over 24 MB before upload

interface Result {
  filename: string;
  transcript: string;
  duration?: number;
  language?: string;
  at: Date;
}

type Status = "idle" | "compressing" | "transcribing" | "error";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [progress, setProgress] = useState("");
  const ffmpegRef = useRef<import("@ffmpeg/ffmpeg").FFmpeg | null>(null);

  const onDrop = useCallback((accepted: File[], rejected: { file: File }[]) => {
    if (rejected.length > 0) {
      setError("Unsupported file type. Use .m4a, .mp3, .wav, or .mp4.");
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
    maxSize: MAX_DROPZONE,
    maxFiles: 1,
    disabled: status === "compressing" || status === "transcribing",
  });

  async function compress(input: File): Promise<File> {
    setStatus("compressing");
    setProgress("Loading audio processor… (~10 s first time)");

    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { fetchFile, toBlobURL } = await import("@ffmpeg/util");

    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg();
      const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpegRef.current = ffmpeg;
    }

    const ffmpeg = ffmpegRef.current;
    setProgress("Compressing… (16 kHz mono — takes ~15–30 s)");

    const ext = input.name.split(".").pop() ?? "m4a";
    await ffmpeg.writeFile(`input.${ext}`, await fetchFile(input));
    await ffmpeg.exec([
      "-i", `input.${ext}`,
      "-ar", "16000",
      "-ac", "1",
      "-b:a", "32k",
      "output.mp3",
    ]);

    const raw = await ffmpeg.readFile("output.mp3");
    const data = raw instanceof Uint8Array ? new Uint8Array(raw) : new TextEncoder().encode(raw as string);
    return new File([data], input.name.replace(/\.[^.]+$/, ".mp3"), { type: "audio/mpeg" });
  }

  async function transcribe() {
    if (!file) return;
    setError(null);

    let uploadFile = file;
    if (file.size > WHISPER_LIMIT) {
      try {
        uploadFile = await compress(file);
      } catch {
        setError("Compression failed. Try a smaller file or convert to MP3 first.");
        setStatus("error");
        return;
      }
    }

    setStatus("transcribing");
    setProgress("");

    const fd = new FormData();
    fd.append("file", uploadFile);

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

  const busy = status === "compressing" || status === "transcribing";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>🎙 Voice Memo Transcriber</h1>
        <p style={{ color: "#999", marginTop: 8 }}>Drop an audio file and get a full transcript. Large files are compressed automatically.</p>
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
          opacity: busy ? 0.5 : 1,
        }}
      >
        <input {...getInputProps()} />
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎵</div>
        <p style={{ margin: 0, color: "#ccc", fontWeight: 500 }}>
          {isDragActive ? "Drop it here…" : "Drag & drop your voice memo here"}
        </p>
        <p style={{ margin: "8px 0 16px", color: "#555", fontSize: 14 }}>
          .m4a · .mp3 · .wav · .mp4 · any size (large files compressed in-browser)
        </p>
        <button style={btnStyle("outline")}>Browse files</button>
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "#2a1515", border: "1px solid #5a2020", borderRadius: 8, color: "#f87171", fontSize: 14 }}>
          {error}
        </div>
      )}

      {file && (
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}>
          <div>
            <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{file.name}</p>
            <p style={{ margin: 0, color: "#666", fontSize: 12 }}>
              {(file.size / 1024 / 1024).toFixed(1)} MB
              {file.size > WHISPER_LIMIT && <span style={{ color: "#f59e0b", marginLeft: 8 }}>will compress before upload</span>}
            </p>
            {progress && <p style={{ margin: "4px 0 0", color: "#4f8ef7", fontSize: 12 }}>{progress}</p>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!busy && (
              <button onClick={() => setFile(null)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            )}
            <button onClick={transcribe} disabled={busy} style={btnStyle("primary")}>
              {status === "compressing" ? "Compressing…" : status === "transcribing" ? "Transcribing…" : "Transcribe"}
            </button>
          </div>
        </div>
      )}

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

      <div style={{ marginTop: 40, padding: "16px", border: "1px dashed #333", borderRadius: 8, fontSize: 13, color: "#666" }}>
        <strong style={{ color: "#999" }}>From your iPhone:</strong> Voice Memos → tap recording → ··· → Share → Save to Files. Then open this page and tap Browse files.
      </div>
    </main>
  );
}

function btnStyle(variant: "primary" | "outline"): React.CSSProperties {
  return variant === "primary"
    ? { background: "#4f8ef7", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontWeight: 500, fontSize: 14 }
    : { background: "none", color: "#ccc", border: "1px solid #444", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13 };
}
