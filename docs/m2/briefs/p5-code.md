# Brief: p5-code (no session token in any URL: sign-in code exchange)

docs/m2/BRIEF-BASE.md applies, including its Architecture line. Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-code.md. Never pkill/killall; port 0; kill only PIDs you recorded.

## Goal (proxy's decision, from client's p6-land verifier, MEDIUM security)

The callback puts the long-lived session token in the URL fragment (`#token=…`, server/auth/http.js:165-172). Chrome
keeps it in its on-disk History (measured: 7 rows per profile with the full token) and in the navigation-timing
entry; web/ can't undo that. **No long-lived token ever goes in a URL.** The fragment carries a short-lived,
single-use code bound to the browser that ran the login; the client exchanges it with `POST /auth/exchange` for the
session token. The token still travels in `hello` (Herdr can't send credential headers), so a code exchange, not a
session cookie.

**Systems design skill:** apply `distributed-systems-design` (APPLIER) before coding: the code must work when the
callback and the exchange hit different nodes behind a load balancer (no sticky sessions), and say what single-use
means across nodes. Note it in the report.

## The endpoint shape (fixed; already sent to the client track; change it only if you find a real problem, and say so)

- **Callback:** `302` to `postLoginUrl#code=<code>` (or the share link's board URL `#code=<code>`; `&link=invalid` /
  `&link=unavailable` unchanged). It also sets an exchange cookie `__Host-plen_xchg` (Secure, HttpOnly,
  SameSite=Strict, Path=/, Max-Age=60) holding a random binder; the code is bound to it. Clears the login cookie as now.
- **`POST /auth/exchange`**, same origin, `credentials: "same-origin"` (the cookie must ride along),
  `Content-Type: application/json`, body `{ "code": "<code>" }`:
  - `200 { token, user, name, email, domain, exp }` (exp in seconds since epoch) and the exchange cookie cleared;
    `Cache-Control: no-store`.
  - `400 { error: "invalid-code" }`: unknown, malformed, expired (> 60 s), already used, or not bound to this browser's
    exchange cookie (one error for all, no oracle). Cookie cleared.
  - `403 { error: "bad-origin" }`: `Origin` header missing or not the origin of `postLoginUrl` (CSRF guard).
  - `415`/`400` for a wrong content type or body; `405` for other methods; `503 { error: "unavailable" }` as now.
- **Client duty** (for the client track): read `#code`, `history.replaceState` to drop the fragment at once, then POST.

## Design rules

- Code: ≥ 128 bits of randomness or a MAC-signed blob; lifetime ≤ 60 s; single use. Bound to the binder (e.g. the
  code carries a MAC over the binder hash, or the server stores binder hash with the code). Never log codes or binders.
- **Across nodes:** pick and justify one: (a) stateless signed code + binder cookie (a leaked code is useless without
  the HttpOnly cookie; the cookie is cleared on first use; a per-node used-set as defence), or (b) single-use stored
  through a port (would touch the Registry port and engine's adapters: ask the manager first). (a) is preferred.
- No session token in any URL anywhere: grep server/auth for `#token` and `token=` in redirects; update the header
  comments of http.js and docs that describe `#token`.
- Keep the replay guard, the login cookie and share-link redemption as they are.

## Tests (test/auth/http.test.js or a new file)

Happy path (callback → code → exchange → token verifies with `sessions`); **replayed code refused**; **expired code
refused** (injected clock, 61 s); **wrong origin refused** (missing, other origin, `null`); code without its cookie,
with another login's cookie, tampered code; the callback's Location never contains the session token; the share-link
path carries a code too; a second node (a fresh `httpRoutes` with the same config/keys) can exchange a code minted
by the first (if you pick (a)).

## Files you own

server/auth/http.js (and a small helper file in server/auth/ if needed), test/auth/. Not web/ (client's), not
main.js. If p5-google's dev harness (server/auth/dev-google.js or scripts/, another worker's) needs a tweak for the
new flow, list it in the report; don't edit it.

## Done when

Tests above pass; full `bun test` passes (if a full run fails, name the failing tests:
`bun test 2>&1 | grep -E '\(fail\)'`); report with what changed, tests, the skill note, not-verified, risks. Then stop.
Do not commit.
