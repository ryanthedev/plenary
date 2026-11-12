# Report: p8-readme2 (README refresh for phase 2)

**Status: done. `README.md` rewritten to match committed `main` (bc0bd63). Commands were run as written, every
linked path is tracked in git, and `bun test` in a clean clone of main gives 884 pass, 80 skip, 0 fail. Nothing
committed.**

**Read this first: the README goes stale when client's in-progress web restructure lands.** The working tree has
uncommitted changes that delete `web/app.js`, `web/ui/*`, `web/collab/*.js` and `web/sync.js`, and add `web/main.js`,
`web/core/*` and `web/adapters/*`. The README names `web/app.js`, `web/ui/dev-users.js` and `web/collab/dev.html`.
Re-check the "What works today" table, the "Open the canvas" section and the repo layout after that merge.

## What changed

| File | What |
|---|---|
| `README.md` | Full rewrite. Sections: what it is, status, works today (with code/test pointers), not there yet, layout, dev loop, run the server, open the canvas (new), protocol, core rule, Docker, design, license. |

**Tests added:** none (documentation only).

## Claims and their evidence

| README claim | Evidence |
|---|---|
| Protocol v1.1 in code: Replica, Room, recovery, presence, records, settings compare-and-set | `packages/protocol/{replica,room,presence,records}.js`; `test/{convergence,recovery,presence,records,v11}.test.js`; `PROTOCOL.md` title "v1.1" |
| Server is one process: gateway, room host, SQLite log and SQLite registry, memory bus, disk blobs, JSON logs, `/health` | `server/main.js` (imports), `server/server.js`; ran it (log lines below) |
| Boards and ops survive restart and `kill -9` | `test/server/main.test.js:112`, `:153` |
| Google sign-in with code exchange mounted; login, callback and exchange answer 503 without client vars | `server/auth/http.js` routes, `server/main.js` (`httpRoutes`); `test/server/main.test.js:227` and `:252`; ran it without `.env`: login, callback and exchange gave 503, logout gave 302 |
| A session token joins over `/ws` and the socket closes when it expires | `test/server/revocation.test.js:100` |
| Admin API: `POST /boards`, invites, links, grants; revocation closes connections | `server/auth/http.js:330-375`, `server/admin/boards.js`; `test/auth/http.test.js`; `test/server/main.test.js:273` |
| `POST /boards` gives 403 on a fresh server, dev tokens included | Ran it: 403 `forbidden`. `tenancy.tenantOf` needs a domain (`server/auth/tenancy.js:58`). The registry port's tenant writers are `createTenant` and `addTenantAdmin` (`server/auth/registry-port.js:45-48`); `git grep` at HEAD over `server/` and `scripts/` finds one caller outside the adapters: the dev tenant with `domain: null` (`server/main.js:128`). The test seeds a tenant through the registry (`test/server/main.test.js:233`) |
| Without dev tokens no client can join | Follows from the row above: no dev board, no other way to create one. Log line at start: "every hello will be refused" |
| Cluster adapters exist; CI's second job runs their contract tests against real services; the server doesn't use them | `server/{store,registry}/postgres.js`, `server/bus/nats.js`, `server/blobs/s3.js`; `test/server/{pg-store,pg-registry,nats-bus,s3-blobs}.test.js` (skip without env); CI job `test-cluster-services` (run 43187407531 on main 2a0409c: both jobs success, via `gh run view`). `server/main.js` imports only sqlite/memory/disk; `DATABASE_URL`/`NATS_URL` only gate `COOKIE_KEY` (`server/main.js:91-95`); `PLENARY_ROLES` is read nowhere in `server/` |
| Leases and takeover not built | `server/room-host.js:239` (SEAM p4); `pl_leases` holds only an epoch (`server/store/postgres.js:66`) |
| Web canvas runs in the browser through a SharedWorker; doesn't talk to the server | `web/app.js` imports `sharedNet`/`localNet` only; `web/ui/net.js` header (SEAM phase 3); nothing in `web/` imports `web/adapters/transport/ws.js` or `web/core/signin.js`. Opened in Chrome (below) |
| Server doesn't serve `web/`; `GET /` is 404 | `server/server.js` routes; ran it: `/` gave 404 |
| Canvas UI features: tools, properties panel, layers, library, export, role gating, connection pill | `web/app.js` (imports `ui/panel.js`, `ui/export.js`, `ui/roles.js` `toolsFor`/`pillFor`, core `library.js`); Chrome screenshot showed the toolbar, Properties, Layers, Library and the "Live" pill |
| Collaboration features: avatars, cursors, selections, laser, emotes, reactions, comment threads, notes | `web/collab/ui.js` header (avatars, laser, selection, threads, notes/comments drawer) and its `reactFor` state; `web/collab/{presence,records,notes}-model.js`; `test/web/collab/`; Chrome screenshot of `web/collab/dev.html` showed avatars, cursors, a selection, threads and the reaction bar |
| Cluster Compose defines Postgres, NATS, S3 store, 3 app nodes, a load balancer; nodes run single-node | `deploy/cluster.compose.yml` services; never run (as `deploy/README.md` says) |
| Collaboration UI only on `web/collab/dev.html` | `mountCollab` is used only in `web/collab/`; opened it in Chrome |
| Web edges (WebSocket transport, sign-in exchange) tested, unused | `web/adapters/transport/ws.js`, `web/adapters/auth/http.js`, `web/core/signin.js`; `test/web/adapters/`, `test/web/contracts/`, `test/web/core/signin.test.js` |
| Dev users `ada`…`fi` and their roles | `web/ui/dev-users.js` |
| One dependency, pinned; CI installs frozen | `package.json`, `bun.lock`, `.github/workflows/ci.yml` |
| Cluster tests skip without `DATABASE_URL`/`NATS_URL`/`S3_*` | `describe.skipIf(!url)` in `test/server/pg-store.test.js:13` and peers; 80 skips locally |
| Bun 1.4.4 | `.github/workflows/ci.yml`; `bun --version` 1.4.4 |
| Purity: protocol imports only two core files | `test/purity.test.js:7` |
| No LICENSE | `ls LICENSE*`: none |

## How I checked

- **Quick start in a clean clone** (scratchpad, no `.env`, no `../herdr-draw`): `bun install --frozen-lockfile`
  installed 5 packages. `bun test` ran 5 times: 4 runs gave 0 fail, and 1 run (at 2a0409c) gave 1 failure. I did
  not capture that failure's name, so it may be a flaky test. The final run at bc0bd63 gave 884 pass, 80 skip,
  0 fail.
- **Server block run exactly as written**, from the clean clone, so no `.env` was loaded. Results:
  - **Log:** `google:false`, the dev board id, and the port.
  - **Routes:** `/health` 200, `/auth/login` 503, `/` 404, and `POST /boards` with `dev-token` 403.
  - **WebSocket:** a `hello` with `dev-token` and the dev board was welcomed as `editor dev:ann`.
  - **Shutdown:** stopped by its recorded PID.
- **Same server in the repo:** there `.env` loads and the log shows `google:true`, so `/auth/login` answers 302.
  That is why the README notes that Bun loads `.env`. No `.env` value or `Location` header was printed.
- **Canvas page:** I served the clean clone with `python3 -m http.server 0 --bind 127.0.0.1` and opened it in Chrome.
  - `/web/index.html?board=…&as=ada` and `&as=bo` rendered the full UI with the "Live" pill and no console errors.
  - `/web/collab/dev.html` rendered with no console errors.
  - Cleanup: closed my tab and killed only the recorded python PID.
- **Links:** every repo path in the README is tracked (`git ls-files`). External links bun.sh and the herdr-draw
  repo both answered 200.
- **Name and privacy:** `PROJECT_NAME` appears 3 times (lines 1, 3, 5). The only "plenary" hits are the `PLENARY_*`
  env names (commitment 2026-11-11: code identifiers are allowed). There are no emails, no Google project names and
  no client ids.
- **Engram:** searched first; nothing relevant to this job.

## Not verified

- **Docker:** no image was built or run. The README says so and points to `deploy/README.md`.
- **Two tabs editing together on the canvas:** the README claims it, citing the SharedWorker design and
  `test/web/ui-land.test.js`. I opened one tab per user in turn, not two at once.
- **A real Google login through `server/main.js`:** not done. `scripts/dev-google.js` is the dev harness.
- **The working-tree `bun test` fails 1 test:** `the page never puts the token in localStorage…` in
  `test/web/core/page-signin.test.js`. That file is untracked, from the in-progress web restructure, and not mine.
  The run had 987 pass and 1 fail. Committed main passes.

## Risks and requests (files I don't own)

- **No way to create a tenant (product gap, HIGH for M2):** `POST /boards` is unusable on a running server, because
  no route or command creates a tenant with a domain or admins. That includes Google sign-in, which does not create
  the tenant for a Workspace domain. Someone must own a tenant bootstrap (a first-admin command, or create on first
  sign-in for a domain).
- **After Google sign-in the browser lands on `GET /`, which is 404:** `postLoginUrl` defaults to `${origin}/` and
  the server serves no page. This will be fixed once the web page is served by the server and connects to it.
- **`deploy/README.md` is still stale** (line 21: "`POST /boards` and Google sign-in are not wired into
  `server/main.js`"). Another worker owns that file; I only link to it.
- **No LICENSE file** (unchanged; the CEO's choice).
- **Stale log line in `server/main.js:152`:** with dev tokens off it logs "sign-in is not wired yet: every hello will be
  refused". Sign-in is now wired; only the tenant gap still stops every join. Engine owns the file.
- **`docs/m2/PLAN.md` is linked from a public README** and names the Google Cloud project (unchanged from p8-readme).

## Fix round

Answers p8-readme2v (PASS, 1 MEDIUM, 3 LOW). I changed only `README.md`.

| Finding | Fix |
|---|---|
| **MEDIUM:** Google sign-in described inside the `PORT=0` block, where Google redirects to port 8080 | The `.env` bullet now says to use a separate command for a working sign-in. A new "Google sign-in locally" section has its own command with `PORT=8080`, `OIDC_REDIRECT_URI` and `PUBLIC_URL`. It also says to register that exact redirect URI on the OAuth client, how to change the port (all three values plus the registered URI), and that the browser still ends on a 404 today |
| **LOW 1:** "every variable" was not true | Now says "most variables", and names `POST_LOGIN_URL` and `BOARD_URL` (`server/main.js:176-177`) with their default |
| **LOW 2:** every node needs the same `COOKIE_KEY` | Added to the "Cluster mode" bullet (`server/main.js:95`: "every node must sign with the same key") |
| **LOW 3:** tenant bootstrap is decided | Added "Planned: a first-admin bootstrap (decided, not built yet)", per commitment 0b122c0. `server/admin/tenants.js` is still untracked, so it is not claimed as existing |

**How I checked the new command:** I ran it as written from the clean clone, on port 8080, with fake client values
(`fake-id`, `fake-secret`, not real credentials).
- **Startup:** the log showed `"google":true` and `"port":8080`.
- **Redirect:** `/auth/login` redirected with `redirect_uri=http://localhost:8080/auth/callback`.
- **Port use:** 8080 was free beforehand, because the redirect URI fixes that port.
- **Cleanup:** I stopped the server by its recorded PID.

**Not verified:** a real Google login with this command (it needs the real OAuth client and a person).
