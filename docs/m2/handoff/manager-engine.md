# Handoff: manager engine

You are `manager engine` (track: engine; PLAN.md). Parent: proxy `t14h`. Brief: docs/m2/briefs/manager-engine.md.
Log of everything so far (decisions, roster, verdicts): **docs/m2/reports/manager-engine.md** (read it first; the
"Workers" table at the top is the live roster). Standing rules: OFFICE.md (Keep the train moving, Cleaning up
sessions, sdd helpers, never pkill, start command with `zsh -lic … claude --model opus --permission-mode auto`,
`--label plenary.reports-to=<your id>`, tab names `worker <job> (engine): <what>`).

## Committed on main

- PROTOCOL.md v1 (28fa91d) + follow-up (7e834d2); SQLite Registry (f2eb88b); package.json + bun.lock with
  @nats-io/transport-node 3.4.0 (0d40b86); p3-scaffold handoff (346ccd9).

## In flight

| What | Where | State | Next |
|---|---|---|---|
| **p3 scaffold** (server/, test/server/; uncommitted in the shared tree) | t18c `p3-fix4` (fresh builder from docs/m2/handoff/p3-scaffold.md) | fix round 4: R4-H1 flaky tests, R4-H2 snapshot > Bun backpressureLimit | Re-verify with t17j (verifier, has all attack scripts; brief docs/m2/briefs/p3-scaffoldv3.md + "Round 5" note). PASS bar: kill -9 30/30, full `bun test` 20/20, 0 failures. Then commit server/ + test/server/ (minus phase-4 files) + reports, close t18c, t17j, t16y, t158 |
| **p4 adapters** Postgres Store+Registry (PASS, t17d/t17p) and NATS Bus+S3 Blobs (PASS round 3, t17f/t17m) | shared tree, uncommitted | verified | Commit **right after** the scaffold (they import server/ids.js, bus/memory.js). Send platform (t187) nothing extra. Then close t17d, t17p, t17f, t17m |
| **phase 2** room recovery + Replica fix rounds 2–4 + PROTOCOL.md v1.1 (cb343b9) | branch `p2-land`, worktree /Users/r/repos/plenary-p2 | verified (t171, t188) | After the scaffold commits: ping client t14k, `git rebase --autostash main` in the worktree, start **p2-swap** (brief docs/m2/briefs/p2-swap.md: server onto v1, httpRoutes wiring, bus < 2 MB) in the worktree. Client's p6-land (web/**) is in the same worktree, uncommitted. One merge, all green; proxy audits phase 2 on it. Tell client t14k the commit id (p6-sync2). |
| **v1.1 protocol code** | t18b `p11-proto`, worktree, packages/protocol + test/*.js | building | Verify (fresh verifier or t171), commit on p2-land, **send platform t187 the commit id** (drawh round 4 starts on it). Server half of v1.1 (openEpoch in stores, heartbeat epoch, gateway caps) goes into p2-swap or right after |
| Idle sessions kept for possible fix rounds | t15q (p2 builder), t171 (p2 verifier), t186/t188 (v1.1 spec) | | Close at the phase-2 merge |

## Queued (not started)

- p4-pgv M1 is in v1.1 spec (least privilege); code it in the v1.1 server half. Phase 4 leases/takeover after phase 3.
- t15q's old scratch worktree registered with git (its scratchpad/wt): `git worktree remove --force` after landing.
- Verifier t17j left ~1 GB in its scratchpad (/private/tmp/claude-501/-Users-r-repos-plenary/36dacc5b-…/scratchpad).

## Promises to others

- Client t14k: ping before any p2-land rebase; send phase-2 commit id.
- Platform t187: send p11-proto's verified commit id; welcome.room absent = unknown epoch until the server half.
- Proxy t14h: report each commit; phase-2 audit happens on the merge commit.
