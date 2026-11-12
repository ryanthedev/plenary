# Report: p5-codev (verify p5-code: no session token in any URL)

**PASS** with 2 MEDIUM, 7 LOW. No HIGH. The goal holds, and it held in a real Chromium:

- **No URL carries the session token or identity:** not the callback's `Location`, not the History DB.
- **Strict cookie survives the cross-site chain:** the exchange cookie (`SameSite=Strict`) was sent on the
  exchange after a cross-site redirect.
- **Single use:** a second exchange gets 400 and no cookie.

Required tests exist and pass (replay, expiry, wrong origin). An anonymous client can no longer lock out sign-in.
`bun test`: **480 pass, 78 skip, 0 fail** (558 tests, 32 files). `test/auth/architecture.test.js` passes, and no
adapter imports were added: http.js still imports only `./util.js` and `../admin/boards.js`.

Tree change: this report only. Scratch work is in the session scratchpad.

## Findings

| # | Sev | Finding |
|---|---|---|
| 1 | MEDIUM | One-origin requirement not enforced; the repo's own http.test.js config describes a deployment that can't sign in |
| 2 | MEDIUM | `scripts/dev-google.js` still reads `#token`; the live dev harness breaks the moment p5-code lands |
| 3 | LOW | `cookieKey` now mints sessions; the header still calls it the login-cookie key |
| 4 | LOW | Cross-node replay by a holder of both the code and the cookie (documented) |
| 5 | LOW | Two parallel exchanges during an issuing outage: the losing request's 400 clears the cookie, so a retry fails. Two sign-ins in parallel tabs: one or both must sign in again (rulings below) |
| 6 | LOW | Timing differs by path, but only reveals whether a cookie was sent |
| 7 | LOW | Lockout by an *authenticated* scripted account: not closed, but impractical; no rate limit built |
| 8 | LOW | Clock skew between nodes moves the 60 s window; skew over 60 s breaks every cross-node exchange |
| 9 | LOW | No counters for 400 `invalid-code` or 503 from a full guard (monitoring) |

### MEDIUM 1: the one-origin requirement is not enforced (sdd ensemble HIGH candidate; confirmed, downgraded)

Codex and grok both flagged it, so it was a HIGH candidate. I confirmed it.

- **What it is:** the exchange works only if the callback host, `postLoginUrl` and `boardUrl` share one origin.
  - The `__Host-` cookie belongs to the callback's host only.
  - The Origin guard accepts only `postLoginUrl`'s origin.
- **Nothing checks it:**
  - `httpRoutes` accepts a `boardUrl` on another origin without complaint (probe: it constructs). A share-link
    sign-in then lands on a page whose exchange gets 403 and never sees the cookie.
  - `test/auth/http.test.js:12-20` sets the callback on `https://plenary.test` but `postLoginUrl` on
    `https://app.plenary.test`. Those tests pass only because they set Cookie and Origin headers by hand. In a
    browser that layout can never exchange.
- **Why MEDIUM, not HIGH:**
  - It fails closed, so there is no security impact.
  - Today's only wiring (`scripts/dev-google.js:68`) uses one origin.
  - main.js doesn't wire httpRoutes yet.
  - The builder listed it under Risks.
- **Fix (platform, small):**
  - In `httpRoutes`, throw unless `new URL(boardUrl).origin === appOrigin`.
  - Say in the header and config docs that the callback (OIDC `redirectUri`) must be on the same origin.
  - Move http.test.js to a single origin.

### MEDIUM 2: the dev harness still reads `#token` (not p5-code's file)

- **What breaks:** `scripts/dev-google.js:33-44`, the `/signed-in` page, reads `p.get("token")`. After p5-code it
  always shows "not signed in". Its header comment (line 16) is also stale.
- **What to change:** exactly what docs/m2/reports/p5-code.md "Needs a change elsewhere" says: read `#code`,
  call `replaceState`, then POST `/auth/exchange`.
- **Ask:** land it with p5-code, or straight after, before anyone runs the live Google check.
- **Stale log lines:** `docs/m2/COMMITMENTS.md:78-79` still mention `#token=`. That file is the manager's
  append-only log, so append a correction rather than edit.

### LOWs

- **3. `cookieKey` is now as powerful as the session key.**
  - I forged an `x1.` cookie with only `cookieKey` and got 200, a session token for an arbitrary user and email,
    which `sessions.verify` accepts.
  - This is inherent to a stateless signed cookie that carries identity.
  - The header (`http.js:10`) still says it "signs the login cookie". Say that it mints sessions, so it is guarded
    and rotated like the session key. Deriving both from one secret, or deriving the `x1` key with HKDF, are options.
- **4. Cross-node replay (documented).**
  - The same code and cookie on a second node gave 200, while a replay on the same node gave 400.
  - It needs the HttpOnly cookie, which a real browser drops after the first answer (seen in Chromium). So only
    someone who already controls the browser can do it. Accepted as the brief's option (a).
- **5. Outage race.**
  - With `issue` failing and two concurrent POSTs of one pair, one request gets 503 (and releases the code) and the
    other gets 400 (and clears the cookie). A browser can't retry after that.
  - Needs a double submit *during* an outage. Without an outage, concurrent POSTs give exactly one 200 (probe:
    `[200, 400, 400]`).
  - Client contract note: POST once, never in parallel.
- **6. Timing.**
  - Measured over 2000 runs each: no cookie about 4.0 µs, bad MAC 19.7 µs, wrong code 22.9 µs. An expired cookie
    also skips the code digest.
  - Harmless: only the holder of the HttpOnly cookie can send it, so a sender only ever times their own cookie. With
    the code alone, every attempt takes the no-cookie path. The hash compare itself is constant-time.
- **7. Lockout by a signed-in account.**
  - Anonymous lockout is closed. In probes with a guard cap of 3, a real login still worked after 500 bogus
    exchanges and 20 bogus callbacks (each callback had a valid state but a bad Google code).
  - A replayed successful callback stays refused: 400 on the same node, and 400 on another node with a single-use
    Google code (`idp.strictCode`). The other node refuses because Google won't redeem the code twice.
  - Filling one node's cap still needs about 100k *successful* Google sign-ins in 10 minutes (about 167 per second),
    which is attributable and impractical.
  - Bogus callbacks still each cost one call to Google's token endpoint. A per-IP or per-user limit at the gateway
    (CHECKER: Ch4, rate limiting) remains advisable and isn't built.
- **8. Clock skew.** Node B checks expiry against a cookie minted on node A. Skew of s seconds shrinks or stretches
  the 60 s window by s. Over 60 s, every cross-node exchange fails with 400 and the cookie is cleared. NTP is assumed;
  write it in the ops notes.
- **9. Monitoring.** The handler emits nothing, and logging belongs to main.js. Count `invalid-code` and replay-guard
  503s per node when it's wired (the builder notes the same).

## Builder's named risks: rulings

- **Cookie holds a signed identity, not a bare binder: accepted.**
  - A stateless code needs the identity somewhere. In the code it would put email and name into History, the very
    leak this job removes.
  - The `x1.` prefix separates it from `s1.` session tokens and `l1.` login cookies (tested).
  - The cost is LOW 3 (`cookieKey` now mints sessions).
- **Parallel sign-ins: confirmed, LOW, and slightly worse than the builder said.**
  - Tab B's cookie overwrites tab A's.
  - If B exchanges first, B gets 200 and A gets 400.
  - If A exchanges first, A gets 400 *and that 400 clears the cookie*, so B then gets 400 too: both tabs must sign
    in again (probed).
  - Rare, and it fails closed. A client that sees `invalid-code` should offer "sign in again".
- **`exp` decoded from session.js's token format: accepted for now, LOW.**
  - If the format changes, the exchange answers 503 (tested, code not spent). It fails closed, never with a wrong
    `exp`.
  - Cleaner: `sessions.issue` returns `{ token, exp }`. That's a session.js change for its owner.
- **One origin required:** MEDIUM 1.

## How I checked it

**Exchange probes** (scratch bun tests importing the real modules; two node instances sharing keys):

| Attack | Result |
|---|---|
| Expiry | Minted on a whole second: 200 at +59.999 s, 400 at +60.000 s. Minted mid-second (.500): 200 at +59.499 s, 400 at +59.501 s, because `exp` is truncated to whole seconds and the code dies at the next whole-second boundary (lifetime 59–60 s, never over 60). 400 at 61 s |
| Origin: missing, `null`, `""`, uppercase host, trailing slash, `:443`, comma list, other site | All 403, nothing spent, cookie kept |
| Code without cookie; another login's cookie (either way round); tampered cookie MAC; tampered code | Each 400 `{"error":"invalid-code"}` (status printed for each) |
| Session token (`s1.`) or login cookie (`l1.`) as the exchange cookie | 400 |
| Duplicate cookie names | First one wins; no confusion |
| Body or method errors | Wrong or missing content type 415; JSON array 400; extra field or `__proto__` 400 `unknown-field`; `{code:null}` 400 `invalid-code`; 1 MB body 413; GET, PUT, DELETE, HEAD, OPTIONS, PATCH all 405. None spend the code: the real pair still worked afterwards |
| Replay | Same node 400; other node 200 (LOW 4) |
| Concurrency | Same node: exactly one 200 |
| Worst-case identity in the cookie | Name of 300 CJK or control characters (cut to 200; a control character becomes 6 bytes of JSON) plus a 253-character domain: `name=value` 1347–2147 bytes, exchange 200. My long-email probes never kept the email (oidc nulled it as not authoritative). By arithmetic, a full 320-byte email adds about 430 bytes, about 2.6 KB in all: under the 4096 cap |
| `no-store` | On every response |
| Logging | http.js has no `log` or `console` calls; error bodies carry only an error code |

**Contract:** the 200 body keys are exactly `token, user, name, email, domain, exp`. `exp` is an integer, and the
null rules match docs/m2/contracts/auth-exchange.md (the builder's type test pins them, and I re-read the code).

**Real browser:** Chromium 1217 (Playwright's cached Google Chrome for Testing), `--headless=new`, scratch profile,
PID 34219 recorded, stopped with SIGTERM and confirmed exited.

- **Setup:** app on `http://localhost:<port0>`; fake Google authorize page on `http://127.0.0.1:<same port>`, a
  different site, which redirects back with JS. The landing page reads `#code`, calls `replaceState`, POSTs twice and
  reports back.
- **Result:**
  - The login cookie reached the callback.
  - The callback's Location had no `s1.` and it set `__Host-plen_xchg`.
  - The exchange request carried the cookie and Origin `http://localhost:<port>`: 200, with a token.
  - The second POST went **without** the cookie: 400.
  - `document.cookie` can't see the cookie (HttpOnly). The address bar ended without the fragment.
  - Chrome accepted `__Host-` + Secure on `http://localhost`.
- **History DB:** 5 URLs. No `s1.` token, no email or domain, and one `…/app#code=<code>` row. That row is expected
  and harmless: the code was spent, its cookie cleared, and it was dead after 60 s anyway.
  - Whole-profile scan with `/usr/bin/grep -rla`, binary-safe: no `s1.eyJ` and no `ann@acme` in any file.
  - Positive control: the same scan finds `code=` in History and the cache DB, so the scan does read those files.
- This closes three of the builder's not-verified items: Strict cookie after a cross-site chain, `__Host-` on
  localhost, and History.

**Hexagonal:** `bun test test/auth/architecture.test.js` passes: 11 tests, 0 fail.

## distributed-systems-design (v0.1.0), CHECKER on the cross-node design

- **Stateless web tier:** yes. The only shared state is `cookieKey` (and the session key), both from config. No
  sticky sessions are needed, and a second node exchanges (tested).
  - Nothing enforces that nodes share the keys. A mismatch, or an in-flight exchange during key rotation, gives 400
    and a re-login: it fails closed.
- **Unique IDs (Ch7):** 256 random bits per code, no coordination. Fine.
- **Consistency:** single use is per node, an explicit availability-first choice. A cross-node double spend needs
  the HttpOnly cookie as well as the code. Option (b), a shared used-set through the Registry port, would close it at
  one store write per sign-in. I agree it's not worth it for M2.
- **Rate limiting (Ch4):** not present on `/auth/callback` or `/auth/exchange`.
  - Placement is deferred to the gateway or load balancer, where the client IP can be trusted.
  - The anonymous lockout no longer depends on it (LOW 7). Hammering Google still does.
- **Failure scenarios:**

  | Failure | Behaviour |
  |---|---|
  | Session issuing down | 503, code not spent |
  | Code store or guard full | 503, fails closed |
  | Google down | 400 `login-failed` |
  | Clock skew | LOW 8 |
  | Key mismatch | 400 and re-login |

- **Scale:**
  - The builder's estimate holds: about 833 exchanges per second cluster-wide, each a few HMACs, and used-code sets
    of about 50k entries (about 5 MB).
  - Bottleneck: the per-node replay guard (cap 100k, held 10 min). It now holds only successful logins, so a
    100k-join burst on a single node sits exactly at the cap. It's fine with 2 or more gateways, or with
    `maxLoginStates` raised.
- **Monitoring:** absent (LOW 9).
- **At 10×:** the guard cap and Google's quota go first; the exchange itself doesn't.

## sdd ensemble review

- **Reviewers:**
  - **Ran:** codex (`effort: high`) and grok.
  - **Unavailable:** agy (`check_adapter` failed: quota exhausted, resets in about 64 h), kimi (no model
    configured), mistral (no API key), qwen (not installed).
- **What they saw:** a scratchpad copy of the diff plus the new test, http.js, session.js, the contract and the
  brief. They never had the repo or `.env`.

| Reviewer finding | Verdict |
|---|---|
| Codex MEDIUM and grok MEDIUM: `boardUrl` / `postLoginUrl` origin split breaks the exchange | **Agreed (HIGH candidate) → confirmed, rated MEDIUM** (finding 1) |
| Grok HIGH: Origin `null` or missing lets CSRF through | **Refuted.** The check is strict equality with the app origin, so `null`, `""` and a missing header all give 403 (probed) |
| Grok MEDIUM: the clearing Set-Cookie may not match, so the cookie survives | **Refuted.** Same name, Path and host; Chromium dropped the cookie (the second POST went without it) |
| Grok MEDIUM: no `Vary: Origin` | **Refuted.** Every response is `no-store` and never cacheable, so there is no cache to poison |
| Grok LOW: the state slot isn't released if `mintCode` throws | **True in code, no impact.** That needs WebCrypto to fail after Google succeeded, Google's code is spent anyway, and the user's next sign-in gets a new state, so nobody is locked out |

## Not verified

- **No live Google sign-in.** It needs the person, and `google-live.test.js` was not re-run with
  `PLENARY_LIVE_GOOGLE=1`.
- **One browser only:** Chromium. Not checked in Safari (ITP) or Firefox, nor over https on a real domain.
- **Share-link path:** tested in bun only, not in the browser.
  - With one origin: the builder's test (the code lands on the board URL and the role resolves).
  - With a split `boardUrl`: my probe. Location went to `https://other.test`, and the exchange from that origin got
    403 `bad-origin` (and in a browser the host-only cookie wouldn't be sent there at all). That confirms MEDIUM 1
    end to end.
- **Lockout by an authenticated account:** reasoned, not reproduced.

# Re-check (fix round t196, from manager t187)

**PASS.** Both MEDIUMs are fixed. No new findings above LOW. `bun test`: **510 pass, 78 skip, 0 fail** (588 tests,
33 files).

## MEDIUM 1, one origin: fixed

I tried 18 configs against `httpRoutes()` (scratch test, real module).

- **Refused at build time:** every split origin.
  - `postLogoutUrl`: another host, `http:`, or `:8443`.
  - `boardUrl`:
    - `{board}` in the host (`https://{board}.app.test/`, `https://app.test{board}/`);
    - userinfo that moves the host (`https://app.test@{board}/`);
    - a trailing-dot host;
    - an IDN look-alike;
    - a `postLoginUrl` on `www.` while the board stays on the apex.
  - `publicUrl` on `api.`.
  - A `{board}` in the port is refused as not an absolute URL.
- **Built, all correctly:** each is the same origin after WHATWG normalization, which is how browsers normalize the
  Origin they send.
  - `:443`, uppercase hosts, trailing slashes.
  - `https://u{board}@app.test/`: userinfo, host unchanged.
  - Two `{board}`s: only the first is replaced, both at check time and at run time.
  - `https://app.test\@evil.test/{board}`: the backslash parses as `/`, so the host stays `app.test`.
- **Run time:** board ids `@evil.test`, `../..//evil.test`, `%2F%2Fevil` and `x:1@evil` all stay on `https://app.test`,
  because `encodeURIComponent` escapes them.
- **LOW, residual: the callback origin is still unchecked.** The OIDC `redirectUri` sits behind the IdP port, so
  http.js can't see it. The header now makes it the composition root's duty, and `scripts/dev-google.js` keeps it on
  `ORIGIN`. When main.js wires Google (p2-swap), it should assert `new URL(redirectUri).origin === new URL(postLoginUrl).origin`.
  Alternatively, expose `redirectUri` on the port (a port change).
- **http.test.js:** its config is now one origin (`https://plenary.test`), so it describes a deployment that can sign in.

## MEDIUM 2, dev harness: fixed, and it works in a real browser

The real `scripts/dev-google.js` (`startDevGoogle`) ran in headless Chromium 1217 with no Google login.

- **No secrets read:** env was passed in as `{ GOOGLE_CLIENT_ID: <fake>, GOOGLE_CLIENT_SECRET: "secret" }`, so no
  `.env` was read or printed.
- **Setup:**
  - The harness ran on port 0, with the fake IdP as its `fetch`.
  - Chrome's `--host-rules` / `--host-resolver-rules` sent `localhost:8080` to the harness. Nothing bound 8080.
  - The same rules sent `accounts.google.com:443` to a port-0 TLS fake authorize page (throwaway self-signed cert,
    `--ignore-certificate-errors`), which redirects back.
  - Chrome started at `http://localhost:8080/auth/login`, the target of the page's "Sign in with Google" link.
  - Recorded PIDs 77081 and 84564 were stopped by me; `pgrep` afterwards found no Chrome left.
- **Page, read over DevTools protocol:**
  - `#who` = **"signed in as ann@acme.com"**.
  - `location.href` = `http://localhost:8080/signed-in`: the fragment was dropped.
  - `document.cookie` can't see the exchange cookie.
- **Harness log:**

  | Request | Result |
  |---|---|
  | `/auth/login` | 302 |
  | `/auth/callback` | 302, `loginCookie: true` |
  | `/signed-in` | 200 |
  | `POST /auth/exchange` | 200, `exchangeCookie: true` |

  The log records presence only, never cookie values.
- **This closes the fix round's not-verified item:** Chrome keeps the `Secure`, SameSite=Strict `__Host-` exchange
  cookie on `http://localhost` through a cross-site (https) redirect, and sends it on the exchange.
- **No token or identity in any URL:**
  - History: 5 URLs, with 0 containing `s1.`, `token`, `ann` or `acme`. One `/signed-in#code=<code>` row (spent, and
    dead after 60 s), as in the first check.
  - Binary-safe `/usr/bin/grep -rla` over the whole profile: no `s1.eyJ` and no `ann@acme`. Positive control: the
    same scan finds `code=`.
  - The navigation-timing entry holds `#code=<code>`, never a token.

## p5-google Hand-off steps: still true

| Step | Status |
|---|---|
| 1 | Unchanged, Google-side |
| 2 | Same command; the harness still reads `.env` from the repo root and prints its PID and URL |
| 3 | Chrome on `localhost` keeps both cookies: now measured for the exchange cookie too |
| 5 | Matches the page: it drops `#code`, POSTs once, and shows "signed in as …", or the no-verified-email text from the same line |
| 6 | Matches the page's failure text `sign-in failed (<status> <error>)`, so it shows "sign-in failed (400 invalid-code)". The `exchangeCookie` log field exists as described |
| 7 | Unchanged |

Not re-run: the live Google sign-in (needs the person).

## Still open from the first check (LOW, unchanged)

- **LOW 3:** `cookieKey` mints sessions. Now documented in the header; no code change.
- **LOWs 4–9:** as above.
- **`docs/m2/COMMITMENTS.md:78-79`** still say `#token=`. That's for the manager to append a correction.
