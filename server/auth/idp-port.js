// Identity, and the two ports that produce one: the IdP port (interactive sign-in) and the Verifier port (a token
// the server already issued). Types only; no adapter code. Adapters: oidc.js (IdP: Google), session.js and dev.js
// (Verifier). Contract tests: test/auth/idp-contract.js, test/auth/verifier-contract.js.
//
// ---- Identity ----
// Who signed in. `user` is namespaced by its source ("google:<sub>", "dev:<name>"), so sources never collide.
// `email` is set only when the IdP is authoritative for it (it may claim invites); `domain` is the Workspace
// domain (`hd`), lower-cased, never derived from the email. Exactly these four keys.
//
// ---- IdP port (driven by http.js /auth/login and /auth/callback) ----
//   begin() → { url, state, nonce, verifier }
//     `url` is where the browser goes; the caller keeps { state, nonce, verifier } (http.js: in a signed, HttpOnly,
//     short-lived cookie, so any server instance can finish the flow: no server-side login state). Each call returns
//     fresh, unguessable values. Rejects only if the adapter can't start at all (http.js answers 503 `unavailable`).
//   finish({ code, state, expected }) → Identity | null
//     `expected` is what begin() returned (as the caller stored it). Resolves null when the sign-in is refused: a
//     missing or mismatched state, a missing code, an incomplete `expected`, a code the IdP rejects, a token that
//     fails verification (signature, issuer, audience, nonce, expiry). It also resolves null (never rejects) when
//     the IdP can't be reached or times out: a sign-in is interactive and retried by the person, so an outage is a
//     failed sign-in, not a server error. Bounded: an adapter must time out its own network calls. Never rejects on
//     garbage input, including a non-object argument (finish(null)). A code is bound to its sign-in's PKCE
//     verifier (a code from another sign-in is refused even if the nonce matches) and works ONCE (a second finish
//     with the same code is null); for googleOidc, Google enforces both and the adapter must send the verifier.
//     The caller (http.js) separately refuses a replayed login cookie.
//     begin() ignores any arguments.
//
// ---- Verifier port (sessions, dev tokens; composed by port.js into the Auth port's verify) ----
//   verify(token) → Session | null
//     Offline (no network). null = "not mine or invalid": a non-string, empty, malformed, forged, expired or unknown
//     token. Never throws on garbage input; a genuine infrastructure failure may reject (the Auth port lets it
//     propagate, and the gateway answers `unavailable`).
//     Session = the Identity's four keys plus, when the token expires, `exp`: integer seconds since the epoch,
//     always in the future (an expired token is null). A token with no expiry (dev tokens) OMITS the key: never
//     null, 0 or Infinity. The gateway closes a live connection at `exp`; with no `exp` it sets no timer, and the
//     connection lives until it closes or a `grants` re-check drops its role.
//     Why a separate Session type, flat: Identity stays exactly four keys because it is also what session.issue()
//     takes and what the exchange cookie holds (who signed in, not for how long); flat because the gateway reads
//     `identity.exp` and the same object goes on to role(identity, board) and the admin use cases unchanged.

/**
 * @typedef {{ user: string, name: string|null, email: string|null, domain: string|null }} Identity
 *
 * @typedef {{ url: string, state: string, nonce: string, verifier: string }} LoginStart
 *
 * @typedef {{
 *   begin(): Promise<LoginStart>,
 *   finish(o: { code: unknown, state: unknown, expected: Partial<LoginStart>|null|undefined }): Promise<Identity|null>,
 * }} IdP
 *
 * @typedef {Identity & { exp?: number }} Session
 *
 * @typedef {{ verify(token: unknown): Promise<Session|null> }} Verifier
 */

export {};
