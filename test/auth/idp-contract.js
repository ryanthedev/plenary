// The IdP port contract (server/auth/idp-port.js), as reusable bun tests. Every IdP adapter runs the same suite:
//
//   idpContract("google", async () => ({ idp, authorize, outage }));
//
// `make()` returns a FRESH adapter plus its test driver:
//   idp                          the adapter (begin, finish)
//   authorize(begun, identity?)  plays the user signing in at the IdP for the flow `begun` (what begin() returned)
//                                and returns the authorization code the IdP would redirect back with
//   expected                     the Identity that authorize() produces by default
//   outage(on)                   optional: make the IdP unreachable (true) or reachable again (false)

import { describe, test, expect } from "bun:test";

const IDENTITY_KEYS = ["domain", "email", "name", "user"];

/**
 * @param {string} name
 * @param {() => Promise<{ idp: import("../../server/auth/idp-port.js").IdP,
 *   authorize(begun: object): Promise<string>, expected: import("../../server/auth/idp-port.js").Identity,
 *   outage?: (on: boolean) => void }>} make
 */
export function idpContract(name, make) {
  describe(`IdP contract: ${name}`, () => {
    test("begin() gives a url and fresh, non-empty state, nonce and verifier", async () => {
      const { idp } = await make();
      const a = await idp.begin(), b = await idp.begin();
      for (const x of [a, b]) {
        for (const k of ["url", "state", "nonce", "verifier"]) expect(typeof x[k] === "string" && x[k].length > 0).toBe(true);
        expect(new URL(x.url).protocol).toMatch(/^https?:$/);
        expect(x.state.length).toBeGreaterThanOrEqual(16);
        expect(x.nonce.length).toBeGreaterThanOrEqual(16);
      }
      expect(a.state).not.toBe(b.state);
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.verifier).not.toBe(b.verifier);
    });

    test("a completed sign-in gives exactly an Identity", async () => {
      const { idp, authorize, expected } = await make();
      const begun = await idp.begin();
      const code = await authorize(begun);
      const id = await idp.finish({ code, state: begun.state, expected: begun });
      expect(id).toEqual(expected);
      expect(Object.keys(id).sort()).toEqual(IDENTITY_KEYS);
      expect(typeof id.user).toBe("string");
      expect(id.user).toMatch(/^[a-z]+:./); // namespaced by source
    });

    test("a mismatched state is refused", async () => {
      const { idp, authorize } = await make();
      const begun = await idp.begin();
      const code = await authorize(begun);
      expect(await idp.finish({ code, state: begun.state + "x", expected: begun })).toBeNull();
      expect(await idp.finish({ code, state: undefined, expected: begun })).toBeNull();
    });

    test("a missing or incomplete `expected` is refused", async () => {
      const { idp, authorize } = await make();
      const begun = await idp.begin();
      const code = await authorize(begun);
      for (const expected of [null, undefined, {}, { ...begun, nonce: "" }, { ...begun, verifier: undefined }, { state: begun.state }])
        expect(await idp.finish({ code, state: begun.state, expected })).toBeNull();
    });

    test("a missing or unknown code is refused", async () => {
      const { idp } = await make();
      const begun = await idp.begin();
      for (const code of [undefined, null, "", 42, "no-such-code"])
        expect(await idp.finish({ code, state: begun.state, expected: begun })).toBeNull();
    });

    test("a code from another sign-in (other nonce) is refused", async () => {
      const { idp, authorize } = await make();
      const one = await idp.begin(), two = await idp.begin();
      const code = await authorize(one);
      expect(await idp.finish({ code, state: two.state, expected: two })).toBeNull();
    });

    test("a code from another sign-in with the SAME nonce is refused (PKCE verifier binds it)", async () => {
      const { idp, authorize } = await make();
      const one = await idp.begin(), two = await idp.begin();
      const code = await authorize(one);
      // Only the verifier (and state) differ from the sign-in the code belongs to; nonce is one's.
      const forged = { ...two, nonce: one.nonce };
      expect(await idp.finish({ code, state: forged.state, expected: forged })).toBeNull();
    });

    test("a code works once: a second finish with the same code is refused", async () => {
      const { idp, authorize, expected } = await make();
      const begun = await idp.begin();
      const code = await authorize(begun);
      expect(await idp.finish({ code, state: begun.state, expected: begun })).toEqual(expected);
      expect(await idp.finish({ code, state: begun.state, expected: begun })).toBeNull();
    });

    test("a non-object argument never rejects; begin ignores arguments", async () => {
      const { idp } = await make();
      for (const o of [null, undefined, 0, 42, "x", true, []]) expect(await idp.finish(o)).toBeNull();
      const b = await idp.begin("garbage", null, {});
      expect(typeof b.state).toBe("string");
    });

    test("garbage never throws", async () => {
      const { idp } = await make();
      const junk = [undefined, null, 0, "", "x", {}, [], { state: 1, nonce: {}, verifier: [] }];
      for (const code of junk) for (const state of junk) for (const expected of junk)
        expect(await idp.finish({ code, state, expected })).toBeNull();
      expect(await idp.finish({})).toBeNull();
    });

    test("an unreachable IdP is a refused sign-in (null), not a throw; it recovers", async () => {
      const { idp, authorize, expected, outage } = await make();
      if (!outage) return;
      const begun = await idp.begin();
      const code = await authorize(begun);
      outage(true);
      expect(await idp.finish({ code, state: begun.state, expected: begun })).toBeNull();
      outage(false);
      const again = await idp.begin();
      expect(await idp.finish({ code: await authorize(again), state: again.state, expected: again })).toEqual(expected);
    });
  });
}
