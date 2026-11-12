// The Storage contract (web/ports/storage.js), as reusable bun tests. Every storage adapter runs it:
//
//   import { storageContract } from "<repo>/test/web/contracts/storage-contract.js";
//   storageContract("session", () => sessionStore({ backing: () => fake }), { makeUnavailable: () => ... });
//
// makeStorage(): a FRESH, empty Storage per test. opts.makeUnavailable(): a Storage of the same adapter whose
// backing store fails (private mode, quota); omitted, those tests are not registered. opts.skip: skip all (a
// real-service adapter whose env is unset). opts.shared: two instances share one backing store BY DESIGN (a real
// browser's sessionStorage); skips the instance-independence test. Failures are matched by err.code, never by class.
// Nothing may be logged while storing (values hold the session token): console is watched in every test.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { STORAGE_UNAVAILABLE } from "../../../web/ports/storage.js";

/**
 * @param {string} name
 * @param {() => import("../../../web/ports/storage.js").Storage} makeStorage
 * @param {{ makeUnavailable?: () => import("../../../web/ports/storage.js").Storage, skip?: boolean, shared?: boolean }} [opts]
 */
export function storageContract(name, makeStorage, opts = {}) {
  describe.skipIf(!!opts.skip)(`Storage contract: ${name}`, () => {
    let s, logged, saved;
    beforeEach(() => {
      logged = []; saved = {};
      for (const k of ["log", "info", "warn", "error", "debug", "trace"]) {
        saved[k] = console[k];
        console[k] = (...a) => { logged.push([k, ...a]); };
      }
      s = makeStorage();
    });
    afterEach(() => {
      Object.assign(console, saved);
      expect(logged).toEqual([]);          // an adapter never logs (keys and values may be secrets)
    });

    test("get of an absent key is null", () => {
      expect(s.get("nope")).toBe(null);
    });

    test("set then get returns the exact string (empty, unicode, long, JSON-looking)", () => {
      for (const v of ["", "x", "héllo ✏️ 日本", "a".repeat(100_000), '{"a":1}', "null", "0"]) {
        s.set("k", v);
        expect(s.get("k")).toBe(v);
      }
    });

    test("set overwrites; remove forgets; remove of an absent key is fine", () => {
      s.set("k", "1"); s.set("k", "2");
      expect(s.get("k")).toBe("2");
      s.remove("k");
      expect(s.get("k")).toBe(null);
      expect(() => s.remove("k")).not.toThrow();
      expect(() => s.remove("never-set")).not.toThrow();
    });

    test("keys are independent", () => {
      s.set("a", "1"); s.set("b", "2"); s.set("", "empty key");
      s.remove("a");
      expect(s.get("a")).toBe(null);
      expect(s.get("b")).toBe("2");
      expect(s.get("")).toBe("empty key");
    });

    // p6-portsv H4: a value must never be readable or clobbered through another key. p2's real keys all share
    // the "plenary." prefix, so truncation, case-folding or normalising would merge them.
    test("keys that differ only in case, a prefix, unicode form or length never collide", () => {
      const keys = [
        "plenary.session", "Plenary.Session", "PLENARY.SESSION", "plenary.sessio", "plenary.session.x", "plenary.session ",
        " plenary.session", "plenary.panel", "plenary.library", "plenary.mine.b-1234567890abcdef.google:ann",
        "plenary.mine.b-1234567890abcdef.google:bob", "caf\u00e9", "cafe\u0301", "日本", "k".repeat(1000), "k".repeat(1001),
        "a.b", "a_b", "0", "00",
      ];
      expect(new Set(keys).size).toBe(keys.length);
      keys.forEach((k, i) => s.set(k, `v${i}`));
      keys.forEach((k, i) => expect(s.get(k)).toBe(`v${i}`));
      for (let i = 0; i < keys.length; i += 2) s.remove(keys[i]);
      keys.forEach((k, i) => expect(s.get(k)).toBe(i % 2 === 0 ? null : `v${i}`));
    });

    test("a fresh instance shares nothing with another one", () => {
      if (opts.shared) return;
      const other = makeStorage();
      s.set("k", "mine");
      expect(other.get("k")).toBe(null);
      other.set("k", "theirs");
      expect(s.get("k")).toBe("mine");
    });

    test("a non-string value is a TypeError, never coerced or stored", () => {
      for (const v of [1, null, undefined, {}, true]) expect(() => s.set("k", /** @type {any} */ (v))).toThrow(TypeError);
      expect(s.get("k")).toBe(null);
    });

    test("a non-string key is a TypeError", () => {
      expect(() => s.get(/** @type {any} */ (1))).toThrow(TypeError);
      expect(() => s.set(/** @type {any} */ (null), "v")).toThrow(TypeError);
      expect(() => s.remove(/** @type {any} */ ({}))).toThrow(TypeError);
    });

    if (opts.makeUnavailable) {
      const code = fn => { try { fn(); } catch (e) { return e?.code ?? "no code"; } return "did not throw"; };
      test("unavailable: get/set/remove throw STORAGE_UNAVAILABLE; get never answers null", () => {
        const u = opts.makeUnavailable();
        expect(code(() => u.get("k"))).toBe(STORAGE_UNAVAILABLE);
        expect(code(() => u.set("k", "v"))).toBe(STORAGE_UNAVAILABLE);
        expect(code(() => u.remove("k"))).toBe(STORAGE_UNAVAILABLE);
      });
    }
  });
}
