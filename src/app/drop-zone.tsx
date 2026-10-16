"use client";

import { useDropzone, type FileRejection } from "react-dropzone";
import { ACCEPT, ACCEPTED_EXTENSIONS, MAX_SIZE_LABEL } from "@/lib/files";
import { MAX_SIZE } from "@/lib/limits";
import { btn } from "./styles";

/**
 * Where a file is dropped or picked. A click anywhere on the zone opens the
 * file picker. From the keyboard, Browse files is the way in: the zone itself
 * takes no focus, since a focusable zone loses its presentation role and reads
 * as an unnamed element.
 */
export function DropZone({
  onDrop,
  working,
}: {
  onDrop: (accepted: File[], rejected: FileRejection[]) => void;
  working: boolean;
}) {
  // Not `disabled` while working: that drops the zone's drop handler, and the
  // browser then opens a dropped file in place of the page. onDrop ignores it.
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxSize: MAX_SIZE,
    multiple: false,
    noClick: working,
    noKeyboard: true,
  });

  return (
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
        opacity: working ? 0.5 : 1,
      }}
    >
      <input {...getInputProps()} />
      <div style={{ fontSize: 40, marginBottom: 12 }}>🎵</div>
      <p style={{ margin: 0, color: "#ccc", fontWeight: 500 }}>
        {isDragActive ? "Drop it here…" : "Drag & drop your audio file here"}
      </p>
      <p style={{ margin: "8px 0 16px", color: "#555", fontSize: 14 }}>
        {ACCEPTED_EXTENSIONS.join(" · ")} · up to {MAX_SIZE_LABEL}
      </p>
      {/* Its click bubbles to the zone, which opens the picker. */}
      <button type="button" disabled={working} style={btn("outline")}>
        Browse files
      </button>
    </div>
  );
}
