# Brief: p3-scaffoldv (verify the single-node server scaffold)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PLAN.md phase 3, PROTOCOL.md § Ports (the contract), then the job's files. **Do not read
docs/m2/reports/p3-scaffold.md** (the builder's claims); what you need is here.

- **Your tab:** `verifier p3-scaffoldv (engine): server scaffold`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p3-scaffoldv.md only. Everything else is read-only.
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
