// Browser storage access that never throws.
//
// localStorage and sessionStorage can be full (setItem throws QuotaExceededError)
// or blocked. When Safari blocks all cookies, even reading window.localStorage
// throws a SecurityError, so these helpers take a getter and touch the storage
// object only inside the try.

/** The stored value, or null when the key is missing or storage is unavailable. */
export function safeGet(getStorage: () => Storage, key: string): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

/** Store a value. Returns false when storage is full, blocked or unavailable. */
export function safeSet(getStorage: () => Storage, key: string, value: string): boolean {
  try {
    getStorage().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
