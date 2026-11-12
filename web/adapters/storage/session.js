// Storage adapter: the browser's sessionStorage (per tab, survives a reload; the sign-in token lives here).
// Implements web/ports/storage.js. Same few lines as local.js on purpose: adapters never import each other.
//
// Every failure becomes STORAGE_UNAVAILABLE: the global missing, its getter throwing (SecurityError when site data
// is blocked), or a method throwing (QuotaExceededError on set, private modes). Resolved on every call, so a store
// that comes back (or goes away) later is seen.

import { STORAGE_UNAVAILABLE } from "../../ports/storage.js";

/**
 * @param {{ backing?: () => any }} [o]  backing: returns the Web Storage object (default globalThis.sessionStorage);
 *   tests pass a fake.
 * @returns {import("../../ports/storage.js").Storage}
 */
export function sessionStore({ backing = () => globalThis.sessionStorage } = {}) {
  const fail = cause => Object.assign(new Error("sessionStorage unavailable", { cause }), { code: STORAGE_UNAVAILABLE });
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
