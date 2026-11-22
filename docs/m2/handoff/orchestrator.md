# M2 Backlog Orchestrator Handoff (2026-11-22)

## Completed & Committed on `main`
1. `8840be7` — `p8-rig4`: local native cluster rig (`scripts/cluster-rig.js`, `deploy/cluster.compose.yml`, `deploy/cluster/Caddyfile`, `deploy/cluster/RIG.md`, `test/deploy/`, `test/architecture.test.js` `COMPOSITION_ROOTS`).
2. `72c93b1` — `p8-load5`: closed `p8-load4v` MEDIUM (`connectedAtEnd < planned` and `skippedOffline > made` -> `INCOMPLETE`, exit 1; drain waits for reconnecting clients; 15 calibration runs unaffected) + 2 LOWs (due clock starts at first welcome; unknown flags, flag-as-value, blank `--rig`, ramp > 3600 s exit 2).
3. `7e33764` — `p-hb` (`E-1` + `C-4`): downstream heartbeat (`welcome.hb`, pre-encoded `{ t: "hb" }` every 10 s in `server/gateway.js`, `Replica` 25 s live idle deadline without proving silent connections, `web/core/sync.js` feeds `here`/`emotes` through `replica.receive`).
4. `0232245` — `herdr-draw` sunset: CEO decided `herdr-draw` will be sunset in lieu of Plenary (`drawh` proposal dropped, `packages/core/` owned directly here, `test/core-source.test.js` and CI `herdr-draw` clone removed).
5. `2eb42cb` — `E-2`: full jitter `U(0, 5 s)` on first retry after a proven connection drops (`BACKOFF.firstJitterMs`) + optional `session` param on `Replica` / `openLink`.
6. `e56bf7b` — `E-4` + `E-3`: role-scoped presence fan-out in `server/gateway.js` (writers 50 ms full, viewers 100 ms presenters + writer emotes only, closing viewers emit no `leave`) + incremental `Replica.recordsState()` via per-thread cached JSON in `packages/protocol/records.js`.
7. `fef393f` — `E-5` + `/metrics`: startup memory cache + immutable `/v/<build>/...` URLs in `server/static.js` (`Cache-Control: public, max-age=31536000, immutable`), and Prometheus text exposition `GET`/`HEAD /metrics` in `server/server.js`.
8. `34bcc52` — Tidy pass 1: `p4-wire2v` L1 (`redactingLogger` `scrub` try/catch) & L4 (redact field keys), `deploy/README.md` updated for live cluster mode + `web/` + `/metrics` + `herdr-draw` sunset, `deploy/cluster.compose.yml` header updated (`p8-rig4v` L2).
9. `1a6b074` — Tidy pass 2: closed `p-tabv` L2 (`server/gateway.js` 8-cap message "open writer tabs" + `test/server/v1.test.js`, `test/server/tab.test.js`, `test/web/p7-tab.test.js`) and `p7-tabv` L1–L2 (stale "writer-connection cap" comments in `web/core/sync.js`, `web/core/session.js`, `web/ports/collab.js` + explicit 20 s timeout on real-gateway test in `test/web/p7-tab.test.js`). Verified `p8-one-linkv` L1–L8 and `p5-devadmin2v`/`p5-google2v` LOWs were already closed in `p5-tidy`.
10. Full `bun test` gate verified: **1579 pass, 155 skip, 0 fail** (516,005 expect() calls across 96 files).
11. `d8ebe35` — `F11`: per-board gateway reply subject (`plen.<tenant>.<board>.gw.<gateway>`) in `server/bus/port.js`, `server/gateway.js` (per-board subscription in `joinBoard`, verifying `ws.data.b === b`), and `server/room-host.js`, plus all 8 bus/gateway/room-host test files (120 pass, 0 fail).
12. Phase 8 3-node cluster load-test proof (this commit): ran native 3-node cluster (`scripts/cluster-rig.js up --name m2-proof --gateways 2 --hosts 1`: Postgres 17 + NATS + 2 gateways + 1 host + Caddy LB) with 500 clients (5 editors, 10 annotators, 485 viewers) via `scripts/load/run.js --rig .rig/m2-proof --create-board`; **VALID**, 500/500 joined (p99 6 ms), 299/299 ops acked & echoed (editor ack p99 26 ms), 133,558 viewer deliveries (p99 25 ms), 0 closes 1013 / 0 reconnects / 0 errors; recorded under `docs/m2/load/cluster-3node-500/`. Rig torn down cleanly (`scripts/cluster-rig.js down --name m2-proof`).

## Remaining M2 Backlog (in order)
1. **`p5-snap` (`F9`, optional/next):** HTTP snapshot route (`GET /boards/:board/snapshot?ticket=...`) + signed snapshot ticket for large-board catch-up off the WS frame path.
2. **Higher-scale 3-node cluster load-test proof (optional, e.g. 2k–10k clients + host takeover under load):**
   - Native `postgres`, `nats-server`, and `caddy` are installed on this machine (`/opt/homebrew/bin/`), and `scripts/cluster-rig.js` + `scripts/load/run.js` are verified end-to-end.
   - Can run a larger scale test (e.g. `--clients 2000` or `--clients 5000` with `--procs 4`) and/or a 2-host takeover proof (`--hosts 2` + `scripts/cluster-rig.js kill host-1` under load) and record under `docs/m2/load/`.
3. **Final full `bun test` + Postgres/NATS live test pass (optional):**
   - Full default `bun test` is 100% green (1579 pass, 0 fail). With a running Postgres + NATS (e.g. from `cluster-rig.js`), the 155 skipped Postgres/NATS integration tests can also be exercised.

## Important Environment / Execution Notes
- Loopback sockets (`Bun.serve`, `WebSocket` tests) and `.git/` writes require `BypassSandbox: true` on `run_command`.
- Never commit `.env` or copy `.env` into scratchpads; never use `pkill`/`killall`; stop only PIDs you started and recorded.
- Note: untracked/modified historical `docs/m2/briefs/` and `docs/m2/reports/` files (`manager-client.md`, `manager-platform.md`, `p1-v11*`, `p2-recovery*`, `p2-swapv*`) were pre-existing dirty files before these runs and intentionally left untouched.
