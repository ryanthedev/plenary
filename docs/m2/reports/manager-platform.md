# Report: manager platform

Manager terminal: `t14q` (tab `manager platform`). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| pd-drawh (builder) | t14y | done pd-drawh (platform) | reported, idle |
| pd-drawhv (verifier) | t155 | verifier pd-drawhv (platform): drawh proposal | RUNNING |
| p8-readme (builder) | t15s | done p8-readme (platform) | reported, idle |
| p8-readmev (verifier) | t161 | verifier p8-readmev (platform): repo README | RUNNING |

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
