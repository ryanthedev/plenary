// A fake IdP ADAPTER (the IdP port, server/auth/idp-port.js), in memory: for tests that need a sign-in without
// Google's wire protocol. Not the same thing as fake-idp.js, which fakes Google's NETWORK for oidc.js.
// It passes test/auth/idp-contract.js.
//
//   const idp = fakeIdpAdapter();
//   const begun = await idp.begin();
//   const code = idp.authorize(begun, { user: "fake:ann", ... });   // the user signs in at the "IdP"
//   await idp.finish({ code, state: begun.state, expected: begun });  // → that Identity
//   idp.down = true;   // unreachable: finish resolves null, begin rejects

import { randomId } from "../../server/auth/util.js";

export const FAKE_IDENTITY = { user: "fake:ann", name: "Ann", email: "ann@acme.com", domain: "acme.com" };

export function fakeIdpAdapter({ authorizeUrl = "https://idp.invalid/authorize" } = {}) {
  /** code → { nonce, verifier, identity }; a code works once */
  const codes = new Map();
  const ok = v => typeof v === "string" && v.length > 0;
  const idp = {
    down: false,
    async begin() {
      if (idp.down) throw new Error("fake idp: down");
      const state = randomId(32), nonce = randomId(32), verifier = randomId(43);
      return { url: `${authorizeUrl}?state=${state}`, state, nonce, verifier };
    },
    /** The person signs in at the IdP for the flow `begun`; returns the code the IdP redirects back with. */
    authorize(begun, identity = FAKE_IDENTITY) {
      const code = "c-" + randomId(24);
      codes.set(code, { nonce: begun.nonce, verifier: begun.verifier, identity: { ...identity } });
      return code;
    },
    async finish(o) {
      const { code, state, expected } = o && typeof o === "object" ? o : {};
      if (!expected || typeof expected !== "object" || !ok(expected.state) || !ok(expected.nonce) || !ok(expected.verifier)) return null;
      if (state !== expected.state || !ok(code)) return null;
      if (idp.down) return null;
      const c = codes.get(code);
      if (!c) return null;
      codes.delete(code);
      if (c.nonce !== expected.nonce || c.verifier !== expected.verifier) return null;
      return { ...c.identity };
    },
  };
  return idp;
}
