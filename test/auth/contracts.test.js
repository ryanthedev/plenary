// Every auth adapter against its port's contract (brief p5-hex):
//   IdP port      googleOidc (driven through fake-idp.js, a fake Google network), fakeIdpAdapter (in memory)
//   Verifier port sessions, devAuth
import { googleOidc } from "../../server/auth/oidc.js";
import { sessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { randomId } from "../../server/auth/util.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";
import { fakeIdpAdapter, FAKE_IDENTITY } from "./fake-idp-adapter.js";
import { idpContract } from "./idp-contract.js";
import { verifierContract } from "./verifier-contract.js";

idpContract("googleOidc", async () => {
  const net = await fakeIdp();
  await net.addKey("k1");
  let down = false;
  const fetch = (url, init) => (down ? Promise.reject(new TypeError("fetch failed")) : net.fetch(url, init));
  const idp = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "https://plenary.test/auth/callback", fetch });
  return {
    idp,
    async authorize(begun) {
      const code = "c-" + randomId(24);
      net.strictCode(code, await net.mint({ nonce: begun.nonce }), begun.url);
      return code;
    },
    expected: { user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" },
    outage: on => { down = on; },
  };
});

idpContract("fakeIdpAdapter", async () => {
  const idp = fakeIdpAdapter();
  return { idp, authorize: async begun => idp.authorize(begun), expected: { ...FAKE_IDENTITY }, outage: on => { idp.down = on; } };
});

verifierContract("sessions", async () => {
  const clock = { t: Date.UTC(2026, 10, 11) };
  const s = await sessions({ key: "k".repeat(32), ttlSec: 3600, now: () => clock.t });
  const expected = { user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" };
  const token = await s.issue(expected);
  return { verifier: s, token, expected, exp: Math.floor(clock.t / 1000) + 3600, now: () => clock.t, expire: () => { clock.t += 3600_000; } };
});

verifierContract("devAuth", async () => ({
  verifier: devAuth({ enabled: true, tokens: { "dev-token-ann-0123456789": { name: "ann", email: "Ann@Acme.com", domain: "Acme.com" } } }),
  token: "dev-token-ann-0123456789",
  expected: { user: "dev:ann", name: "ann", email: "ann@acme.com", domain: "acme.com" },
}));
