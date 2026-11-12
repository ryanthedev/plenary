# Report: p8-readme2v (verify the README refresh)

**Verdict: PASS.** No HIGH finding, one MEDIUM, three LOW. Every "works today" claim matches committed main, every
link resolves, and every command runs as written.

- **README under check:** `README.md`, sha1 `dd8d22d6dd63a35749b16aa4e19e01837a890d96`. It is untracked and was
  not changed by this job.
- **Main checked:** HEAD 0b122c0, in a fresh clone in the scratchpad, so no uncommitted work, no `.env` and no
  `../herdr-draw`. The builder checked bc0bd63; the only change since then is one line in `docs/m2/COMMITMENTS.md`.
- **Full test run:** `bun install --frozen-lockfile` then `bun test` (Bun 1.4.4) gave **884 pass, 80 skip, 0 fail**
  across 52 files.

## MEDIUM

1. **Google sign-in with the README's `PORT=0` command sends the browser to the wrong port.**
   - **The problem:** README.md:100-101 says a `.env` holding `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` turns
     sign-in on, and it says so inside the `PORT=0` run block. But `OIDC_REDIRECT_URI` defaults to
     `http://localhost:8080/auth/callback` (`server/main.js:101`). On a random port, Google returns the browser to
     8080, where nothing listens.
   - **Also missing:** the README never says that this redirect URI must be registered on the OAuth client.
   - **Fix (README only, names only):** for sign-in, run on a fixed `PORT` and set `OIDC_REDIRECT_URI` (and
     `PUBLIC_URL`) to match it, then register that exact URI on the OAuth client.
   - **Mitigation:** this matters less today, because after sign-in the browser lands on `GET /`, which answers 404
     (README.md:43-44 says so).
   - **Agreement:** codex found this independently and rated it MEDIUM.

## LOW

1. **The variable list is called complete, but it isn't.**
   - **The claim:** README.md:102-103 says every variable is listed with its default at the top of `server/main.js`.
   - **What the code reads:** `POST_LOGIN_URL` and `BOARD_URL` (`server/main.js:158-159`) are not in that header.
     `DATABASE_URL` and `NATS_URL` appear there only inside the `COOKIE_KEY` note.
   - **Fix:** say "most variables" instead, or name the missing ones. codex agrees.
2. **The README omits that every node needs the same `COOKIE_KEY`.**
   - **Where:** README.md:50-51 says cluster mode makes `COOKIE_KEY` required, but not that the value must match on
     every node.
   - **Why it's LOW:** cluster mode isn't composed yet, and `deploy/README.md:37` (linked from the README) says
     "same value". codex rated it MEDIUM; I rate it LOW for that reason.
3. **The tenant-bootstrap decision isn't mentioned.** The "Creating a tenant" gap (README.md:47-49) is true on main:
   - **No route or command:** `git grep createTenant` over `server/`, `scripts/` and `web/` finds only the dev
     tenant with `domain: null` (`server/main.js:128`).
   - **Seen live:** `POST /boards` with `dev-token` answered 403.
   - **Already decided:** commit 0b122c0 records a bootstrap (`bootstrapTenant` plus a CLI in `server/admin/`).
   - **Fix (optional):** add "planned: a first-admin bootstrap", so readers know it is decided and not open.

## How I checked

### Commands, run exactly as written in the clean clone

| README section | Result |
|---|---|
| Dev loop: `bun install --frozen-lockfile`, `bun test` | 5 packages installed; 884 pass / 80 skip / 0 fail |
| Run the server (`PORT=0 … bun server/main.js`) | Log lines gave the port and the dev board id, and showed `google:false`. Routes: `/health` 200 with a JSON body; `/` 404; `/metrics` 404. `/auth/login`, `/auth/callback` and `POST /auth/exchange` each gave 503. `POST /boards` with Bearer `dev-token` gave 403 `forbidden` |
| WebSocket `hello` | `{t:"hello",v:1,token:"dev-token",board,since:0,client}` at `/ws` was welcomed as `role:"editor"`, `user:"dev:ann"` |
| Open the canvas (`python3 -m http.server 0 --bind 127.0.0.1`) | Opened `/web/index.html?board=…&as=ada` and `&as=bo` in two Chrome tabs at once. A rectangle drawn as ada appeared in bo's tab, which confirms the two-tab claim the builder had left unverified. `/web/collab/dev.html` rendered avatars, cursors, a selection, threads and the reaction bar. No console errors after load; errors during page load were not captured, because console tracking starts at the tool's first call, which came after load |

**Cleanup:** I recorded the PIDs of the Bun server (34289) and the static server (40578) and killed only those. I
closed both Chrome tabs.

### Claims, checked against the code at HEAD

| Claim | Evidence |
|---|---|
| Protocol v1.1, its pieces, and that clients converge | `PROTOCOL.md:1`; `packages/protocol/*`; all five cited tests exist and pass |
| Single-node composition | `server/main.js` imports only sqlite, memory and disk; restart and kill -9 survival: `test/server/main.test.js:112,153` |
| Sign-in routes; 503 without Google; socket closes when the session expires | `server/auth/http.js:27-41`; `test/server/main.test.js:227,252`; `test/server/revocation.test.js:100` |
| Admin API; a grant change closes live connections | `server/auth/http.js:33-41`; `test/server/main.test.js:273` |
| Each cluster adapter has a contract test, run in CI's second job; the server doesn't use them | pg-store uses store-contract, pg-registry uses registry-contract, nats-bus uses bus-contract, s3-blobs uses blobs-contract. CI job `test-cluster-services`. `DATABASE_URL` and `NATS_URL` only gate `COOKIE_KEY` (`server/main.js:91-95`) |
| Canvas runs in the browser through a SharedWorker; no server link | `web/app.js:19` (`sharedNet`/`localNet`); `web/ui/net.js` header; nothing in `web/` imports `transport/ws.js` or `core/signin.js`. `web/app.js` and `web/ui/*.js` contain no `fetch(`, `WebSocket` or `/auth/` call, only comments. `web/ui/token.js` only reads a `#token=` fragment, and `web/app.js:9` says such a token is refused until the WebSocket transport is wired |
| Dev users and their roles | `web/ui/dev-users.js` matches the README exactly |
| Skips without `DATABASE_URL`, `NATS_URL` or `S3_*`; one dependency; Bun 1.4.4 | test headers; `package.json`; `.github/workflows/ci.yml:31,118` |
| Purity; the core-source check skips without `../herdr-draw` | `test/purity.test.js:7`; `test/core-source.test.js:15` |
| Cluster Compose services | `deploy/cluster.compose.yml`: postgres, nats, blobs (plus init), app-1 to app-3, lb |
| Links | every repo path in the README exists at HEAD (`git cat-file -e`); no LICENSE file, as the README says |

### Secrets and personal data

- **Against `.env`:** I compared the README with every `.env` value of 6 characters or more (3 values) inside one
  process, without printing them. No hits.
- **Pattern scan:** no emails, no `apps.googleusercontent`, no `GOCSPX`, no project ids, and no "omni".
- **Name:** `PROJECT_NAME` appears 3 times. "plenary" appears only in the `PLENARY_*` env names, which the
  2026-11-11 commitment allows as code identifiers.
- **One handle remains:** the herdr-draw GitHub link contains the owner's public handle. That is a public repo URL
  which CI already clones, so I did not flag it.

### Outside-model review (sdd)

Each reviewer ran in its own scratch clone, never in the shared tree. Afterwards both clones were unchanged, and
their README copies were byte-identical to the one under check.

- **codex:** found the same three items as above (the redirect URI, the variable list, the shared `COOKIE_KEY`).
  It reported no broken paths and no secrets.
- **agy:** unavailable. `check_adapter` showed it is out of quota (429 `RESOURCE_EXHAUSTED`, resets in about 59 h).
- **grok (in place of agy):** none of its findings stand.

  | grok's claim | Verdict |
  |---|---|
  | HIGH: "`PROJECT_NAME` is false; the name is settled" | **Refuted.** Both README briefs require the token, and CLAUDE.md keeps the name only in CLAUDE.md and package.json until it is settled |
  | MEDIUM: "Bun 1.4.4 isn't strictly required" | **Refuted.** The README names the version CI pins; that is the right guidance |
  | MEDIUM: "`COOKIE_KEY` is not called required in cluster mode" | **Refuted.** README.md:50-51 says it is required; the real gap is redirect/sign-in setup (MEDIUM 1 above) |
  | "The README's every-variable line is accurate" | **Contradicted** by the code (LOW 1 above) |
- **Engram:** searched before writing; there was no prior memory about this README.

## Not verified

- **Docker:** I built and ran no image. The README says so itself.
- **A real Google sign-in through `server/main.js`:** not done.
- **The working tree:** as the builder warned, the uncommitted web restructure in the shared tree deletes
  `web/app.js`, `web/ui/*` and `web/collab/*.js`. All of those are cited by the README. The README is true for main
  but must be re-checked when that restructure merges.

## Risks (files I don't own)

- **Stale log line:** `server/main.js:152` still says "sign-in is not wired yet" when dev tokens are off.
  The builder already flagged this; it is unchanged at HEAD.
- **A linked file names the Google Cloud project.** `docs/m2/PLAN.md`, which the README links, contains that
  project's name once at HEAD (confirmed with `git grep`; the name is not repeated here). It needs fixing before
  the repo goes public.
- **`deploy/README.md` contradicts the README.** At HEAD, `deploy/README.md:21-22` still says `POST /boards` and
  Google sign-in are not wired into `server/main.js`, and that boards live in an in-memory registry. Both are false
  at HEAD: the server mounts `httpRoutes`, and the registry is SQLite.
- **Cleanup confirmed:** `kill -0` on both recorded PIDs (34289, 40578) reports no such process.

# Re-check

**Verdict: PASS.** The MEDIUM and all three LOWs are fixed and true at main 9c7af11. The new command runs as
written, and the README contains no secrets. There are no new findings, only one wording nit.

- **README checked:** sha1 `cc3f163ecdd98ca658b1a637b72ced3c3fef94e3`. The only difference from the version I first
  verified (`dd8d22d6…`) is the fix-round diff.
- **Main checked:** a fresh clone at 9c7af11. Main changed since 0b122c0 only in `docs/`, the Postgres adapters
  and the architecture tests; none of those files is cited by the README.

| Finding | Re-check |
|---|---|
| **MEDIUM:** sign-in redirect | **Fixed.** The new "Google sign-in locally" command sets `PORT=8080`, `OIDC_REDIRECT_URI=http://localhost:8080/auth/callback` and `PUBLIC_URL=http://localhost:8080`. These equal main's defaults (`server/main.js:4,101-102`; `PORT` defaults to 8080 at `:163`). The `PORT=0` bullet now points to that command. I ran it exactly as written from the clean clone, with fake `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment and no `.env`. The log showed `"google":true` and `"port":8080`, `/health` answered 200, and `/auth/login` answered 302 with `redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth%2Fcallback`, the URI the README says to register. Port 8080 was free beforehand. I stopped the server by its recorded PID (7277), and `kill -0` confirmed it was gone |
| **LOW 1:** variable list | **Fixed.** The README now says "most variables" and names `POST_LOGIN_URL` and `BOARD_URL` with defaults based on the origin (`server/main.js:158-159` at main). The builder's report cites `:176-177`, which is wrong, but only the report has that line number, not the README |
| **LOW 2:** same `COOKIE_KEY` on every node | **Fixed** and true (`server/main.js:95`) |
| **LOW 3:** tenant bootstrap | **Fixed.** It is marked "planned (decided, not built yet)", which matches commitment 0b122c0. `server/admin/tenants.js` is not on main, and the README doesn't claim it |
| **Secrets** | None. The README contains none of the 3 `.env` values of 6+ characters (compared inside one process, values never printed). No emails, client ids or project names. `PROJECT_NAME` still appears 3 times |

**Nit (not a finding):** the README says "the two values above are the defaults", and then "change all three
values". `PORT=8080` is a default too, so a reader may wonder which two are meant.

**Not verified:** a real Google login (it needs the real OAuth client and a person). `bun test` was not re-run,
because the change is to `README.md` only.
