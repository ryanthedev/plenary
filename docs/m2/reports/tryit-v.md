# Review: tryit (51244be, base bc7d5ca), independent

Worktree `/Users/r/loops/plenary/wt/tryit`, branch `plenary/tryit`. Reviewed `git diff bc7d5ca..51244be` (15 files).
Nothing committed by the reviewer. Probes in the scratchpad (`tryv-89451`). All servers I started (ports 8097,
8098, 8099) were stopped by their recorded pids; the browser tabs I opened were closed.

## Executed results

- `bun test` (repo root, once): **1611 pass, 155 skip, 0 fail**, 1766 tests across 98 files, 239.7 s.
  This includes `test/architecture.test.js`, `test/web/architecture.test.js`, `test/server/dev-menu.test.js`,
  `test/web/adapters/devconfig.test.js`, `test/web/gate.test.js`, `test/web/core/signin.test.js` and `test/web/collab/ui.test.js`.
- README "Try it", run word for word on port 8099 in headless Chrome (oberskills mcp-browser):
  - Startup log: `warn dev tokens are ON: not for production {board, users:2}`, `server listening {port:8099, hostname:127.0.0.1}`.
  - Tab 1 `http://localhost:8099/?as=ada`: no gate, pill "Live", `👁 0 viewers`, session `{token:"dev-ada", user:"dev:ada"}` in sessionStorage.
  - Tab 2 `http://localhost:8099/?as=bo`: both avatars (A, B) shown, the dev board id in the toolbar.
  - Drew a rectangle in bo's tab (R, drag). Screenshot of ada's tab shows the same rectangle with "bo selected" and bo's cursor. **Sync confirmed.**
  - Tab 3 `http://localhost:8099/` (no `?as=`): gate "Dev sign-in is on: pick a user, or sign in with Google." with
    buttons `?board=<devboard>&as=ada` "Continue as ada (owner)" and `…&as=bo` "Continue as bo (editor)".
- Dev off (port 8098, no `PLENARY_DEV_TOKENS`), `/?as=ada`: Google-only gate, only `/auth/login`, no session stored.
- Viewer through the menu (port 8097, tokens ada=owner, vic=viewer): browser `/?as=vic` shows pill "View only" and
  `👁 1 viewer`. A raw socket using vic's token **as read from GET /auth/dev**, sending a valid op: `welcome:viewer | here | error:forbidden`.
  The role comes from the server (gateway.js:1008-1012), not from the page.
- Production-like configs, probed in-process through `start()` (scratchpad `probe.test.js`, 9/9 ran):

| PLENARY_DEV_TOKENS / env | GET /auth/dev | Startup log |
|---|---|---|
| unset | 404 | "dev tokens are off and Google sign-in is not configured" |
| `""` | 404 | same |
| `null`, `"x"`, `[1,2]` | 404 | error "is not a JSON object; dev tokens stay off" |
| Google only (`GOOGLE_CLIENT_ID/SECRET`) | 404 | "dev tokens are off: sign-in is Google only" |
| `{}` | **200** `{"board":"b-…","users":[]}` | warn "dev tokens are ON: not for production" |
| Google + dev token `{name:ann, role:owner, domain:"acme.com", admin:true}` | **200**, lists `"token":"t1"` | "dev tenant", "dev tokens are ON" |
| `HOST=0.0.0.0` + dev | **200**, tokens listed, listening on all interfaces | only the generic "dev tokens are ON" |

  No `Access-Control-Allow-Origin` header on any answer (CORS is closed). The server ignores the `Host` header:
  `curl -H "Host: attacker.example:8099" localhost:8099/auth/dev` returned the tokens.
  A host-only cluster node gets no route (main.js:307 makes no dev board without the gateway role, so `config.devSignIn`
  is never set). A gateway node in cluster mode does get it. I read this in the code; I did not run it, because there
  is no Postgres or NATS here.

## Requirements

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Dev sign-in via `?as=` and the sign-in screen, only with PLENARY_DEV_TOKENS, learned from GET /auth/dev, impossible when off | **PASS** (with the findings below) | http.js:350-352 mounts the route only when `dev.enabled === true && config.devSignIn`; main.js:363-372 sets `devSignIn` only when there is a dev board; web/main.js:457-459 signs in only through `menuSignIn` with the server's menu (signin.js:393-401 returns null without a menu). Tests: dev-menu.test.js (on, off, `[1,2]`), signin.test.js `menuSignIn` block, devconfig.test.js. Run live as above. |
| 2 | "0 watching" becomes "N viewers" | **PASS** | ui.js:108-110, with singular and plural. ui.test.js checks "0 viewers", "1 viewer" and "12,408 viewers". Seen live: "👁 0 viewers", "👁 1 viewer". |
| 3 | README rewritten, with a Try it section | **PASS** | The steps work word for word (above). The Status and layout tables match the tree. |
| 4 | Hexagonal architecture kept | **PASS** | web/ports/devconfig.js imports nothing; web/adapters/auth/devconfig.js imports nothing (fetch and timers are injected); core/signin.js gains only pure functions. Both architecture suites pass in the full run. |

## Findings

### MEDIUM

**M1. No test proves "off" for most production-like configs, and `{}` still mounts the route.**
- test/server/dev-menu.test.js:79-91 covers only "unset" and `[1,2]`. Nothing covers `PLENARY_DEV_TOKENS=""` (the
  compose files' default, `${PLENARY_DEV_TOKENS:-}`), Google configured without dev, a node without the gateway role
  (cluster, `PLENARY_ROLES=host`), or `{}`. My probe shows that all of these behave correctly today except `{}`. The
  brief asks for a test of each, and without one a regression in main.js:268 (`if (env.PLENARY_DEV_TOKENS)`) or in
  the `roles.gateway` branch would go unnoticed.
- `PLENARY_DEV_TOKENS='{}'` turns the dev verifier on (dev.js:9: an empty object passes). It also creates a dev board
  and serves `GET /auth/dev` → 200 `{"board":"b-…","users":[]}`. The page shows no buttons (devconfig.js:301 returns null
  when there are no users), but the route exists and gives out the dev board id. deploy/README.md:37 says
  "Unset or empty = off", and an operator would read `{}` as empty.
- Fix: in main.js, treat a token object with no usable entries as off, or at least mount no route when `users` is
  empty. Add one `dev-menu.test.js` case each for `""`, `{}`, Google-only and, through `nodeConfig`/`start` with a
  stub cluster, a gateway-less node. All of them should expect 404.

**M2. The server publishes every dev token, admin tokens included, to anyone who can reach it, and the operator is warned only by the old generic line.**
- http.js:350-352 and main.js:364-371 list every token, including tokens flagged `admin:true` with a `domain`.
  main.js:340-348 makes such a token a **tenant admin of that domain**. In the probe "Google + dev token for
  acme.com", an unauthenticated GET /auth/dev returned the admin token for the acme.com tenant, which is also the
  tenant of that domain's Google users. `HOST=0.0.0.0` is accepted with no extra warning, and the Docker image sets
  HOST=0.0.0.0 (deploy/Dockerfile:35).
- Before this change, a dev token was a bearer secret that only its holder knew. deploy/README.md:51-56 still says to
  "make up your own token strings" (`<a-long-random-token>`), which suggests secrecy protects them. Now any client
  can read them.
- What the operator is told: the root README's Try it section says it in bold ("Anyone who can reach the port can
  read the dev tokens"). The startup log only repeats the old `dev tokens are ON: not for production` (main.js:351)
  and never mentions /auth/dev or the published tokens. deploy/README.md was not updated. The http.js:352 comment
  says "main.js logs a warning", but that warning is the old one.
- Fix (any of these, in rough order of strength): log a loud warn line that names `GET /auth/dev` and says it
  publishes N tokens (M of them admin), plus the bind host. Refuse, or at least warn, when dev tokens are on with a
  non-loopback HOST or with Google configured. Drop `admin`/`domain` tokens from the menu. Update deploy/README.md's
  dev-token paragraph.

### LOW

**L1. A DNS rebinding attack can read /auth/dev even on 127.0.0.1.** The server ignores `Host` (probe above), so any
web page a developer visits while the dev server runs can rebind its name to 127.0.0.1 and read every dev token.
"Keep the default HOST=127.0.0.1" (README Try it) does not fully protect them. Fix: answer /auth/dev only when `Host`
is `localhost`, `127.0.0.1`, `[::1]` or the configured PUBLIC_URL host.

**L2. Stale header comment.** web/main.js:4-5 still says "No dev rooms, no dev users, no ?as= here". Lines 7-10 and
the code now do `?as=` through the server menu. The comment should say that `?as=` exists here only through
`GET /auth/dev`.

**L3. The comment over-claims "a signed-in tab skips the request".** web/main.js:452-453 says so, but `devBoard()`
(web/main.js:469) still calls `devMenu()` whenever a signed-in tab has no `?board=`. On a production server that is
one extra 404 per board-less load. It is harmless, but the comment is wrong.

**L4. The role shown in the menu can differ from the real role.** main.js:366-370 keeps the *first* token per name
and its role. main.js:324-329 grants the *highest* role across that name's tokens. With `{"t1":{name:"bo",role:"viewer"},"t2":{name:"bo",role:"editor"}}`
the button reads "bo (viewer)", but bo joins as editor. The port says the role is for display only
(web/ports/devconfig.js:7-8), so this affects the label only.

**L5. A dead button when Google is off.** The dev gate always shows "Sign in with Google" (web/main.js:482). Without
GOOGLE_CLIENT_ID/SECRET that link answers 503, as it did before this change. The README's Try it section starts a
server without Google, so a first-time user will see a button that does not work.

**L6. A port mismatch in the README.** "Run the server locally" uses `PORT=0`, but the next section's curl
(`Creating a tenant`) is hard-coded to `http://localhost:8099`. That port is right for Try it and wrong for `PORT=0`.

## Not findings (checked)

- CORS: GET /auth/dev sends no ACAO header, so another origin cannot read it (outside the DNS rebinding case in L1).
- The adapter (devconfig.js) checks the server's answer strictly: the board regex, the name regex, token
  whitespace, at most 100 users, a timeout with the timer cleared, and null on any failure. Tests cover each.
- The gate builds its text only through textContent, and gate.test.js checks this with an HTML payload.
- After `?as=`, a tab sends the same `hello` with a dev token as before. Roles come from the Registry at the gateway,
  and a viewer's op is refused `forbidden` (seen live).

## Verdict

**FAIL.** Requirements 1-4 hold, and the suite and the README walkthrough pass. The FAIL is for the two asked-for
security points: M1 (there is no test of "off" for the empty-string, Google-only and gateway-less configs, and `{}`
mounts the route) and M2 (admin dev tokens are published unauthenticated with no specific startup warning, and
deploy/README.md still treats tokens as secrets). L1-L6 should be fixed in the same round. No unrelated tech debt was
found, so nothing was added to TECH-DEBT.md.
