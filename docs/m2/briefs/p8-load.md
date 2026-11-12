# Brief: p8-load (load client for the M2 ~10k-client test)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load.md. Report only to
t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values or
tokens (dev tokens included: print only the path of the file holding them). Never pkill/killall: stop only PIDs you
started and recorded. Ports from port 0. Do not commit. Stop at 60% context after writing what you have. Name failing
tests with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

M2's gate (docs/m2/PLAN.md phase 8) is a load test of ~10k simulated clients on 3 nodes. Engine (t18m) gave platform
the load client and keeps the pass numbers (it writes them when its p4-wire job lands). A sibling job, p8-rig, builds
the cluster rig (scripts/cluster-rig.js: Postgres + NATS + nodes behind Caddy; it writes `rig.json` in its rig dir
with the LB URL and a dev-tokens file path). Until p4-wire, the client must work against one single-node server
(`bun server/main.js` with `PLENARY_DEV_TOKENS`), which is enough to build and calibrate it.

## Do

1. **scripts/load/** (Bun, no new deps). Use packages/protocol's `Replica` as a consumer only: never edit
   packages/ (read PROTOCOL.md and packages/protocol/replica.js for hello, welcome, ops, acks, presence). A later
   engine change may add an optional `{tab}` Replica option; keep that one line easy to add.
   - CLI: `bun scripts/load/run.js --url ws://... --board <id> --tokens <file> --editors n --annotators n
     --viewers n --ramp <clients/s> --duration <s> --out <dir>`, and `--rig <rig dir>` to take URL and tokens from
     p8-rig's `rig.json` (agree the field names by reading p8-rig's code when it exists; until then accept both flags).
   - **Roles:** editors draw (ops at a configurable rate), annotators add annotations/comments and move cursors,
     viewers only receive. Defaults a ratio like the NFRs (handful of editors, ~2% annotators, the rest viewers).
   - **Measure:** op-to-echo latency (send to the op arriving back, per role, and send to delivery at a sample of
     other clients), p50/p95/p99/max; join rate (hello to welcome, and clients joined per second); counts of
     welcome, 1013 (try again later), other close codes, errors, reconnects; client-side CPU/event-loop lag so a
     saturated load generator is visible and the run is marked invalid instead of blaming the server.
   - **Scale on one machine:** many clients per process, several worker processes (`--procs n`) merged into one
     result; open-file limits checked up front with a clear message. Dev tokens: the server caps sockets per user
     (`PLENARY_MAX_CONNS_PER_USER`, default 64), so generate enough distinct dev users (a helper that writes a
     tokens JSON file 0600 and the matching `PLENARY_DEV_TOKENS` value into a file, never stdout).
   - **Board:** create one via the admin route (POST /boards, read server/auth/http.js) or use the dev board id the
     server logs; document which.
   - **Output:** `result.json` (machine readable, versioned schema) plus `report.md` (markdown summary). A real run's
     report goes under docs/m2/load/ (create the dir) only when it is a calibration run you describe in your report.
2. **Tests (test/load/*.test.js):** against a real single-node `server/main.js` started on port 0 with a temp
   data dir: 50 to 200 mixed clients, every editor op echoed, percentiles computed correctly (unit test the stats on
   fixed inputs), close codes counted (force one 1013 or a close and see it counted), tokens absent from
   stdout/stderr and from result.json, `--procs 2` merges correctly. Each of these has a mutation that makes a test
   fail: list them in the report.
3. **Calibration:** one run of as many clients as this Mac sustains against one single-node server (say how many,
   where the client or server saturated, the numbers). Not the gate; a baseline.

## Files you own

scripts/load/**, test/load/**, docs/m2/load/** (new), docs/m2/reports/p8-load.md. Nothing else. Never packages/,
server/, PROTOCOL.md, test/server/*, scripts/cluster-rig.js (p8-rig's), deploy/.

## Done when

docs/m2/reports/p8-load.md has: files, how to run (single node now, rig later), the result.json schema, the test list
with mutations and results, the calibration numbers and where saturation showed, `bun test test/load` 3x clean, full
`bun test` counts (known unrelated: test/core-source.test.js; name any other failures from other sessions'
uncommitted files). Then stop.
