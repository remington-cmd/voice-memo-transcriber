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

/** A file's extension in lower case, without the dot; "" when it has none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** Extensions whose audio is normally AAC, the codec iPhone voice memos use. */
const AAC_EXTENSIONS = new Set(["m4a", "mp4", "aac"]);

/** True for files whose audio is normally AAC (.m4a, .mp4, .aac). */
export function isAacFile(filename: string): boolean {
  return AAC_EXTENSIONS.has(extensionOf(filename));
}

/**
 * Shown when the browser can't decode a file to split it, naming its
 * extension when it has one. Current browsers all decode MP3, so a failed
 * .mp3 is most likely damaged. A failed AAC file in a browser with no AAC
 * decoder (`aacSupported` false, as in some Linux and Firefox builds) is the
 * browser's fault, not the file's. Otherwise a failed .m4a may be damaged or
 * Lossless (ALAC), which Chrome can't decode. Anything else gets the advice
 * to convert.
 */
export function decodeFailedMessage(filename: string, aacSupported = true): string {
  const ext = extensionOf(filename);
  const what = ext && /^[a-z0-9]+$/.test(ext) ? `this .${ext} file` : "this file";
  const lead = `This browser couldn't decode ${what} for splitting.`;
  if (!aacSupported && AAC_EXTENSIONS.has(ext)) {
    return `${lead} It can't play AAC audio. Use a current Chrome, Edge or Safari, or convert the file to MP3.`;
  }
  switch (ext) {
    case "mp3":
      return `${lead} It may be damaged. Try exporting it again.`;
    case "m4a":
      return `${lead} It may be damaged or recorded as Lossless. Try exporting it again, or convert it to MP3.`;
    default:
      return `${lead} Convert it to MP3 or AAC (.m4a), or try Chrome.`;
  }
}
