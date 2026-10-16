"use client";

import { useEffect } from "react";

// Shown in place of the page when it throws while rendering, so an unexpected
// client error leaves a way back instead of a blank screen.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Something went wrong</h1>
      <p style={{ color: "#999", marginTop: 8, marginBottom: 20 }}>
        The page hit an unexpected error. Try again, or reload the page.
      </p>
      <button
        onClick={reset}
        style={{
          background: "#4f8ef7",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 16px",
          cursor: "pointer",
          fontWeight: 500,
          fontSize: 14,
        }}
      >
        Try again
      </button>
    </main>
  );
}
