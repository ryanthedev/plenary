# Report: p2-swap (server onto the v1.1 protocol)

**Status: in progress.** Worker p2-swap (engine), manager t18m. Worktree /Users/r/repos/plenary-p2, branch p2-land.

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

(filled in at the end)

## State / next (for a successor)

- Baseline before any change: test/auth has 2 failures not caused by this job ("an unreachable Google never prints
  the client id", google-live.test.js; the shared tree has an uncommitted change to that file). test/server had ~33
  failures: the scaffold still drove the v0 Replica.
- Cherry-picked ffd2a11 as the manager asked; it also touched docs/m2/reports/p3-scaffold.md (not only the test).
