// A fake Google: a local RS256 keypair, its JWKS served through an injected fetch, ID-token minting, and a token
// endpoint. No network.
import { b64url, utf8 } from "../../server/auth/util.js";

export const CLIENT_ID = "test-client.apps.googleusercontent.com";

export async function rsaKey() {
  return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
}

export async function fakeIdp({ now = () => Date.now() } = {}) {
  const keys = new Map(); // kid → keypair
  const idp = {
    jwksFetches: 0,
    cacheControl: null,   // e.g. "public, max-age=60"
    tokenRequests: [],
    /** what the token endpoint returns for a code (lenient: reusable, no PKCE check) */
    codes: new Map(),
    /** code → { idToken, challenge }: Google-like codes, PKCE-checked (S256) and single use. See strictCode(). */
    strict: new Map(),
    /** Register a Google-like code for the sign-in whose authorize URL is `url` (its code_challenge binds it). */
    strictCode(code, idToken, url) {
      idp.strict.set(code, { idToken, challenge: new URL(url).searchParams.get("code_challenge") });
    },
    async addKey(kid) { keys.set(kid, await rsaKey()); return keys.get(kid); },
    removeKey(kid) { keys.delete(kid); },
    async jwks() {
      const out = [];
      for (const [kid, k] of keys) {
        const j = await crypto.subtle.exportKey("jwk", k.publicKey);
        out.push({ kty: "RSA", n: j.n, e: j.e, kid, alg: "RS256", use: "sig" });
      }
      return { keys: out };
    },
    /** Mint a token. `header`/`claims` override defaults; `signWith` = a kid whose private key signs. */
    async mint(claims = {}, { kid = [...keys.keys()][0], header = {}, signWith = kid, raw } = {}) {
      const t = Math.floor(now() / 1000);
      const h = { alg: "RS256", typ: "JWT", kid, ...header };
      const c = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1001", iat: t, exp: t + 3600, nonce: "n-1",
        email: "ann@acme.com", email_verified: true, hd: "acme.com", name: "Ann", ...claims };
      for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
      const signing = b64url(utf8(JSON.stringify(h))) + "." + b64url(utf8(JSON.stringify(c)));
      if (raw) return raw(signing);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.get(signWith).privateKey, utf8(signing));
      return signing + "." + b64url(sig);
    },
    fetch: async (url, init) => {
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        idp.jwksFetches++;
        return Response.json(await idp.jwks(), idp.cacheControl ? { headers: { "cache-control": idp.cacheControl } } : undefined);
      }
      if (url === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(init.body);
        idp.tokenRequests.push(Object.fromEntries(form));
        const s = idp.strict.get(form.get("code"));
        if (s) {
          idp.strict.delete(form.get("code"));          // single use, like Google
          const v = form.get("code_verifier") ?? "";
          const got = b64url(await crypto.subtle.digest("SHA-256", utf8(v)));
          return got === s.challenge ? Response.json({ id_token: s.idToken }) : new Response('{"error":"invalid_grant"}', { status: 400 });
        }
        const id_token = idp.codes.get(form.get("code"));
        return id_token ? Response.json({ id_token }) : new Response("{}", { status: 400 });
      }
      throw new Error("fake idp: no network: " + url);
    },
    exportPublic: kid => crypto.subtle.exportKey("spki", keys.get(kid).publicKey),
    exportPublicJwk: kid => crypto.subtle.exportKey("jwk", keys.get(kid).publicKey),
  };
  return idp;
}
