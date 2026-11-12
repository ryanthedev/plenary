# Report: p5-googlev (verify p5-google)

**Result: PASS.** No HIGH. Two MEDIUM, five LOW. The live check passes against Google's real endpoints, the normal
suite skips it, and neither secret appears anywhere I could find. One error path in the live test can print the
client id (MEDIUM 1). The builder's failure analysis misses that an anonymous client can lock out sign-in on a
gateway (MEDIUM 2, in `http.js`, platform's file). Nothing in the tree was changed except this report.

## What I ran

**Versions verified** (sha256): `scripts/dev-google.js` `f841471c…f2f1b95f76` (mtime 21:53:53),
`test/auth/google-live.test.js` `60cec8c1…ee76bf5538b` (mtime 21:55:01). Both unchanged during my runs.

| Check | Result |
|---|---|
| Harness error paths (sentinel credentials, `fetch` injected, login then callback with a valid state) | Google **throws** an Error whose message holds the URL and the POST body; Google answers **500 echoing the body**; Google answers **200 with junk**; Google throws a **non-Error** (the sentinel secret string). All four: callback 400 `login-failed`, **no sentinel** in the response, its headers or the logs, nothing on stderr, harness still serves `/` |
| Assertion messages on failure | None prints either secret. The client id is compared as a boolean (`:52`); URLs are reduced to origin + path (`:49`, `:72`, `:84`). Failures of `:53`–`:64` print the redirect URI, scope, state, nonce, challenge or the sealed login cookie, none of which holds the client id or secret. The one leak is a thrown `fetch` (MEDIUM 1), which isn't an assertion |
| `PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live.test.js` | **7 pass, 0 fail.** Google answers 200 at `/v3/signin/identifier`, no error markers. The control (redirect port 8081) gives `redirect_uri_mismatch`. 2 RS256 keys import. The token endpoint answers `400 invalid_grant` |
| `bun test` (full) | **376 pass, 78 skip, 0 fail** (454 tests, 27 files). The live file prints its skip line; no test calls Google |
| `bun test test/auth/google-live.test.js` (no flag) | 1 pass, the live block skipped |
| **Secret negative control** (my probe, token endpoint, bogus code) | Real secret gives `400 invalid_grant`. The secret with its last two characters changed gives `401 invalid_client`. So the test's `invalid_grant` assertion **does prove the secret is right**, not just that Google is reachable. The builder didn't claim this; it holds |
| Harness on the real port 8080 (PID recorded, killed by PID) | `/` 200; `/auth/login` 302 to Google; `/whoami` with no bearer 401; callback with no state, or with `error=access_denied`, 400 `login-failed`; unknown path 404. Bound to `127.0.0.1:8080` only (lsof) |
| Busy port | A second instance exits 1 ("something already answers on port 8080"). A silent TCP listener on `127.0.0.1:8080` also stops it ("Failed to start server"). A silent listener on `[::1]:8080` does **not** (LOW 2) |
| Bad env | Empty secret: exits 1 with "must be set (.env)". No value printed |
| Hand-off success reachable? | Yes. The callback issues a session without consulting tenancy (`http.js:150-172`), so the empty in-memory registry doesn't block the CEO's login. The "(no Google-verified email…)" case in step 5 matches `authoritativeEmail` (`oidc.js:127-132`) |
| **Secret scan** | A script reads `.env` in-process and counts hits of the client id, the secret, `COOKIE_KEY` and the client id's numeric prefix. **0 hits** in all 323 tracked and untracked non-ignored files, in every test output, harness log and probe output of mine. Only counts were printed. `.env` is mode 0600 and git-ignored |

## Can the live test pass while sign-in is broken?

| Breakage | Caught? |
|---|---|
| Wrong `redirect_uri` | Yes: test 1 asserts it exactly; the control proves the Google check sees a mismatch |
| Missing PKCE param or wrong method | Yes: test 1 asserts `code_challenge` (43 chars) and `S256`. Google itself would **not** catch it (confidential clients may skip PKCE) |
| Google's 200 error pages | Yes: keys on the final path plus error markers, not the status |
| Wrong client id or secret | Yes: client id compared in test 1; secret proven by `invalid_grant` (my control above) |
| Wrong `code_verifier` at the token endpoint, or ID-token checks (`aud`, `iss`, nonce, email) on a **real** Google token | **No.** Needs a real code, i.e. the human login. Known and stated by the builder |

## Findings

**HIGH:** none.

**MEDIUM 1: if Google is unreachable, the live test prints the client id** (`test/auth/google-live.test.js:69`
and `:82`).
- **Cause:** when `fetch` throws (offline, DNS, TLS, a proxy), Bun's error carries a `path` field with the full URL,
  and `bun test` prints it. The URL is the authorization URL, so it holds `client_id=…` unredacted.
- **Proven** with a fake id in a scratch test: both `ECONNREFUSED` and `ENOTFOUND` print
  `path: "https://…/o/oauth2/v2/auth?client_id=FAKEID-…"`.
- **Why it matters:** the brief forbids printing any URL carrying the client id; the builder's leak checks cover
  only responses and logs. (The client id is visible to browsers by OAuth's design, so this is MEDIUM, not HIGH.
  The secret never rides in a URL: it goes in the token POST body, and that path is wrapped in `oidc.js:232`.)
- **Fix (builder's file):** wrap both Google fetches in `try/catch` and rethrow `new Error("google unreachable: " +
  e.code)`, or fetch a URL rebuilt without `client_id` for the error message. Add a test that points the harness at
  an unreachable authorize host and asserts the output holds no id.

**MEDIUM 2: an anonymous client can lock every user out of sign-in on a gateway for 10 minutes**
(`server/auth/http.js:131-141` and `:157-161`; platform's file, not this job's).
- **How:** login cookies are free (`GET /auth/login`). Each callback whose state matches its cookie takes a
  replay-guard slot **before** the code is checked, even with a bogus code. When the guard holds 100k entries, every
  callback gets 503 until entries expire (10 min).
- **Proven** with a fake IdP and `maxLoginStates: 3`: three anonymous bogus callbacks (400 each), then a real
  user's callback gets **503**. Each bogus callback was also one token POST to the IdP.
- **Cost to the attacker at the default cap:** about 170 login/callback pairs a second per gateway for 10 minutes.
  Each one also spends one call to Google's token endpoint under our client (quota unverified).
- **History:** p5-httpv MEDIUM 1 found this anonymous fill as a CPU cost. The fix added the cap, and the re-check
  recorded "cap full: a valid real login gets 503" as deliberate fail-closed behaviour (`p5-httpv.md:166-185`). What
  no report records is that an **anonymous** client can drive the cap full. `manager-platform.md:222` lists "no rate
  limit on callbacks" as an open LOW for M8. So: known parts, newly joined; I rate it MEDIUM. The builder's
  bottleneck 1 treats the cap as a legitimate-load limit only.
- **Options (platform's call):** a per-IP (or per-/24) rate limit on `/auth/callback`; take the slot only **after**
  `oidc.finish` succeeds (a bogus code then costs nothing, and replay of a good code is still refused; a real code
  is single-use at Google anyway); or evict oldest-first instead of failing closed, since the nonce and Google's
  single-use code remain as guards.

**LOW 1: a failed real login logs no cause.** The harness logs `loginCookie: true|false` only, and `http.js` maps
every refusal to `login-failed`; the harness's own `catch` (`scripts/dev-google.js:88`) drops the error too. If the
CEO's one login fails with the cookie present, nobody can tell `invalid_grant` from a bad `aud`, nonce or `iss`
without re-instrumenting. Suggest a dev-only reason field in the harness log (via the `log` hook, never the
response).

**LOW 2: a silent listener on `[::1]:8080` doesn't stop the harness.** `answers()` treats "no HTTP reply in 1 s"
as free, and the harness binds IPv4 only, so a non-HTTP or slow IPv6 listener coexists (measured: both on 8080).
The browser's `localhost` may then reach the other one. Rare on a dev Mac. Fix: also try `Bun.listen` on `::1:8080`
briefly, or treat a connect that succeeds without a reply as busy.

**LOW 3: the error message doubles its prefix:** "dev-google: dev-google: GOOGLE_CLIENT_ID and …"
(`scripts/dev-google.js:59` and `:114`).

**LOW 4: the secret proof is implicit.** Add the wrong-secret control (expect `invalid_client`) next to the
`invalid_grant` test, so a future reader knows the assertion proves the secret.

**LOW 5: the builder's systems-design claims are correct but partly unchecked live.** All tests it cites exist
(`oidc.test.js:146, 176, 216, 230, 254`; `http.test.js:210, 223, 486, 517`). See the CHECKER notes below.

## Hand-off, read as the CEO

Clear and correct. It names the test-user requirement, the exact start command, `localhost` not `127.0.0.1`, what
success and failure look like, and how to stop. Nothing misleads. Two small gaps: failure gives no cause (LOW 1),
and a harness restart invalidates the session (random key per run), which only matters if they reload `/signed-in`
after restarting.

The harness says at the top it is a dev composition root, not the product server. A grep of `server/`, `scripts/`,
`test/` and `web/` finds it named only in itself and the live test.

## Systems design (distributed-systems-design v0.1.0, CHECKER) on the builder's failure table

| Item | Verdict |
|---|---|
| Google down: `/auth/login` still redirects; `finish` times out at 10 s; existing sessions keep working | **Correct.** `begin()` makes no call; token POST has `AbortSignal.timeout`; sessions verify by HMAC offline. Google is a single point of failure for **new** sign-ins only; acceptable, and stated |
| JWKS rotation | **Correct** and well covered (cooldown, max-age cap, failed fetch keeps keys, shared cold fetch) |
| Clock skew | **Correct** (±60 s, `iat` ≤ 1 day). Unchecked: the login cookie's 10-min window across gateways with skewed clocks; minor |
| Replayed callback | **Correct** for replay. **Missed:** the same guard is an anonymous lockout lever (MEDIUM 2) |
| Estimate (830 fresh sign-ins/s worst case, ~10 MB guard per process) | Arithmetic right. The worst case is unrealistic (sessions last 12 h) and the builder says so |
| Bottleneck 1 (guard cap at the NFR) | Real, but understated: the cap fills from abuse, not only load |
| Bottleneck 2 (Google token quota) | Agree; unverified. MEDIUM 2 makes it worse: anonymous callers spend it |
| Bottleneck 3 (no monitoring) | Agree. Add: login-failed by cause (also fixes LOW 1), guard size, 503 "full" count |
| Checklist: **rate limiting on public APIs** | **Missing** on `/auth/login` and `/auth/callback`. This is the root of MEDIUM 2 |
| Checklist: stateless web tier | Good: login state rides in a signed cookie, so any gateway finishes any flow. The session key must be shared across gateways in the real composition root (the harness's per-run key is fine for dev) |

## What I did NOT verify

- A real login, real ID-token checks, the `code_verifier` at Google, Google's cross-site redirect back, replay of a
  real code, Google's rate limits: all need the human login.
- Safari and Firefox with the `__Host-` `Secure` cookie on `http://localhost`.
- **The builder's Chrome result** (Chrome keeps and returns the `__Host-` cookie on `http://localhost`): I did not
  re-run it. The hand-off's "use Chrome" rests on the builder's run alone.
- MEDIUM 2 at the default 100k cap against the real harness (proven at cap 3 with a fake IdP; the code path is the
  same). I did not flood Google.
- No sdd ensemble: nothing needed a second opinion, and the brief said to skip it otherwise.

## Process notes

- Every process I started was killed by its recorded PID. One harness outlived its `timeout` wrapper (PID 96243);
  I killed it by that PID. Port 8080 was free before and after.
- Probes and outputs live in my scratchpad, not the tree; all scanned with 0 hits.

# Re-check (MEDIUM 1 fix round, for t187, 2026-11-11)

**PASS.** MEDIUM 1 is fixed. With Google unreachable and a sentinel client id, no output path I could reach prints
the client id: not the test output, not the harness's stdout or stderr, not the callback's response. The live
check and the full suite pass. MEDIUM 2 belongs to p5-code and was not re-checked.

**Versions checked** (sha256): `scripts/dev-google.js` `4c30888a…fe1fb60c39f64`, `test/auth/google-live.test.js`
`e28dedd5…463bb7b55`. Unchanged across all runs below.

| Check | Result |
|---|---|
| **Control:** does a dead proxy make Google unreachable, and does raw `fetch` then leak? | `HTTPS_PROXY=http://127.0.0.1:9`: a raw fetch of an authorize URL with a sentinel id fails, and Bun prints the sentinel. So this setup can catch a leak |
| **Live test file, Google unreachable** (`PLENARY_LIVE_GOOGLE=1`, sentinel id and secret in env, same dead proxy, `NO_PROXY` for the local harness) | 7 pass, 4 fail as expected (the four tests that need Google). Each failure prints `error: google unreachable: ECONNREFUSED` with no URL. **Sentinel hits in the full output: 0** |
| **Harness CLI, Google unreachable** (same env, port 8080, PID recorded, killed by PID, 8080 free before and after) | `/` 200, `/auth/login` 302, callback with a valid state 400 `login-failed` (`loginCookie: true`). **Sentinel hits in stdout, stderr, callback headers and body: 0** |
| New always-run block in the test file (child `bun` process, sentinel id, hosts `127.0.0.1:9` and `.invalid`, with a raw-`fetch` control) | Passes in the normal suite; read the code: it asserts the control leaks and `safeFetch` doesn't |
| Live check, real credentials | **11 pass, 0 fail.** Same Google answers as before: `/v3/signin/identifier` with no error markers; the control gives `redirect_uri_mismatch`; 2 RS256 keys; token endpoint `400 invalid_grant` |
| Full `bun test` | **478 pass, 78 skip, 0 fail** (556 tests, 32 files). No failing tests |
| Secret scan (in-process, counts only) | **0 hits** for the real client id, the secret and `COOKIE_KEY` across all tracked and untracked files and every output of this round |

**Code read:** `safeFetch` (`scripts/dev-google.js:107-113`) rethrows a new Error holding only a charset-checked
`code` or `name`, with no `cause`. Every Google fetch in the test file goes through it; the remaining raw `fetch`
calls hit only the local harness (`h.url`).

**LOW (new, not verified):** `probeAuthorize` reads the body with `g.text()` outside `safeFetch`. If a connection
drops after Google's headers arrive, that read throws, and I did not check whether Bun's body-read error carries the
URL. Rare, and only in the live test. Wrapping the `text()` call the same way would close it.

**My own slip, for the record:** my first Google-down run passed the variables as one unsplit zsh string, so the
live block skipped and proved nothing. I caught it (the run showed 8 skips) and re-ran with the variables inline;
the results above are from that run.
