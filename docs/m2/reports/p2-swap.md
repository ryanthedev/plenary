# Report: p2-swap (server onto the v1.1 protocol)

**Status: done, uncommitted (manager merges).** Worker p2-swap (engine), manager t18m. Worktree /Users/r/repos/plenary-p2, branch p2-land.

**Done-when (2026-11-12):** `bun test test/*.test.js test/server test/auth` in the worktree: **429 pass, 80 skip, 0 fail** (509 tests,
33 files, 90 s). With a temporary Postgres 17 and NATS (max_payload 2 MB) set: **488 pass, 19 skip, 0 fail**; the 19 skips are
by their skip conditions google-live (needs real credentials) and s3-blobs (no S3_ENDPOINT); not counted per file.
No `SEAM(p2)` left in server/.

**One caveat on those numbers:** they were taken with a one-line `Boolean()` fix in test/auth/google-live.test.js, since
reverted (test/auth is platform's, and main already fixed the same line in d8fc084, which p2-land predates). So the
worktree now shows **2 failures in google-live.test.js** ("an unreachable Google never prints the client id": `leaks()`
returns `undefined` without a `.env`). They go away on merge with main; nothing for engine to do.

## Design (distributed-systems-design skill v0.1.0, APPLIER mode)

### 1. Scope (from CLAUDE.md's confirmed NFRs; nothing asked of the CEO)

- Per board: a handful of editors, ~2k annotators, 100k live viewers. Editors < 150 ms in region, viewers < 1 s.
- 100k joins in 2 min. An acknowledged op is never lost. Presence may drop. Eventually consistent delivery.
- M2 gate: ~10k clients, single node (SQLite, memory bus) and cluster (Postgres, NATS) adapters behind the same ports.
- This job: the room host and gateway on the v1.1 Room/Replica, the Store epoch, presence relay, per-connection
  pacing and caps, revocation hook, main.js wiring (HTTP routes, OIDC, env isolation).

### 2. Estimate

| Flow | Peak per board | Consequence |
|---|---|---|
| Durable ops in | 2k writers × ~0.2 op/s ≈ 400/s (cap 20/s per connection) | one sequencer with group commit: one fsync per batch, not per op |
| Entries out | 400/s × 100k viewers = 40M deliveries/s | encode each batch once; gateways fan out from `.entries`, never the room |
| Presence in | 2k × 20 cursor/s = 40k/s | coalesce per 50 ms per gateway; never touches room or Store |
| Joins | 100k / 120 s ≈ 830/s | catch-up served by gateways from a per-board cache (snapshot + tail, encoded once, shared) |
| Bus messages | ≤ 2 MB each | `.entries` batches split by encoded size; catch-up never on the bus |

### 3. High-level design (hexagonal: core depends on ports; main.js picks adapters)

```
client ──ws──> gateway ──.inbox (n-numbered)──> room host (Room v1.1) ──append──> Store
   ^              │  ^                                 │
   │              │  └──.gw.<gateway>: welcome/ack/err─┘
   │              ├──.presence / .emotes (gateways only)
   └── catch-up + live <── feed (per board, per gateway) <── .entries {items} / heartbeat {seq, epoch}
                                 └── Store reads (catch-up, gap repair, 5 s silence poll)
```

- **Room host** (server/room-host.js): per board, `store.openEpoch` → latest checkpoint (stepping back past a bad
  one) + log after it → `Room.rebuild`. Log adapter `{ append(entries, expectSeq), putCheckpoint(cp) }` over the
  Store; after an append resolves, entries are published on `.entries` (split under the bus cap) before the Room
  acks. Only `welcome`/`ack`/`error` go to `.gw.<gateway>`; the Room's own catch-up and broadcasts are not sent.
  Append timeout (4 s, host timer) and `room.sweep()` on a timer; a failed room is rebuilt (new epoch).
  Heartbeat `{ seq, epoch }` every 2 s. Gateway connection lists feed `room.listed()`.
- **Feed** (server/feed.js, new, core): one per board per gateway. Subscribes `.entries` before any hello is
  forwarded; keeps the board's base snapshot (from the latest valid checkpoint) and the entries after it as
  encode-once shared frames; repairs gaps and silence from the Store. Serves every connection's catch-up and live
  entries (writers and viewers alike).
- **Gateway** (server/gateway.js): auth before the room (unchanged), `v: 1` required, `n` per connection, close
  notices and 5 s connection lists, ops before `welcome` → `auth`, op bucket per connection (20/s, burst 100, queue,
  500 ops / 8 MB cap → `unavailable`), ≤ 8 writer connections per (user, board), `too-large` with the op id when
  an inbox message exceeds the bus cap, presence relay (presenceProblem, limiter, coalescer, 50 ms), viewer emote
  counts, `grants` re-check, token expiry.
- **Store epoch**: `openEpoch`/`epoch` in a `leases` table (SQLite and Postgres), in the store contract test.

### 4. Wrap-up (bottlenecks, failures)

| Concern | Where it is handled | Left open |
|---|---|---|
| One sequencer per board | room host + Room group commit; one fsync per batch | per-board ceiling not measured (M4 load test) |
| Fan-out | `.entries` encoded once per batch, split under 2 MB; each gateway's feed fans out | 100k viewers per board not measured |
| Joins | per gateway per board feed: base snapshot + tail, encode-once shared frames; the room never serves catch-up | a board past § Limits joins slowly (spec says so) |
| Lost bus message | feed repairs gaps from the Store, on the 2 s heartbeat, and on a 5 s silence poll | — |
| Host crash | rebuild from checkpoint + log, new epoch; an op from an unknown connection gets `unavailable`, client reconnects | lease/takeover across nodes is phase 4 (cluster not wired in main.js) |
| Bad checkpoint | skipped (entry S check), never deleted; rebuild and feed step back with `beforeSeq` | — |
| Writer abuse | 20 ops/s bucket per connection, 500-op / 8 MB queue, ≤ 8 writers per (user, board), live frame queue cap | — |
| Dead sockets | Bun `idleTimeout` 30 s + `sendPings` | Bun's ping cadence stands in for "ping after 10 s idle" (not measured) |

## Files

- **New:** `server/bus/port.js` (subjects incl. `grants`, MAX_BUS_BYTES, busBytes, utf8Length), `server/feed.js` (the
  per-board feed), `test/server/v1.test.js` (12 tests), `test/server/architecture.test.js` (engine core imports no adapter).
- **Rewritten:** `server/room-host.js` (on Room.rebuild/receive/fail/sweep/listed/heartbeat), `server/gateway.js`
  (v1: feed, pacing, caps, presence, grants, expiry; plus a read-only `feed(tenant, board)` peek for tests).
- **Changed:** `server/main.js` (HTTP routes, Google OIDC when both GOOGLE_* set, COOKIE_KEY/SESSION_KEY, `grants`
  announcements; the only `process.env` reader), stores (`leases` / `pl_leases` epoch; Postgres `migrate()` creates
  only missing tables), memory/nats bus (cap from port.js), `server.js`, `server/breather.js` (comment only).
- **Tests adapted to v1:** rig, gateway, outbound, main, store-contract, pg-store.
- **Architecture test location:** platform's test/auth/architecture.test.js says engine owns a repo-wide
  `test/architecture.test.js`; that file doesn't exist. Mine is test/server/architecture.test.js with a hand-kept
  list of core files (a new core file must be added to it). Manager: move or widen it if you want the repo-wide one.

## Fixed this session (beyond the first handoff)

- **Feed rebase race (real bug, server/feed.js).** The host writes its byte-triggered checkpoint just *after* it
  publishes the entries that triggered it, so the feed's look on those entries missed it and then waited for another
  `rebaseBytes` of tail. Joiners got an older snapshot plus a longer tail (correct, bounded, but bigger). Now a miss
  is retried once on the next heartbeat or Store poll (not on entries: a burst can still be ahead of the checkpoint).
  Test: v1.test.js "a board feed picks up the host's checkpoint…"; fails with the retry removed (checked).
- **google-live "unreachable Google" (2 tests):** not the network sandbox as earlier noted: `leaks()` returns
  `undefined`, not `false`, when no `.env` sets GOOGLE_* (true in a worktree). Already fixed on main (d8fc084); the
  worktree copy is left untouched.

## Tests adapted, and why (each is v1 behavior, not a relaxed guarantee)

- **main.test.js:** settings ops carry `appBase` (v1.1). After a clean restart a joiner gets a `snapshot` (the stop
  checkpoint), so the log is now checked straight from the SQLite file. The kill -9 test paces like a client (≤ 200
  unacked, under the gateway's 500-op queue at 20/s) and resends unacked ops plus a 30-op sample of acked ones from
  inside the op-id window (W = 256 per client, § Op ids); each sampled resend must ack at its first seq, and `ann:1`
  (below the window) must get `stale`. Before: it fired 2,500 ops/s and resent everything, which v1 refuses by design.
- **outbound.test.js:** the host's byte fold now also needs tail ≥ half the board (the 2× bound), so tests that meant
  "the board in one snapshot" call `foldAll(r)` (a checkpoint through the Room) after writing (this includes three
  24 MB-board tests that were passing on a partial snapshot plus tail; their comments say "in one snapshot"); H1 fold expectations
  are 8 not 9; after a clean restart both H1 shapes join from a snapshot; viewers are not in `room.conns`. The
  "parked across folds" test checkpoints through the Room and waits for the feed's base (2× bound makes 300 KB of
  growth on 6 MB never fold by itself). Idle timeout was ruled out as a cause (same failures at 120 s).
- **New coverage:** Postgres least privilege (owner migrates; a role with only USAGE + DML starts, writes, and is refused
  on an un-migrated schema; fails if `migrate()` uses `CREATE TABLE IF NOT EXISTS`, checked); live frame queue cap →
  `unavailable` (fails with the cap raised to 8 MB, checked); an idle viewer that pongs survives `idleTimeoutSec` while a non-ponging socket is closed.

## Not verified

- Load: nothing measured at 10k clients (M2 gate is a separate job). Bun's ping cadence vs the spec's 10 s.
- Postgres and NATS ran against local temporary servers (PG 17.11, nats-server from Homebrew), not CI's.
- `here` (spec item) not built. Cluster adapters are not wired in main.js; cluster mode only gates COOKIE_KEY.

## Risks

- The feed can still lag the host's checkpoint by up to one heartbeat (2 s) after a fold; joiners in that window
  get the previous snapshot plus a longer tail (correct, just bigger).
- Byte-triggered checkpoint (`tailFoldBytes`, 8 MB default, with the 2× bound) extends § Recovery "When": a spec ask.
- Queue overflow answers `unavailable` (PROTOCOL.md § Pacing), where the brief said "close with `limit`".
- Viewers never reach the room (rule 8): a viewer-only board gets its epoch from the Store / heartbeat.

## What platform must do

- **deploy/cluster.compose.yml** sets DATABASE_URL and NATS_URL but no COOKIE_KEY: those nodes now refuse to start.
  Add the key (blocks that stack after the merge).
- `session.js` `verify()` should return `exp` (seconds) so the gateway closes a connection at expiry (tested with a fake).
- Registry mutations announce `grants` via main.js's wrapper today; platform may prefer to publish from the registry.
- Registry Postgres least privilege (server/registry/) is platform's; the Store's is done and tested.

## History

- Cherry-picked ffd2a11 as the manager asked; it also touched docs/m2/reports/p3-scaffold.md (not only the test).
