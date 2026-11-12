# Report: p5-httpv (verify p5-http: sign-in and admin HTTP routes)

**PASS.** No HIGH findings. One MEDIUM: the replay guard's cost grows with traffic, which gives an unauthenticated caller a way to burn CPU. Four LOW notes follow. Verifier for `manager platform` (t14q). Nothing
committed. Nothing written outside this report and the session scratchpad.

## What I checked

- **The diff:** `git diff -- server/admin` (the createBoard retry and report, plus AdminError `board`/`cause`), and
  the untracked `server/auth/http.js` and `test/auth/http.test.js`.
- **Read against:**
  - PROTOCOL.md § Auth, § Tenancy and § Registry.
  - session.js, dev.js, oidc.js (`begin`/`finish`), tenancy.js (`redeemLink`, `tenantOf`), registry.js (the
    in-memory adapter keeps everything in `Map`s), util.js and boards.js.
  - The builder's 19 tests in `test/auth/http.test.js`.
- **PROTOCOL.md matches the code:**
  - `POST /boards` takes its tenant from the identity.
  - Everyone signs in before redeeming a link.
  - Only a tenant admin grants `owner`.
  - Id-only admin calls check the id's board (`revokeInvite`/`revokeLink` compare `i.board`/`l.board` with
    the managed board).
  - `createBoard` retries the owner grant, then reports the failure with the board id.
- **`bun test` (full):** 291 pass, 0 fail, 20 files.
- **Attack tests:** 18 tests in the scratchpad (`attack.test.js`), run against the real module with the fake
  IdP. All 18 pass.
- **Asserted vs. read from logs:** most rows below are asserted by a test. These were read from `console.log`
  output instead:
  - the error-body contents;
  - the duplicate-cookie result;
  - the cross-process replay;
  - the cross-tenant redeem;
  - the invalid-UTF-8 status;
  - the `/blobs/../boards` normalisation;
  - the prototype-key grant;
  - the timings.

| Attack | Result |
|---|---|
| Open redirect: `redirect`/`next`/`return_to`/`post_login`/`redirect_uri` parameters on login, callback and logout | ignored; Location is Google, `postLoginUrl#token=…` or `postLogoutUrl` |
| Open redirect: `Host`, `X-Forwarded-Host`/`-Proto`, `Forwarded`, `X-Original-URL` | ignored (nothing reads them); Google's `redirect_uri` stays the configured one |
| Open redirect: link remembered in the cookie (`..%2F..%2Fevil`, `x#y`; `//evil`, `https://evil` and CRLF forms aren't routes at all, so they give null) | link is only a Registry lookup key; lands on `postLoginUrl#token=…&link=invalid` |
| Redeemed share link | lands on `boardUrl` with the board id URL-encoded |
| Cookie: cross-login swap (cookie A + state B; state A + nonce B) | 400 both |
| Cookie: replay after use, same process | 400 |
| Cookie: expiry at exactly `exp` | 400 |
| Cookie: oversized (5 KB) | 400 |
| Cookie: quoted value | 400 |
| Cookie: forged with another key | 400 |
| Cookie: session token used as the cookie | 400 |
| Leak: token in the query or the non-fragment part of Location | never; `?token=` on the API is 401 |
| Leak: error bodies | generic codes; `unknown-field` echoes only the caller's own key, cut to 64 chars |
| Leak: log lines | the handler logs nothing |
| Bearer refused (401) | missing, empty, Basic, a Google ID token, double space, tab, two tokens, comma list, quoted, dev token with dev off, `enabled: "true"` (a string), expired |
| Bearer accepted | `bearer`/`BEARER` scheme and a trailing space (RFC: the scheme is case-insensitive; Fetch trims headers) |
| Authz: member or guest runs `POST /boards` | 403 |
| Authz: board owner | can't grant `owner`, can't demote or remove another owner (403), can set editor (204) |
| Authz: cross-tenant (acme admin on a globex board, 9 route/body variants) | byte-identical to an unknown board: status, body and headers, all 403; globex board untouched |
| Authz: revoke a globex link through an acme board | 403; link still live |
| Redeem: unknown, expired, `a%2Fb` | 404 |
| Redeem: another tenant's link | 200, by design (CLAUDE.md: "anyone else by invite or share link") |
| Bodies refused | 17 KB (413); not JSON (400); invalid UTF-8 (400); `text/plain`, no content type, `application/jsonx` (415); top-level `__proto__`, `constructor`, `prototype`, `toString`, `hasOwnProperty` (400 unknown-field); nested `__proto__` as a role (400, `Object.prototype` not polluted); title not a string; memberRole owner; expiresAt as a string or in the past |
| Paths: `/health`, `/ws`, `/blobs/x`, `/metrics`, trailing slashes, uppercase, `//boards`, `%2F` paths | null for GET/POST/PUT/DELETE |
| Paths: `/blobs/../boards` | handled as `/boards`, because the URL parser removes `..` before the handler sees it (WHATWG behaviour, not a bypass) |
| Outage: Registry throwing on every method (`POST /boards`, invites, `/links/:id`, grants) | 503 |
| Outage: sessions throwing a non-Error (`throw "x"`, `throw null`) | 503 |
| Prototype keys as path params (`__proto__`, `constructor`, `prototype`, `toString`, `hasOwnProperty`, `valueOf`) as board, invite, link and user ids on 6 board routes | byte-identical to an unknown board; `/links/<key>` gives 404 (Bearer) and `link=invalid` (sign-in); `Object.prototype` not polluted |
| `PUT /boards/<own>/grants/__proto__` | 204, stored as a user literally named `__proto__` (a `Map` key, harmless). boards.js accepts any non-empty user id; that rule predates this diff |
| createBoard fix over HTTP: `setGrant` fails once | 201, caller is owner |
| createBoard fix over HTTP: `setGrant` fails twice | 503 `{error:"owner-grant-failed", board}`, exactly those two keys, no cause text (the injected `SECRET-DB-DETAIL` is absent); board exists with no grants; a tenant admin repairs it (204) |
| Revoked link | Bearer: 404. Sign-in: `link=invalid`, and the guest gets no role |
| Missing login cookie at callback | 400; cookie cleared |
| Percent-encoded hostile links (`%2F%2Fevil.example`, `https:%2F%2Fevil.example`, CRLF + `Location:`, `javascript:alert(1)`, `%23frag`, `%3Fq%3D1`, 300 chars) | each rides in the cookie (302 to Google), then lands on `postLoginUrl#token=…&link=invalid`; "evil" never appears in Location |
| Replay-guard cost (see MEDIUM 1) | per-callback cost grows with the number of live states: 0.03 ms → 0.34 ms at 60,000 |

## sdd ensemble review

- **Harnesses that ran:**
  - `codex` (effort high): "No actionable security findings."
  - `grok`: "SECURE, no findings."
  - Both ran on a scratch copy of the repo, so they could not touch the real tree.
- **Harnesses that failed `check_adapter`:**
  - `agy`: quota exhausted (429, resets in about 68 h).
  - `kimi`: no model configured.
  - `mistral`: no `MISTRAL_API_KEY`.
  - `qwen`: binary not installed.
- **Agreement:** none, because neither harness reported a finding. So there was no HIGH candidate to confirm or
  refute.
- **One grok claim is wrong:** grok says "`redeemLink` checks link ownership (no cross-tenant)". It doesn't: a
  share link works across tenants by design. This is a misstatement in grok's summary, not a defect in the code.

## Findings

**HIGH:** none.

**MEDIUM 1: the replay guard scans every live state on every callback, so an unauthenticated caller can burn
CPU** (`server/auth/http.js:122-129`).
- **The cost:** `useState` walks the whole `usedStates` map to prune it on each callback. Entries live 10
  minutes, and the map has no size cap.
- **How an attacker fills it:** valid login cookies are free (`GET /auth/login`), and every callback whose state
  matches its cookie adds an entry, even when the code is bogus.
- **Measured (the last 1,000 calls of each run, ms per callback):**

| Live states | ms per callback |
|---|---|
| 5,000 | 0.055 |
| 20,000 | 0.145 |
| 60,000 | 0.343 |

  The first 1,000 calls of each run stayed at about 0.03 ms. So the cost per call grows linearly, and the total
  grows quadratically.
- **What that means:** extrapolated, 1,000 bogus callbacks a second for 10 minutes holds about 600k states, at
  about 3.4 ms per callback. That is roughly a full core spent on pruning, on the same event loop that serves
  sockets. Each of those callbacks also makes one call to Google's token endpoint.
- **Fix (builder's, small):**
  - Entries are inserted in expiry order (fixed TTL, and `now` is monotonic in practice), so the prune loop can
    `break` at the first live entry.
  - Optionally cap the map's size.
  - Rate-limiting `/auth/*` is a separate M8 item.
- **Why not HIGH:** it is not an auth bypass or a leak. It is a cheap fix, and PASS doesn't depend on it.

**LOW 1: no CORS, so the API is same-origin only.**
- `OPTIONS /boards` gives 405, and no response carries `Access-Control-*` headers.
- Config allows `postLoginUrl` on another origin; the builder's own tests use `app.plenary.test` against
  `plenary.test`.
- A web client served from that other origin cannot call the Bearer API, because the browser's preflight fails.
- Today `web/` doesn't call these routes. Decide same-origin or CORS before web/ starts using them.

**LOW 2: a retry after `owner-grant-failed` can duplicate boards.**
- `createBoard` returns 503 `owner-grant-failed` with `{board}`. A client that blindly retries `POST /boards`
  creates a second board, and the first stays ownerless.
- PROTOCOL.md § Registry allows reporting the failure with the board id, and a tenant admin can repair the
  board (verified: 204).
- The client should treat that code as "board exists, fix the grant", not as "retry".

**LOW 3: an unauthenticated callback makes a 1:1 outbound call to Google** (it compounds MEDIUM 1).
- Anyone can mint a valid login cookie with `GET /auth/login`, then send a callback with a bogus code.
- Each such callback makes one call to Google's token endpoint (20,017 calls in the cost test).
- There is no amplification beyond 1:1, but there is no rate limit either. This belongs with M8 hardening.

**LOW 4: duplicate login cookies, first one wins.**
- A junk `__Host-plen_login` cookie placed before the real one makes the callback fail (400).
- This is denial of service only. The `__Host-` prefix stops sibling subdomains from planting the cookie, so the
  realistic source is the user's own browser state.

## The builder's not-verified list and risks

| Item | Status |
|---|---|
| Real Google, real browser (`__Host-`, Secure on localhost, SameSite on the callback) | not verified here either |
| Google outage at callback shows as 400 `login-failed`, not 503 | confirmed by reading `oidc.finish`, which returns null for both; acceptable for M2 |
| Never mounted through engine's `createServer({ http })`; web/ doesn't read the fragment | confirmed; also see LOW 1 |
| In-memory Registry only | confirmed; my tests used it too |
| Logout is local; tokens stay valid until `exp` | confirmed: an expired token is refused only at `exp` (12 h test) |
| Replay guard is per process | confirmed: a second handler instance accepted a replayed cookie and code (302). This was safe only because the fake IdP reuses codes; real Google codes are single-use, which this didn't verify |
| A share link sent by an attacker makes the victim redeem it | confirmed as described; it grants the victim, never the attacker |
| No `prompt`/`login_hint` on `/auth/login` | confirmed |

## Not verified

- **Real browser and real Google:** same gap as the builder.
- **Behind engine's real server and a load balancer:** where `X-Forwarded-*` might be trusted elsewhere, but
  `http.js` reads none of them.
- **Timing side channels:** the brief set timing aside. HMAC uses `crypto.subtle.verify`.

## Re-check (MEDIUM 1 fix round, for t14q, 2026-11-11)

**PASS.** MEDIUM 1 is fixed: the cost per callback stays flat, the cap fails closed, and replay protection holds.
One new LOW note (LOW 5) follows.

**What changed** (`server/auth/http.js:122-136`, `callback`):
- Pruning pops expired entries from the front of the insertion-ordered `Map` and stops at the first live one.
- A cap, `config.maxLoginStates` (default 100,000), returns 503.
- The replay check runs before the cap check.

**Re-check tests:** `recheck.test.js` in the scratchpad, 5 tests, against the real module and the fake Google,
with a clock that sits on a fractional second. All 5 pass. The earlier 18 attack tests still pass too.

| Check | Result |
|---|---|
| Replay of a used state and code at +1 ms, +1 s, +5 min, +599 s, +599.876 s, +599.999 s | 400 every time |
| Replay at exactly +600 s, +600.001 s, +601 s | 400 (the cookie has expired) |
| Callback 1 s before the cookie expires, then replays at +599.876 s and +599.999 s, after another login has run the prune | 400. The guard entry (callback time + 600 s) always outlives the cookie (login time, rounded down to a second, + 600 s) |
| Clock steps back 2 min, then an entry is inserted with an earlier expiry behind a later one | the replay is still 400; entries only live longer |
| Cap full (`maxLoginStates: 2`): a valid real login | 503 `{error:"unavailable"}`, cookie cleared, no Location, and Google's token endpoint is **not** called |
| Cap full: a replay of a used state | 400, not 503 and never 302 (the guard is still enforced) |
| Cap full: after 10 minutes | room again; a new login gives 302 |
| `bun test` (full) | 315 pass, 0 fail, 69 skip (Postgres, NATS and S3 contract tests gated on env, none in `test/auth`) |
| `test/server/gateway.test.js` | 28 of 28 pass. The known-flaky test at line 627 did not fail on either of my two runs |

**Cost** (bogus-code callbacks with valid cookies; time per callback for the last 1,000, after filling the map):

| Live states | Before the fix | After the fix |
|---|---|---|
| 5,000 | 0.055 ms | 0.185 ms (warm-up noise: the first 1,000 measured 0.73 ms) |
| 20,000 | 0.145 ms | 0.119 ms |
| 60,000 | 0.343 ms | 0.052 ms |
| 95,000 | not run | 0.049 ms |
| about 40,000, one entry expiring per call (churn) | not run | 0.064 ms |

The cost no longer grows with the map: the 95k/5k ratio is under 1, against about 6× before. Small runs are noisy
from warm-up, which is why I compared the last 1,000 calls of each run.

**LOW 5 (new; not part of this re-check's pass criteria): a full cap locks out every sign-in on that gateway.**
- **What it takes:** a valid cookie (`GET /auth/login`) plus a callback with a bogus code adds a state that stays
  for 10 minutes. So about 100,000 such pairs in 10 minutes, around 170 a second, fills the cap. While it is
  full, every real login on that gateway gets 503.
- **Compared with before:** this costs the attacker more requests than the old CPU drain did, but the effect
  is worse: sign-in on that gateway stops entirely.
- **Who is affected:** existing tokens and `hello` are not affected; only new sign-ins are.
- **Cheap mitigation:** delete the state when `oidc.finish()` returns null. Bogus codes then don't hold a slot,
  and only successful logins (which need a real Google account) fill the map.
  - Concurrent replays stay blocked, because the entry exists while `finish()` runs.
  - A successful login never releases its state.
  - Google codes are single-use, so retrying a failed state gains nothing.
- **Otherwise:** rate-limit `/auth/*` (M8). The manager decides; it doesn't change the verdict.
