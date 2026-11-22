# M2 Backlog Orchestrator Handoff (2026-11-21)

## Completed & Committed on `main` (this run)
1. `8840be7` — `p8-rig4`: local native cluster rig (`scripts/cluster-rig.js`, `deploy/cluster.compose.yml`, `deploy/cluster/Caddyfile`, `deploy/cluster/RIG.md`, `test/deploy/`, `test/architecture.test.js` `COMPOSITION_ROOTS`).
2. `72c93b1` — `p8-load5`: closed `p8-load4v` MEDIUM (`connectedAtEnd < planned` and `skippedOffline > made` -> `INCOMPLETE`, exit 1; drain waits for reconnecting clients; 15 calibration runs unaffected) + 2 LOWs (due clock starts at first welcome; unknown flags, flag-as-value, blank `--rig`, ramp > 3600 s exit 2).
3. `7e33764` — `p-hb` (`E-1` + `C-4`): downstream heartbeat (`welcome.hb`, pre-encoded `{ t: "hb" }` every 10 s in `server/gateway.js`, `Replica` 25 s live idle deadline without proving silent connections, `web/core/sync.js` feeds `here`/`emotes` through `replica.receive`).
4. `0232245` — `herdr-draw` sunset: CEO decided `herdr-draw` will be sunset in lieu of Plenary (`drawh` proposal dropped, `packages/core/` owned directly here, `test/core-source.test.js` and CI `herdr-draw` clone removed).
5. `2eb42cb` — `E-2`: full jitter `U(0, 5 s)` on first retry after a proven connection drops (`BACKOFF.firstJitterMs`) + optional `session` param on `Replica` / `openLink`.
6. `e56bf7b` — `E-4` + `E-3`: role-scoped presence fan-out in `server/gateway.js` (writers 50 ms full, viewers 100 ms presenters + writer emotes only, closing viewers emit no `leave`) + incremental `Replica.recordsState()` via per-thread cached JSON in `packages/protocol/records.js`.
7. `fef393f` — `E-5` + `/metrics`: startup memory cache + immutable `/v/<build>/...` URLs in `server/static.js` (`Cache-Control: public, max-age=31536000, immutable`), and Prometheus text exposition `GET`/`HEAD /metrics` in `server/server.js`.
8. Tidy pass (this commit): `p4-wire2v` L1 (`redactingLogger` `scrub` try/catch) & L4 (redact field keys), `deploy/README.md` updated for live cluster mode + `web/` + `/metrics` + `herdr-draw` sunset, `deploy/cluster.compose.yml` header updated (`p8-rig4v` L2).

## Remaining M2 Backlog (in order)
1. **Remaining tidy LOWs (quick, high-clarity):**
   - `p-tabv` L2: 8-cap message in `server/gateway.js` still says "writer connections" instead of "writer tabs" (update `test/server/v1.test.js:148` and `test/server/tab.test.js:11` alongside it).
   - `p7-tabv` L1–L2: stale "writer-connection cap" comments in `web/core/sync.js`, `web/core/session.js`, `web/ports/collab.js`; give real-gateway test in `test/web/p7-tab.test.js` an explicit > 5 s timeout.
   - `p8-one-linkv` L2–L6, L8: check dead merged getters in `web/core/session.js`, `L8` `mine` set saved under old user's key, etc.
   - `devadmin2` / `google2` LOWs: `server/auth/oidc.js` 200 non-JSON token answer labelled `idp_unreachable`, cause table missing labels.
2. **`F11` (per-board gateway subject) + `p5-snap` (`F9`, HTTP snapshot route + signed snapshot ticket):**
   - Check `server/bus/port.js`, `server/gateway.js`, `server/room-host.js` for `subjects.gateway` per-board fanout (`F11`).
   - Optional/next: HTTP snapshot route (`GET /boards/:board/snapshot?ticket=...`) for large-board catch-up (`F9`).
3. **Full `bun test` gate:**
   - Run full `bun test` (with `BypassSandbox: true` for loopback sockets) and verify 0 failures across the entire repo (now that `test/core-source.test.js` is gone, the whole suite should be 100% green!).
4. **M2 Phase 8 3-node cluster load-test proof:**
   - Verify whether native `postgres` / `nats-server` / `caddy` are installed and `scripts/cluster-rig.js up` works cleanly; if so, run a 3-node load test via `scripts/load/run.js --rig ... --create-board` and record the report under `docs/m2/load/`.

## Important Environment / Execution Notes
- Loopback sockets (`Bun.serve`, `WebSocket` tests) and `.git/` writes require `BypassSandbox: true` on `run_command`.
- Never commit `.env` or copy `.env` into scratchpads; never use `pkill`/`killall`; stop only PIDs you started and recorded.
- Keep context under 40%: if approaching 40%, update this handoff, commit clean work, and kick off a fresh `self` orchestrator subagent.
