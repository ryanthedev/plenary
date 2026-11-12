# Brief: p5-google2 (Google sign-in against the real server, scripted up to the CEO's login)

docs/m2/BRIEF-BASE.md applies, including its Architecture line. Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-google2.md. Report only to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine
(t18m) or the CEO. Never pkill/killall; kill only PIDs you recorded. Do not commit. Stop at 60% context after
writing what you have. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

p5-google proved sign-in with the CEO's real OAuth client through a dev harness (scripts/dev-google.js; the CEO's
login PASSED 2026-11-12 04:44Z, docs/m2/reports/p5-google.md). The real server (`bun server/main.js`) now mounts the
same routes (server/main.js header, lines 16-22). This job proves the real server's sign-in as far as a script can
go, and writes the steps for the CEO's one login. **You stop before that login; you never log in yourself.**

## Secrets (hard rules, same as p5-google)

- **Never print, log, echo, commit or paste** the client id or secret, COOKIE_KEY or SESSION_KEY, or any session
  token: not in output, reports, test names, error messages or scratch files. Read them from `.env` in the process
  that needs them. No `cat .env`. Redact `client_id` in any URL you print (`<client-id>`).
- Nothing goes to any service other than Google's own OAuth endpoints, and only what a browser would send.
- server/main.js `start(env)` reads only its env argument: pass the values in-process; don't put them on a command
  line that `ps` shows.

## Do

1. **Live check against the real server** (a bun test under test/auth/, skipped unless `.env` has both keys and
   `PLENARY_LIVE_GOOGLE=1`; reuse helpers from test/auth/google-live.test.js where you can): start the real server
   via `start(env)` on 127.0.0.1:8080 (the redirect URI fixes the port; refuse if busy, check IPv4 and IPv6, see
   p5-googlev LOW 2), data dir in a temp folder, dev tokens off. Check:
   - `GET /auth/login` gives the 302 to Google with every parameter p5-google checked (client id compared as a
     boolean only); the login cookie is HttpOnly, SameSite=Lax.
   - Following it once with a plain GET reaches Google's sign-in page, not an error marker.
   - A **wrong-secret control** (p5-googlev LOW 4): the token endpoint gives `invalid_client` with a wrong secret
     and `invalid_grant` with the right one and a bogus code, through our callback; no crash, nothing secret in the
     response or the server's logs (capture them and scan against `.env` values without printing them).
   - A WebSocket hello with no or a bad token is refused (the real gateway, not a stub).
2. **p5-googlev leftovers** in files you own: LOW 1 (a failed callback logs its cause, e.g. `invalid_grant`,
   `bad_aud`, `bad_nonce`, `bad_iss`, never a token or code) in server/auth/http.js with tests; LOW 3 (doubled
   "dev-google:" prefix) and the new LOW (`probeAuthorize` reads `g.text()` outside `safeFetch`) if still present.
   Check each against the current code first; say which were already fixed.
3. **Hand-off for the CEO's login** (in your report, a section headed "Hand-off: the CEO's login"): exact commands to
   (a) make the CEO's tenant with scripts/admin-bootstrap.js (the CEO's Workspace domain and email are placeholders
   `<domain>` / `<email>`; do not guess them), (b) start the real server with Google on and dev tokens off,
   (c) the URL to open, (d) what success looks like end to end: signed in, `POST /boards` as the tenant admin, the
   board opens in the web app and a stroke survives a reload, (e) failure causes and what each means (using the
   LOW 1 log lines), (f) how to stop the server and remove the temp data. Run every step yourself up to, not
   including, the Google login (e.g. the tenant creation against a scratch data dir), and say which you ran.
4. **Systems design:** apply `distributed-systems-design` (APPLIER) briefly to what changes between the harness and
   the real server (cookie/session keys from env, restart mid-login, two gateways); note which tests cover it.

## Files you own

server/auth/http.js, server/auth/oidc.js, scripts/dev-google.js, test/auth/google-live*.test.js, new files under
test/auth/, docs/m2/reports/p5-google2.md. **Not** server/main.js, server/gateway.js, server/auth/port.js or
server/registry/* (engine's pending p5-load patch changes them), and not server/admin/ or scripts/admin-bootstrap.js
(p5-devadmin2 runs at the same time). Need a change there? Write it in your report.

## Done when

The live check passes against the real server and Google; the normal `bun test` is unaffected (known unrelated:
test/core-source.test.js); a scripted scan finds neither secret in `git diff`, new files or your report; the CEO
hand-off is written and every step before the login has been run. Then stop and leave the session idle.
