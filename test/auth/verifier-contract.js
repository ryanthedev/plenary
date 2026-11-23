// The Verifier port contract (server/auth/idp-port.js: verify(token) → Identity | null, never throws on garbage),
// as reusable bun tests. Every verifier the Auth port composes (session.js, dev.js) runs the same suite:
//
//   verifierContract("sessions", async () => ({ verifier, token, expected, exp, now, expire }));
//
// `make()` returns a FRESH verifier plus a token it accepts and the Identity that token stands for (four keys).
// An adapter whose tokens expire also returns `exp` (the integer seconds the token's Session must carry), `now()`
// (its clock, ms) and `expire()` (advance that clock past the token's lifetime). One with no expiry (devAuth)
// returns none of them, and its Session must OMIT `exp` (idp-port.js: absent = no expiry; never null).

import { describe, test, expect } from "bun:test";

const GARBAGE = [undefined, null, 0, 1, NaN, true, {}, [], () => "x", Symbol.for("t"), "", " ", "x", ".", "..", "s1.", "s1..",
  "s1.a.b", "s1.a.b.c", "s1.@@@.###", "Bearer x", "eyJhbGciOiJSUzI1NiJ9.e30.x", "a".repeat(10_000), "\u0000", "dev:ann"];

/**
 * @param {string} name
 * @param {() => Promise<{ verifier: import("../../server/ports/idp.js").Verifier, token: string,
 *   expected: import("../../server/ports/idp.js").Identity, exp?: number, now?: () => number, expire?: () => void }>} make
 */
export function verifierContract(name, make) {
  describe(`Verifier contract: ${name}`, () => {
    test("its own token gives exactly the Identity, plus exp only if the adapter has expiry", async () => {
      const { verifier, token, expected, exp } = await make();
      const id = await verifier.verify(token);
      expect(id).toEqual(exp === undefined ? expected : { ...expected, exp });
      expect(Object.keys(id).sort()).toEqual(exp === undefined ? ["domain", "email", "name", "user"] : ["domain", "email", "exp", "name", "user"]);
      expect(id.user).toMatch(/^[a-z]+:./);
      if (exp === undefined) expect("exp" in id).toBe(false);
    });

    test("exp, when present, is an integer in the future (seconds since the epoch)", async () => {
      const { verifier, token, exp, now } = await make();
      if (exp === undefined) return;
      expect(typeof now).toBe("function");
      const id = await verifier.verify(token);
      expect(Number.isInteger(id.exp)).toBe(true);
      expect(id.exp).toBeGreaterThan(Math.floor(now() / 1000));
      expect(id.exp).toBeLessThan(1e11);   // seconds, not milliseconds
    });

    test("an adapter with expiry declares it fully (exp, now, expire together)", async () => {
      const { exp, now, expire } = await make();
      const has = [exp !== undefined, typeof now === "function", typeof expire === "function"];
      expect(has.every(Boolean) || !has.some(Boolean)).toBe(true);
    });

    test("garbage gives null and never throws", async () => {
      const { verifier } = await make();
      for (const g of GARBAGE) expect(await verifier.verify(g)).toBeNull();
    });

    test("a tampered token gives null", async () => {
      const { verifier, token } = await make();
      const flip = c => (c === "A" ? "B" : "A");
      // Not the last char: base64url's final char may carry padding bits a decoder ignores.
      for (const i of [0, Math.floor(token.length / 2), token.length - 2])
        expect(await verifier.verify(token.slice(0, i) + flip(token[i]) + token.slice(i + 1))).toBeNull();
      expect(await verifier.verify(token + "x")).toBeNull();
      expect(await verifier.verify(token.slice(0, -1))).toBeNull();
    });

    test("verify is repeatable (no state consumed)", async () => {
      const { verifier, token } = await make();
      const first = await verifier.verify(token);
      expect(first).not.toBeNull();
      expect(await verifier.verify(token)).toEqual(first);
    });

    test("an expired token gives null", async () => {
      const { verifier, token, expire } = await make();
      if (!expire) return;
      expire();
      expect(await verifier.verify(token)).toBeNull();
    });
  });
}
