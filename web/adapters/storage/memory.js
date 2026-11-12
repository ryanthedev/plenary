// Storage adapter: in memory (tests, and the fallback when the browser's store is unavailable). Lost on reload.
// Implements web/ports/storage.js.

import { STORAGE_UNAVAILABLE } from "../../ports/storage.js";

/**
 * @param {{ unavailable?: boolean }} [o]  unavailable: every call throws STORAGE_UNAVAILABLE (to test callers).
 * @returns {import("../../ports/storage.js").Storage}
 */
export function memoryStore({ unavailable = false } = {}) {
  const map = new Map();
  const check = key => {
    if (typeof key !== "string") throw new TypeError("storage: key must be a string");
    if (unavailable) throw Object.assign(new Error("storage unavailable"), { code: STORAGE_UNAVAILABLE });
  };
  return {
    get(key) { check(key); return map.has(key) ? map.get(key) : null; },
    set(key, value) {
      if (typeof value !== "string") throw new TypeError("storage: value must be a string");
      check(key);
      map.set(key, value);
    },
    remove(key) { check(key); map.delete(key); },
  };
}
