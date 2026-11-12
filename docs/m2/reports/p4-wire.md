# Report: p4-wire (main.js reads the cluster env; PG + NATS wiring; roles; auth logger; R2-L1)

Builder: p4-wire (engine). Base: main at 15210d3 plus the shared tree. Nothing committed.

**Status:** every "Done when" item is met. Each mutation is caught: the 5 the brief asked for, plus 3 of mine.
Caveats:
- **Load-test failure:** the full PG + NATS `bun test` run had one failure outside the gate and outside the brief's
  known list: test/load "live, 2 workers…" (another session's). It passed every rerun. Details under Gates.
- **Scratch data:** it could not be deleted, because `rm` is denied in this session. Details under Cleanup.

## Files touched (only the brief's list)

| File | What changed |
|---|---|
| server/main.js | `nodeConfig(env)`: the cluster env, every refusal. `redact()`. `openCluster()`: PG store, PG registry, NATS bus. Roles go to createServer, the auth logger to httpRoutes. CLI: a refused start logs `start refused` and exits 1. New header. |
| server/server.js | `roles: { gateway, host }` (default both) and `node`. Host-only: no gateway, only /health. Gateway-only: `remoteRooms`. `/health` gains `roles`; `gateway` is null on a host-only node. |
| server/room-host.js | `checkLeaseTtl()` exported (one validator). `open()` resolves `"held"` or `"watching"`. R2-L1 fix. `peek()` gains `welcomed`. New `serveOpens()` and `remoteRooms()` (see "Decisions"). |
| server/bus/port.js | `subjects.open` = `"plen-hosts.open"`, `subjects.opened(requester)` = `plen-hosts.opened.<requester>`. |
| PROTOCOL.md | § Bus: one bullet for remote open, which says a cluster with a gateway-only node needs a host node. |
| test/server/main.test.js | The kill -9 test reads `LEASE_TTL_MS = 3000` and passes it as `PLENARY_LEASE_TTL_MS`; it asserts the child logged that ttl. Timeout cut from 150 s to 90 s. Eight new p4-wire tests. |
| test/server/roles.test.js | New: in-process, one memory bus, 3 to 4 nodes. |
| test/server/main-cluster.test.js | New: three `bun server/main.js` children on PG + NATS. |
| test/server/room-host-lease.test.js | One new test (R2-L1). |

The remote open lives in room-host.js, not in a new server/remote-rooms.js. Why: test/architecture.test.js classes a
new top-level server/*.js as neither core nor adapter, and that file isn't mine. room-host.js is already core and
imports only the Bus port.

## Per item: change, test, mutation it catches

| Item | Change | Test | Mutation caught (scratch copy) |
|---|---|---|---|
| Both URLs required | `nodeConfig`: either URL set means cluster mode, and one without the other throws `"<missing> is required in cluster mode …"`. The check runs before COOKIE_KEY's and before anything is created. | main.test "one cluster URL without the other…" (both directions, plus a missing COOKIE_KEY); the CLI test | **both-urls** (checks skipped): 2 fail |
| No URL value anywhere | Refusals name variables only. Adapter failures are rethrown as `could not open the <adapter> (<VAR>) [code]: <redacted message>`. `redact()` strips the whole URL, `user:pass`, the password (raw and decoded) and any `scheme://userinfo@`. No `cause` is attached. NATS `onError` lines are redacted too. | main.test: every refusal runs with `hunter2-FAKE-pw` in the URLs, and the test asserts the password is absent from `message`, `String(err)`, `stack` and every captured log line. The "unreachable URLs" test exercises the real Postgres adapter error (ERR_POSTGRES_CONNECTION_REFUSED). A `redact` unit test. | None. **Limits:** the unreachable-Postgres test passes with or without `redact()`, because Bun's message ("Failed to connect") carries no URL. So redaction is pinned only by the `redact` unit test. No test covers a NATS open failure, or the "close what already opened" path (Postgres up, NATS down). |
| PLENARY_NODE_ID | `/^[a-z0-9-]{1,32}$/`, else refused. The default is the hostname, lowercased, other characters turned into `-`, cut to 32 (`"node"` if empty), so the default is never refused. It is passed to room-host as `hostname` and logged in the `node` line. | main.test "PLENARY_NODE_ID…": bad ids, the 32-char edge, a long hostname, holder `app-9-<pid>-<hex>` | — |
| PLENARY_ROLES | Split on commas, trimmed, lowercased. Empty, unknown or repeated names are refused. A single node refuses anything but both. | main.test "PLENARY_ROLES…"; the CLI test; main-cluster | **ignore-roles**: 3 fail (including main-cluster) |
| PLENARY_LEASE_TTL_MS | Digits only, then `checkLeaseTtl` (room-host's own range, 3 to 600000). A RangeError becomes `PLENARY_LEASE_TTL_MS: …`. Default 10000. It is also the gateway-only open timeout. | main.test "PLENARY_LEASE_TTL_MS…" (`""`, `2`, `0`, `-5`, `1.5`, `10s`, `600001`, `1e4`); the kill -9 test runs at 3000 | — |
| CLI refusal | `start(env)` throws before anything listens. main.js's entry block catches it, logs `start refused` with the redacted message, and exits 1. | main.test "on the CLI a refused start…": three envs, exit ≠ 0, no `server listening`, no password | (both-urls and ignore-roles fail here too) |
| Roles in server.js | Host-only: a room host plus `serveOpens`, and every path except /health answers 404 (including a real Upgrade request on /ws). Gateway-only: `remoteRooms`, no room host, so no lease. Both: as before, plus `serveOpens`. | roles.test (4 tests); main-cluster | **gw-local-host** (gateway-only builds a local room host): 5 fail |
| Remote open | See "Decisions". | roles.test "remote open: one request in flight…"; the two-host test; main-cluster | **cache-open** (success cached): 2 fail. **no-dedup**: 1 fail. **reply-before-open** (host replies before its open settles): main-cluster fails |
| Auth logger | `httpRoutes({ …, log: log.child({ component: "auth" }) })`. | main.test "the auth routes log through the server's logger": `/auth/callback` with no login cookie gives exactly one `sign-in failed` line with `component: "auth"`, `cause: "no_login_cookie"` at LOG_LEVEL info, and none at LOG_LEVEL error | **no-auth-log**: 1 fail |
| R2-L1 | One `drop(slot, ck)` removes the connection from `conns` and `welcomed` together. It is used at the close notice, after `room.listed`, in the sweep, on a refused or thrown hello and on `unavailable`; `fail()` clears both. I chose the set over a flag on the Room's connection object, which isn't the host's to mutate. | room-host-lease "R2-L1": 2,000 hellos, then 1,000 close notices, then a listing that keeps 500. `peek()` shows `{ conns: 500, welcomed: 500 }`. Then a null renew (lease lost): 1013 goes to exactly those 500 conns. | **r2l1-undone**: 1 fail (welcomed 2000) |
| main.test ttl | `LEASE_TTL_MS = 3_000`, passed through `boot(…, leaseEnv)`. | The kill -9 test, which also asserts the child's `node` line says 3000 | — |
| Header | New names documented in the existing style. "Entry point (single node or one cluster node)". The blobs note. "EVERY NODE MUST USE THE SAME VALUE" on the ttl. | — | — |

Mutation runs: a copy of the tree under the session scratchpad, edited by a script, never the shared tree. Each run
covered main.test, roles.test, main-cluster (with PG + NATS) and room-host-lease, filtered to the relevant tests.

## Decisions (mine; please confirm or overrule)

1. **Remote open.** It resolves on the first reply that names the board, whatever its state, as the brief says.
   - **Reply timing:** a host replies only after its local `open()` settles, and `open()` still awaits a slot that
     is building. So a `held` reply means the inbox is already subscribed. A host whose open throws logs it and
     sends no reply.
   - **The cold-race window:** on a cold board two hosts race, and the watcher's `watching` reply usually arrives
     first: 100 of 100 in-process cold opens. The hello then goes to the inbox while the holder may still be
     building. If it lands before the holder subscribes, the watcher holds it and answers 1013 when the holder's
     `opened` heartbeat comes (the MEDIUM-2 path), and the client retries.
   - **Measured:** in process (memory bus, SQLite, near-instant builds), the first writer was welcomed on the first
     try 15 of 15 times. **Unmeasured on Postgres + NATS with two hosts**, where builds are slower, so the real
     bounce rate may be higher. main-cluster (one host) always passes. The tests that start cold with two hosts use a retry-on-1013 connect, as a real client does.
   - **Alternative, if you want it:** a `held` reply wins, and a `watching` reply resolves only after a short grace
     (or at the timeout). That closes the window at the cost of up to the grace on every open answered only by
     watchers.
2. **Requester id** = `r-<node>-<8 hex>`. The `r-` prefix keeps it valid for `needId` even when PLENARY_NODE_ID
   starts with `-` (the brief's `[a-z0-9-]` allows that, and `needId` refuses it).
3. **`subjects.open` is a string constant**, as the brief writes it. `subjects.opened` is a function, like the others.
4. **A host-only node makes no dev board.** It has no gateway or HTTP routes, so it logs
   `dev tokens are set but this node has no gateway: no dev board here`. Each gateway node still makes its own dev
   board in its own data dir, as before; scripts/load already creates its board with POST /boards.
5. **`/health`** gains `roles`. On a host-only node `gateway` is null. On a gateway-only node `rooms`/`waiting` are 0
   and `opening` counts requests in flight.
6. **Postgres schema:** `public`. The env contract has no schema variable, so main-cluster.test creates a fresh
   database per run and drops it after.

## For deploy/ (platform, t187): env names and behaviour to change

- **The header comment** of deploy/cluster.compose.yml:7-11 ("What is missing … p4-wire wires these") is now stale.
  main.js reads DATABASE_URL, NATS_URL, PLENARY_NODE_ID, PLENARY_ROLES and PLENARY_LEASE_TTL_MS. The same applies to
  the "After p4-wire also" comment at lines 58-61.
- **Both URLs or neither.** One without the other refuses the start (exit 1). COOKIE_KEY is still required in
  cluster mode. The refusal order is: URLs, then node id, roles, ttl, then COOKIE_KEY.
- **PLENARY_NODE_ID** must match `[a-z0-9-]{1,32}`. `app-1`..`app-3` and the rig's `gw-N`/`host-N` all pass. If it
  is unset, the default comes from the hostname (a container id works).
- **PLENARY_ROLES:** `gateway`, `host` or both, comma-separated, any case. A single node refuses a single role.
- **PLENARY_LEASE_TTL_MS** must be the same on every node. The compose's shared `${PLENARY_LEASE_TTL_MS:-10000}`
  already does that. It must be an integer from 3 to 600000.
- **Host-only nodes** (app-3) answer only `/health` (200, `roles: { gateway: false, host: true }`). Every other path,
  `/ws` included, answers 404. Keep them out of the LB, as compose already does.
- **A gateway-only node needs at least one host node.** With none, every writer hello is answered `unavailable`
  after the ttl. Viewers still work: they never reach a room.
- **NATS max_payload 2 MB** is checked at start-up (the adapter refuses less). The compose and the rig set it.
- **S3_\*** are still not read, and blobs stay on each node's PLENARY_DATA_DIR. The compose may keep minio for later
  or drop it.
- **A refused start** logs one JSON line, `{"msg":"start refused","message":…}`, and exits 1. With
  `restart: unless-stopped` that loops visibly in the logs.
- **The `node` log line** at start carries `{ node, roles, cluster, leaseTtlMs }` (no URLs). `server listening` now
  also carries `roles`.

## Gates

| Gate | Result |
|---|---|
| `bun test`, shared tree, no PG/NATS | 1436 pass, 155 skip, **1 fail: test/core-source** (the known herdr-draw drift). No flakes seen. |
| `bun test test/server` ×10, no PG/NATS | 10 of 10 runs: 252 pass, 0 fail |
| `bun test test/server` once with DATABASE_URL + NATS_URL (the brief's gate) | 0 fail, inside the full run below (every test/server file, including main-cluster, room-host-proc, pg-store and nats-bus) |
| `bun test`, shared tree, with DATABASE_URL + NATS_URL (beyond the gate) | 1580 pass, 30 skip, 2 fail. **test/core-source** (known drift). **test/load/load.test.js "live, 2 workers: 100 mixed clients join…"** (untracked, another session's). The failing run's error text was not captured. It passed 1 of 1 alone, and the whole file passed 8 of 8, 3 times, all with the same env. Its children get a scrubbed env (PATH, HOME, PORT, data dir), so they run single-node whatever this job reads. **Inference, not proven:** a timing flake under full-suite load. Worth a ticket for its owner. The brief's three known flakes did not appear. |
| test/architecture.test.js | green (with ports.test: 32 pass) |
| main-cluster.test.js alone ×4 (PG + NATS) | 4 of 4 pass, about 3.4 s each |
| roles.test.js ×20 | 20 of 20 pass |

## Servers and cleanup

- **Postgres 17** (`/opt/homebrew/opt/postgresql@17`, trust auth, `unix_socket_directories=''`): PID 19368,
  127.0.0.1:62902, data under the session scratchpad.
- **nats-server** (`max_payload: 2MB`): PID 19379, 127.0.0.1:62903.
- **Scratch test file:** a throwaway test file (`test/server/zz-scratch-p4wire.test.js`, used to measure the cold
  bounce rate) sat in the shared tree for a few seconds and was then removed.
- **Never-log rule, limit:** it is tested on refused starts only. main-cluster's URLs carry no password (trust-auth
  Postgres, auth-less NATS); it asserts only that the database URL is absent from each child's stdout.
- **Stopped by PID** after the gates: Postgres with `pg_ctl stop` (PID 19368), nats-server with `kill 19379`. Both confirmed gone.
- **Scratch not deleted:** `rm -r` is denied in this session. Left behind in the session scratchpad: pg/ (the Postgres data dir), mut/ (the mutation copies), race/, d/, and a few small scripts. No repo files outside the brief's list changed. The test databases were dropped by main-cluster.test's afterAll, and temp dirs were removed by helpers.cleanup.

---

# Round 2 (brief p4-wire-r2)

**Status:** all four items are done.
- **Cold-board bounce:** on Postgres + NATS (2 hosts, 1 gateway), the first writer on a cold board was bounced or
  lost on 18 of 60 boards before the change, and on 0 of 60 after it.
- **Mutations:** each of the 5 new ones is caught.
- **Gates:** see the table below. Failures outside core-source were all in other sessions' untracked tests, and each
  passed when run alone.

## 1. Remote open: "held" wins, "watching" waits a grace

- **Change** (room-host.js `remoteRooms`): `graceMs = min(1000, floor(timeoutMs / 4))`. A `held` reply settles the
  open at once. The first `watching` reply arms the grace timer, and later `watching` replies don't re-arm it. A
  `held` reply during the grace settles at once. When the grace ends, the open resolves `"watching"`. With no reply,
  it still rejects (`unavailable`) at `timeoutMs`. Settling clears both timers. The in-flight dedup and the
  no-cache rule are unchanged. `graceMs` is exposed on the object, for tests.
- **Tests** (roles.test.js, 3 new):

| Test | What it checks |
|---|---|
| "with two hosts on a cold board a `held` reply resolves the open well before the grace ends" | ttl 4000, so the grace is 1000. Open resolves `held` in < 500 ms. Both replies arrive (`held`, `watching`). One room exists. |
| "watcher-only replies resolve at about the grace, not before; a `held` during the grace resolves at once" | A fake host answers only `watching`: resolves in ≥ 990 and < 1400 ms. Then `watching` at once plus `held` at 200 ms: resolves `held` in ≥ 190 and < 700 ms. |
| "no reply at all rejects at about the ttl" | ttl 800, so the grace is 200. Rejects `unavailable` in ≥ 790 and < 1300 ms. |

- **Mutation grace-skipped** (first reply wins again): 2 fail (the first two tests above).

## 2. Cold bounce on Postgres + NATS, measured

- **Setup:** a scratch script (not in the repo) starts three `bun server/main.js` children on a fresh database:
  host-1 and host-2 (`PLENARY_ROLES=host`) and gw-1 (`gateway`), with ttl 10000, so the grace is 1000 ms.
- **Procedure:** 20 boards are made with POST /boards. For each, one writer sends one hello on a fresh socket. The
  script records a welcome or a close, and the time from hello to that result.

| Code | Run | Welcomed first try | Bounced (1013) | Hello to welcome, ms (min / median / max) |
|---|---|---|---|---|
| Before (first reply wins) | 1 | 11 | **9** | 2 / 3 / 11 |
| Before | 2 | 14 | **6** | 1 / 3 / 24 |
| Before | 3 (with logs) | 18 | **2**, one of them **after 10,001 ms** | 2 / 3 / 13 |
| After (grace) | 1 | **20** | 0 | 1 / 2 / 11 |
| After | 2 | **20** | 0 | 1 / 2 / 10 |
| After | 3 | **20** | 0 | 1 / 4 / 13 |

- **Before, total:** 17 of 60 first writers bounced.
  - **Fast bounces:** the 2-10 ms ones are the path described in round 1. The watcher answers `watching` first,
    the gateway forwards the hello, the watcher holds it, and the holder's `opened` heartbeat makes the watcher
    answer 1013.
  - **The 10,001 ms bounce:** the gateway logged `no welcome in time`, so the hello was lost: nobody answered it, and
    the gateway's 10 s hello timer fired. **Mechanism not verified.** My guess is the watcher dropped its held hello
    on the holder's next heartbeat (room-host `watchEntries`: a heartbeat that isn't "fresh" clears `pending`,
    assuming the holder answered them). It did that while the holder's inbox subscription had not yet reached the
    NATS server when the hello was published. That is a room-host watcher race from p4-host, not this job's code.
    The grace makes the gateway wait for `held`, which is sent after the holder subscribed and on the same NATS
    connection, so the cold path no longer goes through it.
- **After, total:** 0 of 60 bounced, with no added latency (median 2-4 ms), because `held` arrives within a few ms.
- **Where a bounce can remain:** the grace only resolves `watching` when no host answers `held` in time. That means
  the holder is stalled, dead, or slower than 1 s to build (a long log). Then the hello takes the watcher path, as
  before: 1013 once the holder is silent or opens, or the possible lost-hello race above (a 10 s timeout, then 1013).
  I'd suggest a ticket for room-host's owner on that race.

## 3. Redaction gaps closed

- **Change** (main.js): `start(env, { adapters })` takes optional factories `{ postgresStore, postgresRegistry,
  natsBus }`, used only by `openCluster`. Tests pass fakes. Production behaviour is unchanged.
- **Tests** (main.test.js, 2 new): the fakes' errors quote the full URL with the fake password.

| Test | What it checks |
|---|---|
| "a NATS open failure after Postgres opened…" | The Postgres store and registry fakes open. The NATS fake first calls `onError` with an error quoting the URL (the bus-error log path), then throws `could not connect to <url>: … <password> …`. The error must match `could not open the NATS bus (NATS_URL): could not connect to ***`. Both Postgres fakes are closed. The `bus error` log line reads `stale connection to ***`. The password and the Postgres URL are absent from the message, `String(err)`, the stack and every log line (the shared `refusedWith` check). |
| "a Postgres open failure quoting its URL is redacted (message and code)" | The store fake throws with the URL and password in both `message` and `code`. The error must be exactly `… (DATABASE_URL) [E_***]: connect failed to *** (password ***)`. Nothing was opened, so nothing is closed. |

- **Mutations:**

| Mutation | Result |
|---|---|
| no-redact-open (both redacts in `openCluster` removed) | 2 fail |
| no-redact-msg-only (the message's redact removed) | 2 fail |
| no-redact-onerror (the bus `onError` line not redacted) | 1 fail |
| no-close-on-fail (opened adapters not closed) | 1 fail |

  None of these depends on the `redact` unit test.

## Round 2 gates

| Gate | Result |
|---|---|
| `bun test`, shared tree, no PG/NATS | 1453 pass, 155 skip, 6 fail. **test/core-source** (known drift). **5 in test/deploy/cluster-rig.test.js** (untracked, another session's). They use stub nodes (test/deploy/stub-node.js), not server/main.js, and the file passed 11 of 11 when run alone right after. Two other sessions' `bun test` processes were running at the same moment. **Inference, not proven:** contention. |
| `bun test test/server` ×10, no PG/NATS | 10 of 10 runs: 257 pass, 0 fail |
| `bun test test/server` with DATABASE_URL + NATS_URL | 379 pass, 11 skip, 0 fail (includes main-cluster, room-host-proc, pg-store, nats-bus) |
| test/architecture.test.js | 16 pass, 0 fail |

## Round 2 servers

- **Postgres 17:** PID 64891, 127.0.0.1:51961, the same scratch data dir as round 1. The round-1 ports had been taken
  by something else, so new free ports were picked.
- **nats-server:** PID 64909, 127.0.0.1:51962.
- **Stopping:** both are stopped by PID after the gates (see below). The scratchpad is left as it is, as the brief asks.
- **Stopped after the gates:** Postgres with `pg_ctl stop` (PID 64891), nats-server with `kill 64909`. Both confirmed gone. The bounce script dropped its databases.
