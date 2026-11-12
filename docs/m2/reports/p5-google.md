# Report: p5-google (real Google sign-in, scripted up to Google's redirect)

**Result: PASS.** Every scripted check passes against Google's real endpoints with the Omniping client. A human
login is the only step left (hand-off below). Not committed.

## What changed (files)

| File | What |
|---|---|
| `scripts/dev-google.js` (new) | Dev harness. Says at the top it is a composition root for a local check, not the product server. Composes `httpRoutes` + `googleOidc` (real `fetch`) + `sessions` (random key per run) + in-memory Registry + `tenancy` from env. Serves 127.0.0.1:8080. Refuses to start if anything answers on 8080 (IPv4 or IPv6). Prints its PID. Adds `/` (sign-in link), `/signed-in` (postLoginUrl; shows only "signed in as <email>") and `/whoami` (Bearer → `{ email }`, decoded server-side). Logs method, path (no query) and status only; on `/auth/callback` also `loginCookie: true|false` (presence only). |
| `test/auth/google-live.test.js` (new) | The live check. Skipped unless `PLENARY_LIVE_GOOGLE=1` and `.env` has both keys. |
| `docs/m2/reports/p5-google.md` | This report. |

**Why `scripts/` and not `server/auth/`:** `test/auth/architecture.test.js` classifies every file in `server/auth`
and allows only `server/main.js` to import adapters. A harness in `server/auth` would fail that test (or need an
edit to a file I don't own). The brief allowed `scripts/`.

## Checks run, and what they showed

`PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live.test.js`: **7 pass, 0 fail**.

| Check | Result |
|---|---|
| `GET /auth/login` | 302 to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, the client id (compared, never printed), `redirect_uri=http://localhost:8080/auth/callback` exactly, `scope=openid email profile`, `state`, `nonce`, `code_challenge` (43 chars) and `code_challenge_method=S256`. Cookie `__Host-plen_login=l1.…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`. |
| Follow it once, plain GET, no cookies | **200 at `https://accounts.google.com/v3/signin/identifier`** (Google's account chooser). No error markers. |
| Negative control | Same check with `redirect_uri` changed to port 8081 gives `/signin/oauth/error` + `redirect_uri_mismatch`. A bogus client id gives `invalid_client` (manual probe). Google's error pages also answer **200**, so the check keys on the final path plus error markers, not the status code. |
| Discovery | `issuer`, `authorization_endpoint`, `token_endpoint` and `jwks_uri` equal our `GOOGLE` constants. RS256 and S256 are listed. |
| JWKS | 2 RSA keys. Each one imports through our `jwksCache`; an unknown kid gives null. |
| Callback, bogus code + valid state | Google's token endpoint answers **400 `invalid_grant`** (seen through a spy `fetch`). We answer 400 `{"error":"login-failed"}`, clear the login cookie, send no redirect, and the harness stays up. Neither secret appears in the response, its headers or the logs. No query string is logged. |
| `/whoami` and `/signed-in` | A session token decodes to `{ email }` server-side. A forged token gets 401. The page HTML holds no token. |
| CLI on the real port | `bun scripts/dev-google.js` serves `/` 200 and `/auth/login` 302 on 8080. A second instance exits 1 ("something already answers on port 8080"). Stopped with `kill <recorded PID>`; 8080 free afterwards. Its stderr log holds neither secret. |
| Real browser keeps the login cookie | Chrome (via Claude in Chrome), harness on 8080: on `http://localhost:8080/`, `isSecureContext` is true; `fetch("/auth/login")` then `fetch("/auth/callback?state=x&code=y")` gave 400 `login-failed` (state mismatch, so nothing reached Google) and the harness logged **`loginCookie: true`**. So Chrome stores and returns the `__Host-` `Secure` cookie on `http://localhost`, and `localhost` reached the 127.0.0.1-bound harness. Same-origin fetch, not Google's cross-site top-level redirect back; `SameSite=Lax` allows that top-level GET. |
| Normal suite | `bun test`: **376 pass, 78 skip, 0 fail** (454 tests, 27 files; the count moved between runs because other sessions are changing the tree). The live file shows 1 pass + skips without the flag. |
| Secret scan | See "Secrets" below. |

## Hand-off: the human login (for the CEO)

1. **Your Google account must be a listed test user.** The consent screen is External in Testing, so Google
   refuses anyone else ("access blocked" / "app has not completed verification"). Add it in Google Cloud console,
   Omniping project, *Google Auth Platform → Audience → Test users*, if it isn't there.
2. **Start the harness** from the repo root (it reads `.env` there):
   ```
   cd ~/repos/plenary && bun scripts/dev-google.js
   ```
   It prints `dev-google: pid <N>; open http://localhost:8080/`. If it says port 8080 is busy, stop whatever is on
   8080 first (the redirect URI fixes the port).
3. **Open `http://localhost:8080/` in Chrome** (verified to keep the login cookie; others untested). Use `localhost`, not `127.0.0.1`: Google only
   accepts the registered redirect URI. Avoid Safari for now (see risks: the login cookie is `Secure`).
4. **Click "Sign in with Google"**, pick the test account, and accept the consent screen ("unverified app"
   warning is expected in Testing; continue).
5. **Success looks like:** the browser lands on `http://localhost:8080/signed-in` and the page reads
   **"signed in as you@domain"**. The address bar shows no token (the page removes the fragment).
   A Workspace account on a secondary domain, or a non-Gmail consumer address, shows "(no Google-verified email;
   user google:…)": that is our authoritative-email rule, still a successful sign-in.
6. **Failure looks like:** a JSON page `{"error":"login-failed"}` at `/auth/callback`. Check the terminal's log
   line for `/auth/callback` first: `"loginCookie":false` means the browser dropped the login cookie (try Chrome);
   `true` means Google or the token check refused. Report it with the browser name.
7. **Stop the harness:** Ctrl-C in its terminal, or `kill <N>` with the PID it printed.

## Systems design (distributed-systems-design v0.1.0, APPLIER, brief)

**Scope (assumptions from the confirmed NFRs in CLAUDE.md, not re-asked):** sign-in for 100k viewers per board,
**100k joins in 2 min**; editors < 150 ms; an outage must not lose acknowledged ops (sign-in holds none). Sign-in
runs on every gateway; login state lives in a signed cookie, so any gateway can finish any flow.

**Estimate:** if every join were a fresh sign-in, 100k / 120 s ≈ **830 sign-ins/s** at peak, each one token POST
to Google (a few hundred ms, external) plus a JWKS lookup from cache (≤ 1 refetch per 30 s per process). Most
joins reuse a 12 h session token, which verifies offline (HMAC), so the real sign-in rate should be far lower.
Replay-guard memory: 100k states × ~100 B ≈ 10 MB per process.

**Failure behaviour:**

| Failure | What happens | Covered by |
|---|---|---|
| **Google down or slow** | `begin()` makes no network call, so `/auth/login` still redirects (Google then fails in the browser). `finish()` times out at 10 s and gives `login-failed` (400). **Existing sessions keep working**: session tokens verify offline, so only new sign-ins stop. | `oidc.test.js` "M4" (JWKS and token timeouts), "a failed fetch refuses, then retries after 5 s"; `http.test.js` "state mismatch … IdP error" |
| **JWKS rotation** | Unknown kid triggers one refetch, spaced ≥ 30 s apart (5 s after a failure); keys expire at `max-age`, capped at 1 h, so a withdrawn key stops verifying. A failed fetch keeps the old keys. Concurrent cold lookups share one fetch. | `oidc.test.js` JWKS tests (cache by kid, cooldown, concurrent, max-age/withdrawn key, failed fetch). Live: today's keys import. |
| **Clock skew** | ID token `exp`/`iat` allow ± 60 s; `iat` older than a day is refused. The login cookie's 10 min expiry is checked on the gateway that finishes; seconds of skew between gateways only shortens or lengthens that window slightly. | `oidc.test.js` "refusals" (within skew, expired, future iat), "L6" |
| **Replayed callback** | Three guards: the per-process used-state set (400 on replay), the nonce bound to the login cookie, and Google's single-use code. Across gateways only the nonce + Google's code guard; the code's single use is Google's promise. | `http.test.js` "nonce … replayed callback is refused", replay-guard prune and cap tests. Live: Google refuses an unknown code (`invalid_grant`); a **replayed real code is not tested live** (needs a human login). |

**Top bottlenecks / risks found (not fixed; outside my files):**

1. **Replay-guard cap sits right at the NFR.** `http.js` keeps used states for 10 min with a 100k cap per process
   and fails closed (503) when full. 100k fresh sign-ins through one gateway in 2 min fill it exactly; retries
   push past it. Behind N gateways the load is 100k/N, so this only bites a single-gateway deployment. Suggest
   (platform's call): size the cap from the join NFR, or drop each entry when its login cookie would have expired
   anyway (it already does) and add a metric for "full".
2. **Google's token endpoint is a per-login dependency** at up to ~830/s. Google's quota for this client is
   unverified. The M4 load test should measure fresh-sign-in rate separately from rejoin rate.
3. **No monitoring yet** on sign-in outcomes (login-failed by cause, JWKS fetch failures, replay-guard size).
   Worth adding when the real server mounts these routes (p2-swap).

## Secrets

- Never printed: every check compares the client id and secret in-process. URLs that carry the client id are
  reported as origin + path only, or with `client_id=<client-id>`.
- **Scan:** a script reads both values from `.env` in-process and searches every tracked and untracked file
  (`git grep --untracked`, which honours `.gitignore`, so `.env` itself is excluded) plus this report and the
  harness log. Result recorded in the final section.

## What I did NOT verify

- **A real login** (by design; the CEO does it). So the ID-token signature, `aud`, `nonce` and email rules have
  only been checked against the fake IdP, not a real Google token.
- **Safari and Firefox with the `__Host-` cookie on `http://localhost`.** Verified in Chrome only (above). Safari
  has historically refused `Secure` cookies on plain http; if it drops the cookie the log shows
  `loginCookie: false` and the callback answers `login-failed`.
- **Google's cross-site redirect back** to the callback in a browser (needs the human login); the cookie test used
  a same-origin fetch.
- **Replay of a real code at Google**, and Google's rate limits for this client.

## Secret scan result

2026-11-11, after all files above were final: **0 hits** for the client id, the secret and `COOKIE_KEY` across
every tracked + untracked repo file (this report, the harness and the test included) plus the scratch
files (probes and both harness logs), rerun after the last edit to any of them. `.env` is git-ignored (`git check-ignore`). The scan printed only counts.

## Fix round

From manager platform (t187), after p5-googlev PASS: **MEDIUM 1 fixed.** MEDIUM 2 (`http.js`) belongs to another
job, so `http.js` is untouched.

**The leak:** when `fetch` throws (offline, DNS, TLS, refused), Bun's error carries the full URL, and `bun test`
prints it. The live test's two authorization-URL fetches would have printed `client_id=…` unredacted.

**Changes:**

| File | What |
|---|---|
| `scripts/dev-google.js` | New `safeFetch`: on a thrown error it rethrows `new Error("google unreachable: <code>")`, where code is the error's `code` or `name`, charset-checked, else `error`. It has no `cause` and no URL. New `probeAuthorize(url)`: follows an authorization URL with `safeFetch`, returns status, origin + path, and the error markers found. The harness now defaults to `safeFetch` for `googleOidc`. Its other outbound fetch, the port check in `answers()`, already swallows errors and returns false. |
| `test/auth/google-live.test.js` | Every Google fetch now goes through `safeFetch`: the sign-in probe, the control, discovery, the JWKS, `jwksCache`, and the token-endpoint spy. The two authorization-URL checks use `probeAuthorize`. **New always-run block** (no network to Google): a child `bun` process runs `probeAuthorize` against an unreachable host with a **sentinel client id** and lets the error go uncaught, and the test reads all of its stdout and stderr. Two hosts: `127.0.0.1:9` (refused) and `plenary-unreachable.invalid` (no such host). It asserts `google unreachable:` appears, and that the sentinel, the host and the real client id or secret do not. **Control:** the same child with raw `fetch` *does* print the sentinel, for both hosts, so the test can catch a regression. |

**Checks:**
- **Normal run** (`bun test test/auth/google-live.test.js`): 5 pass, 8 skip, 0 fail. The 4 new tests and their controls run without the flag.
- **Live run** (`PLENARY_LIVE_GOOGLE=1`): 11 pass, 0 fail. Same Google answers as before: `/v3/signin/identifier`, the control gives `redirect_uri_mismatch`, 2 keys import, the token endpoint gives `invalid_grant`.
- **Full `bun test`:** 478 pass, 78 skip, 0 fail (556 tests, 32 files). One earlier full run had 1 fail: `http.test.js` "replay guard: pruning visits O(1) entries…". `server/auth/http.js` was being changed by another session at that moment (mtime 22:06:30, during my run). The file passed 22/22 three times in isolation, and the next full run had no fail. I didn't touch either file. If that test fails again, it belongs to the MEDIUM 2 job.
- **Secret scan, rerun after the last edit:** 0 hits for the client id, the secret and `COOKIE_KEY` across 333 files (327 tracked + untracked, 6 scratch). Only counts were printed.

**Not verified:** a real outage while the harness serves a browser login. It is covered indirectly: `googleOidc.finish` already swallows thrown fetches (p5-googlev's injected-throw check), and it now receives `safeFetch` errors, which hold no URL.
