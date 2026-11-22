# M2 Backlog Orchestrator Handoff — M2 COMPLETE (2026-11-22)

## Status: **M2 COMPLETE**

All M2 phases, backlog items, load-test proofs, live 2-host takeover proof, and full unit + integration test gates are complete and committed on `main`.

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
10. `d8ebe35` — `F11`: per-board gateway reply subject (`plen.<tenant>.<board>.gw.<gateway>`) in `server/bus/port.js`, `server/gateway.js` (per-board subscription in `joinBoard`, verifying `ws.data.b === b`), and `server/room-host.js`, plus all 8 bus/gateway/room-host test files.
11. `7484a26` — Phase 8 3-node cluster load-test proof (500 clients): `docs/m2/load/cluster-3node-500/` (**VALID**, 500/500 joined, 299/299 ops acked & echoed, 133,558 viewer deliveries, 0 closes 1013).
12. `7fcc24f` — `p5-snap` (`F9`): HTTP snapshot route (`GET`/`HEAD /boards/:board/snapshot?ticket=...`) + offline-verifiable HMAC-SHA256 snapshot ticket (`snap1.` prefix, 5 min TTL, scoped to `(board, seq)`, zero Registry queries) in `server/auth/session.js`, `server/auth/http.js`, `server/feed.js` (lazy cached gzip), `server/gateway.js` (`hello.snap: "http"`, `welcome.snapshot`, tail-only WS catch-up, warm + cold `gw.snapshot`), `server/server.js`, `server/main.js`, `PROTOCOL.md`, and `test/server/snapshot-http.test.js` (unit + live E2E warm & cold gateway).
13. Phase 8 higher-scale 4-node cluster load-test proof + live 2-host takeover proof (this commit):
    - **2,500-client 4-node cluster (`--gateways 2 --hosts 2` + Postgres 17 + NATS + Caddy):** `docs/m2/load/cluster-4node-2500/` — **VALID** (exit 0), 2,500/2,500 clients joined (p50 1 ms, p99 26 ms, max 61 ms), 387/387 ops acked & echoed (editor ack p50 21 ms / p99 104 ms), 826,273 viewer deliveries (p50 18 ms, p99 88 ms), 0 closes 1013 / 0 reconnects / 0 errors; all 6 generator workers unsaturated (CPU mean ~16.3%, lag p99 13–17.5 ms).
    - **Live 2-host takeover under load (`--gateways 2 --hosts 2 --lease-ttl-ms 3000`):** `docs/m2/load/cluster-4node-takeover/` — `SIGKILL`ed active room host `host-1` (`rooms: 1`) mid-load via `scripts/cluster-rig.js kill host-1`; `host-2` took over the Postgres lease (`rooms: 1, waiting: 0`); **VALID** (exit 0), 429/429 ops acked & echoed (**0 acked ops lost**), 15/15 writers reconnected cleanly (`15 closes 1013`, `15 rejoins`), 185/185 viewers stayed connected without dropping; 200/200 connected at end.
    - All rigs torn down cleanly (`scripts/cluster-rig.js down`).
14. Full test gate verified (0 failures):
    - Live Postgres 17 + NATS full suite (`DATABASE_URL` + `NATS_URL`): **1,710 pass, 30 skip (live Google OAuth / S3 / mid-up fixture), 0 fail** across 97 files (including `main-cluster.test.js` and `counting.test.js` verified individually without contention).
    - Default `bun test` (CI gate, no external services): **0 fail** across all 97 files.

## Remaining M2 Backlog
None — M2 is complete.

## Important Environment / Execution Notes
- Loopback sockets (`Bun.serve`, `WebSocket` tests) and `.git/` writes require `BypassSandbox: true` on `run_command`.
- Never commit `.env` or copy `.env` into scratchpads; never use `pkill`/`killall`; stop only PIDs you started and recorded.
- Note: untracked/modified historical `docs/m2/briefs/` and `docs/m2/reports/` files (`manager-client.md`, `manager-platform.md`, `p1-v11*`, `p2-recovery*`, `p2-swapv*`) were pre-existing dirty files before these runs and intentionally left untouched.
