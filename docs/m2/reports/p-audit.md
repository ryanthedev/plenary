# p-audit: architecture audit of the engine (commit 3a7520d)

Read-only audit. Nothing in the repo was changed except this file. All work ran in a detached worktree of
3a7520d (since removed). Bun 1.4.4, macOS, localhost only. "Verified" means I ran it or read the line;
"suspected" means reasoning from code, not run.

## Headline

- **The log is safe; liveness and fan-out are not ready.** The Store's `expectSeq` CAS keeps the log linear
  even with two room hosts (verified), but nothing else in M2's scale story holds yet.
- **What breaks first at 10k clients (M2):** gateway CPU on live fan-out (one socket send per connection per
  append batch) and presence bytes (no thinning; every viewer gets every writer's cursor at 20 Hz).
- **At 100k (M4):** the same two, by 10×, plus join egress (4.5 MB snapshot × 833 joins/s) and the 60 s
  role re-check (≈10k Registry qps).
- **Hexagonal:** mostly sound in shape (main.js is the only composition root, ports have contracts), but
  the gateway is welded to Bun's WebSocket, there is no Clock/Timer port on the server, and three ports'
  JSDoc typedefs lag what core actually calls.
- **Phase 4** needs a real lease (holder, expiry, DB clock), an epoch fence on append, holder-only inbox
  subscription, a placement adapter behind `rooms.open`, and main.js role wiring.

## 1. Findings

Severity per the brief: HIGH = violates an NFR or the hexagonal rule in a way that bites in M2; MEDIUM =
bites by M4 or makes a port unswappable; LOW otherwise. Not repeated here: p2-tune R1–R6 and p-serve.

| id | sev | file:line | what | proposed fix | job | status |
|---|---|---|---|---|---|---|
| F1 | HIGH | server/gateway.js:422-430 (onLive), push ~250 | One `send` per connection per `entries` message. 5 editors × 20/s + annotator notes ≈ 167 batches/s; × 10k conns ≈ 1.67M sends/s ≈ 6.7 CPU-s/s (at ~4 µs/send measured). 3.3k conns per node still needs ~2.2 cores in a single-threaded process. | Per-connection tick (50–100 ms) that merges pending entries + presence into one frame; encode once per tick per role, not per batch. Consider `server.publish` topics for the shared frame (moves work off the JS thread: 0.06 vs 4.9 µs JS-time/socket, measured). | p-fanout | verified (cost), estimate (rate) |
| F2 | HIGH | server/gateway.js:527-543 (presence tick); PROTOCOL.md § Presence | Spec says gateways under load thin to owner/editor first, annotator/commenter cursors capped at 50 most recent. Not implemented: every connection gets every cursor. 200 cursors = 11.8 KB batch × 20 Hz = 236 KB/s per conn; × 10k = 2.36 GB/s. 2k annotators ≈ 10× that. | Implement thinning; viewers get presenter presence only, at a lower rate (e.g. 10 Hz); cap and decimate annotator cursors. | p-fanout | verified (batch size, tick cost 1.41 µs/conn); estimate (bandwidth) |
| F3 | HIGH | server/gateway.js:725 | Each cursor is published to the bus raw, uncoalesced: 2k annotators × 20/s = 40k bus msgs/s per board, delivered to every gateway. | Coalesce per gateway per tick before publishing (one presence batch per gateway per 50 ms). | p-fanout | verified (code) |
| F4 | HIGH | server/main.js:73 (`announcingRegistry`, addLinkUse) | Every share-link redemption announces on `grants`, which makes every gateway re-check every connection on that board (~6 Registry queries each). During a 100k join wave via a share link this is redemptions × connections × 6. p2-tune R1 coalesces re-checks but the announcement itself is the trigger. | Don't announce on addLinkUse (a new use only adds access to the redeemer); scope announcements to the affected user where possible. | p4-wire | verified (code); load suspected |
| F5 | HIGH | server/room-host.js (append path, no fence); store/sqlite.js, store/postgres.js:97 | Two room hosts on one board: log stays linear (CAS), but a client got welcome ×2, ack ×5, `error:unavailable` ×1, and a host died with "room stopped". Liveness break; and any takeover in phase 4 needs a fence. | Lease + epoch fence on append (see § 3). | p4-store-lease, p4-host | verified (two-host probe) |
| F6 | MEDIUM | server/gateway.js:145, 207, 250-254, 772-779 | Core gateway depends on Bun `ServerWebSocket` quirks: `getBufferedAmount`, `send` returning 0/−1, `terminate`, `drain`, `backpressureLimit`, `idleTimeout`, `sendPings`. Transport is not swappable (e.g. for the self-hosted SignalR option in CLAUDE.md). No server Transport port or contract. | Extract a server Transport port (send → {ok, backpressured, dropped}, buffered(), close/terminate, drain event) + contract test; Bun adapter owns the quirks. | p-ports (after p-fanout) | verified (code) |
| F7 | MEDIUM | server/feed.js:35, 120, 133-134; server/room-host.js:83, 94, 220, 229; server/server.js:21, 31; server/gateway.js:84 | No server Clock/Timer port. feed.js calls `Date.now()` though the gateway injects `now`; room-host uses `setInterval`/`setTimeout` directly; gateway `mintId` uses `Date.now`+`Math.random`. Leases and token expiry need a controllable clock in tests, and lease expiry must use the Store's clock. | Clock + Timer port (now, setTimeout, setInterval) injected from main.js; fake clock in tests; leases use DB time. | p-ports | verified (code) |
| F8 | MEDIUM | server/gateway.js:599; server/auth/tenancy.js (role) | Each hello costs `registry.board` + `role()` ≈ 5–6 Registry queries (board, grant, invitesFor, linkUses + link per use, tenant). 100k joins in 2 min = 833/s ≈ 5.5k qps; the 60 s timed re-check adds 100k × 6 / 60 ≈ 10k qps at M4. | Cache role per (user, board) with invalidation from `grants`; batch the timed re-check per board. | platform (server/auth) | verified (code); estimate (qps) |
| F9 | MEDIUM | server/feed.js (snapshot path); gateway `maxTotalBufferedBytes` 256 MB | Snapshot over the socket: 10k-element board ≈ 4.5 MB checkpoint; 833 joins/s ≈ 3.75 GB/s egress; 256 MB buffer ≈ 56 snapshots in flight per gateway. | Serve the snapshot over HTTP, compressed and CDN-cacheable by (board, seq); socket sends only the tail. | p-fanout (protocol) + platform | verified (sizes); estimate (rate) |
| F10 | MEDIUM | packages/protocol/room.js (checkpoint/fold); server/store/sqlite.js (putCheckpoint) | Fold is synchronous and clones the board: 23 ms at 10k elements, plus ~25 ms synchronous SQLite write of 4.5 MB. Stalls all rooms on that host; grows with board size. | Fold incrementally or in a worker; async putCheckpoint. | p4-host | verified (bench) |
| F11 | MEDIUM | server/bus/port.js:40 | Gateway subject is `plen-gw.<gw>`, not the spec's per-board `.gw.<gateway>`. Fine single-node; in a cluster it can't be scoped per board. | Per-board gateway subject (marked SEAM(p4)). | p4-host | verified (code) |
| F12 | LOW | test/server/store.test.js; test/server/pg-store.test.js | `storeContract` runs only on Postgres (skipped without DATABASE_URL). SQLite has its own tests with no epoch, maxBytes or round-trip coverage. I ran storeContract on sqliteStore in the scratch worktree: 12/12 pass. | Run storeContract on sqlite in CI. | p4-store-lease | verified |
| F13 | LOW | packages/protocol/ports.js | Typedefs lag usage: Store.read's 5th arg `maxBytes` and `.bytes`/`lastSeq` results, Bus `flush` and `maxBytes` are called by core but not declared. Adapters could drop them and still type-check. | Add to typedefs and to the contracts. | p4-store-lease (Store), p4-host (Bus) | verified (code) |
| F14 | LOW | server/room-host.js (foldIfDue, onInbox) | room-host reaches into Room internals (`inflight`, `queue`, `seq/resolved`, `tailChars`, `chars`, `records.chars`, `unresolved`). | Expose a small Room status method. | p4-host | verified (code) |
| F15 | LOW | server/room-host.js:255, 257 | `idle()` uses `bus.flush?.()`, an optional memory-bus-only call. | Make flush part of the Bus port or drop it. | p4-host | verified (code) |
| F16 | LOW | no server Log port | Logging is fused with stdout; no Log contract. Acceptable for M2 (logs to terminal is a decision). | Leave; add a contract when a second adapter appears. | — | verified |
| F17 | LOW | server/blobs/port.js:21 | Uses `Bun.CryptoHasher` in the port module. | Move hashing into adapters or use WebCrypto. | p-ports | verified |
| F18 | LOW | packages/protocol/replica.js:31 | Uses `Math.random()` though a `random` param is injected (used only for backoff at 339). | Use the injected `random`. | p-ports | verified |

Hexagonal checklist (brief item 1):

- **main.js is the only adapter picker:** yes. But it wires only sqliteStore, memoryBus, diskBlobs and
  sqliteRegistry; `cluster` is used only for the key check, so Postgres/NATS/S3 are not wired (phase 4).
- **Contracts per port:** Store (pg only, F12), Bus (memory, nats), Blobs (disk, s3), Registry (memory,
  sqlite, pg), Auth (verifier, idp). Missing on the server: Clock, Log, Transport (F6, F7, F16).
- **Missing ports:** Clock/Timer and randomness (F7, F18); Transport (F6).

## 2. CHECKER (systems-design skill) against the NFRs

| Check | Verdict | Evidence |
|---|---|---|
| One sequencer per board, epoch fencing | **Partial.** One sequencer by convention; epoch exists (`openEpoch`) but append is not fenced and there is no lease holder/expiry. | F5; leases tables hold only `epoch` (postgres.js:45 says "phase 4 adds the holder and expiry"). |
| Acknowledged op never lost | **Holds single-node.** Ack only after durable append (`landed()`); SQLite `synchronous=FULL` + fullfsync; CAS on `expectSeq`. | Append p50 0.36 ms / p95 1.7 ms with fullfsync (bench). |
| Presence may drop | Holds; never persisted. | presence.js |
| 100k viewers / 2k annotators per board | **Fails today** on fan-out and presence bytes. | F1–F3 |
| 100k joins in 2 min | **At risk**: warm join costs 0 Store reads (feed shared per board per gateway, good) but ~6 Registry queries and a 4.5 MB snapshot each. | F8, F9 |
| Editors < 150 ms home region | Holds at 4k viewers on localhost (p99 103 ms, max 182 ms); not measured under presence load. | Table below |
| Viewers < 1 s worldwide | Not measured (localhost only). Bus partition degrades to ~5 s Store polling. | Failure modes |

### Load numbers and methods

| Number | Value | Method |
|---|---|---|
| Room op cost | 12.65 µs/op | Room + in-memory log, 20k one-rect ops; entry ≈ 562 B |
| SQLite append, 1 entry | p50 0.36 ms, p95 1.7 ms (0.06 ms without fullfsync) | bun:sqlite, WAL, synchronous=FULL |
| SQLite append, 50 entries | 1.31 ms | same |
| SQLite read, 1000-entry page | 1.19 ms | same |
| Checkpoint fold, 10k elements | 23 ms sync; stringify 3 ms; 4.5 MB | room.checkpoint() |
| putCheckpoint 4.5 MB | ~25 ms sync | sqliteStore |
| Rebuild | 12 ms from checkpoint; 77 ms from 20k entries (3.9 µs/entry) | Room.rebuild |
| Socket send cost | ~4 µs process CPU per 1 KB send (≈250k sends/s/core) | Bun.serve, 4000 sockets, per-socket send vs server.publish (same total CPU; publish moves it off the JS thread) |
| Presence tick | 1.41 µs/conn without send; batch 11.8 KB for 200 cursors | 10k fake conns |
| Byte counting | Buffer.byteLength 0.06 µs (1 KB), 0.35 µs (14 KB); utf8Length 17 µs (14 KB) | microbench |
| End-to-end op latency, 1000 viewers | p50 5.7, p95 11.8, p99 20.2, max 24.2 ms; 100% delivered | real `start()` via main.js; 1 editor at 20 ops/s, 100 ops; viewers in a separate process |
| End-to-end op latency, 4000 viewers | p50 14.3, p95 39.7, p99 102.7, max 182.4 ms; 100% delivered | same |
| Latency under 200-cursor presence load | **Not measured** (run lost to a restart; re-run not permitted) | — |

### Failure modes

| Failure | Behaviour today | Gap |
|---|---|---|
| Store slow/down | Append has a 4 s timeout, then the room fails; waiting clients get `unavailable`. Warm-board viewers keep their view; new/cold boards fail to open. | Acceptable for M2; no ack is lost because acks follow the append. |
| Bus partition | Gateways poll the Store after 5 s without an `.entries` heartbeat (heartbeat every 2 s), so viewers see ~5 s lag; writers' hello times out at 10 s. | Presence lost during the partition (allowed). |
| Gateway crash | Room drops that gateway's connections after 30 s of silence; clients reconnect and catch up with `since`. | Fine. |
| Room host crash | No takeover until phase 4; the board is down until restart. | § 3. |
| Clock skew | Emote windows, token expiry and (soon) leases use local `Date.now`. | Leases must use the Store's clock (F7). |
| Slow consumers | Well budgeted: buffered-bytes limits, laggard drop, shared catch-up chunks. `slowest()` (gateway.js:268) and `laggard()` (280) are O(n) scans and can run in a loop. | LOW; revisit in p-fanout. |

## 3. Phase-4 readiness

What leases and takeover need:

1. **Lease in the Store:** `(board, holder, epoch, expiresAt)`; acquire/renew/release using the DB clock;
   contract tests for both adapters.
2. **Epoch fence on append:** `append(board, expectSeq, entries, epoch)` rejects a stale epoch.
3. **Holder-only inbox:** only the lease holder subscribes; on lease loss call `fail()` and unsubscribe.
   (The two-host probe shows why: both hosts answering the same connection.)
4. **Placement:** the gateway's injected `rooms.open` (gateway.js:617; SEAM(p4) at room-host.js:239)
   becomes a placement adapter (bus open request or lease lookup).
5. **Per-board gateway subject** (F11).
6. **main.js roles:** `gateway`, `host` or both; wire Postgres/NATS/S3 when `cluster`.
7. **Async fold** (F10), so a takeover's rebuild and a big checkpoint don't stall other rooms.

### Proposed fix jobs (file ownership does not collide)

| Job | Owns | Findings |
|---|---|---|
| p-fanout | server/gateway.js, server/feed.js, packages/protocol/presence.js, PROTOCOL.md § Presence / § Pacing | F1, F2, F3, F9 (protocol side) |
| p4-store-lease | server/store/*, new server/store/port.js, packages/protocol/ports.js (Store), store contract + running it on sqlite | F5 (lease, fence), F12, F13 (Store) |
| p4-host | server/room-host.js, server/bus/port.js, server/bus/* , packages/protocol/room.js (fold) | F5 (holder-only inbox), F10, F11, F13 (Bus), F14, F15 |
| p4-wire | server/main.js, server/server.js (deploy/ stays platform's) | F4, phase-4 item 6 |
| platform | server/auth/tenancy.js; snapshot-over-HTTP serving | F8, F9 (serving side) |
| p-ports (after p-fanout) | Clock/Timer port, server Transport port extracted from gateway.js, blobs/port.js, replica.js | F6, F7, F17, F18 |

Order: p4-store-lease first (fence + lease contract), then p4-host and p4-wire; p-fanout can run in parallel
now. p-ports waits for p-fanout because both touch gateway.js.

## Not verified

- No NATS or Postgres runs (no DATABASE_URL / NATS_URL); cluster numbers are from code and single-node benches.
- Latency under presence load was not measured.
- Localhost only: no network, no multi-region.
- Full `bun test` not run (nothing changed); only the scratch sqlite storeContract probe (12/12 pass).
- Rates (batches/s, joins/s, qps) are estimates from the NFRs times measured per-unit costs.
