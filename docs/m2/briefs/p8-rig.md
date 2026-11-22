# Brief: p8-rig (local cluster rig for the M2 load test)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig.md. Report only to
t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values or
tokens (no `cat .env`). Never pkill/killall: stop only processes whose PIDs you started and recorded; remove only
Podman containers whose ids you recorded. Ports from port 0 or probed free, never fixed. Do not commit. Stop at 60%
context after writing what you have. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

M2's gate (docs/m2/PLAN.md phases 4 and 8) needs a ~10k-client load test on 3 nodes and a "kill a board's host, another
takes over, no acked op lost" check. Both need a cluster rig: Postgres + NATS + several node processes (gateways and
room hosts split) behind one load balancer. Engine owns the load client and server/main.js; platform owns the rig.

Today server/main.js (engine's, read-only for you) only checks COOKIE_KEY in cluster mode and still opens SQLite + a
memory bus; engine's next job p4-wire wires DATABASE_URL, NATS_URL, PLENARY_NODE_ID, PLENARY_ROLES into it. So the rig
must be fully working and tested for its own half now, with the end-to-end part written and skipped until main.js
accepts the cluster env.

**Env contract from engine (t18m, 2026-11-12), what main.js will read after p4-wire:** `DATABASE_URL`, `NATS_URL`
(cluster mode), `PLENARY_NODE_ID` (lease holder prefix, `[a-z0-9-]` only, unique per node), `PLENARY_ROLES` (comma
list of `gateway,host`, default both), `PLENARY_LEASE_TTL_MS` (default 10000, identical on every node; the rig sets it
once for all nodes and exposes `--lease-ttl-ms`). Blobs stay local disk. Plus today's `PORT`, `PLENARY_DATA_DIR`,
`PLENARY_DEV_TOKENS`, `COOKIE_KEY`, `SESSION_KEY`. A sibling job p8-load writes the load client (scripts/load/); it
reads the LB URL and tokens file from your `status --json` / `rig.json`, so keep those fields documented and stable.

## Do

1. **scripts/cluster-rig.js** (Bun, no new deps), CLI `up | down | status`, and an importable `startRig(opts)` /
   `stopRig(rig)` for tests:
   - **Postgres 17** native (`/opt/homebrew/bin/initdb`, `pg_ctl` or `postgres`) in a rig dir (default under
     `.rig/<name>/`, add `.rig/` to .gitignore), own port, trust auth on localhost only, one database. Podman is a
     fallback only if native is missing; record container ids.
   - **NATS** `nats-server` with `max_payload` 2 MB (reuse deploy/cluster/nats.conf values), own port.
   - **N nodes** (default 3: two `PLENARY_ROLES=gateway`, one `host`; flags `--gateways n --hosts n`), each
     `bun server/main.js` with its own PORT, `PLENARY_NODE_ID`, `PLENARY_DATA_DIR`, shared `COOKIE_KEY`/`SESSION_KEY`
     generated per rig (written 0600 into the rig dir, never printed), `DATABASE_URL`, `NATS_URL`, dev tokens for
     the load client (generated, kept in the rig dir file, never printed; print only the file path).
   - **Load balancer:** Caddy (`/opt/homebrew/bin/caddy`) in front of the gateway nodes, WebSocket-safe, health
     check on whatever health path main.js has (read it; if none, TCP).
   - Health: wait until Postgres accepts, NATS answers, every node listens and the LB answers; clear timeout errors.
   - **Teardown** removes only what this rig started (PIDs recorded in `rig.json` in the rig dir); `down` works from
     `rig.json` after the `up` process died; a crash during `up` tears down what had started.
   - `--node-cmd` (or opts.nodeCmd) override so tests can run a stub node.
   - Logs per process into the rig dir; `status` prints PIDs, ports, the LB URL and the tokens file path.
   - A `kill <node>` subcommand (SIGKILL one node by its recorded PID) for the phase-4 takeover check.
2. **deploy/cluster.compose.yml:** make it consistent with the rig (same env names, roles split, NATS 2 MB, Caddy).
   Keep the "NOT FUNCTIONAL YET" header until main.js wires the adapters; say exactly what is missing.
   `podman compose config` (or `podman-compose config`) must parse it; do not `up` it unless cheap, and if you do,
   record and remove only your containers.
3. **Tests (test/deploy/cluster-rig.test.js):** real Postgres + NATS start/stop with stub nodes (a tiny Bun HTTP+WS
   echo as nodeCmd) behind real Caddy: a WebSocket through the LB reaches a gateway stub; `down` leaves no recorded
   PID alive and no port held; `up` failure midway leaves nothing running; tokens/keys never appear in stdout/stderr.
   Skip with a clear reason if postgres/nats-server/caddy are missing. One **end-to-end test** with the real
   server/main.js (hello over the LB, an op acked, visible from a second gateway) is written and `test.skip`'d with
   a reason naming p4-wire, unless main.js already accepts the cluster env when you run it.
4. **Docs:** a short "Local cluster rig" section in a NEW file deploy/cluster/RIG.md (deploy/README.md has someone
   else's uncommitted edits; do not touch it).

## Files you own

scripts/cluster-rig.js (and helpers under scripts/rig/ if needed), test/deploy/*, deploy/cluster.compose.yml,
deploy/cluster/* (new files there too), .gitignore (one `.rig/` line), docs/m2/reports/p8-rig.md. Nothing else. Never
server/main.js, server/gateway.js, PROTOCOL.md, test/server/* (engine's), never deploy/README.md.

## Done when

docs/m2/reports/p8-rig.md has: files changed, how to run it, what was proven live (process list before/after `down`,
LB WebSocket check), what is skipped until p4-wire and exactly which main.js env it expects, test counts for
`bun test test/deploy` (3x clean) and full `bun test` (known unrelated: test/core-source.test.js; others from other
sessions' uncommitted files: name them). Each guard (teardown only-ours, crash-midway cleanup, secrets not printed)
has a test that fails when the guard is removed: list those mutations and results. Then stop.
