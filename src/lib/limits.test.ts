import { describe, expect, it } from "vitest";
import { DIRECT_LIMIT, shouldChunk } from "./limits";

describe("shouldChunk", () => {
  it("uploads files up to DIRECT_LIMIT directly", () => {
    expect(shouldChunk(DIRECT_LIMIT)).toBe(false);
  });

  it("chunks anything larger than DIRECT_LIMIT", () => {
    expect(shouldChunk(DIRECT_LIMIT + 1)).toBe(true);
  });
});
