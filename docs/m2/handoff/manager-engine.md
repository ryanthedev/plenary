# Handoff: manager engine (from t14j, 2026-11-11, at ~52% context)

You are `manager engine` (track: engine; PLAN.md). Parent: proxy `t14h`. Brief: docs/m2/briefs/manager-engine.md.
Full log, decisions and verdicts: **docs/m2/reports/manager-engine.md** (roster table at the top; read the last
~40 bullets). Standing rules: OFFICE.md (Keep the train moving; Cleaning up sessions; sdd helpers; never pkill;
Architecture = hexagonal + systems-design skill APPLIER/CHECKER in every design-bearing brief). Start sessions with
OFFICE.md's command plus `--model opus --permission-mode auto`, `--label plenary.reports-to=<your id>`,
`--plugin-dir /Users/r/repos/systems-design.skill`; tab names `worker|verifier <job> (engine): <what>`.
Other managers: client `t14k`, platform `t187` (successor of t14q).

## Committed on main (engine)

PROTOCOL.md v1 28fa91d + 7e834d2; SQLite Registry f2eb88b; package.json/bun.lock 0d40b86; handoffs 346ccd9, 0d77863.

## Live sessions and what's next

| Session | Job | State | Next step |
|---|---|---|---|
| t18c | p3-fix4: scaffold fix round 4 (shared tree server/, test/server/; uncommitted) | running its final gate (21 loaded + 20 quiet full runs, kill -9 30 quiet + 15 loaded) | Re-verify with **t17j** (has all attack scripts; tell it "Round 5", same bar: kill -9 30/30, full bun test 20/20 incl. under load, 0 failures). On PASS: `bun test` yourself, commit server/ + test/server/ by path (exclude phase-4 files), plus reports/briefs. Close t18c, t17j, t16y, t158 |
| t17d, t17p / t17f, t17m | p4-pg (PASS) / p4-natss3 (PASS round 3): verified, uncommitted in the shared tree | idle | Commit each **right after** the scaffold (they import server/ids.js, server/bus/memory.js). Platform's p5-hex may first change only the import lines in server/registry/{sqlite,postgres}.js to server/auth/registry-port.js (agreed). Then close the four |
| t18b / t171 | p11-proto: v1.1 code in packages/protocol on p2-land (worktree /Users/r/repos/plenary-p2; uncommitted) incl. client accessors previewEntries/pendingOf | t171 verifying **round 4** (fix round 3: held key base fixed by its first held change) | On PASS: commit packages/protocol + test/*.js + PROTOCOL.md on p2-land by path; send the commit id to **platform t187** (drawh round 4) and **client t14k** (p7-wire) |
| t15q, t186, t188 | phase-2 builder, v1.1 spec builder/verifier | idle | Close at the phase-2 merge |

## The phase-2 landing (agreed with proxy and client)

1. Scaffold commits on main (above), then the p4 adapters.
2. Ping client t14k, then in the worktree: `git rebase --autostash main` (client's uncommitted web/ files, incl.
   p6-land and web/collab, ride along).
3. Start **p2-swap** (brief docs/m2/briefs/p2-swap.md; add the systems-design APPLIER line and the v1.1 server half:
   Store.openEpoch/epoch in sqlite+postgres stores, heartbeat {seq, epoch}, gateway writer cap 8, bucket per
   connection, too-large with id, catch-up never on the bus, .entries split < 2 MB, Postgres least privilege) in the
   worktree; verify (CHECKER mode); client's p6-landv (t181) must PASS too.
4. One merge into main, all green; tell client and proxy the id; proxy audits phase 2 on it.
5. Then: **p-arch** (brief docs/m2/briefs/p-arch.md, test/architecture.test.js + test/arch-scan.js for client and
   platform) and the **architecture audit** (server/ + packages/protocol, hexagonal + skill CHECKER vs the NFRs)
   on the merged tree. Findings become fix jobs. Then phase 4 leases/takeover.

## Promises

- Client t14k: ping before any p2-land rebase; send the v1.1 code commit id and the merge id.
- Platform t187: v1.1 code commit id; welcome.room missing = unknown epoch until the server half.
- Proxy t14h: report each commit; phase-2 audit on the merge commit.
- Cleanup: t15q's old worktree (its scratchpad/wt) `git worktree remove --force` after landing; t17j's ~1 GB scratch.
