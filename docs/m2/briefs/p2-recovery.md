# Brief: p2-recovery (room recovery in packages/protocol)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md, CLAUDE.md, then PROTOCOL.md (v1,
committed 28fa91d) in full, and packages/protocol/*.js and test/*.js.

- **Your tab:** `worker p2-recovery (engine): room recovery`. Manager: `manager engine`, terminal `t14j`.
- **You own:** packages/protocol/, test/*.js at the top level (convergence, holes, protocol,
  purity, world, and new test files you add there). Not test/web/, test/auth/, server/, PROTOCOL.md, or
  packages/core (never edited here). If the spec is wrong or unclear, don't edit it: write the question/fix in your
  report and pick the safest reading.
- **Report:** docs/m2/reports/p2-recovery.md (what changed, tests added, how you checked, NOT verified, risks).
  Then stop and leave the session idle. Don't commit.

## Goal (PLAN.md phase 2)

Room recovery in packages/protocol, which stays pure (test/purity.test.js): implement PROTOCOL.md v1's section
"What phase 2 changes in packages/protocol", file by file (envelope.js, room.js, replica.js, ports.js, new
presence.js; codec.js unchanged). No Store/Bus/socket code; async ports and the gateway are phase 3.

## Also in scope (manager decisions, in PROTOCOL.md once the follow-up lands)

- `Replica.local()` normalizes on send: each outgoing element's `version` = (highest version the replica knows for
  that id, confirmed or pending) + 1, fresh `versionNonce` (so a long drag never trips MAX_VERSION_JUMP).
- `Replica.receive()` returns what it applied; `Replica.reset()` keeps pending ops overlaid (no flicker).
- Tests for each (a 5,000-move drag then one send is accepted; reset keeps pending visible).
- **Round-2 verifier decisions** (docs/m2/reports/p1-specv2.md M1, M2, M5; also in manager-engine.md):
  - M1: Replica paces every send, resends included, to the published rate (clock injected). Over-rate is
    backpressure at the gateway, never a refusal (gateway is phase 3; Replica pacing is yours).
  - M2: a Room answers `unavailable` to an op from a connection it did not welcome in this incarnation; the Room
    accepts a close notice for a connection and drops its `n` state.
  - M5: a refusal on `records` only drops that op from the Replica's pending overlay (no reset); no-op record
    actions are accepted, logged and acked.
- **PROTOCOL.md is being edited in parallel** by p1-seam (folding in exactly these decisions plus text fixes). Build
  to the committed spec plus the bullets above; if they conflict, the bullets win. The manager tells you when
  p1-seam commits; re-read the diff then and reconcile names.

## Done when (PLAN.md + the spec's test table)

- A room rebuilt from MemoryLog (with and without a checkpoint) deep-equals the original.
- An acked op resent to the rebuilt room gets the same ack/seq and nothing is logged.
- An annotator is still refused on another's note after a rebuild.
- No seq gap or reuse after rebuild; a conditional append with a stale `expectSeq` throws.
- The convergence test passes with the room rebuilt from the log mid-run.
- Op-id bound, records (threads, replies, resolve, reactions set/unset), presence unit tests: per the spec's table.
- Existing tests updated only where the spec says they change; `bun test` passes, purity test included.

## Process rules (OFFICE.md)

- Never `pkill`, `killall` or `pkill -f`. Start any server or browser from a script that records its PID; kill
  only that PID. Use free ports (port 0), never hard-coded ones.

## Added while running (sent by prompt)

- Nesting limit: `opProblem` refuses ops nested deeper than 64 as `bad-op`, checked iteratively; test a 30,000-deep op.
- From client's p6-basev (H1, H2): pending ops across a reset are re-normalized against the post-reset state; a
  local version ahead of the Replica's with no pending op is reconciled (confirmed copy wins). Tests: an edit during
  a resync lands live; after a cancelled 5,000-move drag a peer's edit still applies. Report any new API.
