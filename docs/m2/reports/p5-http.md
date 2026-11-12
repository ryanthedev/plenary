# Report: p5-http (HTTP handlers for sign-in and admin)

**Status: done, http.js is ready to mount.** Builder for `manager platform` (t14q). Not committed.

## Mount hook (as amended by engine via t14q)

```js
import { httpRoutes } from "./auth/http.js";
createServer({ ..., http: httpRoutes({ registry, sessions, oidc, tenancy, now, config, dev }) });
// handler: async (req, url) => Response | null   (null = not my route; url optional, parsed from req if absent)
```

- **Order:** engine's routes first, then these, then the engine's 404 (engine's server.js already does this).
- **Reserved paths:** `/health`, `/ws`, `/blobs/*`, `/metrics` always give null. Routes are an allowlist of exact
  patterns, so any path not listed below gives null too. A test covers this.
- **Never throws:** refusals are 4xx JSON, and infrastructure errors are 503 `unavailable`.
- **`deps`:** `{ registry, sessions, oidc, tenancy, now, config }`, plus an optional `dev` (added at t14q's
  request, 2026-11-11).
- **For engine, `dev`:** main.js can pass the same `devAuth(...)` object it already builds for the Auth port.
  - Bearer then accepts dev tokens as well as session tokens, so `POST /boards` works in dev runs.
  - Dev tokens are accepted only when `dev` is passed **and** `dev.enabled === true`. With no `dev`, with
    `devAuth()` unconfigured, or with `enabled: false`, a dev token is a 401.
  - A dev user can create boards only if they are an admin of a tenant matching their token's `domain`.
  - A dev verifier that throws gives 503, as the session verifier does.
- **`deps`, continued:** `oidc` may be null, in which case
  sign-in routes answer 503 `sign-in-unavailable` and the Bearer API still works.
- **`config`:**
  - `cookieKey`: at least 32 bytes, from env; required when oidc is set.
  - `postLoginUrl`: absolute http(s), no fragment.
  - `postLogoutUrl`: optional.
  - `boardUrl`: a template containing `{board}`.
  - `publicUrl`: optional; when set, a created link carries `url`.
  - `maxBody`: default 16384.
  - Bad config throws at build time, never per request.
- **Amendment 5 (Herdr):** these are browser and admin routes only. Nothing drawh needs sits behind Bearer;
  drawh's token still goes in `hello`.

## Routes

| Route | Result |
|---|---|
| `GET /auth/login` | 302 to Google (PKCE S256, state, nonce); sets the login cookie |
| `GET /auth/callback` | 302 to `postLoginUrl#token=…`, or to `boardUrl#token=…` when a share link is pending; clears the cookie. Failure: 400 `login-failed`, cookie cleared |
| `GET /auth/logout` | clears the login cookie, 302 to `postLogoutUrl` |
| `POST /boards` | `{title?, memberRole?}` → 201 `{board}`. Tenant = `tenancy.tenantOf(caller)`, never the body (a `tenant` field is 400 `unknown-field`) |
| `GET/POST /boards/:b/invites`, `DELETE /boards/:b/invites/:id` | list `{invites}` / 201 `{invite}` / 204 |
| `GET/POST /boards/:b/links`, `DELETE /boards/:b/links/:id` | list `{links}` / 201 `{link, url?}` / 204 |
| `PUT /boards/:b/grants/:user` | `{role}` (null removes) → 204; user id URL-encoded (`google%3A123`) |
| `GET /links/:id` | Bearer: redeem, 200 `{board, url}`, dead link 404. No Bearer: starts sign-in with the link in the login cookie; the callback redeems and lands on the board |

**Errors:**

| Status | Code |
|---|---|
| 401 | `auth` (with `WWW-Authenticate: Bearer`) |
| 403 | `forbidden` (unknown board, or a board the caller can't manage) |
| 400 | `bad-request`, `bad-json`, `unknown-field` |
| 413 | `too-large` |
| 415 | `unsupported-media-type` |
| 405 | wrong method on one of these routes |
| 409 | `last-owner` |
| 503 | `unavailable` |
| 503 | `owner-grant-failed` with `{board}` |

## Design choices (reversible)

- **Login cookie:** `__Host-plen_login`, with Secure, HttpOnly, SameSite=Lax, Path=/, no Domain and Max-Age=600.
  - The value is `l1.<payload>.<HMAC>`. The payload is `{state, nonce, verifier, link?, exp}`.
  - The expiry is signed and checked against `now`.
  - The `l1.` prefix means it can never pass as a session token (`s1.`), and the reverse is tested.
  - Signed, not encrypted: the PKCE verifier sits in the browser's own HttpOnly cookie, which is the standard
    stateless pattern.
- **No session cookie at all:** no cookie ever authenticates a request, so there is no CSRF surface.
  - Consequence: opening a share link in the browser always passes through Google, which is usually silent when
    the user is already signed in.
- **Deviation from the brief:** `GET /links/:id` with no Bearer starts sign-in directly. It sets the login
  cookie with the link and sends a 302 to Google, instead of first redirecting to `/auth/login`.
  - The effect is the same, with one fewer hop.
  - It also avoids a half-made cookie that could carry a link into a later, unrelated sign-in.
  - The link is never in a URL parameter.
- **Second deviation from the brief:** `GET /links/:id` **with** a Bearer returns 200 `{board, url}` JSON.
  The brief says it redirects to the board. A Bearer caller is a program, not a browser, so a 302 into the web
  app would be odd for it. The browser path (no Bearer) does end on the board.
- **Dead link at sign-in:** the user is still signed in and lands on `postLoginUrl#token=…&link=invalid`, or
  `&link=unavailable` when the Registry is down.
- **Redirect headers:** every redirect carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  Redirect targets come from config only.
- **Replay guard:** a per-process used-state set (pruned at the cookie's expiry) refuses a replayed callback.
  It is **not shared across gateways**; there, Google's single-use authorization code is the guard.

## Fold-in: p5-fixv MEDIUM 1 (PROTOCOL.md § Registry)

`server/admin/boards.js` `createBoard` now retries the owner `setGrant` once.

- **If the retry also fails:** it throws `AdminError("owner-grant-failed")` carrying `.board` (the id) and
  `.cause`.
- **Over HTTP:** that is 503 `{error: "owner-grant-failed", board}`, never success for an ownerless board.
- **Recovery:** a tenant admin can still manage that board, including granting `owner`.
- **API change:** `AdminError`'s constructor gained an optional third argument; existing callers are unchanged.

## Files

- **New:** `server/auth/http.js`, `test/auth/http.test.js`.
- **Changed:** `server/admin/boards.js` (createBoard retry and report; AdminError `board`/`cause`; header comment).

## Tests (test/auth/http.test.js, 19 tests, no network)

All run against the fake IdP through the handler; the last one also runs over a real `Bun.serve` on port 0.

- **Full flow:** login, callback, token in the fragment (none in the query), `POST /boards`, a cross-domain
  invite, a link, a guest redeeming the link signed out (sign-in then board), the invitee's role, the member's
  `memberRole`, a grant, revokes, and last-owner 409.
- **Bearer redeem:** works, and a dead or revoked link gives 404. A dead link at sign-in is flagged in the
  fragment. The link is in the signed cookie, not the URL.
- **Login cookie refused when:** missing, a flipped MAC, a payload re-signed without the key, a session token
  used as the cookie, or expired (10 min + 1 s on the injected clock). Each refusal clears the cookie.
- **Callback refused on:** state mismatch, missing code, an IdP `error`, or another login's cookie.
- **Nonce:** an ID token minted with another nonce is refused, and so is a replayed callback.
- **Open redirect:** `redirect`/`next`/`return_to`/`redirect_uri`/`url` parameters and a hostile Host header
  are all ignored. Relative, `javascript:` and fragment config URLs are refused at build.
- **Logout:** clears the cookie, and the token still verifies (stateless).
- **Bearer refused (401) when:** missing, Basic, empty, lowercase scheme with junk, tampered, without the scheme,
  sent only as a cookie, or expired.
- **`POST /boards`:** member and guest get 403; a `tenant` field is 400 and creates nothing (counted);
  `memberRole: owner` is 400.
- **No existence leak:** unknown board, forbidden board and a `..%2F` board give byte-identical status, body
  and headers on all 7 board routes. A link can't be revoked through another board.
- **Bodies:** 17 KB is 413, and so is a streamed body with no Content-Length and a lying Content-Length. Also
  tested: bad JSON, empty, `[]`, `null`, an unknown field (including `__proto__`), form content type 415,
  `charset` accepted, grants need `role`, and a bad percent-escape gives 400.
- **Outages:** a Registry that throws on every call gives 503 on 5 routes; a throwing session verifier gives
  503; a redeem outage at sign-in gives `link=unavailable`.
- **createBoard fix:** two failed grants give 503 with the board id (board exists, no owner); one failure is
  retried and succeeds; also tested directly against the admin function.
- **Dev tokens (both ways):**
  - Refused (401) with no `dev`, with an unconfigured `devAuth()`, with `enabled: false`, and with a verifier
    object that doesn't declare itself enabled.
  - Accepted with an enabled `devAuth`: the board is created and the dev user becomes owner.
  - With dev on, an unknown dev token is 401, session tokens still work, and a throwing dev verifier gives 503.
  - Checked that it can fail: with the `enabled` gate removed, this test goes red.
- **Mount:** reserved and unknown paths give null for GET, POST, PUT and DELETE; wrong method gives 405 with
  `Allow`; the engine's `url` argument is honoured; `oidc` null gives 503 on sign-in routes.

**How I checked the tests can fail:** I removed each guard in turn, ran the file, then restored it.

| Guard removed | Result |
|---|---|
| MAC check | its test went red |
| used-state set | its test went red |
| cookie expiry | its test went red |
| streamed body cap | its test went red |
| unknown-field check | its test went red |
| HTTP state check | stays green, because `oidc.finish()` checks state again (defence in depth) |

**`bun test`:** after the `dev` change, the full suite passes, 291 of 291. `test/auth/http.test.js` passes 19 of 19.

- **Earlier runs were red, from a file I don't own:** the first full run (around 18:43) showed 287 pass and
  3 fail. I captured only one failing name, `H1` in `test/server/outbound.test.js`, and that test also failed
  twice in `bun test test/server`.
- **Why that wasn't this change:** the engine track was editing that file during this job (created 18:42,
  changed again 18:45), along with `server/breather.js`. Nothing in `server/` imports `boards.js` or `http.js`.
  After their 18:45 edit, the suite was green.

## Not verified

- **Real Google:** no real client, no real consent screen, no real token endpoint.
- **Real browser cookies:** `__Host-` and `Secure` behaviour, SameSite=Lax on the Google → callback top-level
  redirect, and fragment handling by the web client.
- **`Secure` on plain-http localhost:** Chrome and Firefox treat localhost as secure, but I didn't check it.
- **IdP outage vs refusal:** `oidc.finish()` returns null for both a Google outage and a refusal, so a Google
  outage at callback shows as 400 `login-failed`, not 503.
- **Engine's real server:** the handler was never mounted through `createServer({ http })`, only a bare
  `Bun.serve` on port 0. `main.js` is engine's to wire.
- **Web client hand-off:** `web/` doesn't read `#token` or call `/auth/*` or `/links/*` yet (I grepped and found
  nothing), so nothing consumes the fragment today. The client must read `token` (and `link`) from
  `location.hash`, then clear the hash with `history.replaceState`.
- **Durable registries:** these routes ran against the in-memory Registry only, not engine's SQLite or Postgres
  Registry.

## Risks

- **Logout is local:** session tokens are stateless, so logout only clears the login cookie. A token stays
  valid until its `exp` (12 h default); the web client must drop it. Revocation is an M6 item.
- **Replay guard is per process:** across gateways, replay protection rests on Google's single-use code.
- **Login CSRF on links:** an attacker can send a victim a share link. Following it makes the victim redeem
  that board, which is what a share link is for; it grants the victim access and never the attacker.
- **Login page parameters:** `/auth/login` takes no `prompt` or `login_hint`. Workspace account choice is left
  to Google.

## Questions for the manager

None open. The dev-token question was answered by t14q: an optional `dev` is in place (see Mount hook).

## Fix round (p5-httpv MEDIUM 1, 2026-11-11)

**Fixed:** the replay guard no longer scans every live state on each callback. Its size is now capped, and the
cap fails closed.

### Change (`server/auth/http.js`, `useState`)

- **Pruning from the front:** every entry gets the same TTL from `now()` when it is inserted. A `Map` keeps
  insertion order, so the map is also in expiry order.
  - Pruning pops expired entries from the front and stops at the first live one: amortised O(1) per callback.
  - If the clock steps back, pruning only stops early and entries live longer, which is the safe direction.
- **Hard cap:** `config.maxLoginStates`, default 100,000.
  - When the cap is full, a callback gets 503 `{error: "unavailable"}` and the login cookie is cleared.
  - It fails closed: a login is never accepted without the replay guard.
  - A replayed state is still answered 400 `login-failed`; the replay check runs before the cap check.

### Tests added (`test/auth/http.test.js`, 21 tests now)

**Cost stays flat.** This reuses the verifier's method: time the last 1,000 callbacks after filling the map.
Valid cookies are forged with the test key, and a stub oidc refuses every code, so only the cookie check and
the guard are timed.

| Run | ms per callback (fix) | ms per callback (old full scan) |
|---|---|---|
| ~3k live states | 0.031 to 0.034 | 0.048 |
| ~41k live states | 0.029 to 0.042 | 0.287 |
| ~40k live, one entry expiring per call (churn) | 0.032 to 0.036 | 0.303 |

- **Assertion:** the large/small ratio and the churn/small ratio must each stay under 3.
  - The fix measured about 1× on 4 runs.
  - The old code measured about 6×, and the test fails on it (checked by putting the old loop back).
- **Why churn is measured:** deleting from the front of a `Map` could leave tombstones that each later
  iteration has to skip. The churn run shows it doesn't here (Bun 1.4.4).
- **Runtime:** the whole file runs in about 3 s.

**Cap test:**
- With `maxLoginStates: 3`, three states are used, and the fourth gets 503 with the login cookie cleared.
- A replay while full is still 400 `login-failed`.
- After the TTL passes, there is room again.
- With a cap of 1, a real login through the fake IdP succeeds and the next one gets 503.
- Checked that it can fail: with the cap check removed, the test goes red.

### `bun test`

- **`test/auth`:** 86 of 86 pass.
- **Full suite:** 295 pass and 1 fails, the same on two runs.
  - The failure is `H1: non-readers spread over several accounts can't keep joiners out…` in
    `test/server/outbound.test.js`.
  - That is engine's file. It and `server/gateway.js` were edited at 18:57:54, 40 s before my first run.
  - Neither imports `server/auth/http.js` or `server/admin/boards.js` (checked with grep).
  - So the full-suite gate is red on a file I don't own.

### Left as they are (p5-httpv LOW 1 to 4, per t14q)

- **LOW 1:** there is no CORS, so the Bearer API is same-origin only. A web client on another origin (one
  `postLoginUrl` allows) can't call it.
- **LOW 2:** a client that blindly retries `POST /boards` after `owner-grant-failed` creates a second board, and
  the first stays ownerless. A tenant admin can repair it.
- **LOW 3:** each unauthenticated callback makes one outbound call to Google's token endpoint. There is no rate
  limit; that belongs to M8.
- **LOW 4:** with duplicate `__Host-plen_login` cookies, the first one wins, so a junk cookie in the user's own
  browser makes the callback fail (DoS only).

**Question for the manager:** the full `bun test` gate is red only on engine's in-progress
`test/server/outbound.test.js` (`H1`). Should I wait for engine and re-run, or is `test/auth` green enough for
this round?
