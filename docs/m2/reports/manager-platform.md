# Report: manager platform

Manager terminal: `t14q` (tab `manager platform`). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| pd-drawh3 (builder, round 3) | pd-drawhv (verifier) 
## 2026-11-11 start: p5-auth and p8-ci in parallel

- Briefs: docs/m2/briefs/p5-auth.md, docs/m2/briefs/p8-ci.md. Files disjoint (server/auth, server/admin,
  test/auth vs .github, deploy).
- p5-auth builds against the working-tree Auth port (async `verify` then `role`), confirmed by the proxy.
- Decision (reversible): a Workspace member's default role on a board of their tenant is the board's
  `memberRole`, set at `POST /boards`, default `viewer`.
- Seam gaps sent to the proxy (not blocking): Store port has `board(id)` but no create call; no home for
  invites, links, grants; member default role unspecified in PROTOCOL.md. Workaround: a platform-local registry
  port (`server/auth/registry.js`, in memory) the engine can back with SQLite/Postgres later.
- Engine's answer (via proxy): PROTOCOL.md gets a Registry port shaped after server/auth/registry.js
  (boards, tenants, invites, links, grants, `createBoard({tenant, title, memberRole})`); `Store.board` moves to
  `Registry.board`; per-board `memberRole` default `viewer` is the rule. Relayed to builder t14s; registry
  method names stay stable, changes go to the proxy first.
- Proxy granted platform the root `.dockerignore` and `.gitignore` (whole files). To add: `.env*`, `.git`,
  `node_modules`, `*.db`/`*.sqlite` and `-wal`/`-shm`, local blob dirs. Goes into p8-ci's fix round, or a small
  job after p8-civ PASS.
- Engram (memory service) unreachable this session; nothing recalled or stored.

## 2026-11-11 p8-ci: DONE (commit 8f89d4f)

- Verifier p8-civ (t14w): PASS, no HIGH. `bun test` re-run by me before commit: 65 pass, 0 fail.
- **Never run on GitHub; image never built** (no Docker on this machine).
- Follow-ups in job p8-ign (t150): root `.dockerignore` and `.gitignore` (MEDIUM 1), cancel-in-progress on PRs
  only (LOW 3), compose `name:` (LOW 7), `.env` location note (LOW 5).
- For the proxy/engine (not platform files): CI can't compare packages/core against herdr-draw, because
  `test/core-source.test.js` skips that half when `../herdr-draw` is absent (always, on a runner). Hash check of
  core vs SOURCE.json still runs. Options: a second checkout of herdr-draw at the SOURCE.json commit, or accept.
- Proxy: close it. CI clones public herdr-draw to ../herdr-draw at the SOURCE.json commit before `bun test`
  (test file untouched). Added to p8-ign (t150). Pinned = proves core equals herdr-draw at that commit; newer
  herdr-draw changes are still caught only on dev machines.
- Cleanup (OFFICE.md "Cleaning up sessions"): closed tabs, `hc kill` + `hc rm` on t14t (p8-ci) and t14w
  (p8-civ); both now `not_found`. No servers or scratch terminals were left running. Removed from the roster.
- 2026-11-11 CEO rule (commit 9218fdf, OFFICE.md "sdd helpers"): every platform verifier brief from now on
  requires an sdd ensemble review (codex + agy + any harness passing check_adapter; two agreeing = HIGH candidate,
  confirmed or refuted in the report). No platform verifier was running when it arrived. Running builders
  (t14s, t14y, t150) get it via BRIEF-BASE.md; not interrupted.

## 2026-11-11 p5-auth and p8-ign built; verifiers running

- p5-auth (t14s): 28 auth tests, full suite 82 pass; registry signatures listed in docs/m2/reports/p5-auth.md,
  unchanged since first draft (relayed to proxy). Verifier p5-authv (t153), with sdd ensemble.
- p8-ign (t150): ignore files, explicit Dockerfile copies, CI clone of herdr-draw. Verifier p8-ignv (t152), with
  sdd ensemble.
- Decisions on the builder's open questions (reversible, mine):
  - **Tenant bootstrap:** operator-created for M2 (an operator command/env at server start creates a tenant
    for a domain and names its first admin). The first sign-in from a domain does NOT create a tenant, since any
    Workspace could otherwise claim a tenant on a shared server. Built with the phase-3 wiring.
  - **Share-link guests sign in** (any Google account) in M2; no anonymous guest sessions.
- Sent to engine via proxy (PROTOCOL.md is theirs): § Auth says `verify`/`role` resolve null and never throw,
  so a registry outage looks like a refusal (`auth`, not `unavailable`). Proposal: throw on infrastructure
  errors and let the gateway answer `unavailable`.
- 2026-11-11 owner rule: every session I start gets `--label plenary.reports-to=t14q` and a tab name with the
  track, e.g. `worker p5-wire (platform): …`. The proxy relabelled my existing sessions.
- pd-drawh (t14y) asked to run `pkill -f "standin.js 8793"`; declined (no pattern kills), steered to
  `kill $PID`. Nothing had started, so nothing was left running.
- 2026-11-11 rule (OFFICE.md): no pkill/killall; servers started by a script that records the PID, killed by
  that PID only; free ports (port 0). Sent to running t14y (pd-drawh) and t153 (p5-authv); goes in every new
  brief.
- p8-ignv (t152): PASS, no HIGH. Only codex passed `check_adapter`, so the two-harness rule could not fire.
  Fix round on t150 (MEDIUM 1: key/credential files not ignored; LOW 2-4); t152 re-checks after.

## 2026-11-11 p8-ign: DONE (commit 4fc4c71)

- Verifier p8-ignv (t152): PASS; fix round (MEDIUM 1 key/credential files, LOW 2-4) re-checked PASS.
  `bun test` re-run by me: 125 pass, 0 fail; `git ls-files -ci --exclude-standard` empty.
- Still unverified: no Docker here (`.dockerignore` result simulated); workflow never run on GitHub.
- Left open (LOW): `web/dev.html` ships in the image until phase 3 decides how the client is served;
  SOURCE.json's 7-char SHA could become ambiguous (engine's file; full SHA would fix it).
- Cleanup: tabs closed, t150 and t152 killed and removed.

## 2026-11-11 pd-drawh built; verifier running

- Builder t14y: patch (docs/m2/proposals/drawh-server.patch, base herdr-draw 5dfe352) + one-page proposal; applies
  cleanly, herdr-draw tests 269 pass (258 before); herdr-draw checkout untouched. Copied protocol is v0, so a
  small follow-up is expected after phase 2. Verifier pd-drawhv (t155) with sdd ensemble.
- For engine (via proxy): the room refuses an element more than 1,000 versions ahead (`MAX_VERSION_JUMP`), so an
  old, heavily edited board file can't be fully seeded. Should a first write of an element be exempt?
- Next platform job after these: wire auth + admin into server/ once phase 3 (engine) is committed.
- Engine (via proxy) on drawh seeding: no first-write exemption (an exempt first write could claim a version near
  2^53 and lock the element). Seeding is a client-side import: drawh rewrites each element's version to 1 with a
  fresh versionNonce, ids kept; no new message, no server path. Goes into the drawh patch's fix round if t155
  sends it back, else the post-phase-2 refresh.

## 2026-11-11 p5-authv: PASS with 7 MEDIUM; fix round sent back

- Verifier t153: no auth bypass, cross-tenant access, forgery or existence leak. Only codex passed
  `check_adapter` (agy out of quota ~69 h; grok/kimi/mistral not signed in), so one harness, run twice.
- Decisions (mine, reversible):
  - **M1 = unverified.** A Google account is trusted for an email only when Google is authoritative
    (@gmail.com, or `email_verified` + `hd`). Guests on other domains reach a board by share link, not by invite
    to their email. So the job is treated as FAIL until fixed.
  - **M6:** only tenant admins grant `owner`; board owners grant up to editor; a board's last owner is protected.
  - **Codex-only ensemble accepted** for this job (not waiting 69 h for agy); the re-check will be by t153.
- Fix round on builder t14s (12% context): M1-M7, L3, L6, L7, L8, each with a test.

## 2026-11-11 p5-auth: DONE (commit 91fb274)

- Verifier p5-authv (t153): PASS; fix round (M1-M7, L3, L6-L8) re-checked PASS. `bun test` re-run by me: 143
  pass, 0 fail. Ensemble: codex only (accepted).
- Accepted for M2 (re-check R1, MEDIUM): two concurrent owner removals can both pass the last-owner check (no
  role gained; a tenant admin repairs it). Real fix = an atomic check in the engine's SQL Registry; sent to engine.
- For engine (PROTOCOL.md): § Tenancy should say "authoritative email" (M1) and the owner-grant rule (M6).
- Not done (by brief): real Google client (waits for the CEO's credentials), HTTP wiring (phase 3), persistence.
- Cleanup: tabs closed, t14s and t153 killed and removed.
- Next job started: p8-readme (t15s). README uses a `PROJECT_NAME` placeholder until the proxy says the name may
  appear (CLAUDE.md: the name lives only in CLAUDE.md and package.json for now). Asked the proxy.
- 2026-11-11 rule (commit 2f29f47): new sessions start as `hc run ... -- zsh -lic 'exec "$@"' zsh claude <args>`
  so they get Engram's env from the login profile. Running sessions are not restarted.
- p8-readme built (t15s). Verifier first started as t15z with the login-shell wrapper but no `--model opus
  --permission-mode auto`; it came up as Fable 5.2, so I removed it within a minute and restarted it as t161
  (Opus 5.5, auto). README commit waits until the engine/client files it links to are committed.
- Queued for platform (deploy/, after phase 3 commits): deploy files still say server/main.js "comes in phase
  3"; compose needs `HOST=0.0.0.0`, dev tokens by name, `restart`, and a live HEALTHCHECK.
- For the CEO via proxy (only if wanted): no LICENSE yet; README says none is granted.

## 2026-11-11 p5-fix started (engine's three items, via proxy)

- Checked first: (1) port.js swallows every error: true. (2) authoritativeEmail accepts any set `hd`: true;
  rule becomes `hd` = the email's domain, or @gmail.com. (3) partly: admin `setGrant` already enforces owner-grant
  and last-owner rules with a test (tenancy.test.js "M6"); raw `registry.setGrant` has neither. The last-owner
  check moves into the Registry contract too (atomic in SQL; closes p5-authv R1); caller rules stay in admin.
- Trade-off logged: a Workspace user whose email is on a secondary domain (email domain ≠ `hd`) can no longer
  claim an invite by email; member role via `hd` and share links still work.
- Builder t166 (Opus, auto, login shell). Verifier to follow.

## 2026-11-11 engine items from p3-scaffoldv; README verdict

- Proxy: engine builds the SQLite/Postgres Registry adapters in server/ against platform's contract; in-memory
  registry.js stays the reference. Added to p5-fix: a shared contract test `registryContract(name, makeRegistry)`
  in test/auth/registry-contract.js for both.
- `HOST=0.0.0.0` and the stale phase-3 notes: new job p8-deploy (t16b), files deploy/ + .dockerignore.
- p8-readmev (t161): FAIL on one HIGH, the real name via env var names (PLENARY_DATA_DIR, PLENARY_DEV_TOKENS).
  **Ruling (mine, reversible):** the name rule covers prose and branding; identifiers in code (env vars, file
  names, the committed PROTOCOL.md title) keep their names until a rename. README prose keeps `PROJECT_NAME`.
  Fix round on t15s for MEDIUM 2 (tenancy IS wired; OIDC, sessions, invites, links, admin API are not), LOW 3, 4.
- p8-readme: VERIFIED (re-check PASS, t161), **not committed**: README.md links to engine/client files not yet in
  git (server/main.js, server/*, test/server/, web/, test/web/). Commit README.md + docs/m2/briefs/p8-readme*.md +
  docs/m2/reports/p8-readme*.md by path once those land (re-run `bun test` and the path check first). Sessions
  t15s and t161 closed, killed, removed.

## 2026-11-11 p5-fix and p8-deploy built; verifiers running

- `bun test test/auth`: 65 pass, 0 fail. Full suite: 4 failures, all in engine's untracked test/server
  (gateway "bad frames": `version` code vs test; two "H1" nesting; "M1/M4 slow sign-in"). p5-fixv must rule out
  that p5-fix's error propagation causes any of them; reported to the proxy for engine.
- p5-fix risk for engine: two dev tokens sharing a name (one owner) now throw `last-owner` at start
  (server/main.js:52); the contract test needs adapters to honour an injected `now`.
- pd-drawhv (t155): FAIL, 2 HIGH. H1: a save landing during the bridge's file write is lost silently (~1 in
  100-200 saves on big/busy boards, measured). H2: `--server` anywhere in argv (even text after `--`) switches
  mode. Plus M1-M5, L1-L6. Fix round on t14y (20% context, idle 31 min): H1, H2, M1-M5, L1-L3, and engine's
  seeding rule (version 1 + fresh versionNonce). t155 re-checks after.

## 2026-11-11 p8-deploy: DONE (commit 2225ff1)

- Verifier p8-deployv (t16j): PASS, no HIGH/MEDIUM. `bun test` re-run by me: 245 pass, 0 fail (engine fixed its
  four). Image never built, compose never run (no Docker). Sessions t16b, t16j closed, killed, removed.
- Proxy: engine's SQLite Registry commit waits on p5-fix (imports registry-contract.js and mint). On p5-fix commit, message t14j and t14h with the commit id.

## 2026-11-11 p5-fix: DONE (commit 4e16752)

- Verifier p5-fixv (t16h): PASS against PROTOCOL.md 7e834d2. `bun test` re-run by me: 254 pass, 0 fail.
  Engine (t14j) and proxy told the commit id directly (engine's SQLite Registry depends on it).
- Old MEDIUMs, not from this job: (1) createBoard throws without the board id if the owner grant fails. Fold
  into the HTTP-wiring job (same function). (2) Spec says gmail needs no `email_verified`; code always requires
  it (safer). Spec change asked of engine via proxy.
- Sessions t166, t16h closed, killed, removed.
- p8-cluster-env (t170) started on the proxy's suggestion: cluster compose (Postgres, NATS, MinIO, 3 nodes, LB) and CI services job. Proposed env names go to engine.
- p8-cluster-env built. Decision (mine, reversible): blob store = `pgsty/minio` (pinned community MinIO fork,
  AGPL-3.0), since official MinIO images left Docker Hub; service named `blobs` so a swap (rustfs, garage) touches
  only it. Proposed env names for engine: DATABASE_URL, NATS_URL, S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/
  SECRET_ACCESS_KEY (Bun's S3 client reads these), PLENARY_NODE_ID. Verifier t174.
- Engine (t14j) confirmed the cluster env names, added PLENARY_ROLES (gateway,host; compose runs at least one
  gateway-only and one host-only node), and NATS max_payload 2MB (PROTOCOL.md § Bus) for compose and CI. Sent to
  builder t170; verifier t174 re-checks the amended files after its current pass.

## 2026-11-11 p8-cluster-env: DONE (commit 33b4cd8)

- Verifier p8-cluster-envv (t174): PASS; re-check of engine's amendments PASS; R-M1 (pipefail/SIGPIPE false
  failure in the CI /varz check) fixed by t170 and checked by me (capture, then grep). `bun test`: 263 pass.
- Nothing run in Docker or on GitHub. Sessions t170, t174 closed, killed, removed.
- 2026-11-11 proxy: first GitHub run of CI (run 43126348872) green for both jobs, test and test-cluster-services. The workflow and the Postgres/NATS services now verified on GitHub (Docker image and compose still never run).

## 2026-11-11 p5-http started (proxy's suggestion)

- Standalone Request → Response handlers: /auth/login, /auth/callback, /auth/logout, POST /boards, invites, links
  (incl. GET /links/:id redeem), grants. Folds in p5-fixv MEDIUM 1 (createBoard reports the board id on failure).
- Design calls (mine, reversible): login state in a signed short-lived HttpOnly SameSite=Lax cookie; callback hands
  the session token to the web client in the URL fragment of a configured post-login URL (no open redirect);
  API routes use `Authorization: Bearer` (no cookie auth on mutations, so no CSRF surface).
- Mount hook proposed to engine (t14j): `httpRoutes(deps) → (req) => Response | null`; awaiting their answer.
- Engine agreed the hook: httpRoutes(deps) → async (req, url) => Response | null, mounted via createServer({ http }) AFTER engine routes; /health, /ws, /blobs/*, /metrics reserved for engine; return own 4xx/5xx (throws become 500). Engine wires main.js when http.js lands: tell t14j then. Relayed to t17b.
- p5-http built (291 pass). Decision: Bearer accepts dev tokens only when a dev verifier is configured. Engine told http.js landed (wire against the commit). Verifier t17c.

## 2026-11-11 pd-drawh fix round result; seeding decision

- H1 re-measured with the verifier's scripts: 15 of 1,560 saves lost before; 0 of 4,541 with the default atomic
  swap (~46 ms per write); 0 of 3,842 with the hard-link fallback as shipped. H2, M1-M5, L1-L6 fixed.
  Patch: applies cleanly, herdr-draw 282 pass, plenary 292 pass, herdr-draw checkout untouched.
- Decision (mine, reversible; engine told via proxy): renumber on seeding only the elements the room would refuse
  (absent and version > 1,000). Renumbering all of them let a pane with the file open silently overwrite later
  edits (builder's test). Sent to t14y; t155 re-checks after.
- Engine agreed the seeding decision; renumbered (refused) elements get version 1,000 (not 1) with a fresh versionNonce. Relayed to t14y. PROTOCOL.md seeding text updated at engine's next spec touch.
- Seeding renumber target stays 1, not engine's 1,000: builder's test shows 1,000 lets stale pane copies 1,001-2,000 silently overwrite a peer's edit; with 1 they're held back with a warning. Engine (t14j) told; can override (one-character change). pd-drawh re-check started on t155.

## 2026-11-11 p5-http: DONE (commit 4fad32a)

- Verifier p5-httpv (t17c): PASS (codex, grok: no findings); MEDIUM 1 (replay guard O(n), uncapped) fixed and
  re-checked PASS. `bun test` re-run by me: 315 pass, 0 fail. Engine (t14j) told the commit id and the main.js
  line; `oidc` null → sign-in routes 503 `sign-in-unavailable` (checked: http.js:15,140,147).
- Open LOWs (M8 hardening): no rate limit on callbacks (1:1 outbound call to Google); logout local only.
- Not done: real Google client (CEO credentials), web/ reading `#token` (client track).
- Sessions t17b, t17c closed, killed, removed.
- Engine: httpRoutes wiring goes into engine's next job p2-swap (after scaffold round-3 verification), with a test that POST /boards via dev Bearer creates a board a socket client joins. Engine will notify.
- p8-deps (t17n) started for engine's p4-natss3: Dockerfile installs bun.lock (--frozen-lockfile --production); CI cluster job gets MinIO + bucket + throwaway S3_* values. Commit only after engine's commit with package.json + bun.lock (t14j to send its id).
- p8-deps: VERIFIED (p8-depsv PASS; M1 CI exec timeouts fixed, re-check PASS), **not committed**: waits for engine's
  commit of package.json + bun.lock (t14j to send its id). Then commit by path: deploy/Dockerfile, deploy/README.md,
  .dockerignore, .github/workflows/ci.yml, docs/m2/briefs/p8-deps*.md, docs/m2/reports/p8-deps*.md (re-run bun test
  first; re-check the diff if those files moved). Sessions t17n, t17r closed, killed, removed.
- p8-deps: DONE, committed after engine's 0d40b86 (package.json + bun.lock). `bun install --frozen-lockfile` clean,
  bun test 315 pass, YAML parses.
- pd-drawhv re-check (t155): FAIL, 1 new HIGH (present since the first cut): R1, a stale drawh save silently
  reverts a peer's board-settings change for everyone (28 of 35 while an agent draws; codex agrees). Graded HIGH
  by me. Plus RM1 (FAT disk: swap is a plain rename), RM2 (link fallback losses, accepted), RM3 (seeding hazard
  facts for the doc). Fix round 2 on t14y (40% context; told to hand off at 60%).
- p5-flake (t182): test/auth/http.test.js:503 asserted a wall-clock ratio (failed 2/132 under load, found by client's p6-land). Replace with a deterministic count; must still fail on the old O(n) pruning.
- p5-flake: DONE (commit c0ff386). Verifier PASS: no wall-clock assertion, fails on three O(n) mutations, 100/100
  runs under full CPU load. bun test 325 pass. Declined the verifier's extra stress re-run (report already
  complete); confirmed no leftover load processes. Sessions t182, t183 closed, killed, removed.

## 2026-11-11 drawh re-check 2 FAIL; round 3; manager handoff

- Re-check 2 (t155): R1 fixed, but the 10 s window silently bounces real settings reverts (R2a) and swallows a
  change-and-change-back after any bounce (R2b). Root cause: settings carry no version. Round 3, the last, on a
  fresh builder t185 (t14y at 46% retired, closed, removed): clock-free base-generation marker, or the scope cut
  (settings room → file only) if the pane drops the marker. If re-check 3 fails, ship the scope cut.
- Sent to engine via proxy: settings versions in the protocol; room identity in v1 welcome. README PASS is stale
  (needs refresh + re-verify after p2-swap).
- Handoff: docs/m2/handoff/manager-platform.md. t14q at ~53% context hands off now.

## 2026-11-11 ~20:10 manager platform t187 takes over from t14q

- Roster: t185 worker pd-drawh3 (round 3, running, 10%); t155 verifier pd-drawhv (idle since 20:05, 37%, reuse
  for re-check 3).
- Proxy: engine's p1-v11 (spec only) adds per-key appSeq compare-and-set for settings and welcome room
  { board, epoch }. Relayed to t185: Step 1 still decides; if option 1, store per-key base as the room appSeq so
  the bridge can later send it as the CAS base; the patch must not depend on unlanded code.
- Proxy: v1.1 committed on p2-land (cb343b9): settings ops carry `appBase` (per-key compare-and-set, soft
  `stale-setting`), welcome carries room {board, epoch}. drawh breaks under v1.1 until it sends appBase. Plan sent to
  engine (t14j): round 3 verifies against v1; round 4 (v1.1 adapter) starts on engine's verified v1.1
  packages/protocol commit, and both land together.
- Engine (t14j) agreed. v1.1 protocol code = p11-proto (p2-land worktree), started now; t14j sends its verified
  commit id on p2-land before merge, and its report gives the Replica/Room API. drawh round 4 must not assume:
  Replica names beyond PROTOCOL.md v1.1 until that report; welcome.room from a real server (missing room =
  unknown epoch, not an error); soft-refusal retry timing beyond the spec rule.
- p5-slow (t18d) started (proxy, from engine's scaffold round 4): test/auth/http.test.js:486 replay-guard O(1) test
  timed out at bun's 5 s under load. Shrink to ~1,000 calls per phase + explicit timeout; keep the mutation check.
- p5-slow: DONE (commit 061ef4c). Verifier p5-slowv (t18f) PASS, 2 LOW (uncounted extra scan, old; smaller set lets
  a scan-every-1,001st mutation pass). 150/150 under load. My `bun test`: one run under heavy machine load had 2
  failures I didn't capture; the next two runs 331 pass, 0 fail. Sessions t18d, t18f closed, killed, removed.
- pd-drawh round 3 (t185) built: option 1 (generation marker appState.herdr.plenaryGen + 64-entry table; per-key
  room appSeq stored for the future appBase). Step 1: the marker survives drawh commands and the pane's FileStore
  save. R1 0/36 + 0/55 undone; R2a, R2b sent at once; H1 0 lost of 1,539. Gates: herdr-draw 301 pass, plenary 331.
  Re-check 3 (last) started on t155 (idle 54 min, 37%). t185 kept until the verdict (fix-round reuse if needed).
- Proxy: capture failing test names on any failed full run (`bun test 2>&1 | grep -E '\(fail\)'`). My uncaptured 2
  failures were most likely engine's test/server/outbound.test.js (t185 saw it in the same window); told proxy.

## 2026-11-11 hexagonal rule (CEO via proxy; OFFICE.md 1f25e61)

- Every brief from now: Architecture line + distributed-systems-design skill (builder APPLIER, verifier CHECKER);
  sessions start with --plugin-dir /Users/r/repos/systems-design.skill.
- Audit of server/auth, server/admin: one real violation: engine's server/registry/sqlite.js:18 and postgres.js:20
  import `mint` from platform's in-memory Registry adapter. Type-only: Identity from oidc.js in dev.js, port.js.
  The IdP port (begin/finish) is unwritten and has no contract test.
- Engine (t14j) agreed: p5-hex's builder changes exactly those import lines (postgres.js is engine-uncommitted; tell
  t14j when it lands); in-memory adapter stays in server/auth/ until engine's p-arch audit; engine folds our
  test/auth/architecture.test.js into test/architecture.test.js.
- p5-hex (t18k) started: registry-port.js, IdP port module, contract tests (IdP, Auth verifiers), import-rule test.
- pd-drawh re-check 3 (t155): FAIL on one narrow HIGH, R3: hide/show/hide 0.1 s apart from one generation drops the
  third silently (4/45 live; certain in-process). Cause: the generation's `sent` list is checked first. All else
  passes (R1 0/34 + 0/51, R2a, R2b, marker loud, RL2, H1 0/1,535, gates). Own-undo limit graded MEDIUM (accepted by
  me: the file already lost the change before the bridge sees it; documented). Stray sync-state file in the real
  ~/.cache/herdr-draw/plenary/ from an early run without DRAWH_STATE_DIR: left alone (not ours to delete blind).
- Decision (mine, reversible): instead of the pre-set "ship option 2 on fail", ONE narrow fix round 3b on t185
  (25%): R3 + codex's variant only, verified by a narrow re-check. Why: a one-rule fix with a crisp test is smaller
  than the scope cut, which also needs a build and a re-check and drops a working feature. Hard stop: another HIGH
  means option 2.
- Proxy agreed to 3b with the hard stop; if 3b gets complicated, prefer the scope cut now and do settings properly on v1.1 (appBase CAS). Guard sent to t185: stop and report 'too complex' rather than add rules.
- Engine manager is now t18m (t14j retired). Promises stand: v1.1 code commit id on p2-land after its round-4 check; missing welcome.room = unknown epoch. p5-hex import-line landing goes to t18m.
- Engine (t18m): v1.1 protocol code verified, committed on p2-land 5d55112 (worktree ../plenary-p2); server half (Store epoch, welcome.room) comes with p2-swap. Round-4 brief written: docs/m2/briefs/pd-drawh4.md; starts after 3b (same patch file). Patch and v1.1 land together.
- p5-hex built (t18k): registry-port.js, idp-port.js (Identity, IdP, Verifier), contracts (IdP vs googleOidc +
  fake IdP adapter; Verifier vs sessions + devAuth), test/auth/architecture.test.js (8 violations on the old tree;
  my audit missed tenancy.js and admin/boards.js JSDoc imports of adapters, and session.js). bun test 367 pass.
  Engine lines changed: sqlite.js:18, postgres.js:20,:38; sqlite.js:32 (type) excused in KNOWN, asked t18m to allow
  it. Verifier p5-hexv (t18n) started (CHECKER mode + ensemble).
- Engine (t18m) agreed all four lines: sqlite.js:18, :32 in platform's commit (KNOWN excuse dropped); postgres.js:20, :38 ride with engine's p4-pg commit. Send t18m the commit id. Amendment sent to t18k; t18n told to re-check it.

## 2026-11-11 Google OAuth client exists (CEO via proxy)

- Web client in Omniping; redirect http://localhost:8080/auth/callback; consent External, Testing (test users only).
  GOOGLE_CLIENT_ID/SECRET in .env (checked: gitignored, mode 600, two keys; values not read by me).
- Note: Bun auto-loads .env from the cwd, so every `bun test`/`bun run` in this repo now has both values in env.
- p5-google (t18p) started without waiting for p2-swap: a standalone dev harness (httpRoutes + googleOidc + sessions
  + memory registry, 127.0.0.1:8080) and a live check skipped unless PLENARY_LIVE_GOOGLE=1: login 302 shape, Google
  accepts the client and redirect (sign-in page, no invalid_client/redirect_uri_mismatch), JWKS parses, bogus
  callback refused cleanly; secrets never printed. Ends with human-login steps for the CEO. Rerun against the real
  server after engine's p2-swap mounts httpRoutes (main.js must read GOOGLE_* env then: engine's).
- drawh 3b (t185): R3 fixed with one rule-order change (board still holds last sent value → file's differing value is the writer's; sent). codex's variant (value set again after a peer change) keeps the board's and prints one line (same bytes as R1's stale save); setting again is sent. toggle3 0/30 wrong, R1 0/36 + 0/55, herdr-draw 303 pass. Narrow re-check 3b on t155 (43%).
- p5-code (proxy, MEDIUM from client's p6-land verifier): #token= lands in Chrome History. Brief written
  (docs/m2/briefs/p5-code.md): callback → #code (≤ 60 s, single use, bound to an HttpOnly SameSite=Strict binder
  cookie), POST /auth/exchange → token; Origin check; prefer a stateless signed code so any node can exchange.
  Shape sent to client (t14k) for p6-hex. Builder starts after p5-hex commits (both edit http.js).
- p5-hexv (t18n): PASS, 2 MEDIUM (import checker skips export-from under a comment; IdP contract misses PKCE binding and double finish), 7 LOW. Fix round on t18k (MEDIUMs + LOW 3 cheap forms, 5, 6). LOW 8 (postgres.js Registry imports Store adapter) forwarded to engine t18m. LOW 9: one unexplained architecture-test failure in 8 full runs (likely a file appearing mid-run).
- p5-google (t18p) built: scripts/dev-google.js harness + test/auth/google-live.test.js (skipped unless
  PLENARY_LIVE_GOOGLE=1). Live: Google shows its account chooser for our client + redirect (negative controls give
  redirect_uri_mismatch / invalid_client); discovery + JWKS OK; bogus callback → invalid_grant → our 400; Chrome keeps
  the __Host- cookie on http://localhost. Human-login steps in docs/m2/reports/p5-google.md. Risks: replay-guard
  cap 100k/process at the join NFR; Google token endpoint per fresh login; no sign-in metrics. Verifier t18z started.
- p5-hex fix round done (t18k: 376 pass); narrow re-check on t18n.
- p5-hex: DONE (commit 02b7434), incl. sqlite.js:18,:32. My bun test 376 pass, 0 fail. postgres.js:20,:38 left for engine's p4-pg commit. Sessions t18k, t18n closed, killed, removed.
- p5-code (t196) started on top of 02b7434.
- p5-googlev (t18z): PASS, 2 MEDIUM: (1) live test prints client_id in a thrown fetch error if Google is unreachable: fix round on t18p; (2) anonymous replay-guard fill locks out sign-in for 10 min: folded into p5-code (t196). 5 LOW.
- Client (t14k) saved the exchange shape as docs/m2/contracts/auth-exchange.md. Answered: user non-empty; name/email/domain string|null (domain = hd, null for non-Workspace); exp int seconds; client-side {error:'network'} OK. t196 told to match + pin types; send t14k the p5-code commit id.
- p5-google: DONE (commit 95971bd). Secret scan of the committed files against .env values in-process: 0 hits. bun test 478 pass, 0 fail. Port 8080 free. Sessions t18p, t18z closed, killed, removed.
- Naming rule (OFFICE.md 7f680a3): sessions get --name plenary-<job>[v] in hc run and claude -n; tab labels 'worker <job> (platform) · <id>: <what>' / 'verifier <job>v (platform) · <id>: <what>'. Applies to every new session.
- p5-code built (t196): #code + signed x1. exchange cookie (carries identity + sha256(code); stateless, any node), POST /auth/exchange, failed callbacks take no replay slot. 480 pass. Deviation: cookie holds signed identity, not a bare binder (keeps identity out of URLs). Risks: one origin required; parallel sign-ins; exp decoded from session.js format. Verifier p5-codev (t1bh, plenary-p5-codev) started.
- drawh re-check 3b (t155): FAIL on HIGH case V (user's undo silently dropped when a peer's change lands between; not
  new in 3b, found by codex). R3 fixed (0 silent drops in 161 runs). Hard stop applied: ship option 2 (scope cut:
  settings room → file only while connected, loud line on a file-side change, seeding of unset keys kept). Building
  on t185. Settings from the file come back properly in round 4 on v1.1 (appBase compare-and-set).
- Proxy is now t1bx (t14h retired; handoff 9d06783). Report to t1bx. t185, t155 relabelled reports-to=t187.
- p5-codev (t1bh): PASS, 2 MEDIUM (one-origin requirement unenforced; dev-google.js still reads #token), 7 LOW; real Chromium shows no token/identity in any URL. Fix round on t196 (both MEDIUMs).
- drawh option 2 built (t185): settings room→file only, loud line + held on a file-side change, seeding of unset keys, a 'written' memory so a peer's change arriving isn't misread. herdr-draw 289 pass, plenary 507. Re-check 4 (scope cut) on t155.

- p5-code: DONE (commit 3f6b489). Verifier PASS + re-check PASS (both MEDIUMs fixed; dev harness signs in end to end in Chromium). Secret scan 0 hits; bun test 510 pass, 0 fail. t196, t1bh closed, killed, removed.

- drawh re-check 4 (scope cut, t155): passes everything the round was for (no peer change undone; toggles, undos, case V refused loudly). One narrow gap by the letter of the bar: an out-of-range value (grid 2000) in the file is put back with no line; it could never reach the board. My call: fix it (one-line order change + test) rather than accept, since it's cheap; MEDIUM (misleading first line after a start) if contained. t185 fixing; t155 then a tiny re-check.

- CEO's live Google sign-in PASSED 2026-11-12 04:44Z (login 302, callback 302 loginCookie true, /signed-in 200, exchange 200). Recorded in p5-google.md; thread closed.

- Engine (t18m): postgres.js committed with registry-port imports (b804f3b), so the re-export can go; and test/auth/google-live.test.js fails 2/5 in a clean worktree without .env (the safeFetch cases); CI would see it. p5-tidy (t1d8, plenary-p5-tidy) started for both.

- Proxy (t1bx): push held for p5-tidy (clean checkout 508 pass / 2 fail, google-live safeFetch) and engine's R5-M1 (t18c). GitHub CI red on main since 04:13Z. Ping t1bx when p5-tidy lands.

- p5-tidy built (t1d8): cause = `leaks` helper returned undefined (not false) without .env; Boolean() fix; re-export dropped (no importers). Clean worktree: google-live 5 pass; one unnamed failure in 1 of 5 full runs. Verifier p5-tidyv (t1df) started.

- p5-tidy: DONE (commit d8fc084). Verifier PASS (5 clean-worktree full runs green, 3 LOW). My shared-tree bun test: 594 pass, 8 fail, all in client's untracked test/web/adapters/transport-ws.test.js (in-progress p6-edge work), named to t14k and t1bx; test/auth 151 pass. t1d8, t1df closed, killed, removed.

- Client (t14k): the 8 transport-ws failures are p6-edge (t1cy) mid-work; until it lands, full runs may skip them: `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`.

- CEO rule (OFFICE.md 'The proxy's input is the CEO's'): never prompt/hc send/SendMessage the proxy t1bx. Report by ending my turn with one short message (outcome first, report path); urgent = say so first. Workers report to me only. Phase 3 pushed to origin (378d089, clean 510/0).

- drawh option 2 fix (t185): invalid-value put-back now prints a line; MEDIUM (first peer change after start) fixed. Re-check 4b on t155.

- drawh re-check 4b (t155): the four asked items PASS; one more hand-edit-only gap (invalid value in a never-set key dropped quietly; could never reach the board). Accepted by me as LOW and written under 'Risks and limits' in drawh-server.md. bun test (transport-ws ignored) 573 pass, 0 fail. **pd-drawh: DONE (commit c3adcba)**, patch sha256 779198853abb22b4…, waiting on the CEO: approve/reject. t185, t155 closed, killed, removed. pd-drawh4 (t1ds, plenary-pd-drawh4) started on v1.1 (brief updated: base c3adcba, bring file-side settings back, R1-R3 + case V must hold).

- pd-drawh4 (t1ds) handed off at its context limit (docs/m2/handoff/pd-drawh4.md): v1.1 bridge built, herdr-draw 304 pass; left: patch's CLAUDE.md paragraph, live scripts on a v1.1 stand-in incl. measure.sh. Successor t1f4 (plenary-pd-drawh4-2). t1ds closed, killed, removed.

- pd-drawh4 built (t1f4): v1.1 bridge, file-side settings back; herdr-draw 304/0; live: case V refused loudly, undo 20/20, toggles 0/161 wrong, R1 0 undone, measure.sh + measure_s.sh LOST 0. Patch sha256 0cbf6109011b43b2…. Open: snapshot = another room; write-back after stale-setting may overwrite a newer file change (asked the verifier to probe). Verifier pd-drawh4v (t1ff) started.

- pd-drawh4v (t1ff): FAIL by the letter, narrow: H1 a newer value saved after a stale-setting refusal, before the write-back, is overwritten silently (open question 2 confirmed); H2 32-bit hash collision takes the quiet path (negligible reach). 2 MEDIUM, 3 LOW. Gates pass (plenary 627/0). Fix round on t1f4 (H1, H2, MEDIUMs if contained); t1ff's live runs still finishing.

- Round 4 fix (t1f4, not stuck: live reruns running, 20% context): H1 held + said (P6, P8, P4b), H2 hash replaced by canonical values (P11 said), M1 not fixed; patch re-cut sha256 ed615d64…; gates herdr-draw 308/0, protocol 128/0, plenary 627/0. Proxy nudged; re-check started on t1ff in parallel with t1f4's live runs.

- Engine (t18m): after p2-swap (phase-2 merge) main.js refuses cluster mode without COOKIE_KEY (>= 32 bytes). Queued job p8-cookie: cluster compose + CI cluster job get COOKIE_KEY from env (compose: required var, no value in the repo; CI: a throwaway random key generated in the job), deploy/README. Start when t18m sends the merge id.

- Round 4 re-check (t1ff): FAIL on one narrow H1 remainder (V5: new value, then back to the dropped value, both inside the refusal window: last save overwritten silently; live 8/8, codex agrees). M2 fixed; M1 loud, loses nothing. Gates pass. Decision (mine): one more small fix on t1f4 with a HARD STOP: another silent case in this window = accept the remaining narrow cases as documented limits.

- Engine (t18m), p2-swap asks: (1) session verify() returns exp: p5-exp (t1fp, plenary-p5-exp) started; (2) grants announce stays a wrapper in main.js (hexagonal: adapter must not import the Bus) — told t18m; (3) Registry Postgres least privilege: queued p5-pgpriv, asked t18m whether p2-swap touches server/registry/postgres.js; (4) COOKIE_KEY: p8-cookie on the merge id.

- drawh round 4 final check (t1ff): everything named holds (V5 fixed live 8/8, variants loud, R1-R3 + case V, no peer change undone; herdr-draw 316/0, protocol 128/0, plenary 627/0; patch f4f9b05a2d3ec81e…). One more ~20 ms same-batch case (F5): accepted under the hard stop and written into drawh-server.md limits. NOT committed yet: the round-4 patch needs v1.1, so it lands with the phase-2 merge (commit on t18m's merge id), keeping c3adcba as the proposal under CEO review until then.
- Engine (t18m): p5-pgpriv after the merge, built on store/postgres.js migrate() (p-arch later moves it to server/pg/schema.js).

- Changed my mind on holding it: committed drawh round 4 now (6961449) so it is durable in the shared tree; the patch carries its own v1.1 protocol copy, and the doc says it needs the v1.1 server. bun test 627/0. CEO's pending review now covers this version. t1f4, t1ff closed, killed, removed.

- p5-exp built (t1fp): verify() returns Identity + flat `exp` (gateway on p2-land reads identity.exp, seconds); tokenExp gone; 633 pass. Verifier p5-expv (t1fq) started.

- p5-exp: DONE (commit e82a537). Verifier PASS (3 LOW). bun test 633/0. t1fp, t1fq closed, killed, removed. t18m told.

- Phase 2 merged to main (dcbdae6; bun test 884/0 per t18m). Started p8-cookie (t1fs), pd-drawh-live (t1ft: drawh vs the real server, scratch clone only), p8-readme2 (t1fv: README.md). p5-pgpriv waits for engine's p-arch commit (moves schema helpers to server/pg/schema.js, does the registry import line).

- Proxy: phase 2 pushed (origin 2a0409c); wants the drawh live run with a verifier, then a report. Already running on t1ft; verifier pd-drawh-livev follows.

- p8-cookie built (t1fs): cluster compose + CI supply COOKIE_KEY; cluster brought up on Podman (no Docker here), torn down (down -v; images left in Podman's cache); 884/0. Healthcheck quirk under Podman noted. Verifier p8-cookiev (t1fz) started.

- p8-cookie: DONE (commit 601f8e9). Verifier PASS (5 LOW). My full bun test: 977 pass, 1 fail: engine's test/server/v1.test.js token-expiry close test hit the 5 s timeout under load (passes 12/12 alone, 3 runs); unrelated to deploy/ files; I committed before reading the result, then checked; flake sent to t18m. t1fs, t1fz closed, killed, removed.

- pd-drawh-live (t1ft): drawh works against the real v1.1 server (shapes + settings both ways, --once codes, catch-up, reconnect; no ack'd op lost over a restart). Mismatches: M1 every clean restart = 'another room' (server checkpoints on stop and answers with a snapshot) and a settings change made while down is thrown away (loudly); M2 a new drawh file joining a board with layers warns and exits 2; M3/M4 stale doc text. S1: POST /boards can't work on a dev node (no tenant admin). Decision (mine): fix round on t1ft for M1 (same room iff welcome.room board matches and epoch strictly greater), M2, M3/M4; then a fresh verifier re-runs live; then report to the proxy for the CEO. S1 queued as p5-devadmin (needs main.js: ask engine).

- Engine (t18m) on S1: one owner (platform): idempotent bootstrapTenant + CLI in server/admin/, and main.js's dev path calls it for dev tokens flagged admin:true (engine allows those lines only). p5-devadmin (t1g1) started. Tell t18m the commit id.

- p8-readme2 built (t1fv); verifier p8-readme2v (t1g2) started. Its side findings: (a) no tenant bootstrap = covered by p5-devadmin; (b) after Google sign-in the browser lands on GET / = 404 (postLoginUrl default; until the server serves web/: client/engine); (c) deploy/README.md:21 stale ('POST /boards and Google sign-in are not wired'), platform's: fix in a follow-up; (d) main.js:152 stale log line (engine's); (e) docs/m2/PLAN.md names the Google Cloud project and the README links to it: for the proxy before anything goes public.

- Engine (t18m): main.js:152 stale log line goes into p5-devadmin (sent to t1g1); engine will serve web/ statically at / (job after p2-tune).

- Engine: p-arch on main (44dd1aa, server/pg/schema.js). The COMPOSITION_ROOTS line for scripts/admin-bootstrap.js comes in p-arch's follow-up (t1fx); t18m sends the id. p5-pgpriv (t1g4) started; also fixes deploy/README.md:21 (stale 'not wired').

- p8-readme2v (t1g2): PASS, 1 MEDIUM (Google sign-in in the PORT=0 block lands on the wrong port: redirect defaults to :8080), 3 LOW. Fix round on t1fv; t1g2 re-checks.

- p8-readme2: DONE (commit ec8680b, README.md + the p8-readme* briefs/reports from both rounds). Re-check PASS; secret scan 0 hits. t1fv, t1g2 closed, killed, removed.

- p5-devadmin built (t1g1): bootstrapTenant (server/admin/tenants.js), CLI scripts/admin-bootstrap.js, main.js dev path (admin:true tokens), main.js:152 log fixed; email:<addr> tenant admins matched in boards.js (vouched email + same hd); 1044/0, both architecture tests pass. Engine told: SQLite 'database is locked' on concurrent first open; PROTOCOL.md could document email admins. Verifier p5-devadminv (t1g7) started, security focus on the email-admin match.

- Engine (t18m): server/registry/ is platform's: sqlite.js busy_timeout + concurrent-first-open tolerance added to t1g4's job (p5-pgpriv). PROTOCOL.md email-admin note at engine's next touch.

- drawh live fix round (t1ft): M1 fixed by judging a snapshot by its contents (agrees(): not behind the tip, every confirmed element/setting at >= version/appSeq); deviation from my epoch-only rule accepted (equal epoch needed for the 1,000-entry checkpoint case; a wiped store can raise its epoch). M2, M3, M4 fixed. herdr-draw 324/0; live rerun clean (no false 'another room', offline grid reached the board). Patch 930623ea…. A review flagged 3 security MEDIUMs in the patch (python -c without -I; predictable symlink-following temp names; unfiltered server text in say()): sent back to t1ft to fix before the verifier.

- 03:44: every agent was killed (herdr-core lost its holder); the proxy resumed me and t1ft, t1g7, t1g4 in place (same ids; all three working again). Watches re-armed. t1g1 (p5-devadmin builder) not resumed: plain shell; resume only for a fix round: claude --resume 4af4429f-6d9f-4cea-b793-4178fa06bf73 --model opus --permission-mode auto.

## CURRENT STATE (kept current every turn; a refreshed manager starts here)

- **p5-tidy COMMITTED (2026-11-12, round 3):** verifier p5-tidy3v (t1hy) PASS with LOWs (docs/m2/reports/p5-tidy3v.md). V6 (doc sentence p5-google2.md (e) overclaimed which causes tests produce) fixed by the manager with the verifier's wording. Open LOWs, queued for a later tidy: N2 (table test accepts made-up `idp_error:`/`token_http_` examples), N3 (truncation note at code point 81 not pinned). Gate 1375 pass, 1 fail (core-source, known). t1hw, t1hy closed.

p5-load4 COMMITTED 479cf46 (verifier t1hf PASS, LOWs only: -3 check refuses test/server/revocation.test.js because of another session's edits; PROTOCOL hunk adds a "**Role cache.**" label). t18m told: apply docs/m2/reports/p5-load.patch whole (PROTOCOL hunk with the main.js roleCache wiring, or drop both), re-run `git apply --check` first, then `bun test test/server`; no reply owed. t1hc, t1hf closed. p5-load3 COMMITTED 426757d.

p5-pgpriv2-4 COMMITTED c2024f3 (verifier t1gz PASS round 4; t18m told; t1gs, t1gz closed).

Manager platform: t187. Parent: proxy t1bx (NEVER message it; end the turn with a short report, its watch reads it). Engine manager t18m, client manager t14k.

Second restart (after 03:44): workers re-prompted by the proxy. Current watch: none (p5-tidy committed; earlier: core:t1hy, verifier p5-tidy3v (proxy 2026-11-12: start the tidy job unless it collides with engine; checked, no dirty files in its paths)) (earlier: core:t1hq; proxy 2026-11-12: start p5-google2 scripted part, stop before CEO login; p5-devadmin2 if no collision with engine's p5-load patch files: none).

| Terminal | Name/tab | Job | State | Next |
|---|---|---|---|---|
| t1ft | worker pd-drawh-live | done: M1-M4 + 3 security fixes, patch sha256 680ec536… | idle | keep for drawh LOWs L1/L2/L7 if the CEO wants them; else close |
| t1gn | verifier pd-drawh-livev | PASS, LOWs only (L1-L7), report docs/m2/reports/pd-drawh-livev.md | committed 4d93b40; closed | CEO approves/rejects |
| t1gx | verifier p5-load2v + re-check 2b | PASS both; committed ec731c7 (tenancy.js, role-cache.test.js, p5-load2/2b/2bv/2v). Re-check LOWs carried to the re-cut: A keep `invalidate(board)` before `rolesFor` in GAP-M6; B PROTOCOL clause -> "never hides a revoke past the next timed pass"; C stale roleCache header comment; D tests for min-over-links and joined-read cap | closed | - |
| t1gv | verifier p5-pgpriv2v | FAIL on H1 (+M1, LOWs), report docs/m2/reports/p5-pgpriv2v.md | closed | none (fresh verifier p5-pgpriv3v after the fix round) |
| t1g4, t1gg, t1g1, t1g7, t1gr | p5-pgpriv{,v}, p5-devadmin{,v}, p5-loadv | done (740665f, 7a44278, 1d73436) | closed | none |

Told t18m (engine): p5-load tree committed 1d73436, do NOT apply p5-load.patch until re-cut and verified. F4+F8 = p5-load; F9 = p5-snap (HTTP snapshot route + signed snapshot ticket in welcome), starts when engine's p-fanout fixes the snapshot/tail shape.

Done today: p5-load tree 1d73436, drawh live 4d93b40, p5-pgpriv 740665f, p5-devadmin 7a44278, p5-slow 061ef4c, p5-hex 02b7434, p5-google 95971bd, p5-code 3f6b489, p5-tidy d8fc084, pd-drawh c3adcba, pd-drawh4 6961449, p5-exp e82a537, p8-cookie 601f8e9, README ec8680b.

Pending for t18m (engine, p4-store-lease 00cf69c): add to deploy/README.md Postgres roles section, before `### Registry time limits`, (1) the pre-lease `pl_leases` upgrade paragraph from docs/m2/reports/p4-store-lease.md:52-55 (needs-migration; ALTER ... ADD COLUMN IF NOT EXISTS holder, expires_at as owner; idempotent, keeps epochs) and (2) the Store's start-up grant probe (refuses `denied` naming what's missing; SELECT/INSERT pl_entries, SELECT/INSERT/DELETE checkpoints, SELECT/INSERT/UPDATE pl_leases; step 3 grants cover it; "never ALTER/DROP/GRANT" stays true; also fix "The Store's message is Postgres's own `permission denied`", now stale). Folded into fix round p5-pgpriv4 (step 5) so t1gz checks it; commits with the pgpriv files. No reply owed to t18m.

Waiting on the CEO: approve/reject the drawh proposal (docs/m2/proposals/drawh-server.md, verified live 4d93b40).
Running: p5-tidy BUILT (t1hs closed; report docs/m2/reports/p5-tidy.md round 2, 13 mutations killed; it reuses the p5-tidy name of d8fc084, old brief/report in git history; also adds mint_failed and labels non-JSON 502 as bad_token_response) and its verifier p5-tidy3v t1hv running; next on PASS: gate, commit by path. p5-google2 COMMITTED 35d5f5a (verifier t1hq PASS; t1hm, t1hq closed): READY FOR THE CEO'S LOGIN, steps in docs/m2/reports/p5-google2.md "Hand-off: the CEO's login" (allow-pasting note added for L3). p5-devadmin2 COMMITTED 84399eb. Gate at 35d5f5a: 1318 pass / 3 fail = core-source (herdr-draw dirty tree) + two in other sessions' uncommitted work (test/server/room-host-lease.test.js MEDIUM-3 repro F; test/server/gateway.test.js 'entries subject carries each entry once'); test/auth + test/admin 214/0. Queued tidy job: devadmin2 F1-F3, google2 L2 (200 non-JSON token answer labelled idp_unreachable, oidc.js) and L4 (cause table missing labels). L1 (auth logger ignores LOG_LEVEL; fix is log.child in main.js) sent to engine t18m. Still waiting: p5-snap (F9) on engine's p-fanout; drawh proposal 4d93b40 on the CEO; p5-load.patch on engine/CEO.
Queued: p5-snap (F9, waits on p-fanout).
Known unrelated failures: test/core-source.test.js (herdr-draw dirty tree); tune.test.js R2 tests (engine's p2-tune r2, t1fw).

- herdr-draw (~/repos/herdr-draw) has someone's uncommitted edits since ~07:45 (CLAUDE.md, core/editor.js, core/geometry.js, mods, test/arrows.test.js); the patch fails on that CLAUDE.md (line 44). A clone of 5dfe352 is unaffected; applying in place needs those edits committed or set aside, or a re-cut.
- Because of those herdr-draw edits, plenary's test/core-source.test.js ("packages/core is still herdr-draw's core") fails: it reads ../herdr-draw/core from the working tree. Not ours to fix; last full run 1196 tests, 1 fail (that one).
- deploy/README.md keeps an uncommitted endpoints hunk (~line 20: POST /boards, /auth/*) from another job; 740665f took only the Postgres roles section.
