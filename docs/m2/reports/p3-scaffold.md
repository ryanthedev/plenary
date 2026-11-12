# Report: p3-scaffold (single-node server scaffold)

**Outcome: done.** `bun test` passes: 128 tests, 0 fail. 46 of them are new, under test/server/ (the rest are the
80 that existed at the start plus 2 another session added meanwhile). Not committed.
The final full suite ran 5 times in a row and test/server 6 times in a row with no failure (an earlier version: 25).

PROTOCOL.md changed while this was built. I re-read § Ports, § Limits, § Recovery and the rules at the end and
brought the code in line (see "Spec re-read" below).

## What changed (all new; nothing outside server/ and test/server/ touched)

| File | What it is |
|---|---|
| `server/server.js` | `createServer(...)`: one Bun HTTP + WebSocket server. `GET /health`, `GET /ws`, an optional `http` handler for the platform's routes, 404 otherwise. Ephemeral port with `port: 0`. |
| `server/gateway.js` | Holds sockets. Decodes with packages/protocol/codec.js, awaits `verify` → board lookup → `role` → room open, then forwards `{conn, gateway, user, role, client, msg}` over the bus **without the token**. Refuses bad frames. |
| `server/room-host.js` | Runs one packages/protocol `Room` per board, as it is today, behind the Store and the Bus. **The only file that touches Room's internals**; every bridge is marked `SEAM(p2)`. |
| `server/store/sqlite.js` | Store port on `bun:sqlite`: WAL, `synchronous=FULL`, `fullfsync`. `append`, `read`, `lastSeq`, `putCheckpoint`, `getCheckpoint(…, beforeSeq?)`, async. |
| `server/bus/memory.js` | In-memory Bus + `subjects` (`plen.<tenant>.<board>.entries|presence|emotes|inbox`). At-most-once, ordered per subject, async delivery. |
| `server/blobs/disk.js` | Blobs port on local disk + `checkBlob` (cap, SHA-1, image type) for any later adapter. |
| `server/log.js` | One JSON object per line to stdout: `time`, `level`, `msg`, plus fields. Credential-looking keys are redacted. |
| `server/ids.js` | `isId` / `needId` (`[a-z0-9-]`, ≤ 64), `isSha1`, `PortError` (`.code`). |
| `server/main.js` | `bun server/main.js`: env config, dev-token auth, graceful SIGINT/SIGTERM. |
| `test/server/*.test.js`, `rig.js`, `helpers.js` | The tests below. Temp dirs under the OS temp dir, ephemeral ports. |

## How the brief's eight goals are met

| # | Goal | Where | Proved by |
|---|---|---|---|
| 1 | Gateway, Bun HTTP + WS, existing codec | gateway.js, server.js | gateway.test.js (real sockets) |
| 2 | /health | server.js | "/health answers 200…" |
| 3 | Structured logs, no secrets | log.js | ports.test.js "logs: …"; every gateway test asserts no token in any log line; main.test.js checks every stdout line |
| 4 | Bad frames never kill the process | gateway.js, room-host.js | "bad frames get an error and/or a close…" (13 first-frame cases, oversize, strikes), "a port that throws…", "a room that throws…" |
| 5 | SQLite Store | store/sqlite.js | store.test.js (10 tests) |
| 6 | In-memory Bus | bus/memory.js | ports.test.js "bus: …" (5 tests) |
| 7 | Local-disk Blobs | blobs/disk.js | ports.test.js "blobs: …" (7 tests) |
| 8 | Dev-token auth, async, before the room | gateway.js (uses platform's port.js / dev.js / registry.js / tenancy.js unchanged) | "auth is refused before a room sees the hello" (9 cases, asserted on the room's inbox, not just the client), "the order is verify, then board, then role…" |

## Tests added (46)

- **store.test.js:** pragmas read back; conditional append; conflict on stale / taken / ahead `expectSeq`; a batch with one
  bad entry writes nothing; read order, `fromSeq`, limit; boards and tenants separate; bad ids refused; checkpoint
  highest-seq-wins (an older write landing last loses); `beforeSeq` and pruning; data survives close/reopen; **two handles on one file**: one
  append wins, the other gets `conflict` (not a raw SQLite error).
- **ports.test.js:** blobs (round trip, idempotent, hash mismatch, 10 MB cap at the edge, tenant isolation, traversal and
  bad ids, images only, a torn temp file is not a hit); bus (subjects, per-subject delivery and order, at-most-once,
  a throwing subscriber, publish from inside a handler); logs (shape, redaction, a throwing writer).
- **gateway.test.js:** /health; extra http handler; auth refusal before the room; verify→board→role order and no token
  past the gateway; **slow auth** (hello + ops in one tick stay in order and are acked); bad frames; ports that throw;
  **rule 1 with a gated Store** (no ack, no broadcast, and nothing shown to a viewer who joins mid-append, until the
  append resolves); the entries subject; **append rejects / conflicts / times out** (no ack ever, `unavailable`, close,
  rebuild from the Store, resends land once); a Room that throws before or after logging; sockets closing mid-auth and
  after hello leave zero room connections; hello timeout; a hello the bus dropped; **a corrupt log** (gap, repeat,
  another board's entry) refuses to start; **convergence over real sockets** (5 clients, 300 rounds, drops and
  reconnects, a fresh `since: 0` client, then a **server restart on the same data** with a 7-entry page size so the
  rebuild pages), two seeds.
- **main.test.js:** the real entry point as a child process: JSON logs, /health, a two-client session, bad frames,
  SIGTERM exits 0, no token on stdout; dev tokens are off by default and a malformed env value doesn't turn them on.

One bug the tests caught while building: an error thrown by `auth.verify` can quote the token, and the gateway logged
that error. Fixed (name and code only are logged for verify errors); the test stays.

## Spec re-read (PROTOCOL.md moved during the job)

| Spec now says | What I did |
|---|---|
| Board lookup is `Registry.board` (§ Auth, § Registry) | Already so. |
| `getCheckpoint(tenant, board, beforeSeq?)` | Added. Checkpoints are kept per `(board, seq)`; the newest 3 per board stay. |
| Subjects `.entries`, `.presence`, `.emotes`, `.inbox` | Added `subjects.emotes` (nothing publishes on it yet). |
| Inbox messages are `{ n, conn, gateway, … }`, numbered per connection | The gateway numbers them (`n` from 1). The room host doesn't check `n` yet. |
| Rule 11: a second `hello` gets `bad-op` and the connection is closed | Done, tested. |
| Rule 11: before `welcome`, ops get `auth` | An op as first frame gets `auth` + close. |
| § Limits: 20 durable ops/s per connection, burst 100, queue then refuse | **Not done** (`SEAM(p2)` in gateway.js). |
| § Bus: `{ seq }` heartbeat every 2 s; gateways subscribe before forwarding a hello | **Not done** (p4 fan-out seam). |
| § Blobs: per-tenant quota; "the first bytes for a hash are kept" | Quota **not done**; first-bytes-kept holds (put returns if the file exists). |
| § Recovery: resolved vs speculative; a dedupe hit on an in-flight entry waits | Holds by construction: one message at a time per board, so nothing is ever in flight when the next is checked. No group commit. |

## Seams (marked in code; replace when the named phase lands)

| Mark | Where | Today | Becomes |
|---|---|---|---|
| `SEAM(p2)` Room auth | room-host.js `load` | Room still calls `auth.check(token, board)`; the host hands it the gateway-verified `{user, role, tenant}`. The token is stripped at the gateway. | Room takes `{user, role}` in the hello context |
| `SEAM(p2)` async Store, group commit, speculative state | room-host.js `load`/`handle` | Room's sync `log.append` only collects; the host awaits `store.append` and holds every output until it resolves; one message at a time per board. Room memory is briefly ahead of the Store and is discarded on failure. | Room's own async append / group commit |
| `SEAM(p2)` rebuild | room-host.js `replay` | Replays the whole log into a fresh Room by setting `seq`, `tail`, `opSeq`, `noteAuthor` by hand | `Room.rebuild({ checkpoint, entries })` |
| `SEAM(p2)` checkpoints | room-host.js | None read or written (Store supports them). The in-memory tail is folded with `room.compact()` every 1,000 entries. | `checkpoint()` every 1,000 entries and on clean stop |
| `SEAM(p2)` op-id table, `stale`, `high`/`horizon`, `at` | — | Whatever today's Room does (unbounded `opSeq`, no `at`) | § Op ids |
| `SEAM(p2)` `v: 1` | gateway.js `hello` | `v` may be missing (today's Replica sends none); any other value is refused | required |
| `SEAM(p2)` presence | gateway.js `frame` | `presence` frames are dropped silently; nothing is published on the presence subject | presence.js + relay |
| `SEAM(p3)` `blob` messages / signed URLs | gateway.js | Not served: `blob` gets `bad-op` and counts as a bad frame (8 of them close the socket); no blob HTTP routes; no quota | signed URLs |
| `SEAM(p2)` op rate limit | gateway.js `frame` | None. An authenticated writer can queue ops on a board without bound (each waits for one fsync) | § Limits: 20/s, burst 100 |
| `SEAM(p4)` placement | room-host.js `open` | The gateway calls `rooms.open(tenant, board)` directly | leases |
| `SEAM(p4)` fan-out, viewers served by gateways | room-host.js, gateway.js | Each connection is a Room connection and gets entries from the Room's own broadcast (encoded once). Entries are also published on `…entries` after the append, with no subscriber yet. | gateways fan out from the subject and repair gaps from the Store |
| `SEAM(p4)` backpressure | gateway.js | A reader with > 16 MB buffered is closed | pause / thin |
| `SEAM(platform)` | main.js | In-memory Registry, one dev board minted at start | durable Registry, `POST /boards`, sign-in |

## Decisions I made where the spec or brief was silent (please confirm or correct)

1. **`read(…, fromSeq, …)` is inclusive** (`seq >= fromSeq`). PROTOCOL.md doesn't say.
2. **`Store.lastSeq(tenant, board)`** added (not in § Store); the host doesn't need it, tests and tools do.
   **Checkpoints kept: 3 per board** (`keepCheckpoints`); the spec doesn't give a number.
3. **A fourth bus subject, `plen-gw.<gateway>`**, for room → gateway replies `{ conn, data, close? }` ("addressed to
   conn", § Bus). It sits outside `plen.<tenant>.…`. `data` is an already-encoded frame.
4. **Inbox also carries `{ conn, gateway, bye: true }`** when a socket closes.
5. **Entries-subject payload** is `{ from, to, data }` with `data` the encoded `entries` frame, not raw entries.
6. **Images only is enforced in `Blobs.put`** (magic bytes; SVG refused), since it is the one choke point.
7. **Bad-frame policy:** before hello, one bad frame = `error` + close 1008. After hello, `error` each, close after 8
   (unknown types and `blob` count; a second hello closes at once).
   Over 4 MiB the transport closes with 1009 (below that an oversized op reaches the Room, which answers `too-large`
   with the op id so the client can undo it). No hello within 10 s = close.
8. **Close codes:** 1008 auth / bad frame, 1009 too big, 1013 `unavailable`, 1001 server stopping.
9. **Board ids in a hello must look like server ids** (`[a-z0-9-]`); anything else is `auth`, same as unknown.
10. **`fullfsync=ON`** by default (macOS needs it for power-loss durability). Measured here: ~0.6 ms per commit.
11. **Flat log fields** (`{ time, level, msg, ...fields }`), not a nested `fields` object.
12. **The hello timer (10 s) runs until the room's first frame arrives**, not just until auth passes: the bus is
    at-most-once, so a dropped hello would otherwise leave a silent socket. It then gets `unavailable` + close.
13. **`role` inside `PLENARY_DEV_TOKENS`** is main.js's own convention for the dev board's grants; platform's
    `devAuth` ignores it.

## Asks for other owners (not done here; outside my files)

- **Platform:** a durable Registry. With the in-memory one, **boards vanish on restart while their log stays**, so phase
  3's "kill -9, restart, every acked op present" gate can't pass through `main.js` yet (the restart test here keeps the
  registry object alive across the restart). Also wire `POST /boards` through `createServer({ http })`.
- **Platform (deploy/):** `main.js` binds `127.0.0.1` unless `HOST` is set, so the container needs
  `HOST=0.0.0.0` in the Dockerfile or compose.yml (neither sets it). The rest matches: `server/main.js`, `PORT`,
  `PLENARY_DATA_DIR`, `/health`. The Dockerfile's "PENDING phase 3" notes can go.
- **Platform:** no change needed in server/auth/ or server/admin/.
- **Spec:** name the reply subject, the `bye` message, the entries-subject payload and `read`'s inclusiveness
  (decisions 1, 3, 4, 5).

## What I did NOT verify

- **Power loss / kill -9.** Durability settings are read back from SQLite, and close/reopen plus an in-process server
  restart are tested. No test kills the process mid-write. (Phase 3's gate; needs the durable Registry.)
- **p95 op-to-peer < 150 ms.** Not measured. Not in this brief.
- **Linux.** Everything ran on macOS, Bun 1.4.4. CI is Ubuntu: the 1009 close on an oversized frame and the
  `fullfsync` read-back (`1`) are the two spots most likely to differ.
- **Load.** Nothing beyond 5 clients. Rebuild replays the whole log on open (no checkpoint), and rooms are never
  unloaded, so memory grows with the number of boards ever opened.
- **Slow-reader close** (16 MB buffered) and the **frame-queue overflow close** (1,024 frames waiting): no tests.
- **Docker image.** Not built or run.
- **Bun's `idleTimeout`** (120 s): set, not tested. Clients have no heartbeat yet, so an idle viewer may be dropped
  after two minutes and must reconnect.
- **Engram** (the shared memory service) was unreachable at the start ("name resolver … zero addresses"), so no
  recall was done and nothing was written to it.

## Risks

- **room-host.js mirrors Room internals** (`replay`). If p2 changes `room.js` before swapping the seams, the
  convergence-with-restart test should fail loudly; that is the one file to change.
- **A Room that throws after logging kicks everyone on that board** (they reconnect; nothing is stored). One hostile
  op that reliably triggers such a bug would be a per-board denial of service. None found by probing today's Room.
- **Append timeout (10 s)** then a late success: the room has already been rebuilt; if the late write lands after the
  rebuild read, the next append conflicts and the room rebuilds once more. Self-healing, but two reconnects.
- **Dev board in main.js** gets a new random id each start.
- **Every fsync runs on the event loop** (bun:sqlite is synchronous): ~0.6 ms here, but a slow disk stalls every
  board on the node for that long. Fine for a scaffold; a worker or Postgres removes it.
- **No inbound backpressure or op rate limit** (see seams).
- **`uncaughtException` is logged and the process carries on** (main.js), by design for "bad frames never kill the
  process"; a real corruption bug would also be carried on past.

---

# Fix round (after docs/m2/reports/p3-scaffoldv.md: FAIL, 1 HIGH, 5 MEDIUM, 8 LOW)

**Outcome: every finding that sits in my files is fixed and tested.** `bun test`: 205 pass, 0 fail (whole repo, other
sessions' tests included). My four test files: 56 tests, run 10 times in a row with no failure. Not committed.
Files touched: `server/gateway.js`, `server/room-host.js`, `server/main.js`, `server/blobs/disk.js`,
`server/store/sqlite.js`, `test/server/gateway.test.js`, `test/server/ports.test.js`, `test/server/main.test.js`.
(Counts in this paragraph are from before the late additions at the end of this report; final counts are there.) Nothing in server/registry/ or
test/server/registry*.test.js (p3-registry's), PROTOCOL.md, packages/ or platform files.

## H1 (deep nesting freezes the process on every join): fixed, server side

| Part | What changed | Where |
|---|---|---|
| Depth check before decoding | `nestedDeeperThan(text, 64)`: one linear pass over the raw frame, no parsing, no recursion; brackets inside strings don't count. A frame deeper than 64 gets `bad-op` and never reaches `codec.decode` or a room. If it starts like today's Replica writes an op (`{"t":"op","id":"…"`), the error carries that id so the client can undo it (rule 5). Counts as a bad frame | gateway.js |
| Catch-up encoded once | Each entry is turned into text once (cached per entry) and reused for the live broadcast, every joiner's tail and the entries subject. The snapshot frame is encoded once per base. The Room is asked for the welcome only; the host adds the catch-up frames (`SEAM(p2)`, mirrors `Room.hello`) | room-host.js |

Tests: `H1: nestedDeeperThan…` (64 passes, 65 doesn't, brackets in strings, wide-not-deep, 900,000 unclosed
braces); `H1: a 30,000-deep op is refused…` (the verifier's attack: six 180 KB ops at depth 30,000 from an annotator
are all refused by id in under 1.5 s where storing them took 8.4 s; nothing reaches the inbox or the Store; a join
and a `/health` at the same moment finish in under 0.5 s where each took 2.1 s; a frame 64 deep is acked, 65 is
refused); `H1: catch-up is right for every since…` (snapshot + tail, mid-tail, up to date, ahead; two joiners get
byte-identical frames; a Replica fed them equals the room).

**Not covered by my side:** deep entries already in a log (written before this fix) are still replayed and encoded.
`opProblem` is the guard for replay and other transports; that is the spec-side fix other sessions own.

## MEDIUM

| # | Fix | Test |
|---|---|---|
| M1 | The first frame is refused in `message()` before it is held if it is over 16 KB. Frames waiting behind the hello's awaits are capped at **2 MiB per connection** (each counts its length + 256); over that, `unavailable` + close 1013. The queue is an explicit array, emptied when the socket ends | `M1/M4…`: 4 MB behind a bad-token hello with a 150 ms `verify` is refused in under 120 ms |
| M2 | Hello timer in state `auth` (ports slow) now answers `unavailable` + 1013. `auth` + 1008 only for a socket that never said hello | `M2: a valid user whose sign-in is slow…` |
| M3 | Unknown `v` answers `version`. The first-frame test now asserts the exact code for each of its 14 cases | `bad frames…` |
| M4 | The 1,024-frame cap is gone; the queue is bounded by bytes (M1). 1,500 small ops behind a slow hello are all acked. A client holding more than 2 MiB of unsent ops is told `unavailable`; noted as `SEAM(p2)` (v1 resends after `welcome`) | `M1/M4…` |
| M5 | `SEAM` notes added: viewers reach the room (rule 8, `SEAM(p4)` in gateway.js), blob quota (disk.js). **Rule 6 `n` check implemented** in room-host.js: a gap closes that connection with `unavailable`. **Presence as first frame is dropped** (rule 11), no error. **`transient` ops are refused** (`bad-op` with the op's id, no strike) and ops are forwarded with only `t, id, stream, op` | `M5: a v0 transient op…`, `bad frames…` |

One deliberate difference from the verifier's suggestion: M5 said "strip `transient`". Stripped, a v0 client's drag
preview would be **logged as a durable op**, so the gateway refuses it instead.

## LOW

| # | Fix | Test |
|---|---|---|
| L1 | `ws.send` returning 0 (dropped) closes the reader (1013), so it can never have a silent gap. `backpressureLimit` is set above our own slow-reader bound | none new (the verifier's slow-reader run covered the bound; the 0-return path is untested) |
| L2 | Blobs: temp file is hard-linked under the blob's name (never replaces, so the first bytes are kept), then the folder is fsynced | `blobs: two puts of one hash at once…` |
| L3 | Noted at the seam in sqlite.js (`SEAM(p2)`); behaviour unchanged, phase 2 decides with § Recovery | — |
| L4 | New case "times out and then lands late": the abandoned write reaches the Store after the rebuild and gets `conflict`; the op is in the log once | `when the append times out and then lands late…` |
| L5 | A Room that throws on a hello: the connection is removed and closed with `unavailable` | `L5: a Room that throws on a hello…` |
| L6 | Rebuild page size 1,000 → **100** entries, with a `SEAM(p2)` note (the Store port pages by count, not bytes; checkpoints shrink the read) | the restart test pages with 7 |
| L7 | Strikes fade: one forgiven per 10 s | `L7: strikes fade with time…` |
| L8 | No change (as the verifier says) | — |

Also changed: the append timeout default is now **5 s** (PROTOCOL.md § Recovery says "append 5 s"; it was 10 s).

## For other owners (not done here)

- **Spec / packages/protocol (in hand elsewhere):** nesting limit in `opProblem`, so replay and other transports are
  covered. Until it lands, a deep entry already in a log still costs on rebuild.
- **packages/protocol (p2):** the Room still implements `transient`; the gateway's refusal can go when the Room drops it.
- **PROTOCOL.md:** the pre-welcome queue bound (2 MiB) and "a refused deep frame carries the op id only when the
  frame starts `{"t":"op","id":…`" are my choices; the spec gives neither.
- **Platform (deploy/):** `HOST=0.0.0.0` is now set in deploy/Dockerfile (checked by grep). Nothing left to ask.
- **Client track (web/sync.js:173):** it sends `transient: true` ops for drag previews. The gateway now refuses
  each with `bad-op` (the connection stays open, the Replica ignores the error because a transient op is never
  pending), so **live drag previews no longer reach other clients** until previews move to presence. Stripping the
  flag instead, as the verifier suggested, would have logged every preview as a durable op.
- **Spec owners, what "64" counts:** the gateway counts the whole frame, and an op sits 2 levels inside it
  (`{t, op: {…}}`), so over a socket an op can be at most 62 deep. PROTOCOL.md's test row says "64 levels pass" for
  `opProblem`, which counts the op alone. Harmless (real ops are about 6 deep), but the two bounds differ by 2.

## Not verified in this round

- **Actual timings** of the H1 test: I only have the test's bounds (< 1.5 s, < 0.5 s), not measured numbers.
- **The verifier's exact scratch tests** were not available to me; I rebuilt each attack from its report.
- **`ws.send` returning 0** and the **16 MB slow-reader close**: no test in the repo.
- **Memory:** M1's bound is asserted by behaviour (refused fast), not by measuring RSS.
- Still open from before: power loss, Linux, p95, load, idle heartbeat for clients that don't answer pings.

## New risks

- **The host now mirrors two pieces of `Room`** (`replay` and the catch-up in `Room.hello`). Both are in
  room-host.js, both marked `SEAM(p2)`, both covered by the catch-up and restart tests.
- **A v0 client that sends `transient` previews** now gets an error per preview (no close). Today's web client
  should move previews to presence when p2 lands.
- **An honest client with more than 2 MiB of unsent ops and slow sign-in** cannot reconnect until v1's
  resend-after-welcome (it retries and is refused the same way).

## Three more items from platform (via the manager)

| # | Ask | Outcome |
|---|---|---|
| 1 | Unknown `v`: gateway says `version`, test didn't accept it | The gateway was right per PROTOCOL.md; the test was mid-edit when platform ran it. It now asserts `version` for that case (M3 above) |
| 2 | `main.js` threw `last-owner` when two dev tokens share a name | Seeding now makes **one grant per user, highest role wins**, so no grant is ever lowered. Test: `main.js: two dev tokens for one user…` (three orders, real child process) |
| 3 | 4 failures in test/server in the shared tree | They were this fix round in progress (bad frames, two H1 tests, M1/M4). All of test/server passes now; the whole suite ran 3 times at the end: 206, 206 and 242 pass (other sessions added tests between runs), 0 fail |

Platform's change that `verify` / `role` now throw on infrastructure failures needed no change here: the gateway
already answers `unavailable` + 1013 for a port that throws (test: "a port that throws during hello…"), and logs only
the name and code of a `verify` error.

## Late additions (after a final review)

| What | Why | Test |
|---|---|---|
| Before the hello has been read, **no** frame over 16 KB is scanned or parsed | The 16 KB check covered only the first frame, and presence before hello is now dropped silently, so a small presence frame followed by 2 MiB frames would have been scanned unauthenticated | `M1/M4…` ("sneak" case) |
| The M1 test no longer asserts a time | It compared 120 ms against a 150 ms sign-in: a flake on a busy machine. It now holds `verify` open and checks the flood was refused while it was still pending | `M1/M4…` |
| The whole-tail catch-up frame is cached per (base, tail length) | The ask was one encode per (base, tail); it was being re-joined per joiner from cached pieces | `H1: catch-up is right…` (byte-identical frames) |
| **A catch-up may exceed the live slow-reader bound** (`maxCatchUpBytes`, 256 MiB; live stays 16 MiB) | Measured: a 22 MB tail tripped "slow reader closed" on a fresh `since: 0` join, on every retry, so a board over 16 MB could never be joined over a real network. Catch-up frames are now marked `bulk` on the bus and the reader gets the larger bound until it has drained | `a catch-up bigger than the live slow-reader bound…` |

**Limit that remains (spec ask):** a snapshot is one frame. § Limits allows 50 MB + 50 MB + 20 MB per board, and each
joiner's socket buffers its own copy until it drains, so many simultaneous fresh joins on a huge board cost that
much memory each. A chunked or streamed snapshot needs a protocol change.

**Final counts:** my four test files hold 58 tests and ran 8 times in a row with no failure after these edits. The
whole suite's last two runs: 254 pass, 0 fail each. Other sessions' tests come and go between runs; one earlier
run showed a single failure in the client track's `test/web/ui-chrome.test.js` (`view-only keys never include a
writing key`), which did not repeat and is not in my files.

## Durable Registry wired into main.js (after p3-registry)

**Done.** `server/main.js` now uses `sqliteRegistry({ path: <data>/registry.db })` (p3-registry's adapter, not
edited). Boards, grants and the op log all survive a restart and a kill -9. Files touched: `server/main.js`,
`test/server/main.test.js`.

| From the proposed diff | Applied? |
|---|---|
| `sqliteRegistry` in its own file next to `plenary.db`; closed in `stop()` | Yes |
| Dev board id kept in `<data>/dev-board.json`, reused on restart; the lookup is outside any try, so a Registry failure fails the start instead of minting a second board | Yes, and the file is written to a temp name and renamed, so a kill mid-write can't leave half a file |
| `last-owner` caught and logged, start goes on | Yes |
| Reconciled with one-grant-per-user, highest role wins | Yes. Added: grants are applied highest role first, so a new owner named in the same start is in place before an old owner is lowered |
| Stale `SEAM(platform)` comment | Rewritten: the Registry is durable; what is left for platform is `POST /boards` and sign-in |

Tests (real child processes, port 0, each child killed by its own handle):

- **`main.js started twice on one data dir…`**: same board and tenant id after the restart; a fresh client sees the
  5 acked ops at their seqs; a resend of an acked op gets the same seq; a new op gets seq 6; a token whose role
  dropped from owner stays owner (logged), another is promoted, a new one is added.
- **`kill -9 mid-stream, restart…`**: three rounds of SIGKILL while a client pumps ops, each followed by a restart
  on the same data and a resend of everything sent so far. Then the log is read straight from `plenary.db`: no seq
  gap, no op logged twice, every sent op present once, and every acked op at exactly the seq it was acked with
  (more than 450 acked ops per run). Ran 6 times in a row with no failure.

This closes the first report's biggest open item ("boards vanish on restart"; the kill -9 gate can now pass through
`main.js`).

Not verified: power loss (process kill only); a kill between creating the dev board and writing `dev-board.json`
(the next start would mint a second dev board; the first stays in the Registry, unused); grants of dev tokens that
were removed from the env stay in the Registry (harmless: their tokens no longer verify).

---

# Fix round 2 (after docs/m2/reports/p3-scaffoldv2.md: FAIL, 1 HIGH, 2 MEDIUM, 5 LOW)

**Outcome: H1, M1, M2 and the LOWs in my files are fixed and tested.** `bun test`, final: 0 fail in three full runs
in a row (315 pass on the last two; the totals move because other sessions are adding tests, some skipped). My five
test files: 72 tests. Not committed. Round 1's "256 MiB catch-up bound" paragraph above is superseded by this
round: that bound and its exemption are gone.
Files touched: `server/gateway.js`, `server/room-host.js`, `server/store/sqlite.js`, `server/bus/memory.js`,
`server/main.js`, new `server/breather.js`; `test/server/rig.js`, `gateway.test.js`, `main.test.js`, new
`outbound.test.js`. Nothing in auth/, admin/, registry/, registry.test.js, PROTOCOL.md or packages/.

## Measured (scratch run, in-process rig, default limits, this machine)

| Attack from the verifier's report | Before (verifier) | Now |
|---|---|---|
| Annotator rewrites one note 280 × 990 KB; fresh `since: 0` viewers | 3 of 3 closed, no catch-up, before and after a restart | 3 of 3 joined in **5–6 ms, 2.0 MB each**, before and after a restart (rebuild 0.8 s). Kept tail: 1 entry, 1.0 MB |
| One editor's burst of 6,400 small ops; `/health` meanwhile | 5.6 s | **worst 22 ms** over 228 polls (burst stored in 4.2 s) |
| Same with 500 ops | 0.47 s | worst 21 ms |

## H1: what changed

| Part (manager's a/b/c) | What it does now | Where |
|---|---|---|
| (a) Catch-up is never one frame | The tail goes out as `entries` frames of at most **1 MiB** (one bigger entry travels alone), built once per (base, tail) from cached entry text and shared by joiners. A reconnecting client mid-tail gets exactly what it lacks | room-host.js `tailChunks`, `catchUp` (`SEAM(p2)`) |
| (a) Paced by the socket | Every outbound frame goes through a per-connection queue. `flush` hands frames to the socket until `send` reports backpressure, then waits for Bun's `drain`. A slow reader holds one socket buffer of copies; the rest waits as references | gateway.js `flush`, `drain` |
| (b) Fold by bytes | The kept tail is folded into the snapshot at 1,000 entries **or 8 MiB of text**, live and during the rebuild after a restart. A board's catch-up is its real state plus at most 8 MiB | room-host.js `foldIfDue` |
| (c) Budgets | "Owed" = socket buffer + queue, for every connection, shared text or not. **64 MiB per user, 256 MiB per process.** Over on a catch-up frame: that joiner is told `unavailable` and closed (nobody being served is cut for a newcomer). Over on live traffic: the reader furthest behind is cut | gateway.js `admit` |
| (c) Per-user connection cap | **64 open sockets per user** (env `PLENARY_MAX_CONNS_PER_USER`); the newest gets `unavailable` | gateway.js `hello`, main.js |
| (c) Non-readers | A connection owed bytes that drains none for **15 s** is reset (`terminate`), whatever it sends. Presence no longer keeps it alive | gateway.js sweep |
| Removed | `maxCatchUpBytes`, the `bulk` exemption and `maxBufferedBytes` are gone: nothing is exempt from the budgets. `catchup` on the bus is only a label for whom to turn away | |

Tests (test/server/outbound.test.js unless noted):
- **The attack, scaled (40 × 200 KB, fold at 1 MiB, user budget 2 MiB so the unfolded 8 MB tail could never fit):**
  three fresh viewers join, each under 1.6 MB, no frame over the chunk bound, a Replica equals the room; then a
  restart on the same data, and the same again.
- **A tail bigger than a frame** arrives as more than 10 bounded frames, in order, complete; a mid-tail reconnect
  gets exactly seq 18–30.
- **Six raw TCP sockets that never read** (16 MB board, one account, presence every 40 ms): the account's share
  (24 MiB in the test) holds, at least three are turned away with `unavailable`, **another user joins meanwhile**,
  the holders are cut by the stall rule, and at the end owed bytes, tracked bytes, queued bytes and the user table
  are all exactly 0. The test asserts the server is really owed more than 8 MB first, so it isn't vacuous.
- **A slow reader that does read** gets the whole 12 MB catch-up and is not closed.
- **Per-user connection cap**, in-process and through main.js's env setting.

## M1 (one writer's burst freezes the process): fixed

A process-wide breather (`server/breather.js`): after 8 ms without yielding, the next unit of work waits one turn of
the event loop. Awaited per inbox message in the room host, per frame in the gateway's pump, and per page in a
rebuild. Tests: `/health` polled during a 4,000-op burst never waits 1 s (measured worst: 22 ms); a unit test of the
breather with an injected clock and with a real busy loop.

## M2 (unmarked divergences): each fixed or marked

| Divergence | Outcome |
|---|---|
| Rule 11, ops before `welcome` are forwarded | `SEAM(p2)` at `forward` in gateway.js (today's Replica sends its ops right behind the hello) |
| Reply subject `plen-gw.<gw>` instead of `plen.<tenant>.<board>.gw.<gw>` | `SEAM(p4)` in room-host.js and bus/memory.js. Not changed: it needs subscribe-before-forward per board, new failure surface right before the room-host swap |
| Catch-up and snapshots travel on the bus (§ Bus says they don't) | `SEAM(p4)`, same place. Frames are now at most 1 MiB, except the snapshot |
| Close notice `{bye: true}` without `n` | **Fixed:** `{ n, conn, gateway, closed: true }` |
| Inbox messages without `name` | **Fixed:** `name` is sent |
| No 5 s open-connection list | `SEAM(p4)` in room-host.js |

## LOW

| # | Outcome |
|---|---|
| L1 pre-welcome bytes, process-wide | **Fixed:** 64 MiB over all connections; past it the newest sender gets `unavailable`. Test `L1: …`. The limits' comments now say the sizes are characters (up to 2 bytes each) |
| L2 `opProblem` depth | Not mine (packages/protocol) |
| L3 second dev board after a mid-start kill | Unchanged, as the verifier says |
| L4 depth counted on the whole frame | Unchanged; spec note (ask below) |
| L5 flaky convergence test | **Fixed in rig.js:** `connect`/`reconnect` share one in-flight promise and `settled()` waits for a reconnecting client. **Convergence test: 50 runs, 50 pass.** New deterministic test `L5: …` forces the refused-op resync 15 times right before `settled()`: 10 runs, 10 pass |
| Round 1's L6 (rebuild page size) | **Closed:** pages stop at 4 MiB of stored text as well as 100 entries |

## My own choices, for the spec owners to confirm or change

- **`Store.read(…, limit, maxBytes?)`**: a fifth, optional argument, and the returned array carries `bytes` (each
  entry's stored size). § Store pages by count only.
- **Defaults:** chunk 1 MiB; fold at 8 MiB; 64 MiB per user and 256 MiB per process owed; 64 sockets per user; stall
  15 s; slice 8 ms; pre-welcome 64 MiB per process. None is in PROTOCOL.md.
- **Turned away vs cut:** a joiner over budget is refused; nobody already being served is cut for it.

## Asks

- **Spec:** a byte trigger for checkpoints in § Recovery (it folds by entry count only, so gateway-served catch-up
  in p2/p4 inherits H1). A chunked or streamed snapshot. Where the depth bound counts from (L4).
- **Load test (p8):** raise `PLENARY_MAX_CONNS_PER_USER` if clients share dev tokens.

## Limits that remain

- **A snapshot is still one frame.** One connection can be owed a board's whole state; a board whose snapshot is
  over **64 MiB** (the per-user share) cannot be joined at all, and § Limits allows about 120 MB. Needs the chunked
  snapshot above.
- **Honest joiners can be turned away:** four simultaneous fresh joins of a 60 MB board exceed 256 MiB and the
  fifth gets `unavailable` (it retries). That is the budget working, but it is a capacity number to tune in M4.
- **A socket we close gracefully that never reads** (a joiner turned away) is not reset: Bun reports it closed and
  stops reading it, but I could not confirm when its file descriptor goes. Sockets holding bytes are reset.
- **Rebuild still replays the whole log** (0.8 s for 277 MB here); only checkpoints fix that.

## Not verified in this round

- **Process memory.** The budget is asserted from the sockets' own buffered counts, not from RSS or footprint. My
  scratch run's RSS (0.8–1.0 GB) includes the test client in the same process, so it says nothing about the server.
- **The verifier's exact attacks against `bun server/main.js`** from a separate process: I ran them in-process on
  the rig. Only the connection cap and the earlier restart/kill tests go through main.js.
- **A slow reader over a real network**, Linux socket buffer sizes, and more than 6 non-readers.
- **Drain under load with thousands of sockets**; the sweep is O(connections) every second.
- Still open from before: power loss, Linux, p95, a soak.

## Late additions (after a final review of this round)

| What | Why | Test |
|---|---|---|
| **Non-readers spread over several accounts can't lock joiners out.** When a joiner doesn't fit, the reader that has drained nothing for the longest (at least 2 s, `stallGraceMs`) is cut first; the joiner is refused only if everyone is draining | Each account could stay under its 64 MiB share while four of them filled the 256 MiB budget, refusing every join on every board for up to 15 s at a time. Same class as H1 | `H1: non-readers spread over several accounts…`: with the stall timer set to 60 s, three honest users still join within 3 s, and the log shows "making room", never "stalled" |
| **The connection cap is re-checked in the step that counts the connection** | Hellos waiting together on the room open all passed the earlier check | `the connection cap holds when many hellos… are in flight together`: 6 hellos behind a gated room open, cap 2: exactly 2 welcomes |
| M1 test retitled | It polls `/health`, not a second board; the title said both | — |
| Non-reader test made less platform-bound | It leaned on macOS loopback absorbing about 2.5 MB; the board is now 24 MB and the mid-test equality between tracked and re-read bytes is gone (the exact zeros at the end stay) | — |

## For the phase-2 room-host swap: what must survive it

| Behaviour | Lives in | Guarded by |
|---|---|---|
| Kept tail folded by bytes (8 MiB), live and on rebuild | room-host.js `foldIfDue` | `H1: an annotator rewriting one note…` (before and after a restart) |
| Catch-up `entries` frames ≤ 1 MiB, labelled `catchup` on the bus | room-host.js `tailChunks` / `catchUp` | `H1: a tail bigger than any one frame…`, `H1: catch-up is right for every since…` |
| A breath per inbox message and per rebuild page | room-host.js (`breathe`) | `M1: one writer's burst…` |
| Rebuild pages bounded by bytes | room-host.js `load`, store `read(…, maxBytes)` | `Store.read can stop a page by size…` |
| Output held until the append resolves; `n` gap check; close notice | room-host.js `handle` | round 1's tests |

Pacing, budgets, the stall rule and the caps are all in gateway.js and don't depend on the room host.

## Two more numbers and one more ask

- **Fold cost, measured on a 30 MB board:** the fold itself under 1 ms (`Room.compact` doesn't copy elements); the
  first join after a fold 39 ms (it encodes the 30 MB snapshot once); the next join 19 ms. So a fixed 8 MiB trigger
  costs a big board about 40 ms per 8 MiB written. A trigger relative to the board's size (the manager's other
  option) would fold less often on big boards; I kept the fixed cap because it bounds catch-up absolutely.
- **Load test (p8):** clients that share a dev token share that user's **64 MiB outbound share** as well as its
  64-socket cap. Only the socket cap has an env setting; the byte share is a `limits` option of `createServer`.

---

# Fix round 3 (after docs/m2/reports/p3-scaffoldv3.md: FAIL, 2 HIGH, 5 LOW, 1 unresolved lead)

**Outcome: H1 and H2 are fixed and tested; L1, L2 and L5 are addressed; the lead did not reproduce.** `bun test`,
final: 328 pass, 70 skip (other sessions' tests), 0 fail, three full runs in a row. My five test files hold 78
tests; the new file ran 6 more times, 0 fail; convergence 20 of 20. Not committed. Files touched:
`server/gateway.js`, `server/room-host.js`, `test/server/outbound.test.js`, `test/server/main.test.js`,
`test/server/rig.js`, new `test/server/trickle.py`.

A review after the first pass of this round found four more problems in the new path, all with a writer active
or with slow readers; they are fixed too (see "Second pass" below). The numbers in this section were re-measured
after it.

## H1 (a catch-up over the per-user budget was always refused): fixed

**The change, as decided:** a queued catch-up frame no longer counts against any budget. It is the room's
encode-once text, one immutable string shared by every joiner; a connection's queue holds only a reference.
What counts is what a connection really costs: the bytes in its socket buffer, plus its own queued frames (live
traffic, errors). Catch-up frames are **pulled** into the socket one at a time, as the socket drains and only while
the copy fits the budgets (gateway.js `flush`, `noRoom`).

| Before (round 2) | Now |
|---|---|
| Every catch-up frame was admitted against the user's 64 MiB as it arrived, before any drain; over it, the joiner was refused | The whole catch-up waits in the queue for free; one frame at a time enters the socket |
| A joiner the budget had no room for was refused at once | It **waits its turn** (woken when anyone drains or leaves). A reader that has drained nothing for 2 s is cut to make room. Only after 30 s of waiting (`maxCatchUpWaitMs`) is the joiner told `unavailable` |
| A frame bigger than a whole budget could never be sent | It goes when that budget is otherwise empty |

**Measured (scratch, in-process rig, default limits):** the verifier's board, 70 notes × 990 KB from one annotator
(snapshot 62.4 MB + a 6.9 MB tail).

| Joiners, all at once, all `since: 0` | Round 2 (verifier) | Now |
|---|---|---|
| 3 tabs of one viewer + the owner | 0 of 3, owner 0 of 1 | **4 of 4, 69.3 MB each, 0.2 s** |
| 8 mixed (two accounts with two tabs each) | — | **8 of 8**, 0.4 s |
| After a restart: 3 tabs of one viewer + the owner | 0 of 3 | **4 of 4**, 0.4 s |
| 20 at once on a 20 MB board, from a separate process, 40 rounds (the verifier's L6: 13–18 of 20) | 13–18 of 20 | **800 of 800**, none turned away |

**The snapshot is still one frame.** Chunking it needs a protocol change: a second `snapshot` message at the same
`seq` is ignored by the Replica, and Bun's `ws.send` can't send one message as fragments. It is shared, so it costs
each joiner only its socket buffer while it drains.

Tests (test/server/outbound.test.js), sized **above** the budget:
- `H1 (round 3): a board bigger than a user's whole budget is joinable from scratch`, two shapes (a 10 MB snapshot,
  and a 10 MB tail, each against a 4 MiB share and a 12 MiB process budget): the owner and **three tabs of one
  viewer**, all at once, each get the whole board; a Replica equals the room; then the same after a restart.
- `…a slow reader of a board bigger than its budget gets all of it`: a raw socket that pauses, then reads; the
  server never owes it more than 4 MB of a 12 MB catch-up (under 2 MB while paused).
- **The round-2 non-reader pin stays fixed:** six sockets that never read (and keep sending presence) never hold
  more than the account's share, another user joins meanwhile, all six are cut, and every counter ends at 0.
- Non-readers over four accounts: honest users still join within the grace, nobody is turned away.
- A joiner that waits past `maxCatchUpWaitMs` gets `unavailable`, not a hang.

## H2 (kill -9 test flaked on `> 450`): fixed

The count threshold is gone as a judgement: the test now asserts `>= 450` (true by construction, 150 acks per
round) and what it is for: the log is gapless, no op is logged twice, every sent op is there once, and every acked
op sits at the seq it was acked with. **30 runs of the test, 30 pass.**

## LOW

| # | Outcome |
|---|---|
| L1 `transient` replies bypassed the queue | **Fixed:** errors to a live connection (bad frames, `transient`) go through the same queue and budgets as everything else |
| L2 chars vs bytes | The limits' comments now say which is which (socket buffers in bytes, queued frames in chars, up to 3 bytes each). Not converted: measuring UTF-8 length of every frame costs a pass over it |
| L3 per-user connection cap is my own choice | Unchanged; for the spec (ask below) |
| L4 § Pacing not enforced | Unchanged, `SEAM(p2)` |
| L5 heartbeat and `.here` unmarked | **Marked** `SEAM(p4)` in room-host.js |
| L6 concurrent joins turned away | Gone with H1's fix (800 of 800 above) |

## The unresolved lead (malformed snapshot frames seen by Bun's WebSocket client): not reproduced

| Attempt | Result |
|---|---|
| The verifier's shape: 20 Bun `WebSocket` joiners at once on a 20 MB board, **from a separate process**, 40 rounds, against the real server (current code). Every snapshot frame (19.8 MB) compared byte for byte with the first, and parsed | **800 of 800 identical and valid** |
| A minimal Bun server with none of Plenary's code, one 17 MB frame to 20 Bun clients at once, 36 rounds, compared with the expected text | **720 of 720 identical** |
| The same minimal server resetting (`terminate`) or closing (1013) each socket 0–6 ms after sending, to see whether Bun's client hands over a partly received frame | 815 frames delivered, **all identical**; the rest delivered nothing. No corrupt frame |

So I have **no evidence either way**: it did not reproduce on this code, on a server without our code, or with
sockets cut mid-frame. I can't say it is Bun's client, and I can't say what triggered it. One fact about the
server side: a catch-up frame is one string handed to `ws.send` unmodified, so if the server did send bad bytes,
the fault would be inside Bun's send path, not in building the frame. If it shows up again, the next step is the
verifier's: a raw TCP capture at that moment.

## Second pass (after a review of this round's first version)

| Problem | Reproduced? | Fix | Test |
|---|---|---|---|
| **A writer active during a join cut the joiner.** Live frames were admitted against the user's share, which now included the snapshot sitting in the joiner's socket | Yes: the new test failed first | Live traffic is judged only on a connection's own queue (16 MiB, `maxConnQueuedBytes`). What sits in sockets is governed where it is put there | `a writer active during catch-up doesn't get a slow joiner (or its other tab) cut` |
| **A waiting joiner looked stalled** (live frames queued behind its catch-up counted as "owed, not reading") and could be reset, or offered as the victim for another waiter | By reading; then by test | "Reading" is judged on the socket alone. A waiter over a limit is told `unavailable`, never reset | `a joiner that waits too long for room…` (now with a writer active) |
| **A waiting joiner blocked itself:** its own queued live frames counted as "the user already holds bytes" | Yes, in that same test | Room for a catch-up frame is judged on bytes in sockets only | same |
| **Trickle readers** (alive, far too slow) could hold the budget and keep a joiner waiting 30 s | Yes, with a Python client (4 KB receive buffer, 160 KB/s) | The make-room rule now goes by pace: a reader that, at the rate it drained over the last 2 s or more, needs over 60 s (`slowEtaMs`) to empty its socket makes way. One that drained nothing is the limiting case | `trickle readers can't hold the budget against a joiner…`: the joiner is in within 5 s; two readers at a fair pace are left alone and the joiner behind them waits its turn. Skipped if `python3` is missing |
| **Catch-up text was only shared within one (snapshot, tail length).** Each fold or new entry made new strings, so joiners parked at different times each held their own copy, uncounted | By reading; then by test | Full tail chunks are kept and only the open last one is rebuilt. The room names each shared text; the gateway counts each name once and bounds the distinct text that queues still reference (256 MiB, `maxSharedQueuedBytes`): past it, the longest-waiting joiners are told to come back | `joiners parked across folds can't pin a board's worth of replaced text each…` |

## My own choices this round, for the spec owners

- `maxCatchUpWaitMs` 30 s and `stallGraceMs` 2 s. A joiner waits rather than being refused.
- `slowEtaMs` 60 s, `maxConnQueuedBytes` 16 MiB, `maxSharedQueuedBytes` 256 MiB.
- The bus's `catchup` field is now a name for the shared text (a string), not a flag.
- A frame bigger than a whole budget is sent when that budget is otherwise empty.

## Asks

- **Spec (engine):** rule 3 still needs a chunked snapshot or a stated maximum snapshot size. Add the per-user
  connection cap to § Limits or § Known limits (L3).

## Not verified in this round

- **Against `bun server/main.js` in a separate process:** only the malformed-frame runs had the client in another
  process; the 70 MB measurements ran in-process on the rig.
- **Process memory during a 70 MB join.** By design each joiner costs its socket buffer, and a fast loopback reader
  shows about 0 owed; I did not measure footprint, and a slow reader's socket holds the whole 62 MB snapshot.
- **Trickle readers at the verifier's scale** (18 sockets on 6 accounts holding 248 MB): my test has two.
- **Process memory with joiners parked across folds:** bounded by count of distinct text (asserted from the
  gateway's own tally), not measured by footprint.
- Linux, a real network, thousands of sockets, power loss, p95, a soak: still open.

## Risks

- **Waiting joiners hold a socket and a room connection for up to 30 s** each. The per-user connection cap bounds
  how many one account can park there.
- **A slow reader of a big board still pins one snapshot-sized socket buffer** (62 MB on that board) until it
  drains or stalls for 15 s (2 s when someone else needs the room). The process budget (256 MiB) bounds how many.
- **The make-room rule moves a slow reader aside when a joiner is waiting:** one whose socket, at its measured pace
  over at least 2 s, would take over 60 s to empty. On the 62 MB board that is any reader below about 1 MB/s. It
  reconnects and tries again, and may never finish on a server that stays that busy.
- **The pace is measured from buffer decreases the gateway happens to observe** (on drain events and the 1 s
  sweep), so it can read low; it errs toward calling a reader slow.

# Fix round 4 (after docs/m2/reports/p3-scaffoldv3.md "Round 4": FAIL, R4-H1 suite unstable, R4-H2 big snapshot)

Fresh builder (`worker p3-fix4`), from the round-3 handoff. Not committed.

**Outcome: both HIGHs are fixed and tested, and the gate passes under load. R4-H2's 1006 was not the server.**

- **Bun's WebSocket *client* refuses any message over 128 MiB.** It closes 1006, and the server sees nothing.
  Bun's server delivered single 150 MB and 400 MB frames whole, even with the old 138 MB `backpressureLimit`.
- **So the verifier's 151 MB join will still fail with a Bun client.** No server setting can change that. See
  "Decision needed".
- **The server defect behind the limit was real, and is fixed.** A frame sent *behind* a big snapshot, while the
  socket still held more than the limit, was dropped by Bun, and the reader was cut.
- **Gate:**
  - **Full `bun test`, loaded** (three suites at once): **21 / 21 runs with 0 failures.**
  - **Full `bun test`, quiet:** 17 / 20. All 3 failures were platform's `test/auth/http.test.js`, during platform's
    edits (details below). None of my tests failed in any run.
  - **kill -9 test:** **30 / 30 quiet, 15 / 15 loaded.**

Files: `server/gateway.js`, `server/room-host.js`, `test/server/outbound.test.js`, `test/server/rig.js`.

## R4-H2: what closes a big join, measured

| Experiment (Bun 1.4.4, scratch script, loopback) | Result |
|---|---|
| Server `ws.send` of one 150 MB frame, `backpressureLimit` 138 MB, raw TCP reader parsing the frame header | **Delivered exactly**: payload 149,999,999 of 149,999,999 bytes |
| Same with a 400 MB frame | **Delivered exactly** (399,999,998 bytes) |
| Bun's `WebSocket` client receiving 134,217,700 bytes (limit 400 MB) | Received |
| Bun's `WebSocket` client receiving 134,217,800 bytes | **Client closes 1006**; the server gets no close (it saw one only when stopped) |

- **The client cap sits exactly at 2^27 = 134,217,728 bytes.** The verifier's numbers fit: 130 MB joined, 151 MB
  didn't, owner included, and with nothing logged.
- **Bun's server never drops a frame handed to an *empty* socket**, whatever its size. It drops (send returns 0) a
  frame handed to a socket that **already holds** more than `backpressureLimit`.
- **The old code could do exactly that.** `drain` fires every time the kernel takes a chunk, so it fired with
  ~100 MB still buffered behind a snapshot. `flush()` then sent the next live frame, Bun dropped it, and the reader
  was cut ("frame dropped by the transport").

## R4-H2: the fix (as decided in the brief)

- **Admitted in UTF-8 bytes.** Every outbound size (shared catch-up, own frames, the shared-text tally, `owed`)
  is in UTF-8 bytes, the unit `getBufferedAmount` reports (round 3's L2, closed).
  - **Measured once per text.** The room host measures each snapshot and chunk once, when it builds it, and sends
    `bytes` with it on the bus; otherwise the gateway measures it.
  - **Inbound accounting is unchanged.** `sizeOf` still counts chars there.
- **`backpressureLimit` = `maxSnapshotBytes` + `maxUserBufferedBytes` = 450 MB + 64 MiB.**
  - **From § Limits:** `board` 50 MB + `notes` 50 MB + `records` 20 MB = 120 M. The unit isn't stated, so the worst
    case is taken: 3 UTF-8 bytes per char, then +25% for `noteAuthor`, `appSeq` and the envelope. 120 M × 3 × 1.25
    = 450 MB.
  - **A threshold, not an allocation.** The budgets still bound what the process holds.
- **`flush()` never hands Bun a frame it would drop.** If the socket holds bytes and those plus the frame would
  pass the limit, the frame waits for the next `drain`. So the number matters only for how soon live traffic
  behind a snapshot moves. Nothing is lost whatever it is.
- **Loud, once per text:**
  - **`error` when a frame is over the limit itself** ("past the spec's caps"). It is still sent: it goes into an
    empty socket.
  - **`warn` when a frame is over 128 MiB** ("Bun's WebSocket client refuses it"). The server can't see that
    refusal, so it says so when it sends.
  - **`error` with sizes if a send ever returns 0.** That was a bare cut before.
- **R4-L1:** the comment at the shared-text cap now says one text bigger than the whole bound is held when it is
  the only one, and why.

**Tests (scaled, as the brief allows):**

- **"R4-H2: a board whose snapshot is several times the old socket limit…"**
  - **The board:** ~12 MB of UTF-8 in ~4 M chars (U+4E2D notes). The old formula gives a 6 MB limit at these
    budgets.
  - **The run:** a raw reader holds the snapshot unread while a writer's 20 entries queue behind it, then reads.
    The test asserts the welcome, the whole snapshot (12 notes, > 11 MB in < 5 M chars), all 20 entries in order,
    no cut, and zero owed at the end.
  - **Proved to fail on the old code:** with the old limit and no `flush()` check, the reader is cut and never gets
    its last entry. Run twice, before and after the load-proofing rewrite.
- **"R4-H2: with the limit BELOW the snapshot, flush() holds frames behind it…":** the same scenario at a 5 MB
  limit, under the 12 MB snapshot. Every live frame waits for the socket to drain instead of being dropped; one
  `error` line.
- **Bytes, not chars:** in both tests, a second tab of the same user parks behind the first. The test asserts the
  shared text it waits on is counted as > 11 MB (UTF-8), not ~4 M chars, and that this tab then gets everything.
- **Each piece of the fix proved necessary.** Reverting one at a time, the named test fails:

  | Reverted | Fails |
  |---|---|
  | Only the `flush()` check (limit stays new) | "limit BELOW the snapshot": the reader is cut |
  | Only shared-frame sizes in bytes (back to `string.length`) | "several times the old limit": `sharedBytes` is ~4 M |
  | Old limit formula and no `flush()` check | "several times the old limit": the reader is cut |
- **"R4-H2: a frame over the socket limit … is logged loudly once per text":** two joiners of a 3 MB snapshot at a
  2 MB limit. Both get it, and exactly one `error` line is logged.
- **`rawSock({ frames: true })` (rig.js) parses server frames, so a test can check messages of any size.** It also
  keeps any bytes that arrived with the 101 handshake response; it used to drop them.

## R4-H1: the suite under load

The brief asked for the two named tests. The manager added (t14j) that the gate must hold on a busy machine. A first
loaded batch failed 1 of 21, on an older stopwatch bound of mine. So every test in `outbound.test.js` now asserts
its property from the server's own signals, not from time:

| Test | Was | Now |
|---|---|---|
| joiners parked across folds (:399) | Needed the hog's socket to hold > ~3 MB (kernel-dependent) | The joiners are the hog's user, and the user budget (1 MB) is smaller than any snapshot, so a joiner waits exactly while the hog holds any byte. Waits on `waitingJoiners + turnedAway` per joiner and on `room.base.seq` per fold. Asserts the ones sent away are a **prefix** of arrival order (longest-waiting first) and the newest stays |
| trickle readers (:358) | Asserted 300 ms after spawning python, before it had joined; passed silently without python3 | Waits until both tricklers read and hold > 24 MB. `test.skipIf(!python3)`, with "(needs python3: skipped without it)" in the name. Its second half (steady readers) is its own test, since it needs no python. The 5 s stopwatch is replaced by: no error, `turnedAway` 0, exactly one "making room" cut |
| non-readers over several accounts | `< 4000 ms` (failed at 4,186 ms in the loaded batch) | Waits for the server to report the non-readers in place. The property comes from the log: cut by the make-room rule, never "stalled" (stall rule set to 10 min) |
| non-readers under the budget, wait timeout, writer during catch-up | Setup by `sleep()` | Waits on `accepted`, `owedBytes`, `sharedTexts`, `waitingJoiners` and the writer's acks |
| `/health` during a burst | `worst < 1000 ms` | Counts `/health` answers that came back **while acks were still arriving**, at > 10 distinct points of the burst. A frozen loop answers only after the last ack. **Checked not vacuous:** with the breather disabled, 0 answers came back during the burst and the test failed |
| breather, real time | Timer fired `< 150 ms` | The timer fired **before the busy loop ended** |
| process pre-welcome budget (L1) | `sleep(20)` to order sockets | Waits until the server has queued each socket's bytes |

- **Server timers that a test isn't exercising are set to minutes** (stall, hello, catch-up wait), so load slows a
  test but can't change its result.
- **Rig defaults raised.** `sock.next` and `whenClosed` now default to 30 s: backstops, never expectations. No test
  relies on one timing out.
- **Two sleeps remain, and load can't break them.** One is a lower bound on how long the server had to wrongly
  push more (:121). The other only makes a race likelier (:223); the assertions hold whichever way it goes.

## Gate, counted

Final code (after the mutation checks and the `bigJoin` tests). The suite itself grew from 401 to 556 tests during
the last batch, as other sessions added files.

| Batch | Result |
|---|---|
| Full `bun test`, **3 suites at once**, 7 rounds (final code) | **21 / 21, 0 failures** |
| Full `bun test`, one at a time (final code) | **17 / 20.** All 3 failures are in platform's `test/auth/http.test.js` (sign-in flow, links, replay guard): runs 6 (22:02), 11 (22:05) and 12 (22:06). Platform was editing `server/auth/` and `test/auth/` throughout: files written at 21:53, 22:05:30 (`http.test.js` itself) and 22:12 (`server/auth/http.js`). The replay-guard test is the one the verifier already saw time out under load in round 4 |
| Same two batches, one test-code revision earlier | Loaded **21 / 21**. Quiet 19 / 20: the failure was platform's `architecture.test.js`, while `server/auth/*` was being written (21:28–21:30; the run ended 21:29) |
| kill -9 test, quiet | **30 / 30** |
| kill -9 test, each beside a full suite | **15 / 15** |

- **No test under `test/server/` failed in any of the 82 full suites** of the two final-code gates and the one
  before them.
- **The brief's bar is "20 runs in a row with 0 failures".** It is met by the loaded batches (21 in a row, twice),
  not by the quiet batch, because of the platform test above. I can't make that one pass from my files.
- **The flagged R4-H2 failure was not reproduced here.** Platform's drawh builder saw it fail twice under heavy
  load; I didn't get their output. Both R4-H2 tests were rewritten event-first before these gates.

## Real size, against `bun server/main.js` (separate process)

The verifier's attack at a larger size, after the fix: one annotator writes **175 notes × 333,000 × U+4E2D**
(~1 MB of UTF-8 each). Default limits, with dev tokens. Joiners are raw TCP clients that parse frames
(`rawSock({ frames: true })`), from a separate process. The servers were stopped by their PIDs.

| Phase | Joiner, `since: 0` | Result |
|---|---|---|
| Before restart | owner | **Joined, 234 ms.** Snapshot at seq 156: **155.9 MB UTF-8** (52.0 M chars), then 7 `entries` frames to seq 175 (174.8 MB on the wire) |
| | viewer 1, viewer 2 | **Joined**, 158 ms and 160 ms, same frames |
| | viewer, **Bun's WebSocket client** | `welcome`, then **closed 1006** after 40 ms. The server logged `warn` "outbound frame over 128 MiB: Bun's WebSocket client refuses it", with bytes 155,862,758 |
| After a SIGTERM restart (rebuilt from the log) | owner, viewer 1, viewer 2 | **Joined**, 681, 156 and 146 ms, same frames and sizes |

- **The 128 MiB warning was logged once per server process.** It is once per text, and each process built the
  snapshot once.
- **No other warn or error line, and no cut.**
- **Clean-up: NOT done. The delete was refused by the permission system**, as it was for the last verifier. Left in
  my session scratchpad: `/private/tmp/claude-501/-Users-r-repos-plenary/87a620ac-2ae9-42d7-af0f-2198171575a4/scratchpad/bigdata2`
  (168 MB, this run's data) and `…/scratchpad/bigdata` (~208 KB, a failed first try), plus gate logs in `…/gate*`.
  Someone with delete rights should remove the `scratchpad` folder. All the servers I started were stopped by PID:
  4507 and 5409 by the script, and 159 and 2931 (orphans of two failed tries of my script) by hand.

## Decision needed (engine manager / spec)

**A board whose snapshot is over 128 MiB can't be joined from `since: 0` by Bun's WebSocket client**, whatever the
server does. Browsers: untested (Firefox's documented default is far higher; Chrome's I don't know). Herdr's
QuickJS WebSocket: untested.

- **Option A, caps in UTF-8 bytes:** state § Limits' caps in UTF-8 bytes (120 MB of streams). The largest snapshot
  is then ~120 MB plus `noteAuthor` and the envelope. That's just under 134.2 MB, with little room to spare.
- **Option B, snapshot in parts:** a chunked snapshot (round 3's spec ask). It removes the one-frame limit
  everywhere and the one-snapshot-sized socket buffer per slow reader. It needs a protocol change and Replica work.

My recommendation: B. A is tight enough that any growth in the snapshot shape breaks it again.

## Not verified

- **Clients:** browsers' and Herdr's maximum message size.
- **Platforms:** Linux; a real network.
- **Load:** a loaded gate of more than 3 concurrent suites.
- **The drawh builder's two R4-H2 failures:** I didn't see their output, so I can't say which assertion failed.
- **Memory:** process footprint during the real-size joins (reported only as what's listed above).

## Risks

- **Live traffic behind a big snapshot now waits.** It waits for the socket to drain below the limit rather than
  being dropped. That is bounded by `maxConnQueuedBytes` (16 MiB), past which the reader is cut as before.
- **`Buffer.byteLength` runs on every own frame** (live traffic), per connection. That is linear in what was
  already built for that connection, but a cost at 2k connections. A per-entry byte count from the room host
  would remove it.
- **The room host sends `bytes` on the bus.** The NATS adapter (not mine) must pass the field through. The gateway
  measures the text itself if the field is missing.
