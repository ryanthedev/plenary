# Brief: p11-proto (protocol v1.1 code in packages/protocol)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, then in the worktree
/Users/r/repos/plenary-p2 (branch p2-land): PROTOCOL.md (v1.1, committed cb343b9) in full, packages/protocol/*.js and
test/*.js; and /Users/r/repos/plenary/docs/m2/reports/p1-v11.md ("What the next code job changes") and
docs/m2/reports/p1-v11v.md.

- **Your tab:** `worker p11-proto (engine): protocol v1.1 code`. Manager: `manager engine`, terminal `t14j`.
- **Where you work:** /Users/r/repos/plenary-p2. **You own packages/protocol/ and test/*.js (top level) there.**
  Client's p6-land edits web/** and test/web/** in the same worktree; server/ there is not yours (a later swap job
  does the server half). Don't commit; the manager does.
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p11-proto.md: changes per file, tests, the **Replica/Room API
  for drawh and the client** (exact names and semantics), what's left for the server half, not verified, risks.
  Then stop, idle.

## Goal

Implement the packages/protocol rows of p1-v11.md's code list against PROTOCOL.md v1.1: envelope (`MAX_OP_BYTES`
counted as UTF-8 by hand, depth 62, `stale-setting` code, appBase shapes), room (settings compare-and-set against
speculative `appSeq` after the op-id table, held like other refusals; all-or-nothing; no elements in a settings op;
`welcome.room {board, epoch}` with the epoch passed in at construction/rebuild; a `{seq, epoch}` heartbeat helper),
replica (stamp `appBase`; split mixed local changes; one in flight per (stream, key) with waiting changes; soft
`stale-setting`: drop that op only, retry only once confirmed `appSeq` has passed the refused base; `keepVersions`
seeding mode skipped by restamp; epoch checks on a writer's welcome per rule 12), codec (op frames start
`{"t":"op","id":`), ports (`MemoryLog.openEpoch()`/`epoch()`). Keep purity (test/purity.test.js).

## Done when

- Tests for each row of the list (concurrent settings CAS with one winner and a soft refusal; revert vs stale save
  distinguishable; retry never fires before the conflict is applied; epoch rises per rebuild and a lower epoch makes a
  writer reconnect; mixed change split; seeding with keepVersions; op byte cap with non-ASCII text; depth 62).
- Existing phase-2 guarantees still hold: re-run convergence and recovery across many seeds (hundreds) in scratch.
- `bun test test/*.test.js` green in the worktree. (test/web may go red where web/ uses changed APIs: list them.)

## Process rules

- Never pkill; port 0; record PIDs. sdd helpers per BRIEF-BASE (optional).
