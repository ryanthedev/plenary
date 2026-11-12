# Report: p5-code (no session token in any URL: sign-in code exchange) + p5-googlev MEDIUM 2

**Done.** The callback now sends `#code=<code>` (never `#token=`), plus a 60 s HttpOnly exchange cookie;
`POST /auth/exchange` turns the pair into the session token. Added in-job (manager t187): a failed callback no longer
takes a replay-guard slot. `bun test`: **480 pass, 78 skip, 0 fail** (558 tests, 32 files). Not committed.

## What changed

| File | Change |
|---|---|
| `server/auth/http.js` | Callback mints a code + `__Host-plen_xchg` cookie; new `POST /auth/exchange`; generic bounded `usedSet` (states and codes); replay-guard slot taken only after `oidc.finish` succeeds; header comments describe `#code`, not `#token` |
| `test/auth/http.test.js` | Helpers go through the exchange (`fragToken(res)`); four `#token=` assertions now `#code=`; guard rig's stub IdP succeeds by default; new lockout test |
| `test/auth/exchange.test.js` | New: 13 tests for the exchange |

`grep -rnE "#token|token=" server/auth` → no hits.

## Endpoint shape: as fixed, one deviation in the cookie's contents

- **Unchanged:** Location `postLoginUrl#code=…` (board URL on a share link; `&link=invalid|unavailable` kept);
  cookie name and attributes (Secure, HttpOnly, SameSite=Strict, Path=/, Max-Age=60); the exchange's request,
  200 body `{token,user,name,email,domain,exp}`, 400 `invalid-code` (one error for all), 403 `bad-origin`,
  415/400/405/503. `Cache-Control: no-store` on every answer.
- **Deviation (contents only):** the cookie doesn't hold a bare random binder. It holds
  `x1.<payload>.<HMAC>` with payload `{ h: sha256(code), u, n, e, d (identity), exp }`, signed with `cookieKey`.
  The code is 32 random bytes (256 bits) and nothing else.
  - **Why:** a stateless code must carry the identity somewhere. In the code it would put email/name/user id into
    Chrome's on-disk history, the very leak this job removes. In the HttpOnly cookie it never reaches a URL.
  - **Domain separation:** MAC input prefix `x1.`; a session token (`s1.`) or a login cookie (`l1.`) can't pass
    (tested).
- **What spends a code** (matches `web/adapters/auth/fake.js`): Origin is checked first; 403, 415/400 body errors and
  503 spend nothing and don't clear the cookie. The 400 `invalid-code` and the 200 clear it. If `sessions.issue`
  throws, the used-set entry is released.
- **Field types (manager t187, contract § Field types):** `user` non-empty string; `name`/`email`/`domain` string or
  null (an empty name becomes null in the cookie, so the token and the body agree; name capped at 200 like
  session.js); `exp` an integer. A test pins them.
- **`exp` source:** `sessions.issue` returns only a string and `verify` drops `exp`, and session.js isn't mine. So
  http.js decodes `exp` from the token payload it just issued (`tokenExp`). This couples to session.js's
  `s1.<b64 JSON>.<mac>` format; for any other format the exchange answers 503 rather than break the contract's integer `exp` (tested; code not spent). Cleaner: session.js returns `exp` (engine
  or platform follow-up).

## Systems design note (distributed-systems-design v0.1.0, APPLIER)

Read from `~/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md`; applied while coding, not
strictly before it (I first found only the command stub).

- **Scope:** fixed by the brief and the NFRs, so no questions were needed. Exchange one code per sign-in. Up to 100k
  joins in 2 min. The callback and the exchange may hit different nodes (no sticky sessions). Code ≤ 60 s, single
  use, useless from a URL alone. No new store or port.
- **Estimate** (worst case: all 100k joiners sign in fresh):
  - **Load:** about 833 callbacks/s and 833 exchanges/s cluster-wide. Each exchange is one HMAC verify, one SHA-256
    and one HMAC sign: CPU-trivial.
  - **Used-code sets:** ≤ 833 × 60 s ≈ 50k entries cluster-wide, about 100 B each (≈ 5 MB).
  - **Replay guard:** holds states for 600 s, so ≈ 100k entries in that 2 min burst, cluster-wide. That's the full
    default cap if one gateway took them all (bottleneck 1).
- **High-level design:** browser → LB → any gateway.
  - **Callback** (node A): verify the login cookie, call Google, set the signed `x1.` cookie, 302 to `#code`.
  - **Exchange** (node B): verify Origin, cookie MAC, expiry and `sha256(code)`, then issue the token.
  - The only shared state is `cookieKey`, already shared. Use cases walked: plain login, share link, replay, and an
    exchange on a second node (all tested).
- **Deep dive 1: unique codes across servers (Ch7).** 256 random bits per code, so no coordination is needed and
  collisions are negligible.
- **Deep dive 2: single use without shared state.**
  - **(a) stateless, chosen.** The code needs the HttpOnly, SameSite=Strict cookie. The first exchange clears it. Each
    node keeps a bounded used-hash set (synchronous check-and-set, fails closed).
  - **Not covered:** someone holding both the code and the cookie (malware in that browser) can replay once on
    another node within 60 s. A test documents this.
  - **(b) a shared used-set through the Registry port** would close that, at one store write per sign-in. Not worth
    it for an attacker who already owns the browser.
- **Deep dive 3: rate limiting (Ch4):** see MEDIUM 2 below. A per-IP limit belongs at the gateway.
- **Wrap-up:**
  - **Bottleneck 1:** per-node replay-guard cap (100k, 10 min) under a single-gateway 100k-join burst. Spread
    gateways, or size `maxLoginStates` to the expected burst.
  - **Bottleneck 2:** Google token-endpoint quota at ~833/s (unverified).
  - **Bottleneck 3:** none in the exchange itself.
  - **Failure scenario:** an issuing outage gives 503 and leaves the code unspent, so the client can retry within
    60 s.
  - **Monitoring:** count 400 `invalid-code` and replay-guard 503s per node (not built; logs are main.js's).
  - **At 10×:** the guard cap and the Google quota break first; the exchange doesn't.

## MEDIUM 2: replay-guard lockout (from p5-googlev)

- **Fix:** the callback refuses an already-used state up front (no call to Google). It takes the slot with
  `usedStates.use` only after `oidc.finish` succeeds. A bogus code costs no slot, so anonymous callbacks can't fill
  the 100k cap.
- **Race:** two callbacks racing on one state both pass the up-front check. Google's single-use code lets only one
  through, and the synchronous `use` after `finish` refuses the second.
- **Side effects:** each callback now prunes the guard twice (`seen`, then `use`). The tests-only `pruned` hook reports
  the first, which does the expiry work. A full guard's 503 now comes after Google's code has been spent (the user
  just signs in again once there's room).
- **Tests:** 50 refused-code callbacks (stub IdP) plus 10 bogus codes through the real oidc under cap 3 don't block a
  real login. A replayed successful callback is still refused, with no new call to the token endpoint. A state whose
  callback failed may retry, but is spent once it succeeds. The pruning and cap tests now use successful logins.
- **Per-IP limit: still advisable, not built.** Each bogus callback still costs one call to Google's token endpoint,
  so an attacker can make us hammer Google and risk being throttled. Filling the guard now needs 100k real Google
  sign-ins in 10 min. A small per-IP token bucket on `/auth/callback` (and `/auth/exchange`) belongs where the client
  IP is trustworthy, i.e. behind the load balancer's `X-Forwarded-For` policy. That's a gateway/main.js decision, so
  it's not in http.js.

## Tests added (all pass)

`test/auth/exchange.test.js`:

- Happy path: cookie attributes, body shape, `exp`, `no-store`, cookie cleared, token verifies.
- Location holds only `code` (+`link`): no `s1.`, no email/name/id/token; the code fails `sessions.verify`.
- Replay refused, with and without the cookie still present.
- Expired at 61 s; works at 59 s.
- Origin missing, `null`, other site, sibling host, other port, http → 403, nothing spent.
- No cookie, another login's cookie (both ways), tampered code, malformed codes, re-signed cookie payload
  (user, exp), `s1.`/`l1.` blobs as the cookie → 400; then the real pair still works.
- 200 body types: Workspace user, consumer with an empty name, no name.
- A sessions adapter without an integer `exp` → 503, code not spent.
- Share-link path: `#code` on the board URL; the role resolves.
- Second node exchanges; same-node replay refused; documented cross-node limit; foreign key refused.
- 415 / 400 / 405 (`Allow: POST`), and none of them spend the code.
- `issue` outage → 503, not spent.
- No oidc → 503 `sign-in-unavailable`.

`test/auth/http.test.js`: the lockout test above.

**Mutation check:** each of these removals fails at least one test: hash binding, Origin check, used-set, expiry
check, release on 503, and taking the guard slot before `finish`.

## Needs a change elsewhere (not edited: not my files)

- **`scripts/dev-google.js:38-43` (p5-google's harness) breaks.** Its `/signed-in` page reads `#token`. It must read
  `#code`, `replaceState`, then `fetch("/auth/exchange", { method: "POST", credentials: "same-origin", headers:
  { "content-type": "application/json" }, body: JSON.stringify({ code }) })` and use `.token`. Its config is fine:
  `postLoginUrl` and the callback share `ORIGIN`. Also update its header comment (line 16).
- **`docs/m2/COMMITMENTS.md:78,79`** mention `#token=`. That's the manager's log; append rather than edit.
- **Client track:** shape as in `docs/m2/contracts/auth-exchange.md`, plus 415/400/405 and 503
  `sign-in-unavailable` when Google isn't configured.

## Not verified

- **No real browser run.** I didn't measure that Chrome sends a SameSite=Strict cookie on the app's fetch after a
  cross-site redirect chain (Google → callback → app). It should, since the fetch's site-for-cookies is the app's own
  top-level page. Nor did I re-measure Chrome's History after the change.
- **No live Google login** (needs the human), and `google-live.test.js` was not re-run with `PLENARY_LIVE_GOOGLE=1`.
- `__Host-` + Secure on `http://localhost`: Chrome accepts Secure cookies on localhost; not re-checked here.

## Risks

- **One origin required.** The callback host, `postLoginUrl` and `boardUrl` must share one origin. The cookie is
  host-only `__Host-` and the Origin guard is `postLoginUrl`'s origin, so a split deployment can never exchange and
  the share-link path would 403. Not enforced at build time (the test config in http.test.js uses an API origin
  different from the app origin and only passes because tests set headers by hand). Suggest main.js or config docs
  state it.
- **Two sign-ins in parallel tabs:** the second callback's cookie overwrites the first. The first tab's exchange gets
  `invalid-code` and the client must re-login.
- **`exp` coupling** to session.js's token format (above).

## Fix round (p5-codev MEDIUM 1 and 2, from manager t187)

`bun test`: **510 pass, 78 skip, 0 fail** (588 tests, 33 files). Not committed. No `.env` value read or printed.

### MEDIUM 1: one origin enforced at build time

- **`server/auth/http.js`:** `httpRoutes()` throws if `postLogoutUrl`, `boardUrl` or `publicUrl` (when set) isn't on
  `postLoginUrl`'s origin. The message is `http: config.<key> must be on postLoginUrl's origin (<origin>): sign-in only
  completes on one origin`. `publicUrl` is included because `/links/:id` sets the host-only login cookie, which the
  callback must get back.
- **Callback origin: not checkable here.** The OIDC redirect URI lives inside the IdP adapter (the port doesn't expose
  it), so http.js can't see it. The header now says it is the composition root's duty. `scripts/dev-google.js` keeps
  it on one origin (`REDIRECT_URI` = `ORIGIN/auth/callback`). Adding `redirectUri` to the IdP port would let
  http.js check it too; that's a port change, so not done.
- **`test/auth/http.test.js`:** the config is now one origin (`https://plenary.test`), a deployment that can sign in.
  A new test covers the refusals: another host, scheme or port for `postLogoutUrl`, `boardUrl` and `publicUrl`, plus
  a `postLoginUrl` off the others. It also checks the defaults still build.
- **LOW 3 (header only):** `config.cookieKey` is documented as able to mint sessions (it signs the exchange cookie,
  which carries an identity), so it must be guarded and rotated like the session key. Not changed in code.

### MEDIUM 2: the dev harness uses the code exchange

- **`scripts/dev-google.js`:** `/signed-in` now:
  - reads `#code`;
  - calls `history.replaceState` before any request;
  - POSTs `/auth/exchange` (`credentials: "same-origin"`, JSON);
  - shows `signed in as <email>`, the no-verified-email line, or `sign-in failed (<status> <error>)`.

  The token stays in a script variable. The log line for `/auth/exchange` records `exchangeCookie: true|false`
  (presence only, like `loginCookie`). The header comment is updated. `/whoami` is kept (the live test uses it).
- **New `test/auth/dev-google.test.js` (3 tests, no network, port 0):**
  - It starts the real harness with the fake IdP as its fetch and runs login and callback.
  - It then executes the `/signed-in` page's own script with stubbed `location`, `history`, `document` and `fetch`.
    The stubbed fetch adds the cookie and Origin a browser would.
  - It checks:
    - "signed in as ann@acme.com";
    - the fragment is dropped before the exchange;
    - exactly one POST;
    - the log line shows `exchangeCookie: true` and never the cookie value;
    - no `#code` gives "not signed in";
    - a code without its cookie gives "sign-in failed (400 invalid-code)";
    - a consumer account gives the no-verified-email line.
- **`test/auth/google-live.test.js` without the flag:** passes (its non-live tests pass; the live block skips).
- **`docs/m2/reports/p5-google.md` Hand-off:**
  - Step 5 now says the page drops `#code` and exchanges it.
  - Step 6 adds the new failure, "sign-in failed (400 invalid-code)", and how to read `exchangeCookie` in the log.
  - Steps 1–4 and 7 are unchanged and still true. The harness, port and URL are the same.

### Not verified (fix round)

- **No real Chrome run of the new page.** The test runs its script with stubs. Chrome keeping a `Secure`,
  SameSite=Strict `__Host-` cookie on `http://localhost` through the Google redirect is expected (the login cookie
  already works there) but unmeasured.
- The live Google flow (`PLENARY_LIVE_GOOGLE=1`) was not re-run.
- **Manager's log, not edited:** `docs/m2/COMMITMENTS.md:78-79` still say `#token=`. It's your append-only log, so
  please append a correction there.
