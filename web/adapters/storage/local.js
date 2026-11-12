// Storage adapter: the browser's localStorage (per origin, kept across sessions: the library, preferences).
// NEVER for the session token (web/core/signin.js keeps it in session storage only). Implements web/ports/storage.js.
// Same few lines as session.js on purpose: adapters never import each other.
//
// Every failure becomes STORAGE_UNAVAILABLE: the global missing, its getter throwing (SecurityError when site data
// is blocked), or a method throwing (QuotaExceededError on set, private modes). Resolved on every call.

import { STORAGE_UNAVAILABLE } from "../../ports/storage.js";

/**
 * @param {{ backing?: () => any }} [o]  backing: returns the Web Storage object (default globalThis.localStorage);
 *   tests pass a fake.
 * @returns {import("../../ports/storage.js").Storage}
 */
export function localStore({ backing = () => globalThis.localStorage } = {}) {
  const fail = cause => Object.assign(new Error("localStorage unavailable", { cause }), { code: STORAGE_UNAVAILABLE });
  function run(key, op) {
    if (typeof key !== "string") throw new TypeError("storage: key must be a string");
    let s;
    try { s = backing(); } catch (e) { throw fail(e); }
    if (!s || typeof s.getItem !== "function") throw fail();
    try { return op(s); } catch (e) { throw fail(e); }
  }
  return {
    get: key => run(key, s => { const v = s.getItem(key); return typeof v === "string" ? v : null; }),
    set(key, value) {
      if (typeof value !== "string") throw new TypeError("storage: value must be a string");
      run(key, s => { s.setItem(key, value); });
    },
    remove: key => run(key, s => { s.removeItem(key); }),
  };
}
