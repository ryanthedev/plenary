# Brief: p4-wire (main.js reads the cluster env; PG + NATS wiring; roles; auth logger; R2-L1)

You are the p4-wire builder. Base: main at 15210d3 plus the shared tree's uncommitted work (other managers' files;
don't touch them). Don't commit; the manager commits by path.

- **Your tab:** `worker p4-wire (engine) · <your id>: cluster wiring`. Manager: `manager engine`, terminal `t18m`.
  Report to t18m only; never message the proxy (t1bx).
- **Report:** docs/m2/reports/p4-wire.md (per item: what changed, the test, the mutation it catches). Then one short
  `hc send` to t18m and stop, idle.

## Ownership (edit only these)

server/main.js, server/server.js, server/room-host.js, server/bus/port.js (two new subjects: `open`, `opened`), a new
server/remote-rooms.js if you want it, PROTOCOL.md (§ Bus: the two new subjects only), test/server/main.test.js, new
test/server/main-cluster.test.js and test/server/roles.test.js, test/server/room-host-lease.test.js (R2-L1 test only).
**Not deploy/**: platform (t187) owns it. List in your report every env name and behaviour deploy/ must change; I relay it.

## The env contract (don't rename anything: deploy/cluster.compose.yml:159-175 and scripts/cluster-rig.js:270-271 already
set these exact names and values, e.g. app-1/app-2 `PLENARY_ROLES: gateway`, app-3 `host`, ids `app-1`..)

| Name | Rule |
|---|---|
| `DATABASE_URL` | Postgres store (server/store/postgres.js) **and** registry (server/registry/postgres.js). |
| `NATS_URL` | NATS bus (server/bus/nats.js, `name` = the node id). |
| Cluster mode | Either URL set. **Both are required** in cluster mode: one without the other refuses the start with a message naming the missing one (a Postgres store with an in-memory bus would split-brain across nodes). COOKIE_KEY stays required (already in main.js). |
| `PLENARY_NODE_ID` | `[a-z0-9-]`, 1-32 chars, else refuse the start. Default `os.hostname()` lowercased, other chars turned into `-`, truncated to 32 (so a long hostname never refuses its own default). Pass it to room-host as `hostname`, so holders read `<node>-<pid>-<rand>`. Log it at start. |
| `PLENARY_ROLES` | Comma list of `gateway`, `host` (spaces trimmed, case-insensitive). Default both. Empty, unknown or duplicate token refuses the start. Single-node mode (no URLs) refuses anything but both. |
| `PLENARY_LEASE_TTL_MS` | Integer within room-host's range (it throws RangeError; turn that into a start refusal naming the var). Default 10000. Every node must use the same value: say so in the header. |
| Blobs | Local disk in both modes (PLENARY_DATA_DIR). Nothing in server/ reads or writes blobs today (only createServer passes it through), so per-node disk is no gap yet; S3 blobs are a later job. Write that in the header. |

Never log a value of DATABASE_URL or NATS_URL (they carry passwords); names only. A refused start throws from `start(env)`
before anything listens; on the CLI the error message is printed and the exit code is non-zero.

## Roles

- **gateway+host** (default): as today.
- **host only:** a room host and the bus; `/health` answers; `/ws` and the HTTP routes (auth, POST /boards, static)
  answer 404. No gateway is created.
- **gateway only:** no room host, so it never acquires a lease. The gateway's `rooms.open(tenant, board)` (gateway.js:912)
  becomes a remote open, a decision I make here:
  - New bus subject `subjects.open` = `plen-hosts.open`: `{ tenant, board, gateway, n }`. Every host subscribes and
    calls its local `open(tenant, board)` (idempotent: held, building or watching returns at once; otherwise it acquires
    or starts watching). Each host then replies `{ n, board, state: "held" | "watching" }` on a reply subject the
    requester owns, `subjects.opened(requester)` = `plen-hosts.opened.<requester>` (the requester id = node id plus a
    random suffix, minted by the remote-rooms object; it subscribes itself). Don't touch gateway.js or its
    `plen-gw.<id>` subject: the remote `rooms` object only has to satisfy gateway.js:130's `open(tenant, board)`.
  - A host whose local open throws sends no reply (and logs). Never cache success: every writer hello asks again (the
    in-flight dedup below is the only sharing), because a replaced host has no slot until someone asks.
  - The gateway-only `open` resolves on the first reply that names the board, and rejects after `leaseTtlMs` with no
    reply (then the gateway's existing `down("room")` path answers the hello). Bounded: at most one request in flight per
    board per gateway; others wait on it.
  - Add the subject to PROTOCOL.md § Bus in one or two sentences, plus a line that a gateway-only node needs at least
    one host node in the cluster.
- Put the role choice in server.js (`roles: { gateway: bool, host: bool }`), not in main.js branches all over.

## Also

1. **Auth logger:** pass `log: log.child({ component: "auth" })` to httpRoutes (check http.js's `deps.log` shape:
   `warn(msg, fields)`); today it gets none and prints its own stdout line ignoring LOG_LEVEL.
2. **R2-L1** (docs/m2/reports/p4-hostv.md:750): `slot.welcomed` only grows. Keep the flag on the connection entry
   (or delete from the set wherever a connection leaves `slot.conns`: `m.closed`, after `room.listed`, the sweep).
   Test: the verifier's repro (2,000 hellos, 1,000 close notices, a listing that drops 500 more) leaves the welcomed
   count equal to `conns` (500); `fail()` after a lost lease still sends 1013 only to welcomed live connections.
3. **main.test.js:** the kill -9 test reads its ttl from one constant and passes it as `PLENARY_LEASE_TTL_MS` to the
   child (use 3000), so the test is shorter and the env var is exercised for real.
4. **Header comment** of main.js: document every new name in the existing style, and drop "Single-node entry point"
   for "Entry point (single node or one cluster node)".

## Done when

- Unit tests (no Postgres/NATS) for every start refusal above: each message names the variable and never contains a
  URL's value (test with a URL that carries a fake password and assert the password is absent from the error and from
  every captured log line).
- test/server/roles.test.js, in-process with the memory bus shared by three createServer instances (gateway, gateway,
  host): a writer on gateway 1 and one on gateway 2 of the same board converge; the host-only node answers 404 on
  /ws; a gateway-only node with no host answers the hello `unavailable` within ttl + 1 s. Also gateway-only plus **two**
  hosts (the broadcast makes both open every board, the F5 path): a writer gets exactly one welcome and exactly one ack
  per op; after the holding host stops, the next writer hello is welcomed by the other.
- test/server/main-cluster.test.js (skips without DATABASE_URL and NATS_URL): three child processes of
  `bun server/main.js` (roles gateway / gateway / host, a fresh PG schema or database, free ports, **one
  PLENARY_DATA_DIR per child** so no shared local state hides a gap) serve one board
  end to end; kill -9 the host child and start a second host: acked ops survive, writers are welcomed again within
  ttl + 3 s.
- Mutations (scratch copy): skip the both-URLs check; ignore PLENARY_ROLES; gateway-only falls back to a local room
  host; R2-L1 fix undone; the auth logger not passed. Each is caught by a test; list them in the report.
- `bun test` green in the shared tree (except test/core-source, the known herdr-draw drift, and the known flakes
  "here: bounded with many viewers", pacing maxLiveQueuedBytes, tune.test 1 in 100: name any you see);
  `bun test test/server` 10x with 0 failures; once with DATABASE_URL and NATS_URL (brew postgresql@17 + nats-server,
  free ports, PIDs recorded, stopped after). test/architecture.test.js green.

Process: never pkill/killall; port 0; record PIDs and kill only those; never read, print or log `.env` or a real
secret (tests use fakes); delete scratch data at the end. Read big files in ranges (≤ 200 lines) and filter test output.
