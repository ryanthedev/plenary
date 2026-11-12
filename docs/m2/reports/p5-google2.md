# Report: p5-google2 (Google sign-in against the real server, scripted up to the CEO's login)

**Result: PASS.** The real server (`server/main.js` `start(env)` on 127.0.0.1:8080, dev tokens off) passes every
scripted check against Google's real endpoints. A failed callback now logs why it failed. Every hand-off step before
the Google login has been run against a scratch data dir. Nobody logged in. Not committed.

## What changed (files)

| File | What |
|---|---|
| `server/auth/oidc.js` | `finish({ …, why })` and `verifyIdToken(…, { why })`: an optional callback hears **one fixed label** when sign-in is refused. New export `CAUSES` lists them all. The token endpoint's `error` is reported only if it is an RFC 6749 name, otherwise as `token_http_<status>`. Google's `error_description` and the response body are never read into a cause. `finish` still returns `Identity \| null`, so the IdP port contract is unchanged. |
| `server/auth/http.js` | New optional dep `log` (`{ warn }`). Every failed `/auth/callback` logs one line, `"sign-in failed" { cause }`. Causes are the IdP's label, or one of `SIGN_IN_CAUSES` (new export). Only label-shaped strings pass (1–4 lowercase words of ≤ 12 letters joined by `_`, optional `_<3 digits>`), so a state, nonce or code never can; anything else becomes `idp_refused`. If no logger is passed, the default writes one JSON line to stdout in `server/log.js`'s format. That is why the real server logs causes today, even though `main.js` passes no logger. |
| `scripts/dev-google.js` | LOW 3: no doubled prefix. New LOW: `probeAuthorize` reads the body inside a try that rethrows without the URL. LOW 2: new exports `listening(host, port)` and `portBusy(port)`, which use a raw TCP connect on 127.0.0.1 and ::1, so a silent listener counts as busy. The CLI uses `portBusy`. The harness passes its logger to `httpRoutes`. |
| `test/auth/signin-cause.test.js` (new) | 10 tests, fake IdP, no network (below). |
| `test/auth/port-busy.test.js` (new) | 3 tests for LOW 2: a silent listener on `::1` or `127.0.0.1` reads busy, then free once it stops. |
| `test/auth/google-live-server.test.js` (new) | The live check against the real server. Skipped unless `PLENARY_LIVE_GOOGLE=1` and `.env` has both keys. |
| `docs/m2/reports/p5-google2.md` | This report. |

## p5-googlev leftovers: status before this job, and now

| Finding | Status in the code before | Now |
|---|---|---|
| LOW 1: a failed callback logs no cause | **Still open.** `http.js` mapped every failure to a bare `login-failed`. | Fixed (oidc.js + http.js). Tested with a fake IdP and live. |
| LOW 2: a silent `[::1]:8080` listener didn't stop the harness | **Still open.** `answers()` was HTTP-only. | Fixed with a TCP probe. Tested in `port-busy.test.js`. |
| LOW 3: "dev-google: dev-google:" | **Still open.** | Fixed. |
| New LOW: `probeAuthorize` reads `g.text()` outside `safeFetch` | **Still open.** | Fixed. Not reproduced (it needs a reset mid-body). |
| LOW 4: wrong-secret control | Not done before. | Done live (below). |

## Live check against the real server

`PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live-server.test.js`: **9 pass, 0 fail**. Rerun after the last change to `http.js`: same answers, 9 pass.

**How it runs:**
- **Start:** `start(env)` in-process, with an env built in the test. It contains the client id and secret from `.env`, a random `COOKIE_KEY` and `SESSION_KEY` per run, a temp data dir, and no dev tokens or cluster settings. Nothing goes on a command line.
- **Port:** before starting, the test refuses if 8080 is taken on 127.0.0.1 or ::1.
- **Logs:** the server's stdout is captured, not echoed.

| Check | Result |
|---|---|
| Server up as intended | Log has `server listening` on 8080, `sign-in { google: true, cluster: false }`, and "dev tokens are off: sign-in is Google only". `devBoard` is null. (`devTokens` itself logs as `[redacted]`: `server/log.js` redacts any field whose key contains "token".) |
| `GET /auth/login` | 302 to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, the client id (compared as a boolean), `redirect_uri=http://localhost:8080/auth/callback`, `scope` with `openid`, `email` and `profile`, a 32-char `state` and `nonce`, a 43-char `code_challenge`, and `S256`. Cookie `__Host-plen_login=l1.…` with `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/` and `Max-Age=600`. |
| Follow it once (plain GET) | **200 at `https://accounts.google.com/v3/signin/identifier`**, with no error markers. |
| Right secret, bogus code, through our callback | Google's token endpoint: **400 `invalid_grant`**. We answer 400 `{"error":"login-failed"}`, clear the cookie and send no redirect. Log: **`sign-in failed { cause: "invalid_grant" }`**. `/health` is still 200. |
| **Wrong-secret control** (second start, random secret) | Google's token endpoint: **401 `invalid_client`**. Same 400 to the browser. Log: **`cause: "invalid_client"`**. No crash. Together with the row above, this proves the real secret is the one Google accepts. |
| WebSocket hello on the real gateway | **Setup:** a tenant made by `bootstrapTenant` with an email admin, then a session minted with the run's key. `POST /boards` gives 201. **Positive control:** a hello with that token gets `welcome`. **Refused** with `error auth` and close 1008: no token, an empty token, a forged `s1.x.y`, and a session signed with another key. |
| Secrets | **Values scanned:** the client id, the secret, `.env`'s `COOKIE_KEY`, the run's two keys, the wrong secret and the minted token. **Where:** the server's whole captured log (2131 chars) and 14 response parts. **Result: 0 hits.** The only exception is by OAuth's design: the client id is in the `/auth/login` `Location` header. That header was scanned for every other value (0 hits) and left out of the response scan. The bogus code never appears in the log. |
| Stop | `app.stop()` frees 8080 (checked with the TCP probe). |

**Also run:**
- **`PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live.test.js`** (the harness): 11 pass, 0 fail.
- **Normal `bun test`** (rerun after the last code change): 1292 pass, 147 skip, 1 fail (1440 tests, 76 files). The one fail is `test/core-source.test.js`, the known unrelated one (herdr-draw's `editor.js` hash drifted). Both live files skip without the flag.

## Tests added (`test/auth/signin-cause.test.js`, 10 tests, always run)

| Test | Covers |
|---|---|
| Before Google | `no_login_cookie`, `bad_login_cookie`, `idp_error:access_denied`, `idp_error` (an unknown `?error=` is not echoed), `state_mismatch`, `no_code`. None of them calls Google. |
| Token endpoint | `invalid_grant` and `invalid_client`, each with an `error_description` sentinel that never reaches the log. `token_http_401` for an unknown error name, `token_http_502` for HTML, `idp_unreachable` for a thrown fetch whose message holds a URL, `idp_timeout`, `bad_token`. |
| ID token | `bad_aud`, `bad_nonce`, `bad_iss`, `expired`, `unknown_kid`, `bad_alg`, `bad_sig`. Each also checks that the token, nonce and code are not in the log. |
| Success and replay | A success logs nothing. A replayed callback logs `state_used`. A full replay guard logs `replay_guard_full` (503). |
| Other adapters | An adapter that refuses without a cause logs `idp_refused`; one that throws logs `idp_threw`. |
| Label filter | A state-, nonce- or code-shaped string handed to `why` is never logged; it becomes `idp_refused`. http.js admits only 1–4 short lowercase words joined by `_`, optionally `_<3 digits>`. |
| Robustness | A throwing logger doesn't change the answer. A cause that isn't a plain label (`"Bearer s1.leaked…"`) is dropped and becomes `idp_refused`. |
| Default logger | Writes one JSON line to stdout: `{ level: "warn", msg, cause, time }`. |
| Lists match the code | Every `no("…")` in oidc.js is in `CAUSES`, and every `fail("…")` in http.js is in `SIGN_IN_CAUSES`. |
| **Restart mid-login / second gateway** | Login started on node A. A node with the same `cookieKey` finishes it (302 `#code=`). A node with a different key refuses with `bad_login_cookie`. |

Each assertion names its exact cause and also checks that the logged object has only `{ msg, cause }`.

## Hand-off: the CEO's login

`<domain>` is your Google Workspace domain and `<email>` your address on it. Run everything from the repo root:
Bun loads `.env` from there (the Google client and `COOKIE_KEY`). Use Chrome.

**Before you start:**
- **Test user:** your Google account must be a test user of the Omniping OAuth client (it was for the 2026-11-12 harness login).
- **Shell:** `PLENARY_DEV_TOKENS`, `DATABASE_URL` and `NATS_URL` must not be set in your shell. With `DATABASE_URL` set, the bootstrap writes your tenant to Postgres while the server (single node) reads SQLite, and `POST /boards` gives 403.

**(a) Make your tenant** in a fresh data dir:
```
cd ~/repos/plenary
D=$(mktemp -d -t plenary-ceo)
bun scripts/admin-bootstrap.js --domain <domain> --admin <email> --data-dir "$D"
```
- **Prints:** one line, `{"ok":true,"registry":"sqlite","tenant":"t-…","domain":"<domain>","created":true,"added":["email:<email>"],…}`.
- **Re-running** it changes nothing.
- **An email on another domain** is refused (exit 2).

**(b) Start the real server** with Google on and dev tokens off:
```
lsof -nP -iTCP:8080 -sTCP:LISTEN          # must print nothing: the redirect URI fixes port 8080
PLENARY_DATA_DIR="$D" bun server/main.js
```
Leave it in the foreground. Its log should show, in order:
- `"msg":"sign-in"` with `"google":true`
- `"msg":"dev tokens are off: sign-in is Google only"`
- `"msg":"server listening"` with `"port":8080`

There must be no "COOKIE_KEY is not set" warning; `.env` has one.

**(c) Open `http://localhost:8080/`** in Chrome.
- **Use `localhost`, not `127.0.0.1`.** Google accepts only the registered redirect URI.
- **What you see:** the gate "Sign in to Plenary". Click **Sign in with Google**, pick your account, and accept the consent screen. The "unverified app" warning is expected.

**(d) Success, end to end:**
1. **Back on `http://localhost:8080/`:** the gate now reads **"No board in this link"**. That means you are signed in; there is just no board yet. The address bar shows no code.
2. **Make a board as the tenant admin.** Open DevTools → Console and paste the snippet below. It reads the session from this tab's sessionStorage, sends it only to this server, and prints only the status and the board id. If Chrome refuses the paste and asks you to type `allow pasting`, type it, press Enter, then paste again (a Chrome safety check, not an error):
   ```js
   const s = JSON.parse(sessionStorage.getItem("plenary.session"));
   const r = await fetch("/boards", { method: "POST", headers: { authorization: "Bearer " + s.token, "content-type": "application/json" }, body: JSON.stringify({ title: "First board" }) });
   const j = await r.json(); console.log(r.status, j.board?.id ?? j.error);
   if (r.status === 201) location.assign("/?board=" + j.board.id);
   ```
   - **Expect:** `201 b-…`, then the board opens.
   - **`403 forbidden`** means the server didn't match you to the tenant's admin (see (e)).
3. **The board opens** with you as its owner. The server makes the creator the owner; the rehearsal saw `welcome` with role owner. How the web page shows that (status pill, avatar) is **unverified**: I didn't render it.
4. **Draw a stroke, then reload the tab.** Use the same tab: the session lives in that tab's sessionStorage, and a load with no `#code` reuses it (`takeSignIn` gives outcome `restored`; read in `web/core/signin.js`, not run in a browser). The stroke is still there.

**(e) If it fails:** the server prints one line, `{"level":"warn","msg":"sign-in failed","cause":"…"}`. The browser gets `{"error":"login-failed"}` at `/auth/callback`.

| `cause` | What it means | What to do |
|---|---|---|
| `no_login_cookie` | The browser didn't send the login cookie back | Use Chrome on `http://localhost:8080`, not 127.0.0.1 and not Safari. |
| `bad_login_cookie` | The cookie was signed with another key or is older than 10 min (for example, the server restarted with no `COOKIE_KEY`) | Start again from (c). |
| *(no line at all; Google shows its own error page, e.g. "Access blocked")* | Google refused before calling us back: usually the account isn't a test user, or a redirect URI mismatch | Add the account under Google Auth Platform → Audience → Test users; open `http://localhost:8080/` exactly. |
| `idp_error:access_denied` | You pressed Cancel on Google's consent screen | Start again from (c). |
| `state_mismatch`, `no_code`, `state_used` | The callback URL was altered, or reused (back button, double submit) | Start again from (c). |
| `invalid_grant` | Google refused the code: too old or already used | Start again from (c), without lingering. |
| `invalid_client` | The client id or secret in `.env` is wrong | Check `.env` (don't paste it anywhere). |
| `idp_timeout`, `idp_unreachable`, `token_http_<n>` | Google couldn't be reached, or answered oddly | Check the network and retry. |
| `bad_aud`, `bad_iss`, `bad_nonce`, `bad_sig`, `unknown_kid`, `expired`, `bad_time`, `stale` | Google's ID token failed a check | Shouldn't happen. Report the cause. |
| `replay_guard_full` (503) | Over 100k sign-ins in 10 min on one process | Not expected here. |

The exchange step can fail separately: the page says "sign-in failed (invalid-code)". That is the 60 s exchange window or a dropped exchange cookie. Sign in again.

If `POST /boards` gives **403 `forbidden`**, the admin match failed. Admin by email needs Google to vouch for `<email>`: your account's Workspace domain (`hd`) must equal the email's domain. A Workspace account whose address is on a secondary domain gets no email from us, so it can't match an email admin.

**(f) Stop and clean up:**
- **Stop:** Ctrl-C in the server's terminal. It logs `server stopped`. If you backgrounded it, run `kill <pid>` with the PID your shell printed.
- **Remove the data:** `rm -rf "$D"`.

### Which steps I ran myself (all before the Google login)

| Step | Run? | What happened |
|---|---|---|
| (a) | **Yes**, with `--domain example.com --admin ceo@example.com` in a scratch dir | `created: true`, `added: ["email:ceo@example.com"]`. The rerun gave `created: false`, `added: []`. `--admin ceo@other.com` exited 2 ("email admin is not on the tenant's domain"). |
| (b) | **Yes**: `PLENARY_DATA_DIR=<scratch> bun server/main.js`, PID 6498 recorded | The log showed the three lines above and no `COOKIE_KEY` warning. Probes: `/health` 200; `/` and `/?board=b-x` 200 HTML; `/auth/login` 302 to Google with `client_id=<client-id>`, `redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth%2Fcallback`, S256 and the `__Host-plen_login` cookie (HttpOnly, SameSite=Lax); a cookieless `/auth/callback` gave `login-failed` and logged `cause: "no_login_cookie"`; `POST /boards` without auth gave 401 `auth`. Stopped with `kill 6498`; logged `server stopped`; 8080 free. |
| (c) | **No.** `/` was fetched with curl (200 HTML), not rendered in a browser. I didn't open `/auth/login` in a browser. You consented already, so Google might redirect straight back with a real code, and that would be a login. | — |
| (d) | **Rehearsed without Google**, on the same scratch dir | **Setup:** in-process `start()`, random keys, a session for `ceo@example.com` / `example.com`. **Board:** `POST /boards` gave 201 on the CLI's tenant; a non-member gave 403 `forbidden`. **Join:** hello gave `welcome`, role **owner**. **Ops:** 3 board ops acked at seq 1–3. **After a full stop and start:** `welcome` at seq 3, and the catch-up snapshot is at seq 3. The ops were settings ops on the board stream, not strokes drawn in the web app. That last part is yours. |
| (e) | Partly | Every cause above is produced in `signin-cause.test.js`. `invalid_grant` and `invalid_client` were also produced live. |
| (f) | Server stopped (above) | The scratch dir is under the session scratchpad, not the repo. I didn't delete it (my sandbox refused an `rm -rf`). It holds only placeholder data. |

## Systems design (APPLIER, brief): harness vs real server

The `distributed-systems-design` skill file couldn't be found under `~/.claude/plugins` in this session. I applied its four steps (scope, estimate, design, failures) the same way p5-google did.

**Scope:**
- **NFRs (from CLAUDE.md):** 100k joins in 2 min; an acknowledged op is never lost (sign-in holds none).
- **What's new here:** sign-in runs inside the real server, so it can run on N gateways and survive restarts. The harness was one process with a random session key and an in-memory Registry.

**What changes:**

| Concern | Harness (`dev-google.js`) | Real server (`main.js`) | Covered by |
|---|---|---|---|
| **Keys** | Random session key per run. `COOKIE_KEY` from env if set. | Both from env. A missing `COOKIE_KEY` is random per process on one node (with a warning) and **refuses to start in cluster mode**. `SESSION_KEY` defaults to `COOKIE_KEY`. | `main.test.js` "COOKIE_KEY: refused when short; required in cluster mode; random … on a single node". Live: the run's own keys sign everything (the minted session joins; one with another key is refused). |
| **Restart mid-login** | All logins in flight die | With `COOKIE_KEY` set, a login started before a restart **finishes after it**: the only login state is the signed cookie. Without it, the callback fails `bad_login_cookie`, now logged. The per-process used-state set is lost on restart; Google's single-use code and the nonce still guard a replay. | `signin-cause.test.js` "restart mid-login / a second gateway" (same key: 302; other key: `bad_login_cookie`). Rehearsal (d): the Registry and ops survive a restart. |
| **Two gateways** | n/a | A login may start on gateway A and return to B; the exchange may land on C. All three need the same `COOKIE_KEY`. Sessions verify offline (HMAC), so a hello on any gateway works. Replay guards are per process (see risks). | Same test, plus `exchange.test.js` "across nodes: a second node … exchanges a code minted by the first". |
| **Registry** | In memory | SQLite (single node) or Postgres. Tenants from `admin-bootstrap.js` are visible to the server, and boards survive a restart. | Rehearsal (a)+(d); `main.test.js` durable-Registry tests. |
| **Observability** | One log line per request | No per-request log, but now `sign-in failed { cause }` per refusal. That is the "login-failed by cause" signal p5-googlev asked for. | `signin-cause.test.js`; live run. |

**Estimate (unchanged from p5-google):**
- **Fresh sign-ins:** at most about 830/s at peak if every join signed in fresh; most joins reuse a 12 h session.
- **Log volume:** one line per failed sign-in, so bounded by callback traffic. An anonymous flood of bogus callbacks makes log lines at Google's speed for the bogus-code path (it calls Google); the no-cookie path calls nothing but still writes one warn line per request (see risk 3).

**Risks found (not fixed; outside my files):**
1. **`main.js` should pass its logger to `httpRoutes`** (engine's file). Without it, the cause lines bypass `LOG_LEVEL` and the logger's `base` fields. Wording below.
2. **Cross-gateway replay window:** the used-state and used-code sets are per process. Behind N gateways, a callback or exchange replayed on another node within the TTL is guarded only by Google's single-use code (callback) or by needing the HttpOnly cookie (exchange). Already documented in `http.js`; unchanged here.
3. **No rate limit on `/auth/callback`** (p5-googlev's open M8 item). The new log line makes a flood visible but doesn't stop it. It also costs: every anonymous cookieless callback writes one warn line, and until `main.js` passes its logger those lines bypass `LOG_LEVEL`.

## Changes needed in files I don't own

- **`server/main.js` (engine):** in the `httpRoutes({ … })` call, add `log: log.child({ component: "auth" })`. Then sign-in causes go through the server's logger (`LOG_LEVEL`, redaction, base fields) instead of the default stdout writer. Until then the default writes the same JSON shape, so nothing is lost.
- **`server/auth/idp-port.js` (port doc):** mention that `finish` may receive an optional `why(cause)` that an adapter may call with a fixed label (oidc.js `CAUSES`), and that the port's return value is unchanged. The contract tests need no change (they pass).
- **`test/auth/architecture.test.js`:** no change needed (no new file under `server/auth`).

## What I did NOT verify

- **The real login** (by design), so the ID-token checks still have no live real-token run on the real server. The harness login of 2026-11-12 is the only real-token evidence.
- **A stroke drawn in the web app** surviving a reload. The rehearsal used protocol board ops over a raw socket; `main.test.js` covers ops surviving a restart.
- **The `probeAuthorize` body-read fix** under a real mid-body reset.
- **Inputs that changed during this job:** `scripts/admin-bootstrap.js` was changed by p5-devadmin2 mid-session, and engine's pending p5-load patch touches `server/main.js`. Steps (a) and (b), the rehearsal and the live check ran against the tree as of 2026-11-12 ~17:10Z. Rerun them after those land.
- **Two real gateways in cluster mode** (Postgres + NATS) doing a live Google login. Covered only by the two-node unit tests above.

## Secret scan

Final section, rerun after the last edit to any file. Result:

2026-11-12, after the last edit to every code and test file: **0 hits** for `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `COOKIE_KEY` (all 3 loaded from `.env` in-process) across 553 files. That is every tracked
and untracked repo file (this report as it stood before this paragraph, the new tests, oidc.js, http.js and
dev-google.js included), the full `git diff`, and the scratch files (the real server's log, the rehearsal script, the
full-suite output). This paragraph holds only counts and key names. `.env` is git-ignored. The scan printed only
counts. The live test separately scanned the per-run keys and the minted session token: 0 hits.
