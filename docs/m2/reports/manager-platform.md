# Report: manager platform

Manager terminal: `t14q` (tab `manager platform`). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p5-auth (builder) | t14s | worker p5-auth: OIDC + tenancy | RUNNING |
| p8-ign (builder) | t150 | worker p8-ign: ignore files | RUNNING |
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
