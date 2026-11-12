# Handoff: p3-scaffold (single-node server scaffold), after fix round 3

Written 2026-11-11 by the builder (terminal t14z) at about 50% context, for a fresh builder if round 4's
verification fails. Nothing here is committed by me; the manager (`manager engine`, t14j) commits by path.
No code was changed while writing this.

## State

- **Tests:** `bun test` = 328 pass, 70 skip (other sessions' tests), 0 fail, three full runs in a row at the end of
  round 3. My test files hold 78 tests.
- **History:** brief `docs/m2/briefs/p3-scaffold.md`; my report `docs/m2/reports/p3-scaffold.md` (first build, fix
  rounds 1–3, each with what was not verified); verifier reports `docs/m2/reports/p3-scaffoldv.md`, `…v2.md`,
  `…v3.md`. Read the newest verifier report first, then "Fix round 3" in my report.
- **Rules that bit me:** port 0 only; kill only processes you started, by their handle or recorded PID, never
  `pkill`; temp dirs outside the repo; PROTOCOL.md and packages/ are not yours; don't commit.

## Files

| Yours (this job) | What |
|---|---|
| `server/server.js` | `createServer`: Bun HTTP + WS, `/health`, `/ws`, optional `http` handler |
| `server/gateway.js` | Sockets: inbound checks, auth before the room, **the whole outbound path** (queue, budgets, stall rules) |
| `server/room-host.js` | Runs packages/protocol `Room` behind Store + Bus. The only file that touches Room internals. Every bridge is `SEAM(p2)` |
| `server/store/sqlite.js`, `server/bus/memory.js`, `server/blobs/disk.js` | Single-node adapters |
| `server/breather.js`, `server/log.js`, `server/ids.js`, `server/main.js` | Event-loop yield, JSON logs, id checks, entry point |
| `test/server/gateway.test.js`, `outbound.test.js`, `main.test.js`, `ports.test.js`, `rig.js`, `helpers.js`, `trickle.py` | Tests and helpers |

**Not yours** (other builders now have files in the same folders; check `docs/m2/COMMITMENTS.md` before touching):
`server/auth/`, `server/admin/`, `server/registry/`, `server/blobs/s3.js`, anything `nats`/`pg`, and in test/server:
`registry.test.js`, `pg-*.test.js`, `nats-bus.test.js`, `s3-blobs.test.js`, `store-contract.js`.
`test/server/store.test.js` was mine but its size changed after another session added `store-contract.js`: ask the
manager who owns it now before editing.

## The outbound / catch-up path as it stands

**Where a joiner's catch-up comes from (room-host.js, `SEAM(p2)`):**
- The Room is asked for the `welcome` only (the hello is passed on with `since` = the room's seq). The host adds the
  catch-up itself, in `catchUp(slot, since)`.
- **Snapshot:** one frame, encoded once per `room.base` (`slot.snapFrame`). Not chunked: the Replica ignores a
  second `snapshot` at the same seq, and Bun can't send one message as fragments. Needs a protocol change.
- **Tail:** `tailChunks(slot)` cuts the kept tail into `entries` frames of at most `chunkBytes` (1 MiB; one bigger
  entry travels alone). Full chunks are kept; only the open last chunk is rebuilt when the tail grows. Each entry's
  text is encoded once (`textOf`, a WeakMap) and reused for live broadcast, chunks and the entries subject.
- A reconnecting client that starts inside a chunk gets that chunk cut to what it lacks (its own string, not shared).
- **Names:** every shared frame goes on the bus with `catchup: "<key>"` (`<tenant>/<board>/s<baseSeq>` or
  `…/c<baseSeq>.<from>-<to>`). Unshared frames carry no `catchup`.

**Folds (room-host.js `foldIfDue`):** the kept tail is folded into the snapshot (`Room.compact()`) at
`compactEvery` (1,000) entries **or** `tailFoldBytes` (8 MiB) of text, live and inside the rebuild loop. A fold
makes a new `room.base`, so new snapshot and chunk strings. Rebuild reads pages of at most 100 entries / 4 MiB
(`store.read(…, limit, maxBytes)`, my extension; the page array carries `bytes`).

**Delivery (gateway.js):**
- Every outbound frame goes through the connection's queue `c.out` (`{ data, len, shared }`). `flush(ws)` sends
  until `ws.send` returns -1 (backpressure), then waits for Bun's `drain` handler; the 1 s sweep is the safety net.
- **What counts ("owed"):** bytes in the socket buffer (`c.buffered`, from `getBufferedAmount`) + the connection's
  own queued frames (`c.outBytes`: live traffic, errors). **Queued shared frames count nothing.**
- **Pull-on-drain:** before a shared frame enters a socket, `noRoom(c, len)` checks bytes in sockets only
  (`socketByUser`, `socketTotal`) against `maxUserBufferedBytes` (64 MiB) and `maxTotalBufferedBytes` (256 MiB). A
  frame bigger than a whole budget goes when that budget is otherwise empty.
- **Parking:** if there is no room, the joiner waits (`c.waitSince`, the `waiters` set). `wake()` runs on any
  drain, on any close, and in the sweep. After `maxCatchUpWaitMs` (30 s) it is told `unavailable` (`turnAway`).
- **Making room:** when a joiner can't proceed, `laggard(scope)` picks a reader whose socket holds bytes, that has
  been watched at least `stallGraceMs` (2 s), and whose measured drain pace (`c.winDrained` since `c.winStart`)
  would need more than `slowEtaMs` (60 s) to empty its socket. It is `cut` (terminate). A reader that drained
  nothing is the limiting case. Nobody draining at a fair pace is cut for a newcomer.
- **Stall rule:** a socket holding bytes with no decrease for `stallMs` (15 s) is cut, whatever it sends.
- **Live traffic:** `push` → `admit` checks only the connection's own queue against `maxConnQueuedBytes` (16 MiB).
  Over it: a waiting joiner is turned away, anyone else is cut.
- **Shared text tally:** `sharedText` (key → refs) and `sharedBytes` count each distinct queued shared text once;
  past `maxSharedQueuedBytes` (256 MiB) the longest-waiting joiners are turned away. This bounds text the room has
  already replaced that parked joiners still reference.
- **Sweep total rule:** if `owedTotal` exceeds the process budget, the connection owed most is cut (or turned
  away, if it is a waiter).
- **Caps:** `maxConnsPerUser` 64 (checked before and after `rooms.open`; env `PLENARY_MAX_CONNS_PER_USER`).
  Pre-welcome inbound: 2 MiB per connection, 64 MiB per process, first frame ≤ 16 KB, nesting ≤ 64 scanned on raw text.
- **`cut` vs `turnAway` vs `refuse`:** `cut` = terminate (reader isn't reading). `turnAway` = error `unavailable`
  + close 1013 (the peer can hear it). `end` does all bookkeeping; every exit goes through it.
- `stats()` re-reads the sockets (`owedBytes`) next to the running totals (`owedTracked`); tests assert both are 0
  at the end, plus `sharedBytes`, `sharedTexts`, `waitingJoiners`, `queuedBytes`.

**Yielding:** `breathe()` (server/breather.js) is awaited per inbox message and per rebuild page in the room host
and per frame in the gateway pump; it yields one loop turn after 8 ms without one.

**Units:** socket buffers are bytes; queued frames and chunk sizes are chars (up to 3 bytes each). Not converted.

## Open SEAMs (grep `SEAM(` under server/ for the exact lines)

| Mark | Where | What is deferred |
|---|---|---|
| p2 | room-host.js: Room auth shim, sync `log.append` collected then awaited, `replay`, `catchUp`/`tailChunks`, `foldIfDue`, rebuild paging | `Room.rebuild`, `applyEntry`, `checkpoint()`, `{user, role}` in the hello context, group commit, resolved vs speculative state |
| p2 | gateway.js: `v: 1` optional; ops forwarded before `welcome` (rule 11); no op rate limit (§ Pacing); `transient` refused; presence dropped; > 2 MiB unsent before welcome gets `unavailable` | v1 Replica, presence.js, § Pacing |
| p2 | store/sqlite.js: checkpoints kept per seq (newest 3), no way to remove a bad one | § Recovery decides |
| p2 | breather.js | § Pacing and group commit bound a burst properly |
| p3 | gateway.js: `blob` messages; blobs/disk.js: per-tenant quota | signed URLs, quota |
| p4 | gateway.js: viewers reach the room (rule 8); real backpressure. room-host.js: placement (`open`), fan-out from the entries subject, heartbeat, `.here`, 5 s open-connection list, reply subject per board, catch-up travelling on the bus | leases, gateway-served catch-up from the Store |
| platform | main.js: `POST /boards` and sign-in via `createServer({ http })` | platform track |

## Test files and what each gate proves

| File | Proves |
|---|---|
| `store.test.js` (+ another session's contract file) | § Store on SQLite: conditional atomic append, conflict, read order, checkpoints, reopen, two handles fenced |
| `ports.test.js` | Blobs (cap, hash, tenant isolation, traversal, images only, concurrent puts), Bus (subjects, order, at-most-once), logs (shape, redaction) |
| `gateway.test.js` | `/health`; auth refused before the room (asserted on the room's inbox); bad frames per case; nesting depth; rule 1 with a gated Store; append reject / conflict / timeout / late landing; a Room that throws; lifecycle; catch-up exact for every `since`; **convergence over real sockets with a restart** |
| `outbound.test.js` | Rounds 2–3: the note-rewrite attack with a restart; bounded frames; a board bigger than the budget (snapshot and tail shapes, owner + three tabs, restart); slow reader; non-readers under the budget; non-readers over several accounts; wait timeout with a writer active; writer active during catch-up; trickle readers (needs `python3`, else skips); joiners parked across folds; connection caps; pre-welcome process budget; `/health` during a burst; breather; the rig's resync race; `Store.read` by bytes |
| `main.test.js` | The real entry point as a child process: JSON logs without tokens, dev tokens, duplicate users, two starts on one data dir, **kill -9 three times mid-stream**, the connection-cap env |
| `rig.js` | `rig()` (server on port 0, temp dir, wrappers for auth/registry/store/bus), `sock` (Bun client), `client` (Replica on a socket), `rawSock` (raw TCP WebSocket that can stop reading), `settled`, `roomState` |

## Known flaky or fragile spots

- **Kernel socket buffers.** The non-reader and trickle tests assume a paused socket leaves megabytes unsent
  (about 2.5 MB absorbed on macOS loopback). Boards are sized 24 MB to leave margin. **Never run on Linux.**
- **A paused Node/Bun socket can't trickle** (it pulls eagerly); only `trickle.py` does. `rawSock.trickle` is used
  only for "steady" readers.
- **A paused raw socket can't see a graceful close** (only a reset). Tests check the server's `stats()` instead.
- **Gateway errors and room acks are not ordered** relative to each other (one test was fixed for this in round 2).
- **Timing asserts that remain:** join under 0.5 s and refusal under 1.5 s in the 30,000-deep test; `/health` under
  1 s in the burst test; several "within N seconds" in outbound.test.js. All have wide margins; none failed in my
  loops, but a loaded machine is where round 3's one failure came from.
- **Convergence test:** 50 of 50 after the `settled()` fix, 20 of 20 after each later server change.
- **The malformed-frame lead** (verifier round 3) never reproduced in about 2,300 large-frame deliveries. If a
  socket test ever fails on unparsable JSON, that is the lead: capture raw TCP.

## What I would do next

1. **If round 4 fails on the outbound path again:** the remaining structural weakness is the one-frame snapshot (a
   slow reader's socket holds the whole board) and the pace estimate (from buffer decreases the gateway happens to
   observe, so it reads low). A cleaner design is the spec's own: the gateway serves catch-up by reading the Store
   on demand, which removes parking, the shared-text tally and most of the sweep.
2. **Run everything on Linux** (CI is Ubuntu): oversized-frame close code 1009, `fullfsync` read-back, and every
   test that leans on socket buffers.
3. **Measure process memory** for: a 70 MB join by a slow reader; many joiners parked across folds; the verifier's
   18 trickle readers on 6 accounts.
4. **Re-run the verifier's attacks against `bun server/main.js` from a separate process**; mine ran in-process.
5. **Count bytes, not chars**, if the 3× slack matters for the budgets.
6. **When p2 lands:** replace the `SEAM(p2)` blocks in room-host.js; the table "For the phase-2 room-host swap" in
   my report lists what must survive and which test guards it.

## Asks still open with other owners

- **Spec:** chunked or size-capped snapshot (rule 3); a byte trigger for checkpoints; where the depth bound counts
  from; the per-user connection cap; names for the reply subject and the `catchup` field; `read`'s inclusiveness
  and its `maxBytes` extension.
- **Client track:** `web/sync.js` still sends `transient` ops; the gateway refuses each one.
- **Load test (p8):** clients sharing a dev token share its 64-socket cap (env setting) and its 64 MiB share.
