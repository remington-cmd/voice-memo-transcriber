import { describe, expect, it } from "vitest";
import { safeGet, safeSet } from "./storage";

function memoryStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    ...overrides,
  };
}

// What Safari does on any access to localStorage when all cookies are blocked.
const blocked = (): Storage => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("safeGet and safeSet", () => {
  it("round-trip a value", () => {
    const storage = memoryStorage();
    expect(safeSet(() => storage, "k", "v")).toBe(true);
    expect(safeGet(() => storage, "k")).toBe("v");
  });

  it("return null for a missing key", () => {
    expect(safeGet(() => memoryStorage(), "missing")).toBeNull();
  });

  it("return null and false when even reaching the storage throws", () => {
    expect(safeGet(blocked, "k")).toBeNull();
    expect(safeSet(blocked, "k", "v")).toBe(false);
  });

  it("return false when the storage is full", () => {
    const storage = memoryStorage({
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    });
    expect(safeSet(() => storage, "k", "v")).toBe(false);
  });

  it("return null when getItem itself throws", () => {
    const storage = memoryStorage({
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(safeGet(() => storage, "k")).toBeNull();
  });
});
