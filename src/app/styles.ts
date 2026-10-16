import type { CSSProperties } from "react";

/** Inline style for the page's buttons. */
export function btn(variant: "primary" | "outline"): CSSProperties {
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
