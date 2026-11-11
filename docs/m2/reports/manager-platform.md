# Report: manager platform

Manager terminal: `t14q` (tab `manager platform`). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p5-auth (builder) | t14s | done p5-auth | reported, idle |
| p5-authv (verifier) | t153 | verifier p5-authv: OIDC + tenancy | RUNNING |
| p8-ign (builder) | t150 | done p8-ign | reported, idle |
| p8-ignv (verifier) | t152 | verifier p8-ignv: ignore files | RUNNING |
| pd-drawh (builder) | t14y | worker pd-drawh: drawh proposal | RUNNING |

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
