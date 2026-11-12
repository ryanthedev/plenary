# Brief: p4-host (the room host holds a Store lease; every write is fenced)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Architecture", the sdd helpers), CLAUDE.md (NFRs: one
sequencer per board, an acknowledged op is never lost), PROTOCOL.md v1.1 (§ Recovery, Room identity / epoch, § Bus),
docs/m2/reports/p-audit.md (F5, F13, F14, F15), packages/protocol/ports.js (the Store lease typedef), and
docs/m2/reports/p4-store-leasev.md (L2, L5, R2-L1, R2-L2, "What p4-host and the builder should do").

- **Your tab:** `worker p4-host (engine) · <your id>: room host on the Store lease`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the shared tree /Users/r/repos/plenary (main), starting from the commit that lands p2-tune. Don't commit.
- **Your files:** server/room-host.js, server/server.js (option pass-through only), server/store/sqlite.js,
  server/store/postgres.js, server/bus/port.js and server/bus/* (F15 only), packages/protocol/ports.js (typedefs,
  MemoryLog), packages/protocol/room.js (F14's status method only), test/server/store-contract.js, store.test.js,
  pg-store.test.js, a new test/server/room-host-lease.test.js, and in test/server/gateway.test.js, revocation.test.js
  and rig.js **only** the lines that wrap or fake `openEpoch` (point them at `acquire`).
- **Not yours:** server/gateway.js, server/feed.js, server/main.js (p4-wire), PROTOCOL.md (write your spec text as a
  proposal in the report), web/**, server/auth|admin|registry/**.
- **Report:** docs/m2/reports/p4-host.md: what changed, each decision below and how it is tested, the mutation each
  test catches, risks, "Not verified", the PROTOCOL.md proposal. Then one short `hc send` to t18m and stop, idle.

## Goal (decisions are mine; follow them)

1. **One path, both modes.** The room host never calls `openEpoch` again. Single node and cluster both use
   `acquire` / `renew` / `release`. `openEpoch` may stay in the Store for old data; say in the report if anything
   still calls it.
2. **Holder id:** unique per room-host instance (per process start): `<hostname>:<pid>:<random>`, overridable by an
   option `holder` (tests). Two `roomHost()` instances in one process have different ids.
3. **ttl:** option `leaseTtlMs`, default 10 s; renew every ttl/3 on a real timer (`setInterval`, unref'd).
4. **Open, lease free (or expired, or released):** `acquire` → epoch. Start renewing **at once, before the rebuild**
   (a long `readFrom` may outlast the ttl). Then build as today with `epoch` = the lease epoch, subscribe the inbox.
5. **Open, lease held live by another holder** (`acquire` null; read `lease()`): `open()` resolves without a local
   room and without subscribing to the inbox (the holder's host serves it over the bus: F5's holder-only inbox).
   Arm one takeover attempt per board for just after the lease's `expiresAt` (judged by asking the Store again, never
   by comparing `expiresAt` with this host's clock). If that `acquire` wins, build the room as in 4.
6. **The dead-holder window must not hang a writer.** After kill -9 on a single node, the new process sees the old
   holder's live lease for up to a ttl. A writer hello in that window reaches an inbox nobody serves. Find what the
   gateway does with a hello that gets no answer (server/gateway.js, read only). If it waits forever, the room host
   must answer it instead. While this host is waiting to take over a board, it answers
   inbox hellos with `unavailable` (close 1013) **only if** no `.entries` heartbeat for that board arrived in the last
   2 heartbeats (the holder is silent). A live remote holder's board is never answered by this host. Test: kill
   the holder (stop it without `release`), a writer hello in the window gets a welcome or `unavailable` within
   ttl + 3 s, and a reconnect after takeover is welcomed with every acked op present.
7. **Losing the lease stops the room.** `renew` null, a `fenced` refusal from `append` or `putCheckpoint`, or no
   successful renew within the host deadline → `fail(slot)` (its connections get `unavailable`), **no `release`**.
   The host deadline is the **send time** of the last successful renew + ttl − one renew interval, measured with
   `performance.now()` (not the injected `now`, which is the rooms' clock and is faked in tests). A renew error
   (timeout, PG down) is retried at the next tick until the deadline.
8. **Every write is fenced (L5, required).** `append` and `putCheckpoint` always pass `slot.epoch`. Remove the
   no-epoch SEAM branch from both adapters' fence: no epoch → refused (`PortError` code `bad-request` or similar,
   your pick, documented). Update the Store typedef (epoch required) and the store contract.
   `MemoryLog` (packages/protocol, used by Room tests without a lease) keeps its current shape; say so in the report.
9. **Clean stop:** `close()` checkpoints as today, settles `slot.writes`, **then** `release`s each lease, so a
   restart on one node takes the board at once.
10. **R2-L2:** a write cut off by `idle_in_transaction_session_timeout` surfaces as a `PortError` (code
    `unavailable`), not a raw Postgres error. **R2-L1:** a test for the `ttl/2` cap on the lease lock wait.
11. **F14:** give Room one small read-only status method (`inflight`, `queued`, `unresolvedCount`, `tailChars`,
    `stateChars`, `resolved`, `seq`, `baseSeq`, `held`) and make room-host use only it (no reaching into internals).
    No behaviour change in room.js.
12. **F15:** `flush()` becomes part of the Bus port (memory: as today; NATS: its flush; any other adapter: resolves),
    and room-host calls it without `?.`. **F13 (Bus):** add `flush` and `maxBytes` to the Bus typedef.

**Deferred, not yours:** F11 (per-board gateway subject: changes `subjects.gateway`, which gateway.js uses; goes to
p-fanout). F10 (incremental fold: its own job). Main.js wiring of `leaseTtlMs`/`holder`: p4-wire.

## Done when

- **Two-host probe (the audit's F5 repro):** two room hosts on one Store and one bus, writers on both gateways:
  one welcome per hello, no duplicate acks, no "room stopped" death, one sequencer.
- **Takeover, both adapters:** holder A stops renewing (not released); host B takes over after expiry; A's late
  append (held past the 4 s timeout, landing after B's acquire) is `fenced`; every op A acked is in the log; B's
  epoch > A's.
- **Clean restart:** close → release → a new host opens the board with no wait.
- **Mutation checks, each caught by a test:** drop the epoch on append; on putCheckpoint; ignore a null renew; subscribe
  the inbox without the lease; release on `fail`; renew deadline judged by the injected `now`.
- `bun test` green in the shared tree (except test/core-source, the known herdr-draw drift); `bun test test/server`
  10x with 0 failures; once with DATABASE_URL and NATS_URL (brew postgresql@17 + nats-server, free ports, PIDs
  recorded, stopped after). test/architecture.test.js green (room-host imports ports only).

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end. Read big files
in ranges (≤ 200 lines) and filter test output; write the report as you finish each goal.
