// The Auth contract (web/ports/auth.js), as
// reusable bun tests. Every auth adapter runs it:
//
//   authContract("fake", () => { const a = fakeAuth(); return { auth: a, mint: async f => a.mint(f), force: k => a.setFail(k) }; });
//   authContract("http", () => httpOverFakeFetch());   // test/web/adapters/auth-http.test.js
//
// makeAuth() returns a FRESH adapter and:
//   mint(fields?)   → a valid, unused code whose session has these fields (name/email/domain may be null); for the
//                     HTTP adapter, what the server's callback issues (with its __Host-plen_xchg cookie).
//   force(kind)     REQUIRED (p6-portsv R2-M1: a failure test must never pass silently because an adapter cannot be
//                   forced). Make every following exchange meet this failure: "bad-origin" (a 403), "unavailable"
//                   (a 503), "network" (no answer: fetch throws), "malformed" (a 200 that is JSON but not the
//                   shape), null (normal). The fake: setFail; http: a fake fetch. A live server can't be forced, so
//                   it gets its own tests, not this contract.
// exp is integer SECONDS since the epoch (p6-portsv R2-L2): mint({ exp }) must come back unchanged, and every
// session's exp is below 1e11 (a ms value today is ~1.8e12).
// Errors are matched by value, from AUTH_ERRORS. Nothing may be logged while exchanging (the token and code are
// secrets): console is watched in every test.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AUTH_ERRORS } from "../../../web/ports/auth.js";

const nullableString = v => v === null || typeof v === "string";

/** Exactly one of a session or an error, each of the documented shape. */
export function expectAuthResult(r) {
  expect(r && typeof r).toBe("object");
  if ("error" in r) {
    expect(Object.keys(r)).toEqual(["error"]);
    expect(AUTH_ERRORS).toContain(r.error);
    return;
  }
  expect(Object.keys(r).sort()).toEqual(["domain", "email", "exp", "name", "token", "user"]);
  for (const k of ["token", "user"]) { expect(typeof r[k]).toBe("string"); expect(r[k].length).toBeGreaterThan(0); }
  for (const k of ["name", "email", "domain"]) expect(nullableString(r[k])).toBe(true);
  expect(Number.isInteger(r.exp)).toBe(true);
  expect(r.exp).toBeLessThan(1e11);       // seconds, not ms (R2-L2)
}

/**
 * @param {string} name
 * @param {() => { auth: import("../../../web/ports/auth.js").Auth, mint(fields?: object): Promise<string>,
 *                 force(kind: "bad-origin" | "unavailable" | "network" | "malformed" | null): void }} makeAuth
 * @param {{ skip?: boolean }} [opts]
 */
export function authContract(name, makeAuth, opts = {}) {
  describe.skipIf(!!opts.skip)(`Auth contract: ${name}`, () => {
    let auth, mint, force, logged, saved;
    beforeEach(() => {
      ({ auth, mint, force } = makeAuth());
      logged = []; saved = {};
      for (const k of ["log", "info", "warn", "error", "debug", "trace"]) {
        saved[k] = console[k];
        console[k] = (...a) => { logged.push([k, ...a]); };
      }
    });
    afterEach(() => {
      Object.assign(console, saved);
      expect(logged).toEqual([]);          // an adapter never logs (the token and the code are secrets)
    });

    test("a valid code resolves to { token, user, name, email, domain, exp } and nothing else", async () => {
      const r = await auth.exchange(await mint());
      expect("error" in r).toBe(false);
      expectAuthResult(r);
    });

    test("name, email and domain may each be null (consumer account, no name from Google): passed through as null", async () => {
      const r = await auth.exchange(await mint({ name: null, email: null, domain: null }));
      expectAuthResult(r);
      expect(r).toMatchObject({ name: null, email: null, domain: null });
      expect(r.user.length).toBeGreaterThan(0);
    });

    test("exp is seconds and passes through unchanged (never converted to or from ms)", async () => {
      const exp = 1_900_000_000;                       // 2030, in seconds
      const r = await auth.exchange(await mint({ exp }));
      expectAuthResult(r);
      expect(r.exp).toBe(exp);
    });

    test("strings are passed through unchanged", async () => {
      const f = { user: "google:1234", name: "Zoë Ñ", email: "zoe@acme.com", domain: "acme.com" };
      expect(await auth.exchange(await mint(f))).toMatchObject(f);
    });

    test("a code is single use: the second exchange of it resolves to invalid-code", async () => {
      const code = await mint();
      expectAuthResult(await auth.exchange(code));
      expect(await auth.exchange(code)).toEqual({ error: "invalid-code" });
    });

    test("an unknown code resolves to { error: 'invalid-code' }", async () => {
      expect(await auth.exchange("c-never-issued")).toEqual({ error: "invalid-code" });
    });

    test("a code that is not a non-empty string resolves to invalid-code (never rejects)", async () => {
      for (const c of ["", null, undefined, 42, {}]) expect(await auth.exchange(/** @type {any} */ (c))).toEqual({ error: "invalid-code" });
    });

    test("exchange returns a Promise that resolves, whatever the input", async () => {
      const p = auth.exchange("whatever");
      expect(p).toBeInstanceOf(Promise);
      expectAuthResult(await p);
    });

    // ── each failure keeps its own value and resolves (p6-portsv H3) ──
    test("force() is provided (required: otherwise the failure tests below could not run)", () => {
      expect(typeof force).toBe("function");
    });

    const kinds = [["bad-origin", "bad-origin"], ["unavailable", "unavailable"], ["network", "network"], ["malformed", "unavailable"]];
    for (const [kind, want] of kinds) {
      test(`forced ${kind}: resolves (never rejects) to exactly { error: "${want}" }`, async () => {
        const code = await mint();
        force(kind);
        let r, threw = null;
        try { r = await auth.exchange(code); } catch (e) { threw = e; }
        expect(threw).toBe(null);
        expect(r).toEqual({ error: want });
      });
    }

    test("the four failures stay distinct (never collapsed into one value)", async () => {
      const seen = [];
      for (const kind of ["bad-origin", "unavailable", "network"]) {
        const code = await mint();
        force(kind);
        seen.push((await auth.exchange(code)).error);
      }
      force(null);
      seen.push((await auth.exchange("c-never-issued")).error);
      expect(new Set(seen).size).toBe(4);
      expect(seen.sort()).toEqual([...AUTH_ERRORS].sort());
    });
  });
}
