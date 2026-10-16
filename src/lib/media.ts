// Reading facts about a media file without decoding it. Browser-only.

/**
 * A file's length in seconds, read from its metadata by the browser's media
 * player, which does not decode the audio. Null when the player can't tell
 * (some .webm files report no length), can't open the format, or takes longer
 * than `timeoutMs`. The object URL is always revoked.
 */
export function readDuration(file: Blob, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    let audio: HTMLAudioElement;
    let url: string;
    try {
      audio = document.createElement("audio");
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }

    let done = false;
    const finish = (seconds: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      // Stop loading before the URL goes away.
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {}
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    audio.preload = "metadata";
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : null);
    audio.onerror = () => finish(null);
    try {
      audio.src = url;
      // iOS Safari may not load anything for a src alone; load() still runs
      // inside the click that started the job.
      audio.load();
    } catch {
      finish(null);
    }
  });
}
