# Report: p3-scaffoldv (verify the single-node server scaffold)

**Verdict: FAIL.** One HIGH (H1: a few deeply nested but valid ops from one annotator freeze the whole process on
every join, and it survives a restart). Five MEDIUM, eight LOW. Everything else on the hunt list held. Verifier session, 2026-11-11. I did not read docs/m2/reports/p3-scaffold.md. Nothing in the
repo was changed except this file; nothing committed.

## What I checked, and how

| Check | Result |
|---|---|
| `bun test` (whole repo) | First run: 127 pass, 1 fail (`test/auth/oidc.test.js:48`, platform's file, mid fix round). Then 6 runs in a row: 143 pass, 0 fail (other sessions added tests meanwhile). `test/server` alone 3×: 46 pass. `test/auth` alone 3×: 42 pass. The one failure never came back and is not in this job's files |
| Done-when coverage | Store contract (store.test.js, 10 tests), Blobs (7), Bus (5), logs (3), gateway over a real socket (/health, auth refused before a room, bad frames, two+ clients converge, restart): present |
| Tests: ports, files | Port 0 everywhere; temp dirs under the OS temp dir. After the runs, `git status --short --ignored` lists nothing new and a `find` for `*.db*`, `blobs` and `.tmp-*` finds only the source dir server/blobs (the ignore file would hide databases from a plain status) |
| Read in full | server/{gateway,server,room-host,main,log,ids}.js, bus/memory.js, blobs/disk.js, store/sqlite.js, all six files of test/server/, against PROTOCOL.md Rules, Limits, Messages, Tenancy, Ports, and packages/protocol/room.js. The store, blobs, bus and log tests assert what their names say (pragmas read back, conflict on behind/taken/ahead, atomic batches, 10 MB edge, traversal lists, two handles) |
| Scratch tests | In a temp dir outside the repo, importing the repo's code by absolute path. Child servers killed by recorded PID only, port 0 only |
| sdd review | codex only, effort high: **single harness**, so its findings are leads. Tree hashes of server/, test/server/, packages/ compared before and after codex ran: unchanged |

### Things I tried to break that held

| Attack | Measured |
|---|---|
| **kill -9 mid-stream** (PLAN phase 3 gate; builder had no test) | 6 rounds, child SIGKILLed while a client pumped ops, then restarted on the same SQLite file and every acked op resent: 3,593 acked ops, **0 missing from the Store, 0 logged twice, 0 resends with a different seq, 0 seq gaps**. Process crash only: power loss not tested |
| **Late append success after the timeout** (builder risk) | Store wrapper that really appends 400 ms after a 150 ms timeout; client reconnects and resends at once. The resend got seq 2, the late append got `conflict`, the log is `[1, 2]` with the op once |
| **Hostile ops from a writer** (per-board kick, builder risk) | 22 shapes (ids `__proto__`/`constructor`, wrong field types, duplicate ids, lone surrogates, NUL, `__proto__` keys, nesting up to 20,000) as annotator and as editor, plus raw-text frames nested 20,000 to 900,000 deep: none threw in the Room and no other connection was kicked ("room threw after logging" never fired; from about 40,000 deep the Room answers `bad-op`). Deep nesting hurts another way: H1 |
| **Slow reader** (builder: untested) | Raw TCP viewer that stops reading while an editor writes 80 × 500 KB and 400 × 100 KB ops: server logged "slow reader closed", sent close 1013, and every entry delivered before the close was in order with no gap. Child RSS peaked at 144 MB |
| **Burst after hello** | 3,000 ops in one loop: all acked, no "frame queue overflow" |
| **Token in the identity** | `verify` returns `{user, name, email, domain}`, no token, so `down("role", err)` can't log one |
| **Path traversal / cross-tenant** | `isId`/`needId`/`isSha1` guard every store key, blob path and bus subject; the gateway builds subjects from the Registry's record, not from the hello. Nothing found |
| **Ack before append, pre-auth reach** | Read and re-tested: the room's output is held until the append resolves; frames queue behind the hello's awaits and are dropped on refusal. Nothing found |

## HIGH

**H1. A few deeply nested, valid ops from one annotator freeze the whole process on every join, for good.**
- Hunt-list item: frames that wedge the process (deep nesting).
- What: nothing limits nesting depth (not the gateway, not `opProblem`, not PROTOCOL.md § Limits). Past roughly
  20,000 levels, Bun's `JSON.stringify` and core's `clone` fall off a cliff: measured standalone at depth 39,000
  (a 234 KB op, well under the 1,000,000-char cap): parse 2 ms, `opProblem` 589 ms, stringify 593 ms, clone 593 ms.
  All of it runs on the one event loop, and the catch-up frame is encoded again for every joiner
  (server/room-host.js:119; packages/protocol/room.js:46-50).
- Measured over real sockets (scratch test on the repo's rig), one annotator, **six ops of 180 KB each** (depth
  30,000, each acked as valid):
  - storing them blocked the server for 8.4 s;
  - every later viewer join with `since: 0` took **2.1 s**, and a `/health` request sent at the same moment also
    took 2.1 s: the whole process is stalled, so every board and tenant on it;
  - after a restart on the same data: first join 4.7 s, later joins 2.1 s each. The ops are in the log, so it
    never heals;
  - once the tail is folded into a snapshot (`compactEvery: 2`): 5.6 to 8.0 s per join, and **15.5 s** for the
    first join after a restart, which is past the 10 s hello timer.
- Scale: the cost grows with each stored op. Annotators are the lowest write role (about 2,000 per board), no rate
  limit is enforced yet, and 100 such ops are 18 MB, inside the `notes` cap: joins would then take minutes each.
  A client that is already up to date (`since` = current seq) is not affected (6 ms).
- Fix, scaffold side: in the gateway, before `codec.decode`, scan the frame text and refuse one nested deeper than a
  small bound (64 is generous for elements) with `bad-op`; it is a linear pass with no parsing. Encode a catch-up
  once per (base, tail) rather than once per joiner.
- Fix, spec side (engine owns it): add a nesting limit to PROTOCOL.md § Limits and to `opProblem`, so replay and
  other transports are covered too. Add a test: a 30,000-deep op is refused and a join stays fast.

## MEDIUM

**M1. One unauthenticated socket can make the server hold gigabytes while `verify` is pending.**
- Where: server/gateway.js:160 counts queued frames (1,024), not bytes; the 16 KB pre-hello cap at :122 runs only
  after a frame is dequeued. Transport cap is 4 MB per frame.
- Measured: stub auth with a 4 s `verify`, one socket, a hello with a wrong token then 300 × 3.9 MB frames: child RSS
  went from 12 MB to **1,194 MB** before the socket was refused. The ceiling per socket is about 4 GB. From reading
  (not measured): the frames stay referenced until `verify` settles, even if the socket closes first.
- Not reproducible with what main.js wires today: same attack against `bun server/main.js` with dev tokens, RSS 27 →
  29 MB (dev `verify` settles in microtasks, so nothing queues). It becomes real when `verify`, the Registry or
  `rooms.open` does real I/O (session HMAC in server/auth/session.js uses `crypto.subtle`; Postgres in phase 4).
- codex raised the same point from reading (as HIGH). I rate it MEDIUM because the shipped wiring is not exposed;
  fix it before sign-in or a networked store is wired.
- Fix: in `message()`, before queueing, refuse a frame longer than `maxHelloChars` when the state is not `live`;
  cap queued bytes per connection as well as frames; drop the queue when the socket ends.

**M2. A valid user is told `auth` when sign-in or room open is slow.**
- Where: server/gateway.js:150 treats state `auth` (hello received, awaiting ports) like `new`.
- Measured: `rig({ verifyDelayMs: 300, limits: { helloTimeoutMs: 60 } })`, valid editor token: the socket got
  `{code: "auth", message: "say hello first"}` and close 1008. PROTOCOL.md's table: `auth` → "sign in again";
  slow ports are `unavailable` → "keep pending ops; reconnect".
- In production the timer is 10 s, so it needs an auth, registry or store call that really takes that long (a
  network IdP, Postgres). On SQLite the rebuild does not yield to timers, so it can't fire mid-rebuild today.
- Fix: in state `auth` answer `unavailable` with close 1013.

**M3. Unknown protocol version gets `bad-op`, not `version`.**
- Where: server/gateway.js:84 (`badFrame` default code). Measured: hello with `v: 99` →
  `{code: "bad-op", message: "this server speaks protocol v1"}`, close 1008.
- PROTOCOL.md Messages: "Unknown `v` → `version`, closed"; the client's reaction differs (stop and update vs resync).
- The test hides it: test/server/gateway.test.js:134 accepts any of `bad-op`, `auth`, `too-large` for every case.
- Fix: pass `"version"`; make the test assert the code per case. codex agrees (reading).

**M4. A client with more than 1,023 unsent ops can't reconnect once auth takes real time.**
- Where: server/gateway.js:160 closes with 1008 "too many frames" when 1,024 frames wait behind the hello.
- Measured: hello + 1,500 small ops in one go: all acked with instant auth, **closed 1008 with 0 acked** when
  `verify` takes 30 ms. Today's Replica sends the hello and every pending op together (test/server/rig.js:104), so
  each retry fails the same way.
- Today's Replica really does that: `connectMessages` returns the hello followed by every pending op
  (packages/protocol/replica.js:32-35).
- Like M1, it does not reproduce with the wiring main.js ships (instant dev auth); it needs auth or room open that
  takes real time. Protocol v1 moves resends after `welcome`, which removes the trigger.
- Fix: with M1's byte cap in place, queue by bytes; or answer `unavailable` and say so in a `SEAM(p2)` note.

**M5. Protocol behaviour that is missing or v0, with no `SEAM` mark.** The brief asks that nothing guesses and that
gaps are marked. Marked seams are fine (rate limit, presence, blob URLs, `v` required, rebuild, checkpoints, group
commit, placement, backpressure). These are not marked:
- **Rule 8, viewers never reach the room:** server/gateway.js:106-112 opens the room and forwards a viewer's hello
  like a writer's; the room holds a connection per viewer. codex called this HIGH; I rate it a missing marker,
  since gateway-side viewer catch-up was not in this job's goal, but the 100k-viewer design depends on it.
- **Rule 6, the `n` gap check:** the gateway numbers messages (gateway.js:116); server/room-host.js `handle` never
  looks at `n`. Harmless on the in-memory bus, wrong on NATS.
- **v0 `transient` rides through:** the gateway forwards whole `op` messages, so `transient: true` reaches today's
  Room. Measured: an annotator's transient op was relayed to a viewer, unthrottled and unlogged. v1 removes it.
- **Blob quota** (§ Limits, per tenant): server/blobs/disk.js has none and no note.
- **First frame is presence:** gets `auth` and a close; rule 11 says pre-welcome presence is dropped (codex, LOW).
- Fix: add the `SEAM(...)` comments, and strip `transient` in the gateway now.

## LOW

| # | Where | What | Fix |
|---|---|---|---|
| L1 | gateway.js:66 | `ws.send`'s return value is ignored and Bun's `backpressureLimit` is left at its default (16 MB per Bun's docs as I recall them; not checked here). At defaults my slow-reader runs showed no dropped frame; a config that raises `maxBufferedBytes` could drop one silently (codex, reading; I did not reproduce) | Set `backpressureLimit` from the same limit; treat a 0 return as a close |
| L2 | blobs/disk.js:58-67 | Two concurrent puts of one hash both pass `exists` and the later `rename` replaces the first, so "first bytes are kept" needs a SHA-1 collision to matter. No directory fsync after the rename, so a put that resolved can vanish on power loss (reading only) | Link-without-replace, fsync the folder |
| L3 | store/sqlite.js:41-45 | Checkpoints: the first write for a seq is kept and there is no way to remove a bad one. Measured: after three checkpoints at seq 100/200/300, a put at seq 50 is pruned in the same transaction, and a second writer at 300 is ignored | Decide in phase 2 with § Recovery; note it at the seam |
| L4 | test/server/gateway.test.js:255 | The "times out" case never lets the append land late, so it doesn't cover the builder's own listed risk. My scratch test did, and the code is right | Add that case |
| L5 | room-host.js:119-131 | If the Room throws on a hello before logging, the connection stays in `slot.conns` with no user and the socket stays open with no welcome (reading only) | Remove the conn and close it |
| L6 | room-host.js:58-66 | Rebuild reads `pageSize` 1,000 entries at a time, each up to 1,000,000 chars: one page can be ~1 GB (reading only; adds to the builder's "replays the whole log") | Page by bytes, or a small page until checkpoints land |
| L7 | gateway.js:78 | Strikes never reset: 8 bad frames over a connection's whole life close it, and `blob` requests count as bad frames until served | Decay strikes over time |
| L8 | main.js:30,58 | Defaults `./data` (gitignored) and port 8080 apply only to a hand-run server; tests override both | None needed; noted for the hunt list |

## The builder's not-verified list

| Item | What I found |
|---|---|
| No kill -9 / power-loss test | kill -9 run: holds (above). Power loss: not tested |
| p95 not measured | Not measured here either. The PLAN gate (op-to-peer p95 < 150 ms) is still open |
| macOS only | Still macOS only (Darwin 25.2, Bun 1.3.14). 1009 on an oversized frame and the `fullfsync` read-back are unverified on Linux |
| Whole-log rebuild, rooms never unloaded | Confirmed by reading; see L6 |
| Slow-reader close untested | Tested: works, no gap before the close. Frame-queue overflow close: tested, works, but see M4 |
| `idleTimeout` 120 s, no heartbeat | See "Idle viewer" below |
| room-host mirrors Room internals | Confirmed; marked `SEAM(p2)`. The builder's restart test compares room state; my kill -9 run checked the Store's contents and the seqs of re-acked resends, not room state |
| Room throws after logging kicks the board | Real by design; I found no input that triggers it. The cheaper attack on a board is H1 |
| Late append success | Tested: one extra rebuild, no loss, no duplicate |
| fsync on the event loop, no rate limit | Confirmed by reading; rate limit is a marked seam. Not measured |
| `uncaughtException` carries on | Confirmed by reading; not exercised |

## Idle viewer

A viewer that said hello and then sent nothing was **still open after 150 s** (past the 120 s `idleTimeout`), against
a child server with the real gateway. The client was Bun's WebSocket, which answers the server's pings by itself, as
browsers do. Not tested: a client that does not answer pings (possibly Herdr's QuickJS WebSocket); expect it to be
closed at 120 s and to need an app-level heartbeat.

## codex (single harness) leads, and what became of each

| codex said | Outcome |
|---|---|
| HIGH: viewers reach the room | True by reading; rated M5 (unmarked seam), not HIGH, for the reason given there |
| HIGH: pre-auth frame queue | Confirmed by measurement with slow auth, refuted for the shipped wiring: M1 |
| MEDIUM: no op rate limit | Marked `SEAM(p2)` and builder-disclosed; not a finding |
| MEDIUM: `ws.send` result ignored | Not reproduced at defaults: L1 |
| MEDIUM: `version` code | Confirmed by test: M3 |
| MEDIUM: blob put race | True only with a SHA-1 collision: L2 |
| MEDIUM: no blob quota | True, unmarked: part of M5 |
| MEDIUM: timeout test never lands late | True: L4 |
| LOW: presence before hello | True by reading: part of M5 |

## Not verified

- Power loss, Linux, p95, a real multi-minute soak, memory growth per opened board.
- Engram recall failed (service unreachable), so no past-session notes were consulted.
- server/auth and server/admin were out of scope and only read where the gateway calls them.
