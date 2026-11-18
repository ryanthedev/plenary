# Report: p8-rig2v (verify p8-rig2, round 2 of the local cluster rig)

**Verdict: FAIL (round 2), on one HIGH (H2).** The round 1 findings are fixed: H1 (TZ and locale) and M1 (the dir
inside rig.json). M2 (binding) is now under test. But process identity still fails open by another route.
- **Cause:** `psInfo` returns `null` whenever `ps` cannot run, and every caller reads `null` as "process gone".
- **Repro:** a caller whose PATH lacks `ps`. Reproduced live with the same result as round 1's H1:
  - a second `up` wiped a live rig's dir, including the Postgres data dir under the running postmaster;
  - it re-ran initdb;
  - it left 7 processes that no rig.json names.
- **Second opinion:** codex found it independently and also graded it HIGH.
- **Fix:** about 3 lines (below).
- **Grade:** the trigger is narrower than H1's, but the brief's line "a second `up` against a live dir refuses and never
  rmSyncs" is broken outright, so I grade it HIGH. The manager may regrade it on likelihood.

Everything else the brief asked for holds:
- **H1:** status, kill, second `up` and down across 6 TZ/locale pairs.
- **Old-format refusal:** correct and clear.
- **M1:** a copied or moved rig.json.
- **Binding:** 8 mutations, each fails a test.
- **Round 1 regressions:** 11 mutations, each still fails a test.
- **Real main.js through Caddy:** works.
- **Secrets:** none in output, logs or rig.json; files are 0600.
- **Gates:** green.

Worked in a copy: `rsync` of the tree (no `.git`, no `.rig`) to
`/private/tmp/claude-501/-Users-r-repos-plenary/1f79dbb9-1305-4ce2-a67d-0e6f9e174403/scratchpad/pl`. There were no
edits, mutations or rig runs in /Users/r/repos/plenary. The only file written there is this report. Nothing was
committed.

## Findings

| # | Grade | Finding | Where |
|---|---|---|---|
| H2 | HIGH | `ps` failing to run reads as "every process gone": `up` deletes a live rig's dir, `down` leaks everything, and the failed `up` leaks its own Postgres | scripts/cluster-rig.js:73-81, 157-159, 200-203 |
| M3 | MEDIUM→LOW (observed benign) | A second `up` on the same dir during the first `up`'s initdb window (no PID recorded yet) passes the live check and runs `rmSync` on the dir | scripts/cluster-rig.js:198-205 |
| L6 | LOW | After `mv A C`, rig.json's `tokensFile`, `keysFile` and `logsDir` still point into A. `status` prints them, and the load client reads `tokensFile` | scripts/cluster-rig.js:105-115 |
| L7 | LOW | The e2e test's `test.skip` reason is stale: main.js now reads the cluster env, and the test **passes** when un-skipped | test/deploy/cluster-rig.test.js (the `test.skip("e2e (needs p4-wire)…`) |
| L8 | LOW (nit) | The refusal message reads "cannot tell whether caddy (pid N) are this rig's". Also, `ps -p` alone cannot tell the user much, because the old text depends on the locale | scripts/cluster-rig.js:111-112 |

Carried from round 1, unchanged and now in RIG.md "Known limits": L2 (env visible via `ps eww`), L3 (one-second
lstart), L4 (Postgres backends after SIGKILL).

### H2: `ps` failure fails open (scripts/cluster-rig.js:73-81)

`psInfo` runs `spawnSync("ps", …, { env: PS_ENV })`. `PS_ENV.PATH` is the caller's PATH. When `ps` cannot be found
or does not run, `r.status !== 0` and `psInfo` returns `null`, which is the same value as "PID gone". The binaries
still resolve through the hard-coded `/opt/homebrew/bin/*` fallbacks (`bins()`, :48-57), so `up` proceeds.

**Repro (live, in the copy):**

```
$ bun scripts/cluster-rig.js up --dir $R/nops --node-cmd "$BUN $S/pl/test/deploy/stub-node.js"      # up 0, 6 pids
$ env -i HOME=$HOME PATH=/opt/homebrew/bin $BUN scripts/cluster-rig.js status --dir $R/nops         # 6 x "dead"
$ env -i HOME=$HOME PATH=/opt/homebrew/bin $BUN scripts/cluster-rig.js up --dir $R/nops --node-cmd …
[rig] up failed: postgres: the process exited before it was ready (log: …/nops/logs/postgres.log)
```

The results, read from `ps` and the rig.json that was left:
- **rmSync ran:** the dir was wiped and initdb ran again (the new `postgres.log` starts with initdb output), while the
  old postmaster 14203 still had it as its `-D`.
- **New rig.json:** it reads `failed [('postgres', 14253, None)]`. The new Postgres was recorded with `started: null`
  (:157-159), so `down` skips it. The health wait then called it "exited", although it was running.
- **Left running:** 7 processes, none recorded: the old 6 (14203 postgres, 14214 nats, 14217/14219/14221 stubs,
  14224 caddy) and the new postgres 14253. I stopped exactly those PIDs. Proof they were mine: all started at
  14:32:36–37, have parent 1, and their command lines name my `rigs/nops` dir or my copy's stub-node.js.

**Who hits it:** any shell, cron or launchd job, or test harness whose PATH lacks `/bin`. Only this trigger was
demonstrated. Other triggers are from reading the code and were **not run**: any failure of `ps` itself (spawn
EAGAIN under a process limit, EMFILE). The `ps` call in the old-format refusal (:110) is bypassed by the same
`null`, so an old rig.json also passes as "nothing live" (by reading, not run).

**Fix (builder's):**
- **Run `ps` by absolute path:** `/bin/ps` on macOS.
- **Separate "ps did not run" from "PID absent":**
  - If `r.error` is set, or `r.status` is `null`, throw.
  - Exit status 1 with empty output is "absent".
  - So `up`, `down`, `kill` and `status` refuse instead of guessing.
- **Add a test:** run `up` normally, then `status` and a second `up` with `PATH` lacking `ps`. Expect a refusal, and
  rig.json and `pg/` untouched.

### M3: concurrent `up` on one dir (scripts/cluster-rig.js:198-205)

The reuse check only looks at recorded PIDs. Until Postgres is launched, a starting rig has `procs: []` (`state:
"starting"`), so a second `up` sees nothing live and runs `rmSync` on the dir.

**Repro (live):** start `up` A in the background, and 0.12 s or 0.2 s later run `up` B on the same dir (rig.json read
at that moment: `starting []`).
- **Both runs:** B exits 0 and A fails with a misleading `initdb failed`.
- **Nothing leaked:** B's 6 processes were recorded and a later `down` stopped them all.
- **Control:** at 0.4 s, Postgres was already recorded, and B refused correctly.

**Grade:** LOW to MEDIUM, from what I observed. Worse interleavings are possible by reading but not shown, for
example A's failure `save` landing after B's last save, which would lose B's records. codex graded it MEDIUM.
**Fix:** an exclusive lock file in the dir (`openSync(…, "wx")` holding the `up` PID and its lstart, checked with
`isOurs`), or record the `up` process itself in `procs` before initdb.

### L6: moved rig keeps the old file paths

`loadRig` rewrites only `rig.dir`. After `mv m1-a m1-c`, `status --dir m1-c` printed `tokens m1-a/tokens.json` and
`logs m1-a/logs`. Nothing writes there, so M1's "writes only the dir named" holds. But scripts/load/run.js reads
`tokensFile` from rig.json and would fail on the missing file (loudly). **Fix:** derive `tokensFile`, `keysFile` and
`logsDir` from `dir` in `loadRig`, or document that a moved rig is for `down` only.

## Checks run (all in the copy)

### H1, live through the CLI (`h1.sh`)

`up` ran under `TZ=Asia/Kolkata LC_ALL=de_DE.UTF-8` (6 PIDs). The raw lstart differs by env:
`Fr. 13 Nov. 02:01:56 2026` vs `Thu Nov 12 20:31:56 2026`.

| Command | Env | Result |
|---|---|---|
| status | `TZ=Pacific/Chatham LANG=fr_FR.UTF-8` | 6 alive |
| status | `TZ=America/New_York LC_ALL=ja_JP.UTF-8` | 6 alive |
| status | `TZ=UTC LC_ALL=C` | 6 alive |
| status | `LC_TIME=de_DE.UTF-8` (inherited TZ) | 6 alive |
| status | `TZ=Asia/Kathmandu LC_ALL=ar_SA.UTF-8` | 6 alive |
| status --json | NY / ja_JP | `alive` all true |
| second `up` | NY / ja_JP | exit 1, `is still running (postgres, nats, node:gw-1, node:gw-2, node:host-1, caddy)`; rig.json byte-identical; `pg/PG_VERSION` present |
| kill gw-2 | `TZ=Europe/Berlin LANG=de_DE.UTF-8` | `killed gw-2 (pid 11335)` |
| down | `TZ=Australia/Sydney LC_ALL=ja_JP.UTF-8` | `stopped caddy, node:host-1, node:gw-1, nats, postgres; already gone: node:gw-2`; `ps -p` on all 6: none left |

**Other places that read `ps` output:**
- **Module:** `psInfo` is the only `ps` call in scripts/cluster-rig.js, and it uses `PS_ENV`.
- **Test helpers:** `lstart`/`lstartIn` pass an explicit env. `psGone` reads only `pid=`, which does not depend on
  locale.
- **The gap:** the only one is PATH (H2).

### Old-format rig.json (no `startedClock`), `old.sh`

| Case | status / kill / down / up | rig.json | `pg/` |
|---|---|---|---|
| A recorded PID reused by an unrelated `sleep` (decoy) | all 4 refuse: `rig.json at … comes from an older cluster-rig.js …; cannot tell whether node:gw-1 (pid N) are this rig's. Check each with ps -p <pid>, stop the ones that are, then remove <dir>` | unchanged | kept |
| Partly live (one PID absent, one is the decoy) | all 4 refuse, naming only the present one (`caddy (pid N)`) | unchanged | kept |
| All recorded PIDs absent | status runs, `down` says `already gone: postgres`, and `up` reuses the dir (expected) | rewritten as a new rig with `startedClock` | rebuilt by the new `up` |

The decoy was alive throughout. The refusal is one-sided: a reused PID blocks until that process exits, and it never
allows wrongly while `ps` works. With `ps` broken, it allows wrongly (H2).

### M1 (`m1.sh`)

Rig A was up, and its rig.json was copied to B (the copy still says `dir: A`).
- **`status --dir B`:** reports `dir` = B.
- **`up --dir B`:** refuses with "is still running".
- **`kill gw-1 --dir B`:** kills A's gw-1, by design, since identity is per PID.
- **Files touched:** none outside B. `find -newer` found no changed file, and A's rig.json is byte-identical.
- **`mv A C`, then `status` and `down` via C:** stopped the remaining 5. C's file then reads `down` with dir C, and A
  was not recreated.

Gap: L6.

### M2 binding and other mutations (copy only; `mut.py` applies each to a fresh copy of the original, runs `bun test test/deploy`, and restores; final compare: identical)

| Mutation | Result | Test that fails |
|---|---|---|
| v2 Postgres `listen_addresses=*` | fails | "up: env contract…" |
| v3 NATS `listen: 0.0.0.0` | fails | same |
| v4 Caddy without `bind` | fails | same |
| v11 NATS `http: 0.0.0.0` (monitor) | fails | same |
| v12 node `HOST=0.0.0.0` | fails | same |
| v13 Caddy `bind 0.0.0.0` | fails | same |
| v14 Postgres `listen_addresses=127.0.0.1,::1` | fails | same (socket count) |
| v15 Caddy `bind 127.0.0.1 [::1]` | fails | same |
| H1 `psInfo` without `env: PS_ENV` | fails (3) | "down and kill only signal…", "down escalates to SIGKILL…", "CLI: identity ignores TZ and locale…" |
| H1 `PS_ENV` without `TZ` (LC_ALL only) | fails (3) | same 3 |
| H1 `PS_ENV` without `LC_ALL` (TZ only) | **survives**: an equivalent mutant. `env:` replaces the child's whole env, so it has no locale variables and `ps` uses C. Checked: with `TZ=UTC` and no `LC_ALL`, a caller under `LC_ALL=de_DE` or `LANG=ja_JP` still got `Thu Nov 12 20:00:16 2026` | none needed |
| H1 old-format refusal off | fails | "an older rig.json…" |
| H1 `startRig` reuse check uses `readRig` (skips the refusal) | fails | same |
| H1 reuse check ignores live PIDs | fails | "CLI: identity ignores TZ…" |
| M1 drop `rig.dir = dir` | fails | "a rig.json copied to another dir…" |
| **Round 1 regressions, against the new test file:** | | |
| b1 `isOurs` ignores the start time | fails | "down and kill only signal…" |
| b2 no `stopRig` in `startRig`'s catch | fails (4) | "up failing midway", "never becomes healthy", "CLI: SIGTERM…", "CLI: keys and dev tokens…" |
| b4 `status` prints the tokens | fails | "CLI: keys and dev tokens…" |
| b6 `baseEnv` spreads `process.env` | fails | "up: env contract…" |
| b7 no abort check in `waitFor` | fails | "CLI: SIGTERM…" |
| v1 keys/tokens 0644 | fails | "CLI: keys and dev tokens…" |
| v5 LB upstreams include the host | fails | "up: env contract…" |
| v6 NATS `max_payload: 1MB` | fails | same |
| v7 no SIGKILL escalation | fails (2) | "down escalates to SIGKILL…", plus `(unnamed)` (as the builder saw) |
| v8 `waitFor` ignores a dead process | fails | "up failing midway…" |
| v9 `killNode` without the only-ours check | fails (3) | "up: env contract…", "down and kill only signal…", "a rig.json copied…" |

**Not rerun:** b3 (`save()` skips while `starting`) and b5 (the failure message includes keys.json). Both are covered
by the same tests as round 1, which are unchanged in those parts.

### Regressions, live

- **Real server/main.js** (`real.js`, default 2 gateways + 1 host, in the copy):
  - `LB /health 200`; `POST /boards 201` through Caddy with the admin token (read from tokens.json, never printed).
  - 4 WebSocket hellos through Caddy, **all `welcome(owner)`**. Round 1 got `error(auth)` on alternate sockets.
    main.js now runs in cluster mode on the shared Postgres (server/main.js:2-3, 93), so the board is visible from
    both gateways.
  - With the e2e test un-skipped (copy only, restored after), it **passes**: an op acked via the LB is seen on gw-2
    (L7).
- **down:** `stopped caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres`, nothing forced, nothing of ours left,
  every port free.
- **Secrets:** 107 secrets (2 keys and 105 tokens), 0 found in logs/* or rig.json. keys.json, tokens.json and every
  log are 0600. The builder's CLI test also covers stdout and stderr, and b4 and v1 still fail it.
- **Crash midway:**
  - **Covered by tests, still killing their mutants:** the builder's tests (node dies, health timeout, SIGTERM during
    `up`, SIGKILLed `up`); see b2, b7 and v8.
  - **Not rerun:** round 1's fake-binary matrix (initdb, postgres or caddy exiting, a taken NATS port).

## sdd ensemble review (of a review-only copy of the 4 files plus p8-rigv.md, in `scratchpad/rev`)

| Harness | Result |
|---|---|
| codex (effort high) | HIGH: `ps` lookup failure, so `up` deletes a live dir and `down` leaks (= H2). MEDIUM: no lock, so concurrent `up`/`down` race (= M3). LOW: one-second lstart (= L3, known). Static review only. |
| grok | PASS, no findings. It asserts "no live rig can appear dead", which H2's live repro refutes. |
| agy | Not tried: round 1 found its quota exhausted, resetting about 49 h from 14:00 today. |

**Agreement:** H2 and M3 were found by me (live) and by codex (static). Both are confirmed live above.

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy | 11 pass, 1 skip, 0 fail (16.93 s) |
| `bun test test/deploy` #2 | copy (after mutations; `cmp` with the real tree: identical) | 11 pass, 1 skip, 0 fail (17.25 s) |
| `bun test test/deploy` #3 | copy | 11 pass, 1 skip, 0 fail (17.27 s) |
| `bun test test/architecture.test.js` | real tree, read-only | 16 pass, 0 fail |

## Distributed-systems-design (CHECKER)

This is test tooling, not a system-design change. The part that matters to design is that the rig's own state
(rig.json) has no single writer. That is M3: two `up`s on one dir have no lease or lock. The same "one sequencer per
board" discipline that the product uses would apply here as a lock file. One lease TTL across all nodes still matches
engine's contract.

## Housekeeping

- **Processes before:** 6418 (bun main.js, someone else's), 53168 and 62656 (excluded).
- **Processes after:** the final sweep for nats-server, postgres, caddy run, stub-node, cluster-rig, plenary-rig-,
  `sleep 60/120/300`, server/main.js and my session id found nothing of mine.
  - **Present, not mine, not touched:** 2156 (bun main.js from scratchpad `a99c25cf…`), 19368 and 19379 (postgres and
    nats from scratchpad `2a10d82f…`), and 53168 and 62656.
- **Stopped by recorded PID:** every rig I started, via its own `down`. The exception is the 7 orphans from the H2
  repro, which I stopped by PID: 14203 and 14253 with SIGINT; 14214, 14217, 14219, 14221 and 14224 with SIGTERM. I
  confirmed they were gone. The `old.sh` decoy was stopped by its PID.
- **No pkill or killall.** No secrets printed: only file paths and counts.
- **Copy and rig dirs stay** in my scratchpad (`pl/`, `rigs/`, `rev/`, scripts `h1.sh`, `race.sh`, `old.sh`, `m1.sh`,
  `mut.py`, `real.js`). All their rigs are down.
