// Storage adapters (web/adapters/storage/*) against the storage contract, plus what is particular to each.
import { describe, test, expect } from "bun:test";
import { storageContract } from "../contracts/storage-contract.js";
import { memoryStore } from "../../../web/adapters/storage/memory.js";
import { sessionStore } from "../../../web/adapters/storage/session.js";
import { localStore } from "../../../web/adapters/storage/local.js";
import { STORAGE_UNAVAILABLE } from "../../../web/ports/storage.js";

/** A Web Storage stand-in (getItem/setItem/removeItem; values stringified like the real one). */
export function fakeWebStorage({ quota = Infinity } = {}) {
  const m = new Map();
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem(k, v) {
      k = String(k); v = String(v);
      if (used() - (m.get(k)?.length ?? 0) - (m.has(k) ? k.length : 0) + k.length + v.length > quota)
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      m.set(k, v);
    },
    removeItem: k => { m.delete(String(k)); },
    get length() { return m.size; },
  };
}
const throwing = () => { throw Object.assign(new Error("blocked"), { name: "SecurityError" }); };
const brokenMethods = () => ({ getItem: throwing, setItem: throwing, removeItem: throwing });

storageContract("memory", () => memoryStore(), { makeUnavailable: () => memoryStore({ unavailable: true }) });
for (const [name, make] of [["session", sessionStore], ["local", localStore]]) {
  storageContract(`${name} (fake Web Storage)`, () => { const f = fakeWebStorage(); return make({ backing: () => f }); },
    { makeUnavailable: () => make({ backing: throwing }) });
  storageContract(`${name} (methods throw)`, () => { const f = fakeWebStorage(); return make({ backing: () => f }); },
    { makeUnavailable: () => make({ backing: brokenMethods }) });

  describe(`${name} storage adapter`, () => {
    const code = fn => { try { fn(); } catch (e) { return e.code; } return "no throw"; };
    test("missing global (undefined / not a Storage) is unavailable, not null", () => {
      expect(code(() => make({ backing: () => undefined }).get("k"))).toBe(STORAGE_UNAVAILABLE);
      expect(code(() => make({ backing: () => ({}) }).get("k"))).toBe(STORAGE_UNAVAILABLE);
    });
    test("quota: set throws STORAGE_UNAVAILABLE with the cause; the old value stays", () => {
      const f = fakeWebStorage({ quota: 10 });
      const s = make({ backing: () => f });
      s.set("k", "abc");
      let err;
      try { s.set("k", "x".repeat(50)); } catch (e) { err = e; }
      expect(err.code).toBe(STORAGE_UNAVAILABLE);
      expect(err.cause.name).toBe("QuotaExceededError");
      expect(s.get("k")).toBe("abc");
    });
    test("resolved per call: a store that becomes available is seen", () => {
      let f = null;
      const s = make({ backing: () => f });
      expect(code(() => s.get("k"))).toBe(STORAGE_UNAVAILABLE);
      f = fakeWebStorage();
      s.set("k", "v");
      expect(s.get("k")).toBe("v");
    });
    test(`default backing is globalThis.${name}Storage (absent under bun: unavailable)`, () => {
      const g = `${name}Storage`, had = Object.getOwnPropertyDescriptor(globalThis, g);
      try {
        const f = fakeWebStorage();
        Object.defineProperty(globalThis, g, { value: f, configurable: true });
        make().set("k", "v");
        expect(f.getItem("k")).toBe("v");
        delete globalThis[g];
        expect(code(() => make().get("k"))).toBe(STORAGE_UNAVAILABLE);
      } finally { if (had) Object.defineProperty(globalThis, g, had); else delete globalThis[g]; }
    });
  });
}

test("session and local stores are separate", () => {
  const a = fakeWebStorage(), b = fakeWebStorage();
  sessionStore({ backing: () => a }).set("k", "s");
  localStore({ backing: () => b }).set("k", "l");
  expect(a.getItem("k")).toBe("s");
  expect(b.getItem("k")).toBe("l");
});
