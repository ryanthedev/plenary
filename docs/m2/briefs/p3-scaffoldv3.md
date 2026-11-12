# Brief: p3-scaffoldv3 (re-verify the single-node server scaffold, round 3)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PLAN.md phase 3, PROTOCOL.md § Ports (the contract), then the job's files. **Do not read
docs/m2/reports/p3-scaffold.md** (the builder's claims); what you need is here.

- **Your tab:** `verifier p3-scaffoldv3 (engine): server scaffold, round 3`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p3-scaffoldv3.md only. Everything else is read-only.
- **Scratch tests** in a dir outside the repo (`mktemp -d`); `bun test` picks up any `*.test.js` in the tree.
- **Process rules:** never `pkill`/`killall`; record PIDs of anything you start and kill only those; port 0 only.
- **sdd ensemble:** load `sdd:subagent-driven-development`, check usage, run codex over the job's files. Today it is
  codex only (agy out of quota, others not signed in): label it "single harness"; its findings are leads to confirm
  or refute, not HIGH candidates by agreement.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings (where, failure scenario, fix). Then stop, idle. Don't commit.

## The job you're checking

The job's files are new (untracked): **server/** except server/auth/ and server/admin/ (platform's), and
**test/server/**. Read them in full (`git status --short server test/server`; `find server -path server/auth -prune
-o -path server/admin -prune -o -type f -print`).

Goal: the parts of the single-node server that don't depend on the protocol v1 recovery fixes: Bun HTTP + WebSocket
gateway using the existing codec; /health; structured JSON logs to stdout (no tokens/secrets); bad frames never kill
the process; SQLite Store (`synchronous=FULL`) for log + checkpoints per § Store (atomic conditional append, stale
expectSeq → `conflict`, ascending read, highest-seq checkpoint wins); in-memory Bus per § Bus; local-disk Blobs
(10 MB cap, SHA-1 verified, keyed by tenant+hash, no path traversal); dev-token Auth wired to async verify/role,
awaited before any room sees a hello. Still-moving v1 details are left as marked `SEAM(p2)` seams, wired to today's
Room.

Done when: `bun test` passes (now ~128); tests cover the Store contract, Blobs, Bus, and a gateway over a real
socket (/health, auth refused before a room sees hello, bad frames survive, two clients converge). Tests use temp
dirs and ephemeral ports.

## Hunt for

- An ack sent before the append resolves; a seq gap/reuse after an in-process restart; conflict handling.
- Any path where a hello, op or presence reaches a room before auth resolves, or after a refusal.
- Cross-tenant: store keys, blob paths, bus subjects; path traversal via tenant/sha1/board ids.
- Frames that crash or wedge the process (huge, binary, malformed JSON, deep nesting, wrong types, flood).
- Logs leaking tokens. Hard-coded ports or files written into the repo tree by tests.
- Seams: are they marked, and does nothing guess at the moving v1 details?

## The builder's not-verified list and risks (check these)

- No kill -9 / power-loss test; p95 not measured; ran on macOS only (1009 close on oversized frame and the
  `fullfsync` read-back may differ on Linux/CI).
- Rebuild replays the whole log on open; rooms never unloaded (memory grows per board opened).
- Slow-reader close (16 MB buffered) and frame-queue overflow close (1,024 frames) untested.
- Bun `idleTimeout` 120 s set but untested; clients have no heartbeat.
- room-host.js mirrors Room internals (`replay`).
- A Room that throws after logging kicks everyone on that board (possible per-board DoS).
- Append timeout 10 s then a late success: the next append conflicts and the room rebuilds again.
- Every fsync runs on the event loop. No inbound backpressure or op rate limit.
- `uncaughtException` is logged and the process carries on.

## Round 2: what's new since round 1

- Round 1 FAILED: read **docs/m2/reports/p3-scaffoldv.md** (H1 deep nesting stalls every join; 5 MEDIUM, 8 LOW) and
  check each finding in these files is actually closed. Re-run its H1 attack (a ~30,000-deep op, then joins and
  /health timing; also after a restart and after compaction).
- The job's files are still server/ (except server/auth, server/admin, **and server/registry/, already committed**)
  and test/server/ (except registry.test.js). PROTOCOL.md is now committed (7e834d2): check against it.
- New since round 1: gateway depth scan (frame depth ≤ 64) before decode; catch-up encoded once per (base, tail);
  `version` error code for an unknown `v`; dev-token seeding (one grant per user, highest role wins, applied
  highest first); a 2 MiB pre-welcome queue bound; transient previews refused with `bad-op`; **server/main.js now
  uses the durable SQLite Registry** (`<data>/registry.db`, dev board id kept in `<data>/dev-board.json`), with tests
  that start main twice on one data dir and kill -9 it mid-stream three times.
- Hunt specifically: the restart and kill -9 gates through main.js (every acked op present once at its acked seq,
  resends land once); the depth scan (off-by-ones, strings containing brackets, escaped quotes, huge flat frames);
  anything in the new queue bounds that lets one client starve others.
- `bun test` is ~261 now; must pass.

## The builder's round-2 not-verified list and risks

- H1 test bounds only (< 1.5 s, < 0.5 s), not measured timings. `ws.send` returning 0 and the 16 MB slow-reader
  close have no repo test. M1's memory bound asserted by behaviour, not RSS.
- room-host.js mirrors two pieces of Room (`replay`, catch-up in `Room.hello`), marked SEAM(p2).
- A v0 client sending `transient` previews gets an error per preview (no close); live drag previews no longer reach peers.
- A client with > 2 MiB of unsent ops and slow sign-in can't reconnect until v1 resend-after-welcome.
- Gateway counts depth on the whole frame (an op can be ≤ 62 deep over a socket); spec's opProblem counts the op alone.
- A kill between creating the dev board and writing dev-board.json mints a second dev board on the next start.
- Still open: power loss, Linux, p95, load, idle heartbeat.

## Round 3: what's new since round 2

- Round 2 FAILED: read **docs/m2/reports/p3-scaffoldv2.md** (H1 one-frame catch-up makes a board unjoinable and
  lets non-readers pin memory; M1 burst freezes the process; M2 unmarked spec divergences; L5 flaky convergence test
  = rig.js settled()). Check each is closed, and **re-run round 2's attacks against `bun server/main.js` from a
  separate process** (the builder ran them in-process only): the note-rewrite attack then `since: 0` joins before and
  after a restart; 40+ non-reading viewers incl. ones sending presence every 10 s; a writer burst while timing /health.
- New since round 2 (the builder's fix): catch-up streamed as bounded `entries` frames paced by backpressure; the
  tail folded by bytes as well as count; a process-wide buffered-bytes budget and a per-user connection cap;
  yielding between ops in a burst; rig.js `settled()` waits for reconnecting clients.
- Files: as before, plus **these are NOT the job's** (other builders are adding them right now; ignore them):
  server/store/postgres.js, server/registry/postgres.js, server/bus/nats.js, server/blobs/s3.js,
  test/server/{store,bus,blobs}-contract.js, test/server/{pg-store,pg-registry,nats-bus,s3-blobs}.test.js.
- The flaky convergence test: run the full `bun test` 20+ times and the gateway convergence test 100 times alone;
  any failure is HIGH.

## The builder's round-3 not-verified list

- The budget is asserted from sockets' buffered counts, not process RSS. The verifier's attacks were run in-process
  only, not against main.js from another process. No slow reader over a real network, no Linux socket buffers,
  no more than 6 non-readers. Drain under load with thousands of sockets; a once-per-second O(connections) sweep.
- Still open: power loss, Linux, p95, a soak.
