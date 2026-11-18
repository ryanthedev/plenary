# Review: tryit round 2 (c9f83cb, base 51244be), independent

Worktree `/Users/r/loops/plenary/wt/tryit`, branch `plenary/tryit`. Reviewed `git diff 51244be..c9f83cb` (10 files)
against round 1's findings (`tryit-v.md`) and the coordinator's decision: the dev menu (`GET /auth/dev`, `?as=`) is on
only with at least one offerable dev user, a loopback bind host, a loopback Host header, Google not configured and the
gateway role; admin/domain tokens never listed; otherwise 404 and one warn line saying why; `{}`/`""`/unset/non-object
mean dev off. Nothing committed by the reviewer. Probes in the scratchpad (`tryv2-28114`); the one server I started
(port 8099, pid 32413) was stopped by pid and the three browser tabs I opened were closed.

## Executed results

- `bun test` (repo root, once): **1620 pass, 155 skip, 0 fail**, 1775 tests across 98 files, 244.2 s, exit 0. `test/server/dev-menu.test.js` + `static.test.js` also run 3 times alone: 32/0 each time.
- Probes through `start()` (scratchpad `name.test.js`, `probe2.test.js`; raw TCP for Host headers).
- README "Try it", run word for word on port 8099 in headless Chrome:
  - Log: `dev sign-in menu is ON: GET /auth/dev publishes the tokens … {users:2, host:127.0.0.1}`, then
    `dev tokens are ON: not for production`, `server listening {port:8099, hostname:127.0.0.1}`. No token value in the log
    (`grep -c 'dev-ada\|dev-bo'` = 0; `devTokens` is shown `[redacted]`).
  - `/?as=ada` and `/?as=bo`: no gate, pill "Live", avatars A and B, `👁 0 viewers`, session `dev-bo`/`dev:bo` in
    sessionStorage, favicon `/favicon.svg` served.
  - Drew an ellipse in bo's tab: ada's tab shows it with "bo selected" and bo's cursor. **Sync confirmed.**
  - `/` with no `?as=`: "Dev sign-in is on: pick a user." with `Continue as ada (owner)` / `Continue as bo (editor)`, and
    **no** Google button (round 1's L5 fixed).
  - `curl 127.0.0.1:8099/auth/dev` → 200; with `Host: evil.example:8099` → 404.

## Round 1 findings

| # | Round 1 | Now |
|---|---|---|
| M1 | `{}` mounts the route; off-configs untested | **Fixed.** main.js:287 makes `{}` off; dev-menu.test.js has one 404 case each for unset, `""`, `{}`, `[1,2]`, Google only, Google+dev, HOST=0.0.0.0+dev. |
| M2 | every token, admin included, published; 0.0.0.0 accepted; no loud log | **Partly fixed.** HOST/Google/gateway gate and the loud ON/OFF lines are in (main.js:370-381). Admin *tokens* are skipped, but admin *identities* still leak: H1 below. |
| L1 | DNS rebinding | **Fixed** for browsers: http.js:356 answers only for Host in {127.0.0.1, ::1, [::1], localhost} (probes below). |
| L2, L3 | stale web/main.js comments | Fixed (web/main.js:4-5, 43-45). |
| L4 | menu role ≠ granted role | Fixed (main.js:373 uses `best`); tested (bo shown editor). |
| L5 | dead Google button | Fixed (web/main.js:72, seen live). |
| L6 | README port mismatch | Fixed (README.md:148 says to start the Try it server on 8099). |

## Probes

HOST env (dev tokens on, loopback fetch):

| HOST | /auth/dev | Log |
|---|---|---|
| `0.0.0.0`, `::`, `127.1`, `::ffff:127.0.0.1` | 404 | warn "… menu (GET /auth/dev) is OFF: HOST=… is not a loopback address" |
| `127.0.0.1 `, ` 127.0.0.1` (whitespace), `127.0.0.2` | start() throws (getaddrinfo / bind) | n/a |
| `LOCALHOST`, `::1`, `[::1]` | 200 (loopback) | warn "menu is ON" |

Host header (raw TCP to a 127.0.0.1 server with the menu on):

| Host | Result |
|---|---|
| `localhost.evil.com`, `127.0.0.1.nip.io:<p>`, `localhost.`, `127.1`, `[::ffff:127.0.0.1]`, two Host headers (either order), `X-Forwarded-Host: localhost` with `Host: evil.com`, absolute URI `http://localhost/…` with `Host: evil.com` | 404 |
| `LOCALHOST`, `[::1]:<p>`, `localhost<TAB>` | 200 (all loopback names; correct) |
| absolute URI `http://evil.com/auth/dev` with `Host: localhost` | 200: the check reads the Host header, not the request line. Not reachable from a browser (a rebinding page cannot choose the Host header), so not a finding. |
| empty `Host:`, bare `::1`, `evil@localhost`, `localhost:99999`, HTTP/1.0 with no Host | **500** plus an error log line with stack, from server.js:46 `new URL(req.url)`: pre-existing, not from this change; TECH-DEBT.md row 14. |

Google partly configured (only `GOOGLE_CLIENT_ID`, or only `GOOGLE_CLIENT_SECRET`) with dev tokens on loopback: menu
**ON** (200). main.js:318 builds Google only when both halves are set, so this matches "Google not configured", but no
line warns about the half-set client: L2.

Is `devMenuOff` the only gate? Yes, for the route: `config.devSignIn` is set only when it returns null (main.js:376-380,
394), and http.js:351 also requires `dev.enabled`. `?as=` has no server side: the page signs in only with a token from
`/auth/dev` (web/main.js). A client can still send a known dev token in `hello` on any dev-token server (HOST=0.0.0.0,
Google on): that is the pre-existing dev-token behaviour, and this change makes nothing worse; it narrows who can
*learn* tokens.

## Findings

### HIGH

**H1. An admin or domain identity is still published when the same name also has a plain token.**
- main.js:370-374 skips a token flagged `admin`/`domain`, but identity is per name: dev.js:21 makes every token for
  name X the user `dev:X`, and main.js:357-366 makes `dev:X` an admin of X's domain tenant. So
  `{"SECRET-ADM":{"name":"ann","domain":"acme.test","admin":true},"SECRET-PLAIN":{"name":"ann","role":"editor"}}` gives
  - `GET /auth/dev` → `{"users":[{"name":"ann","token":"SECRET-PLAIN","role":"editor"}]}` with the warn "menu is ON";
  - with `SECRET-PLAIN`: `GET /boards/<acme board>/links` → 200, and `PUT /boards/<acme board ann does not own>/grants/dev%3Amallory {"role":"owner"}`
    → **204**, `registry.grant` = `owner`. That is tenant-admin power, reached with a published token.
  - (`POST /boards` with the plain token → 403, because tenancy takes the tenant from the token's domain; the board-level
    admin routes do not.)
- The decision says admin/domain tokens are never listed; the README (Try it, line 36-37, and line 149) and
  deploy/README.md say the same and so imply admin powers are never published. Reach is limited to pages on this
  machine's loopback names, but on that path the guarantee does not hold. dev-menu.test.js's admin test uses distinct
  names, so it does not catch this.
- Fix: collect every name that appears on any token with `admin === true` or a `domain`, and exclude those names (all
  their tokens) from `offered`. Add a dev-menu.test.js case with one name on both an admin and a plain token, expecting
  that name absent (and 404 if no one is left).

### MEDIUM

None.

### LOW

**L1. A loopback-bound server behind a reverse proxy can still publish the menu.** nginx's default
`proxy_set_header Host $proxy_host` sends `Host: 127.0.0.1:<port>` upstream, which passes the Host check. A dev-token,
Google-less server bound to 127.0.0.1 behind such a proxy serves `/auth/dev` to the internet. This sits inside the
decision's rule (loopback bind + loopback Host) and deploy/README.md already says never to set dev tokens on a reachable
server, but neither README mentions proxies. Suggest one sentence there, or turning the menu off when `PUBLIC_URL` is a
non-loopback origin.

**L2. A half-configured Google client is silent.** Only one of `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` set: Google
is off (main.js:318), the dev menu is on, and the only hint is `sign-in {google:false}` at info. A warn for "one half
set" would catch the typo. Behaviour itself matches the decision.

**L3. The host-only node logs at info, not warn.** main.js:324: `dev tokens are set but this node has no gateway`. The
decision asks for one warn line saying why. Such a node serves no `/auth/dev` at all (server.js: host-only answers
only `/health`), so this is wording. `devMenuOff`'s gateway branch is unreachable from `start()` because of that
earlier branch; it is tested directly.

**L4. TECH-DEBT.md rows 12 (stale deploy/README) and 13 (favicon) are fixed by c9f83cb** but still say OPEN; the rules
ask the fixer to mark them `FIXED <commit>`.

**L5. A test binds 0.0.0.0.** dev-menu.test.js "HOST=0.0.0.0 plus dev tokens" listens on all interfaces for the length
of the test (with real dev tokens accepted on `hello`). Harmless on a dev box; a CI runner on a shared network would
briefly expose it. Could use a stub/`hostname` injection, or `::` on a non-routed interface. Note only.

## Not findings (checked)

- No token value in any log line: probed with `SECRET-*` tokens across every HOST case and the same-name case
  (`/SECRET/` never in the log), and the live Try it log.
- The ON warn line names `/auth/dev`, user count and bind host (tested in dev-menu.test.js and seen live).
- `{}`, `""`, unset, `[1,2]` → dev off, no menu warn (tested). `{"x":null}` makes `start()` throw in dev.js:13
  (pre-existing: every entry needs a name).
- No `Access-Control-Allow-Origin` on `/auth/dev`; the Host check covers rebinding.

## Verdict

**FAIL** on H1: a name that holds an admin/domain token is still published through its plain token, and that token
acts with the tenant-admin rights (demonstrated: owner grant to a new user on a tenant board the user does not own).
Everything else from round 1 is fixed, the suite is green and the README Try it works word for word. Fix H1 with a
test; L1-L5 are small and can ride along.
