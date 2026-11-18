# Report: p8-rig2 (fix round for p8-rig after verifier p8-rigv FAIL)

**Status: done; all fixed, every gate green.**
- **Findings fixed:** H1, M1 and M2, plus the optional L1 and L5.
- **Known limits:** L2–L4 are written up in RIG.md.
- **Mutations:** the verifier's H1 repro and all 3 binding mutations now fail a test, and so do 5 more.

Nothing is committed. No messages were sent to anyone but this report.

## Files changed (only the brief's)

| File | Change |
|---|---|
| scripts/cluster-rig.js | `PS_ENV` and `STARTED_CLOCK`; `psInfo` runs `ps` with `{ PATH, LC_ALL: "C", TZ: "UTC" }`; `loadRig(dir)` (caller's dir wins, old files refused); rig.json gains `startedClock` |
| test/deploy/cluster-rig.test.js | 5 new tests, a binding check in test 1, the logs scan in the secrets test, a fixed-env `lstart` helper, and `cli()` takes `env` |
| test/deploy/stub-node.js | unchanged |
| deploy/cluster/RIG.md | schema line (`startedClock`); Safety: any TZ/locale, old rig.json refused, the dir you name; new "Known limits" (L2–L4) |

**rig.json schema:** it gains one field, `startedClock: "lstart TZ=UTC LC_ALL=C"`, and is still version 1.
- **Load client:** scripts/load/run.js reads only `lb.wsUrl` and `tokensFile`, so it is unaffected.
- **Test update:** the exact key list in the secrets test now includes the new field.

## Findings

### H1 (HIGH): process identity depended on TZ and locale

- **Change:** every `ps` call runs with `env: PS_ENV` (`PATH`, `LC_ALL=C`, `TZ=UTC`) (scripts/cluster-rig.js, `psInfo`).
  - **The test's own check is independent:** it has a separate `lstart()` with the same fixed env and does not import the
    module's.
  - **Marker:** new rig.json files carry `startedClock`.
- **Old rig.json files (no `startedClock`): refuse, not re-normalise.**
  - **Why not re-normalise:** the TZ and locale the old `up` ran under are unknown, so the old text cannot be converted.
    And old en_US text looks just like new C/UTC text, so only a marker can tell them apart.
  - **What refuses:** `loadRig` is used by `stopRig`, `rigStatus`, `killNode` and `startRig`'s reuse check. It throws
    while any recorded PID exists (as any process at all), names each `name (pid N)`, and says: check with `ps -p`,
    stop the rig's ones, remove the dir.
  - **When nothing is left:** with no recorded PID present, the old file is harmless. `down` marks it down, and `up` may
    reuse the dir.
  - **Effect on `up`:** it can never `rmSync` a dir whose old processes might still be live.
- **Tests:**
  - **"CLI: identity ignores TZ and locale…"**
    - **Setup:** `up` runs under `TZ=Asia/Kolkata LC_ALL=de_DE.UTF-8`.
    - **Precondition (so the test can't pass vacuously):** the raw lstart text for a rig PID differs between that env and
      `TZ=America/New_York LC_ALL=C`.
    - **Records:** each recorded `started` equals the fixed-env lstart.
    - **Status:** `status --json` under `TZ=Pacific/Chatham LANG=fr_FR.UTF-8` shows all 6 alive.
    - **Second `up`:** under New_York/C it exits 1 with "is still running". rig.json is byte-identical, `pg/PG_VERSION`
      still exists, and all 6 PIDs are still the same processes.
    - **`down`:** under New_York/C it stops `caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres`, and every
      PID and port is free.
    - **Cleanup:** the `finally` stops leftovers only by recorded PID, matched by the test's own check against any of the
      three possible recorded forms, so a broken rig cannot leak.
  - **"an older rig.json (no startedClock…) is refused while a recorded PID exists; up never wipes it"**
    - **Setup:** a live decoy recorded in Kolkata/de text.
    - **Refused:** `stopRig`, `killNode`, `rigStatus` and `startRig` all throw `older cluster-rig.js … node:gw-1 (pid N)`.
    - **Untouched:** rig.json is byte-identical, `pg/` remains, and the decoy is alive.
    - **After the decoy dies:** `down` reports it as gone.
- **Verifier's repro, redone (in the copy):** the CLI test above is that repro, through the CLI under different
  TZ/locales. It passes with the fix, and fails under the mutation that removes `env: PS_ENV` (table below).

### M1 (MEDIUM): saved to the `dir` inside rig.json, not the `--dir` given

- **Choice:** overwrite `rig.dir` with the caller's resolved dir (in `loadRig`). `save()` then writes back to the
  file that was read.
- **Why not refuse on a mismatch:** a refusal would strand live processes after `mv .rig/a .rig/b`, since `down` would
  no longer work.
  - **Path spellings:** it would also falsely refuse different spellings of one path (`/tmp` vs `/private/tmp`).
  - **Safety holds either way:** stopping is safe from any copy, because identity is checked per PID.
  - **The real risk:** the only danger is writing another rig's file, and this choice removes it.
- **Status output:** `status` now reports the caller's dir as `dir`.
- **Test:** "a rig.json copied to another dir is read and written there…"
  - **Setup:** dir A has `state: "up"`, and its rig.json is copied to B (the copy still says `dir: A`).
  - **Calls:** `rigStatus(B).dir` is B, `killNode(B)` and `stopRig(B)` run, and B's file ends up `{dir: B, state: "down"}`.
  - **Guard:** A's file stays byte-identical.

### M2 (LOW): loopback binding was untested

- **Test:** added to test 1 ("up: env contract…"), on the rig that is already up.
  - **Sockets:** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` runs for every recorded PID. There must be **exactly 7**
    listening sockets (postgres 1, nats 2, nodes 3, caddy 1), all `127.0.0.1:`, so an empty or failed lsof cannot
    pass.
  - **Config values:** `show listen_addresses` = `127.0.0.1`, and NATS `/varz` `host` and `http_host` = `127.0.0.1`.
- **Result:** all 3 of the verifier's surviving binding mutations now fail (table).

### Optional: L1 and L5 done; L2–L4 documented

- **L1:**
  - **SIGKILL escalation:** "down escalates to SIGKILL…" uses a decoy `sh -c "trap '' TERM; exec sleep 60"` and
    `graceMs: 500`. It expects `forced: ["node:gw-1"]`, a run of at least 500 ms, and an exit by SIGKILL (137).
  - **Health-wait timeout:** "up: a part that never becomes healthy…" uses node-cmd `sleep 300` and `timeoutMs: 8000`.
    It expects `not ready after the timeout (log: …)`, state `failed`, and every PID and port down.
- **L5:** the secrets test now also reads every file in `logs/` for both rigs (at least 11 files), after `down`.
- **L2–L4:** written up under "Known limits" in RIG.md: env visible via `ps eww` to the same user, one-second lstart
  resolution, and Postgres backends after a SIGKILL of the postmaster (untested).

## Mutations (copy only; each applied from a saved original, `bun test test/deploy`, restored; final compare identical)

| Mutation | Result | Test(s) that fail |
|---|---|---|
| H1: `psInfo` without `env: PS_ENV` (the verifier's repro) | **fails** (3) | "CLI: identity ignores TZ and locale…", "down and kill only signal a PID whose start time still matches…", "down escalates to SIGKILL…" |
| H1: no old-format refusal (`if (false)`) | **fails** (1) | "an older rig.json (no startedClock…)…" |
| M1: drop `rig.dir = dir` (save to the file's dir) | **fails** (1) | "a rig.json copied to another dir…" |
| v2: Postgres `listen_addresses=*` | **fails** (1) | "up: env contract…" (binding check) |
| v3: NATS `listen: 0.0.0.0` | **fails** (1) | "up: env contract…" |
| v4: Caddy without `bind 127.0.0.1` | **fails** (1) | "up: env contract…" |
| v7: no SIGKILL escalation in `stopRig` | **fails** (2) | "down escalates to SIGKILL…", plus one that bun reports as `(unnamed)` (not investigated) |
| v10: `up` writes the keys into `logs/keys.log` | **fails** (1) | "CLI: keys and dev tokens never reach stdout or stderr…" (logs scan) |

**Which test file each result used:** only the first row (H1 `ps`) was rerun against the final test file. The later
change touched only that test's `finally`, so the other 7 results stand.

**Leak in my first mutation run (fixed and cleaned up):** the first H1-mutation run left 5 processes running:
nats-server 41363, caddy 41406, and stub nodes 41379, 41381 and 41384.
- **Why they were mine:** they started 14:18:53–54, inside that run, from a temp dir it created.
- **Cause:** the test's `finally` recognised only the fixed-format start time.
- **Fix:** it now also matches the two env forms the test uses.
- **Cleanup:** I stopped exactly those 5 PIDs with SIGTERM and confirmed they were gone (Postgres 41352 had already
  exited).
- **Stubs found late:** they were found only by a later sweep for `stub-node.js`, because a stub's command line does not
  name the rig dir. Each was under my scratchpad copy, had parent 1, and started at 14:18:53–54.
- **Recheck:** a rerun of the H1 mutation left nothing from my copy.
- **Not mine, not touched:**
  - PID 62192 and its children: `bun /Users/r/repos/plenary/scripts/cluster-rig.js up …`, run from the real tree by
    another session's test run. Both were gone by the final sweep.
  - 53168 and 62656, which the brief excludes.

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy | 11 pass, 1 skip, 0 fail (17.11 s) |
| `bun test test/deploy` #2 | copy | 11 pass, 1 skip, 0 fail (16.82 s) |
| `bun test test/deploy` #3 | copy | 11 pass, 1 skip, 0 fail (16.87 s) |
| `bun test test/architecture.test.js` | real tree, read-only | 16 pass, 0 fail |
| `bun test` (full) | copy | 1424 pass, 153 skip, 0 fail, 1577 tests across 83 files (191.95 s) |

- **Copy:** `rsync -a --exclude .git --exclude .rig` of the real tree to
  `/private/tmp/claude-501/-Users-r-repos-plenary/7bcf7478-db57-4903-87d0-4c98262e51c1/scratchpad/pl`. The
  4 owned files were compared byte-for-byte (`cmp`) before the gates.
- **core-source failure absent:** the verifier's known `core-source` failure did not show up in the copy. That may be
  because the copy has no `.git`, which I have not checked; it is not this job's.
- **After all runs:** a sweep for both `plenary-rig-` and `stub-node.js` in command lines finds only 53168 and 62656.

## Not verified / risks

- **DST:** a daylight-saving change between `up` and `down` was not tested live. It is covered in principle, since
  `TZ=UTC` has no DST.
- **Old-format refusal, one-sided risk:** a reused PID makes the old file refuse until that process exits; the
  message says how to proceed. No live rig.json from before this fix exists here (`.rig/` does not exist), so
  the fallback only matters for copies elsewhere.
- **Linux:** the lsof binding test is macOS-oriented (`-Fn`, IPv4 `127.0.0.1:`). It has not been tried on Linux; the
  rig itself is macOS-only today.
- **L3 and L4:** still theoretical or untested, as RIG.md now says.
- **Design skill:** distributed-systems-design does not apply; this is test tooling with no system-design change.
