# Report: p8-load5 (fix round 5 for the load client)

Closed the 1 MEDIUM and 2 LOWs from `docs/m2/reports/p8-load4v.md`:

1. **MEDIUM — dropping clients mid-run and refusing rejoins now reads INCOMPLETE (exit 1):**
   - `scripts/load/run.js`: `buildResult` now sets `clients.connected = planned > 0 && connectedAtEnd >= planned` and `ops.keptOut = due.filter(r => skippedOfflineBy[r] > opsMade_<r>)`; `ops.answered` requires `keptOut.length === 0`, and `result.complete` requires `complete && connected && answered`. `headline()` names every cause with its numbers.
   - `scripts/load/worker.js`: the drain loop also waits for reconnecting clients (`!c.welcomed && !c.gone`) so transient drops have time to reconnect before `connectedAtEnd` is sampled.
   - `scripts/load/client.js`: tracks `skippedOffline_<role>` alongside `skippedOffline`.
   - Checked against all 15 calibration `result.json` files (`docs/m2/load/2026-11-12-calibration/`): none flips (`connectedAtEnd === planned` and `skippedOffline <= sent.total` in all 15).
   - Updated `scripts/load/run.js` header (`--help`) and `docs/m2/load/2026-11-12-calibration/README.md` ("What the headline means" / "Not judged").
   - Tests (`test/load/guards5.test.js`): unit checks for `connectedAtEnd < planned`, `skippedOffline > made`, brief drop, combined reasons; live CLI `dropMid`, `dropMidErr`, and `partialDrop`; 15 calibration files check.

2. **LOW — due clock starts at each client's first welcome:**
   - `scripts/load/client.js`: records `firstWelcomeAt` on the first `welcome`, and starts generation loops on first welcome (rather than at connect) so slow welcomes on a healthy server do not waste ticks before the client can write. Exports `DUE_TICKS` and `writerRate`.
   - `scripts/load/worker.js`: computes `dueClients_<role>` from `rate * (genEndAt - firstWelcomeAt) / 1000 >= DUE_TICKS`.
   - `scripts/load/run.js`: `due = dueRoles(counts, config).filter(r => dueClients[r] > 0)`.
   - Test (`test/load/guards5.test.js`): live CLI `slowWelcome` (900 ms welcome delay, 1 editor, `--op-rate 1.5 --duration 1`) reads **VALID**, exit 0.

3. **LOW — unknown flags, flag-as-value, `--rig " "`, and ramp cap:**
   - `scripts/load/run.js`: `parseArgs` refuses unknown flags (`--op_rate 5`) and a value starting with `--` (`--tokens --local`), naming the flag (exit 2). `run()` calls `parseOptions(o)` before `rigConfig(o.rig)` so `--rig " "` gets `--rig is empty`. `parseOptions` caps ramp duration at `MAX_RAMP_S = 3600` s (documented in `--help` and calibration README).
   - Tests (`test/load/guards5.test.js`): `parseArgs`/`parseOptions` unit checks and CLI exit-2 checks.
