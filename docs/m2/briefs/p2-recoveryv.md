# Brief: p2-recoveryv (verify phase 2: room recovery in packages/protocol)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PLAN.md phase 2, PROTOCOL.md (v1, committed 7e834d2) in full. **Do not read
docs/m2/reports/p2-recovery.md** (the builder's claims).

- **Your tab:** `verifier p2-recoveryv (engine): room recovery`. Manager: `manager engine`, terminal `t14j`.
- **Where the job is:** branch `p2-land`, git worktree **/Users/r/repos/plenary-p2**, commit 359c50d. The job's
  diff: `git -C /Users/r/repos/plenary-p2 diff 7e834d2..p2-land -- packages/protocol test`. It is NOT in the
  shared tree (/Users/r/repos/plenary), where `bun test` doesn't run it. Run `bun test` **in the worktree**.
- **Read-only:** everything, both trees. You own only /Users/r/repos/plenary/docs/m2/reports/p2-recoveryv.md.
- **Scratch tests** outside both repos (`mktemp -d`), importing the worktree's code by absolute path. Never
  `pkill`/`killall`; port 0; record PIDs.
- **sdd ensemble:** load `sdd:subagent-driven-development`, check usage, run codex over the diff in a scratch copy
  (so it can't edit either tree). Codex is the only harness today: label it "single harness"; its findings are leads.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings (where, failure scenario, fix). Then stop, idle.

## The job

Goal (PLAN.md phase 2): room recovery in packages/protocol, which stays pure (test/purity.test.js), per PROTOCOL.md
v1's "What phase 2 changes in packages/protocol". Plus manager additions: `Replica.local()` normalizes on send
(version = highest known for that id + 1, fresh nonce); `receive()` returns what it applied; `reset()` keeps pending
overlaid; Replica paces sends; a Room answers `unavailable` to ops from a connection it didn't welcome this
incarnation and drops `n` state on close; a refusal on `records` only drops that op (no reset); no-op record actions
are logged and acked; `opProblem` refuses nesting deeper than 64, iteratively; ops pending across a reset are
re-normalized against post-reset state (if never sent); a local version ahead of the Replica's with no pending op is
reconciled (confirmed copy wins).

Done when: a room rebuilt from MemoryLog (with and without a checkpoint) deep-equals the original; an acked op resent
to the rebuilt room gets the same ack/seq and nothing is logged; an annotator is still refused on another's note
after a rebuild; no seq gap/reuse after rebuild and a stale `expectSeq` append throws; convergence passes with a
restart mid-run; the spec's test table rows are covered; top-level `bun test` passes in the worktree, purity included.

## Check specifically

- **A loosened assertion:** the builder loosened a flaky assertion after an intermittent convergence miss. Find it,
  say why it was loosened and whether that hides a real bug. Run the convergence and recovery tests across many
  seeds (hundreds) in scratch.
- **Edited old tests:** every change to protocol.test.js, holes.test.js, convergence.test.js, world.js must trace to
  a line in PROTOCOL.md (one, "two editors … same version" comparing nonces "as sent", goes beyond the spec's list).
- **Two late fixes** the builder made: author names on catch-up by entries, and a refused sign-in not retrying
  blindly. Each needs a test.
- **Purity:** does test/purity.test.js cover the new records.js and presence.js?
- **Resend after resync:** an op sent but not logged, then a resync, then its resend: converges, logged at most once.
  "Resends keep their bytes" (only never-sent ops are re-stamped): is that safe with normalize-on-send?
- The usual hunt: an op logged twice, an acked op lost, ack/welcome/checkpoint from speculative state, unbounded
  tables, presence saved, a room seeing an unauthenticated hello.
- Other tracks' tests (test/server, test/web) are expected to fail with this change (their seam swaps are separate
  jobs): report their count separately, not as findings.

## The builder's not-verified list and risks

- Nothing ran against the real server, a browser, SQLite or a socket. Not run in QuickJS (purity is static).
- Caps and eviction tested only with small injected values (not H = 100,000, 50 MB, 10,000 threads).
- `rec.recent.find` is linear in W; restamping is linear in pending ops per entries message; not measured.
- Auto-checkpoint on by default (every 1,000 entries when the log since ≥ half the state's size).
- A room that `fail`s is finished (host must `Room.rebuild`). `Room.rebuild` trusts entry bodies.
- Replica pacing is per Replica (two tabs = two buckets). New file packages/protocol/records.js (not in the spec's
  list); an emote set of eight chosen by the builder (spec names none).
