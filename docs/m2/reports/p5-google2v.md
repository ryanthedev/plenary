# Report: p5-google2v (verify p5-google2: Google sign-in on the real server, scripted up to the CEO's login)

**Verdict: PASS.** No HIGH or MEDIUM findings. Four LOWs and one note, none blocking the CEO's login. Every builder claim I
checked held. Nobody signed in to Google. No code edited, nothing committed. Bun 1.4.4, 2026-11-12 ~17:20Z.

## Findings

| # | Grade | Finding | Where |
|---|---|---|---|
| L1 | LOW | **The default stdout logger ignores `LOG_LEVEL` and the logger's `base` fields, and sprays the test output.** `main.js` passes no `log`, so causes go through `stdoutLog`, not `createLogger`. **Run, not just read:** `LOG_LEVEL=error bun server/main.js` suppressed every info line, yet a cookieless callback still printed `{"level":"warn","msg":"sign-in failed","cause":"no_login_cookie"}`. The full `bun test` run prints **76** `sign-in failed` JSON lines. They come from callers that pass no logger: the direct `httpRoutes` callers (`http.test.js`, `exchange.test.js`, `web/adapters/auth-http.test.js`, found by grep) and anything built through `start()`. I didn't attribute the 76 lines file by file. They carry only `{cause,time,level,msg}` (checked: no other keys). Fix: the builder's proposed `log: log.child({ component: "auth" })` in `server/main.js` (engine's file). No leak, no double log. | `server/auth/http.js:113,444` |
| L2 | LOW | **A 200 from the token endpoint with a non-JSON body is labelled `idp_unreachable`.** `res.json()` throws inside the same `try` as the fetch, so the hand-off's (e) row would tell the CEO "Google couldn't be reached" when Google did answer. Reproduced with the fake IdP (below). Very unlikely with real Google. Fix: a `bad_token_response` label for a parse failure. | `server/auth/oidc.js:255-257` |
| L3 | LOW | **Hand-off (d) step 2 pastes code into Chrome DevTools.** Chrome may refuse the first paste into a console and ask you to type `allow pasting` (a self-XSS guard). Unverified on the CEO's profile. A non-expert could read that warning as "stop". Add one line: "If Chrome asks, type `allow pasting`, press Enter, then paste again." | report, hand-off (d) |
| L4 | LOW | **Hand-off (e) cause table misses a few labels**: `idp_error` (no name), `idp_refused`, `idp_threw`, `bad_sub`, `bad_config`, `bad_expected`. They fit the existing "Shouldn't happen. Report the cause." row. Also a 503 from a `mintCode` failure logs nothing (no cause line); rare and harmless. | report; `server/auth/http.js:288` |

**Note (not a finding):** the builder's report has no mutation table. Its brief didn't ask for one; mine asks me to
redo one, so I built my own (below): 17 of 18 killed.

**Surviving mutant (not a finding):** making `why` last-wins instead of first-wins (M16 below) survives. For
`googleOidc` it is equivalent: each refusal calls `why` exactly once.

## Claims checked

| Builder claim | Result | How |
|---|---|---|
| Live check passes against the real server, 9 pass | **Confirmed** | Ran it myself (below) |
| `/auth/login` 302 params, cookie `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`, `Max-Age=600` | **Confirmed** | Live test asserts every param, client id as a boolean. My own curl against `bun server/main.js` also showed them. |
| One plain GET reaches Google's sign-in page | **Confirmed** | `200 https://accounts.google.com/v3/signin/identifier errors=[]` |
| Wrong secret gives `invalid_client`; right secret with a bogus code gives `invalid_grant`; causes logged | **Confirmed** | `[{"status":400,"error":"invalid_grant"}]` and `[{"status":401,"error":"invalid_client"}]`, observed at the token endpoint by a spy fetch, not by our own code |
| A WS hello with no, empty, forged or wrong-key token is refused, on the real gateway | **Confirmed** | Has a positive control (a valid token gets `welcome`); each bad case asserts close 1008 and `error auth` |
| No secret in log or responses | **Confirmed** | 7 values against 2131 log chars and 14 response parts: 0 hits |
| A failed callback logs one fixed label; no state, nonce, code, cookie, error_description or body | **Confirmed** | Test review, 18 mutations, cookie-gate probes on `bun server/main.js`, and 14 crafted callbacks **with a valid login cookie** through `start()` with a fake IdP, 8 of them crafted token-endpoint replies (below) |
| The IdP port contract is unchanged | **Confirmed** | The only `finish` callers are `http.js` and `test/auth/idp-contract.js`, which passes (in `bun test test/auth`). `why` is optional and extra; every refusal still returns `null`; a throwing `why` changes no verdict (test plus M14). |
| The default logger matches `server/log.js` | **Partly** | Same line shape `{…fields, time, level, msg}`. Bypasses `LOG_LEVEL`, `base` and `clean()` redaction (L1). No double log: `main.js` passes no logger, so only the default writes. |
| `portBusy` reads a silent listener as busy on 127.0.0.1 and ::1, a free port as free, no hang | **Confirmed** | Timed probe below |
| p5-googlev LOW 1/2/3 and the `probeAuthorize` body-read LOW are fixed | **Confirmed** | Read in the diff. LOW 1 and LOW 2 tested and mutation-killed. The body-read fix is not reproduced (needs a mid-body reset), as the builder says. |
| Hand-off steps before the login work with the current admin-bootstrap CLI | **Confirmed** | Walked (below) |
| Full `bun test`: 1292 pass, 1 known fail | **Confirmed** | Same counts |

## Commands and outputs

**Live test** (8080 checked free first with `lsof`; `DATABASE_URL`, `NATS_URL`, `PLENARY_DEV_TOKENS` unset):
```
$ PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live-server.test.js
google: 200 https://accounts.google.com/v3/signin/identifier errors=[]
right secret: token endpoint [{"status":400,"error":"invalid_grant"}]; log cause invalid_grant
wrong secret: token endpoint [{"status":401,"error":"invalid_client"}]; log cause invalid_client
scan: 7 values against 2131 log chars and 14 response parts: 0 hits
 9 pass  0 fail  65 expect() calls
```

**Would the live test fail if a check silently passed?** I read every assertion. Yes in each case:
- **Wrong path:** if the callback took a no-cookie path, the `tokenCalls` assertion (exactly one call to Google) fails.
- **Log not captured:** the scan requires more than 200 log chars containing `server listening`.
- **Nothing scanned:** the scan requires more than 5 response parts.
- **Refusals:** each WS refusal needs close 1008 and an `auth` error, and the valid token must first get `welcome`.
- **Secret control:** `invalid_client` vs `invalid_grant` is read from Google's own reply.

**Gates:**
```
$ bun test test/auth test/admin           → 214 pass, 18 skip, 0 fail (232 tests, 16 files)
$ env -u DATABASE_URL bun test            → 1292 pass, 147 skip, 1 fail (1440 tests, 76 files)
(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)   ← known unrelated
```

**Cause logging past the cookie gate** (scratch `fullflow.js`: real `start(env)` on a free port, fake Google via the
injected `fetch`, each callback carrying a valid login cookie from `/auth/login`). Sentinels were planted in the query
string and in the fake token endpoint's replies. Every reply was 400, every log line had exactly `cause, level, msg,
time`, and sentinel hits were **0** in all 14 cases:

| Input | Cause logged |
|---|---|
| `error=` holding a newline and `{"level"` (plus `error_description`) | `idp_error` |
| `error=ACCESS_DENIED`, `error=access_denied ` (trailing space), `error` repeated | `idp_error` each |
| Wrong state; no code | `state_mismatch`; `no_code` |
| Token reply whose `error` is an array, object or number, `" invalid_grant "`, or only `error_description` | `token_http_400` each |
| Token reply 200 with a non-JSON body | `idp_unreachable` (L2) |
| Token reply 200 with `id_token` = a sentinel | `bad_token` |
| Token reply 599 | `token_http_599` |

**Cookie gate on the real server.** I also sent crafted callbacks to `bun server/main.js` and wrote its stdout to a
scratch file. The query strings and cookies carried sentinels: `STATESENTINEL123`, `CODESENTINEL456`,
`COOKIESENTINEL789`, `ERRSENTINEL` with an embedded newline and `{"level`, and `error_description=DESCSENTINEL`.
- **Result:** 4 lines, causes `no_login_cookie`, `bad_login_cookie`, `bad_login_cookie`, `no_login_cookie`. All four
  stopped at the cookie gate; the deeper branches are covered by the table above.
- **Leaks:** `grep SENTINEL` over the log found **0**. The browser got `{"error":"login-failed"}` each time.

**Mutations** (scratch copy of the tree; tests run: signin-cause, port-busy, http, oidc, exchange):

| # | Mutation | Result |
|---|---|---|
| M1 | `why` label filter removed | killed |
| M2 | `?error=` echoed raw as `idp_error:<e>` | killed |
| M3 | token-endpoint `error` not whitelisted | killed |
| M4 | `no_login_cookie` and `bad_login_cookie` swapped | killed |
| M5 | default logger off (`log = null`) | killed |
| M6 | `portBusy` checks IPv4 only | killed |
| M7 | `listening` always true | killed |
| M8 | logger throw not caught | killed |
| M9 | up-front replay labelled `state_mismatch` | killed |
| M10 | no `idp_timeout` branch | killed |
| M11 | `why` not passed to `verifyIdToken` | killed |
| M12 | extra field in the log line | killed |
| M13 | `replay_guard_full` not logged | killed |
| M14 | a throwing `why` changes the verdict in oidc | killed |
| M15 | `bad_aud` labelled `bad_iss` | killed |
| M16 | `why` last-wins | **survived** (equivalent for googleOidc) |
| M17 | `idp_threw` label lost | killed |
| M18 | a success also logs a line | killed |

**portBusy** (scratch script, real `scripts/dev-google.js`):
```
silent ::1 true 1ms · silent 127 true 0ms · wildcard 0.0.0.0 true 0ms · free false 0ms · 8080 now false 0ms
unroutable host, timeout path: false after 501ms (timeout 500) → no hang
```

## Hand-off walk (placeholders `example.com` / `ceo@example.com`)

Run exactly as written, from the repo root.

**(a) Make the tenant.** `D=$(mktemp -d -t plenary-ceo)`, then:

| Command | Output | Exit |
|---|---|---|
| `bun scripts/admin-bootstrap.js --domain example.com --admin ceo@example.com --data-dir "$D"` | `{"ok":true,"registry":"sqlite",…,"created":true,"added":["email:ceo@example.com"],…}` | 0 |
| The same, re-run | `created:false, added:[]` | 0 |
| `--admin ceo@other.com` | "email admin is not on the tenant's domain example.com" | 2 |
| `--domain Example.COM --admin CEO@Example.com` | Normalised to the same tenant, `added:[]` | 0 |
| No `--admin` | "--admin is required (at least one)" | 2 |

**(b) Start the server.** `PLENARY_DATA_DIR="$D" bun server/main.js`, PID 58672 recorded.
- **Log, in order:** `sign-in {google:true, cluster:false}`, then `dev tokens are off: sign-in is Google only`,
  then `server listening {port:8080}`.
- **No `COOKIE_KEY` warning.** `.env` holds only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `COOKIE_KEY` (key
  names read; values not printed).

**(c) and (d) rehearsed without Google.** A scratch script minted Google-shaped sessions in-process with `.env`'s
`COOKIE_KEY`. That key also serves as `SESSION_KEY` when the latter is unset, as in `main.js`.

| Step | Result |
|---|---|
| CEO (`google:…`, `ceo@example.com`, hd `example.com`) runs `POST /boards` | **201 `b-…`**; hello gets `welcome`, role **owner** |
| Same email but no `hd` (personal or secondary-domain account) | **403** (matches the hand-off's 403 note) |
| Another user on the domain | **403** |
| `/?board=<id>` | 200 |

**Full sign-in through `start()` with a fake Google** (scratch `fullflow.js`, tenant made by the CLI's `run()`):
login, callback, `POST /auth/exchange` (with `Origin: http://localhost:8080`) and `POST /boards`.

| Identity Google vouches for | Callback | Exchange | `POST /boards` |
|---|---|---|---|
| `ceo@example.com`, verified, hd `example.com` | 302 to `http://localhost:8080/#code=…` | 200, email and domain set | **201** |
| `CEO@Example.com` (mixed case), same hd | 302 | 200, email lower-cased | **201** |
| Same email, no `hd` | 302 | 200, email null, domain null | 403 |
| Same email, `email_verified: false` | 302 | 200, email null | 403 |

- **Origin:** `main.js:109` derives it from the redirect URI, so with the hand-off's env it is `http://localhost:8080`,
  the host the `__Host-` exchange cookie needs.
- **`localhost`:** a live `curl http://localhost:8080/` gave 200 via 127.0.0.1, and `/auth/login` gave 302.

The web strings the hand-off cites match `web/main.js:46-53`: "Sign in to Plenary", "Sign in with Google" and "No
board in this link". The `sessionStorage` key `plenary.session` holding JSON with `.token` matches
`web/core/signin.js:19,160`. The console snippet is consistent with both. I didn't render the page in a browser.

**(f) Stop and restart.**
- **Stop:** `kill 58672` logged `server stopped`, and 8080 was free.
- **Restart:** a second server on the same `$D` (PID recorded, then killed the same way) gave `welcome` as owner on
  the same board, so the board survives a restart.
- **Not done:** `rm -rf "$D"`. My sandbox refused it. The dir holds only placeholder data, under `/var/folders/…/T/`.

**Hand-off verdict:** clear enough for a non-expert.
- **Success** is stated end to end, and the failure causes are told apart by one log line.
- **Stop and clean-up** are given.
- **Gaps:** only L3 (Chrome's paste guard) and L4 (missing labels).
- **Still the CEO's step:** a stroke drawn in the web app surviving a reload. Nobody has verified it in a browser.

## Ensemble review (sdd)

Both reviewers got the same prompt and ran in scratch copies of the tree that had no `.env`.

| Harness | Result |
|---|---|
| **codex**, effort high | No findings |
| **agy** | Did not run: out of quota (429 `RESOURCE_EXHAUSTED`, resets in about 51 h) |
| **grok** (`check_adapter` ok), in agy's place | No findings |

- **No HIGH candidates:** nothing that two reviewers agreed on.
- **One refuted claim:** grok said "tests supply their own log". That is false; see L1.

## Systems design (CHECKER)

I loaded `systems-design:distributed-systems-design` v0.1.0 and ran its CHECKER checklist on sign-in in the real
server:

| Check | Result |
|---|---|
| **Stateless web tier** | Yes. Login state lives in a signed cookie; sessions verify offline by HMAC. Any gateway finishes any login if all share `COOKIE_KEY`, and cluster mode refuses to start without one. |
| **Rate limiting on public APIs** | **Missing** on `/auth/callback`. A known M8 item; this job only makes a flood visible in the log. |
| **Monitoring and logging** | Improved (one cause per failure), but the line bypasses `LOG_LEVEL` and `base` (L1). |
| **Consistency choice** | AP by design. Replay guards are per process; a replay on another node is stopped by Google's single-use code (callback) or the HttpOnly exchange cookie (exchange). Documented in `http.js`. |
| **Failure scenarios** | Google slow or down: `idp_timeout` or `idp_unreachable`, 400, server unharmed. Restart mid-login: finishes when `COOKIE_KEY` is set, else `bad_login_cookie`. |
| **10x load** | Callbacks scale with gateways. Each process's replay guard holds 100k states per 10 min and answers 503 when full. At the NFR of 100k joins in 2 min, one gateway would hit the cap only if nearly every join were a fresh sign-in landing on it. That is pre-existing, not from this change; worth a line in M4's load test. |
| **SPOF** | None added. Google itself is an external dependency by design. |

The builder's harness-vs-real-server table holds, with these checks:
- **Cookie key:** the only login state. Restarts and a second gateway are covered by `signin-cause.test.js` (same
  key finishes, a different key gives `bad_login_cookie`) and by my restart run.
- **Replay guards:** per process. This is a known, documented risk, unchanged here.
- **Callback rate limit:** none, so a log-line flood is possible. That is an M8 item, unchanged here.

## Not verified

- **The real Google login,** by design. The callback-success, exchange and email-claim path was verified only with
  the fake IdP through `start()`.
- **A stroke surviving a reload in a real browser.**
- **The `probeAuthorize` mid-body reset.**
- **Chrome's paste guard (L3)** on the CEO's profile.
- **Inputs may change:** `scripts/admin-bootstrap.js` (p5-devadmin2) and engine's pending `main.js` patch are still
  uncommitted. Re-walk (a) and (b) if they change.

## Secrets

- **Never printed or written:** no `.env` value, token, cookie, code or id_token appears in this report or in my
  scratch output. Login cookie values were redacted in the curl output.
- **Scan:** the final scan printed only counts. It loaded `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `COOKIE_KEY` in-process and checked them against this report, all three server logs, both gate outputs, the four
  scratch scripts and the review diff: 3 values, 11 files, **0 hits**.
