// The Verifier port contract (server/auth/idp-port.js: verify(token) → Identity | null, never throws on garbage),
// as reusable bun tests. Every verifier the Auth port composes (session.js, dev.js) runs the same suite:
//
//   verifierContract("sessions", async () => ({ verifier, token, expected, expire }));
//
// `make()` returns a FRESH verifier plus a token it accepts and the Identity that token stands for. `expire()` is
// optional: advance the verifier's clock past the token's lifetime.

import { describe, test, expect } from "bun:test";

const GARBAGE = [undefined, null, 0, 1, NaN, true, {}, [], () => "x", Symbol.for("t"), "", " ", "x", ".", "..", "s1.", "s1..",
  "s1.a.b", "s1.a.b.c", "s1.@@@.###", "Bearer x", "eyJhbGciOiJSUzI1NiJ9.e30.x", "a".repeat(10_000), "\u0000", "dev:ann"];

/**
 * @param {string} name
 * @param {() => Promise<{ verifier: import("../../server/auth/idp-port.js").Verifier, token: string,
 *   expected: import("../../server/auth/idp-port.js").Identity, expire?: () => void }>} make
 */
export function verifierContract(name, make) {
  describe(`Verifier contract: ${name}`, () => {
    test("its own token gives exactly the Identity", async () => {
      const { verifier, token, expected } = await make();
      const id = await verifier.verify(token);
      expect(id).toEqual(expected);
      expect(Object.keys(id).sort()).toEqual(["domain", "email", "name", "user"]);
      expect(id.user).toMatch(/^[a-z]+:./);
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
      const { verifier, token, expected } = await make();
      expect(await verifier.verify(token)).toEqual(expected);
      expect(await verifier.verify(token)).toEqual(expected);
    });

    test("an expired token gives null", async () => {
      const { verifier, token, expire } = await make();
      if (!expire) return;
      expire();
      expect(await verifier.verify(token)).toBeNull();
    });
  });
}
