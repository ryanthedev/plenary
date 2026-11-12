# Brief: p3-fix4 (single-node server scaffold, fix round 4, fresh builder)

Base: docs/m2/BRIEF-BASE.md applies. **Start by reading docs/m2/handoff/p3-scaffold.md** (the previous builder's
handoff: design of the outbound/catch-up path, seams, gates, flaky spots), then docs/m2/OFFICE.md, CLAUDE.md,
PROTOCOL.md (shared tree, committed v1), docs/m2/reports/p3-scaffold.md, and the verifier's
docs/m2/reports/p3-scaffoldv3.md, especially "Round 4".

- **Your tab:** `worker p3-fix4 (engine): scaffold fix round 4`. Manager: `manager engine`, terminal `t14j`.
- **You own (shared tree):** server/ except server/auth/, server/admin/, server/registry/, server/store/postgres.js,
  server/bus/nats.js, server/blobs/s3.js; and test/server/ except registry.test.js, pg-*.test.js, nats-bus.test.js,
  s3-blobs.test.js, *-contract.js. Don't commit.
- **Report:** append "Fix round 4" to docs/m2/reports/p3-scaffold.md. Then stop, idle.

## Fix

- **R4-H1, the suite must be stable:** outbound.test.js:399 ("joiners parked across folds…") assumes a socket-buffer
  size; :358 ("trickle readers…") checks before its Python client has joined. Rewrite both to assert the property
  (who gets turned away, bounded owed bytes) without depending on kernel buffer sizes or timing; wait on events, not
  sleeps. A test that needs python3 must say so when it skips.
- **R4-H2, a snapshot over Bun's `backpressureLimit` (~138 MB UTF-8) can't be sent; joiners are dropped (1006) with
  no log.** Decision: admit shared frames by **UTF-8 bytes**, not `string.length` (round 3's L2); set the socket's
  `backpressureLimit` above the largest snapshot the spec's stream caps allow (compute it from § Limits, with
  headroom), and log loudly if a frame would still exceed it instead of dropping silently. If you find that can't
  hold, stop and say why in the report (the alternative is a spec change to send snapshots in parts).
- Keep everything that passed: catch-up above the per-user budget joins (before and after restart, owner, two tabs),
  non-readers bounded and cut, `/health` during bursts, kill -9 gate.

## Done when

- Full `bun test` **20 runs in a row with 0 failures** (run them; report the count). kill -9 test 30/30.
- A test with a board whose snapshot is over the old ~138 MB limit (scaled limits are fine) joins from since 0.

## Process rules

- Never pkill; port 0; record PIDs, kill only those. Clean up the large scratch data you create (the last verifier
  couldn't delete 1 GB). If you pass ~55% context, write docs/m2/handoff/p3-fix4.md and tell the manager.
