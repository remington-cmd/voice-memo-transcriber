// Which files the dropzone accepts, and what to say about the ones it turns away.

import { MAX_SIZE } from "./limits";

/** MIME types the dropzone accepts, each with its file extensions. */
export const ACCEPT: Record<string, string[]> = {
  "audio/x-m4a": [".m4a"],
  "audio/mp4": [".mp4", ".m4a"],
  "audio/mpeg": [".mp3"],
  "audio/wav": [".wav"],
  "audio/webm": [".webm"],
  "audio/ogg": [".ogg"],
  "video/mp4": [".mp4"],
};

/** Every extension in ACCEPT, once each, in the order first listed. */
export const ACCEPTED_EXTENSIONS: readonly string[] = [...new Set(Object.values(ACCEPT).flat())];

const MAX_SIZE_MB = Math.round(MAX_SIZE / 1024 / 1024);

/** "500 MB": the dropzone's size cap as the page shows it. */
export const MAX_SIZE_LABEL = `${MAX_SIZE_MB} MB`;

/** The shape of react-dropzone's FileRejection that the message needs. */
interface Rejection {
  errors: readonly { code: string }[];
}

/**
 * What to tell the user about files the dropzone rejected. Several files at
 * once is reported first, since every file is rejected for that alone.
 */
export function rejectionMessage(rejections: readonly Rejection[]): string {
  if (rejections.some((r) => r.errors.some((e) => e.code === "too-many-files"))) {
    return "Drop one file at a time.";
  }
  switch (rejections[0]?.errors[0]?.code) {
    case "file-too-large":
      return `File is larger than ${MAX_SIZE_LABEL}.`;
    case "file-invalid-type":
      return `Unsupported file type. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`;
    default:
      return `This file can't be used. Use ${ACCEPTED_EXTENSIONS.join(", ")}, up to ${MAX_SIZE_LABEL}.`;
  }
}

/**
 * Shown when the browser can't decode a file to split it, naming its
 * extension when it has one.
 */
export function decodeFailedMessage(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const what = ext && /^[a-z0-9]+$/.test(ext) ? `this .${ext} file` : "this file";
  return `This browser couldn't decode ${what} for splitting. Convert it to MP3 or AAC (.m4a), or try Chrome.`;
}
