# Report: p8-load3 (fix the LOWs left by verifier p8-load2v)

**Status: done. All 10 findings are fixed. 75 of 81 mutation runs are CAUGHT: every fix's guard, plus all 39 of
p8-load2v's named mutations. The 6 survivors are 4 known from p8-load2v, 1 equivalent and 1 that I guarded and
re-ran CAUGHT. Gates are green. Nothing is committed.**

- **Copy:** `git archive 448ca84` plus `node_modules`, at
  `/private/tmp/claude-501/-Users-r-repos-plenary/457170b9-63d0-4f2e-9e05-09e5e42b722c/scratchpad/base`.
  - **No `.env`:** `find <scratchpad> -name .env` was empty before the runs and at the end.
  - **Every run:** used `TMPDIR` in the scratchpad.
- **Base:** 448ca84. My files in the real tree were clean against it at the start, and still clean just before the
  sync.
- **Synced to the real tree:** `scripts/load/{run,server,tokens,worker}.js` and
  `test/load/{counting,load}.test.js`. New: `test/load/guards.test.js`. `diff -r` of copy against real tree: clean.
- **Docs:**
  - `docs/m2/load/2026-11-12-calibration/README.md`. The brief's `docs/m2/load/README.md` does not exist; this is
    the only README there.
  - A correction note at the top of `docs/m2/reports/p8-load2.md`.
- **Distributed-systems-design:** not applied. This job is the load tool's measurement and its tests, not system
  design (the same call as p8-load2 and p8-load2v).

## Findings, changes and guards

| # | Change | Guarding test | Mutation (applied alone) |
|---|---|---|---|
| 2 | New `readTokensTable` in `tokens.js` is the one parser of a tokens file: path-only errors. `createBoard` and `readTokensByRole` both use it | `guards`: "createBoard: a tokens file that is not JSON…". Files `ltSECRETbare999 and more` and `MYSECRETVAR='lt-abc'`: direct call and CLI. Exit 2; none of `ltSECRET`, `SECRET`, `bare999`, `more`, `MYSECRETVAR`, `lt-abc` in stdout or stderr | G2 (bare `JSON.parse` back) CAUGHT |
| 3 | **Rule:** a run is complete only if every planned client joined **and** the ops were answered: every op sent acked by the drain's end, and ≥ 99% echoed to the sender (integer math). No ops sent passes. New fields: `result.complete`, `result.ops.answered`. Headline: `INCOMPLETE (N of M ops sent were never acked; …)`, exit 1. Documented in the README ("What the headline means") and the `--help` header | `guards`: "answered: …" (6 cases at the boundaries); "live CLI: a server that welcomes everyone and swallows every op…" (fake server, exit 1) | G3a (acks ignored), G3b (echo floor ignored), G3c (`complete` ignores ops), G3d (headline ignores ops): all CAUGHT |
| 4 | `run()` tracks every child it starts: the server from the moment it is spawned (new `startServer({ onChild })`), and each worker. A `finally` stops them on any setup failure (failed `createBoard`, no board, a failed worker). The CLI passes `signals: true`: on SIGTERM, SIGINT or SIGHUP it stops the children (SIGTERM, then SIGKILL after 5 s) and exits 2. Workers also exit if orphaned (their ppid changes) | `guards`: "a setup failure after the --local server started stops the server"; "SIGTERM / SIGINT / SIGHUP to a --local run stops its server and workers, then exits 2" (3 tests: server + 2 worker PIDs, all gone after exit) | G4a (`finally` stops nothing), G4b (no handlers), G4c (handler skips children), G4d (no SIGHUP), G4e (workers untracked), G4f (signal exits 1): all CAUGHT |
| 5 | `--ramp` must be ≥ 1 client/s. Also `--duration` ≥ 1 s, so the load phase is always measurable (see 8) | `guards`: "arguments: a ramp under 1 client/s…" (0.0001, 0.5 refused; 1 accepted); `counting`: "--ramp 0…" (new message) | N4 retargeted, G5, G5b: CAUGHT |
| 6 | An empty or blank value (`""`, `" "`) is refused for counts and numbers: `--editors is empty` | `guards`: "arguments…" (`--editors ""`, `" "`, `--viewers ""`, `--drain ""`) | G6a, G6b CAUGHT |
| 7 | (tests only) | `guards`: "exit code 2: …". CLI `--editors` (no value) and `oops` give 2 on the parse path; `--editors ""` and `--ramp 0.0001` give 2 on the setup path, with no server started | X6, X7 CAUGHT (finding 2's CLI test also fails under X6) |
| 8 | The worker measures load-phase CPU exactly: process CPU time at a mark at `loadFrom` and at `genEndAt`, over the wall time between the marks (`cpuLoadMean`, `cpuLoadMs`). Validity is judged on that. **A load phase under 500 ms, or none, means CPU unmeasured, which makes the run INVALID** with the reason "CPU over the load phase not measured". The 1 s samples stay for the record. The `--local` server also reports `server.cpuPct.loadMean` | `guards`: "a load phase shorter than one CPU sample, burned, is still measured and flagged" (the verifier's 0.9 s repro: now INVALID); "CPU burned in the drain is not the load phase's; a load phase with no measurement is not VALID"; `load`: live 2-worker test checks each worker's `loadMs` is 2.5–3.25 s (the load phase, not from t0) | L1, L3 retargeted: CAUGHT. L2, L4, M11, N1 retargeted: CAUGHT. G8a (500 ms minimum ignored) CAUGHT. G8c (run.js passes no `loadFrom`): NOT CAUGHT in the batch; I added the live `loadMs` bound, and the re-run is CAUGHT |
| 9 | Merge test: the slowest worker first, plus the reverse order. Drain test: `drainMs` < drain + 1 s | `load`: "merge: two workers…"; `counting`: "the drain waits out an ack…" | D1, D3, D4 CAUGHT (D2 too) |
| 1, 10 | README: 125 writers 1.8–12.4 s over 4 runs, each with its load average. Server CPU over the load phase, recomputed from every `result.json`'s `cpuSeries` (seconds 11.5–31.5), as a new column and in the knee bullet; also for the first table's folders. The `drainMs` note names every folder, all ten `p8-load2/` runs included. p8-load2.md: a correction note (125 range, 14.8 vs 10.4 load-average slip, whole-run vs load-phase CPU, `drainMs` folders) | – (docs) | – |

**Load-phase server CPU, recomputed:**

- **Writer steps:** 105 writers 88–93% (5 runs); 125 writers 90% and 73%; 150 writers 82% and 85%; 200 writers 75%.
- **Agreement:** within 2 points of p8-load2v's figures for the same window.
- **The hedge stands:** the degraded runs used less CPU than the healthy ones.

## Mutations

- **Script:** `…/scratchpad/mutate.js`, in the scratchpad above. It is p8-load2v's script, byte-identical
  mutations, plus mine.
  - **Retargeted:** 9 mutations whose code my fixes moved, each marked `[retargeted]`: M11, N1, N3, N4, X4,
    L1–L4. Same intent, new text.
  - **Pre-flight:** every pattern was found exactly once, so there were 0 SKIPs.
- **Output:** `…/scratchpad/mutations.txt`. The batch restored the tree each time; the final diff against the
  snapshot was clean.
- **p8-load2v's 39 named mutations (M1–M14, V1–V14, N1–N11):** 39 of 39 CAUGHT.
- **p8-load2v's own:**
  - **CAUGHT:** X1, X3–X8, D1–D4, L1–L4.
  - **Not caught, as before:** X2 (equivalent), R1 (the LOW rejoin gap they noted), R2 (near-equivalent), T1
    (harmless).
- **Mine:**
  - **CAUGHT:** G2, G3a–d, G4a–f, G5, G5b, G6a, G6b and G8a.
  - **G8b, equivalent:** with the "already past" branch removed, the `setTimeout(…, ≤0)` branch takes the same
    mark a tick later.
  - **G8c:** guarded after the batch, CAUGHT on re-run.
- **Totals:** batch 70 of 76 CAUGHT. After the G8c guard and the integer echo floor, G3a–d and G8c were re-run:
  all CAUGHT.

## Gates

- **`bun test test/load` in my copy, 3 times, after the last change:** 31 pass, 0 fail each time (40.0 s, 39.9 s,
  40.0 s).
- **`bun test test/architecture.test.js` in the real tree (read-only):** 16 pass, 0 fail. I ran it before the sync
  and after it.
- **`.env`:** `find <scratchpad> -name .env` is empty at the end.
- **Processes:**
  - **Before:** nats-servers 75407 and 85354, and `server/main.js` 45599 from the real tree. None are mine; I left
    them alone.
  - **After:** nats-servers 2251 and 85354, not mine. Nothing from my scratchpad.

## Not verified, risks

- **Signal during `startServer`:** a signal in the ≤ 20 s between spawn and "listening" is covered by `onChild`,
  by reading only. It is not tested.
- **SIGKILL to `run.js`:** workers exit within 1 s via the ppid watch, but the server cannot be reached (its
  `server/main.js` is not mine). Untested.
- **Housekeeping, mutation-only orphans:** under mutation G5 (ramp floor lowered), two argument tests start a real
  `--local` run with an hours-long ramp. They hit bun's 5 s timeout and leave the in-process run's server behind.
  - **What I did:** I found two (PIDs 86534 and 87057, my copy, started 16:55) and stopped them by PID.
  - **Scope:** this happens only when that guard is broken, never in the gate.
  - **For the next verifier:** run `ps` after a batch.
- **Live rig:** not run (`--rig`, `--rig --create-board`). Same as before.
- **Breaking change to `result.json`:**
  - **Changed:** `generator.workers[].cpuPct.mean` is now the exact load-phase mean, and null when unmeasured.
  - **Added:** `complete`, `ops.answered`, `cpuPct.loadMs` and `server.cpuPct.loadMean`.
  - **Readers:** none outside `scripts/load`, by grep.
- **Behaviour change:** `--duration` under 1 s is now refused, where 0 was allowed before.

## For t187

- Nothing outside my files needs changing.
- **Not mine, for your attention:** an automated security review saw `server/gateway.js` with its `hello-tab` check
  disabled (`if (false) return badFrame(ws, "hello-tab", …)`). I never touched that file.
  - **Now:** line 886 has the check back (`msg.tab !== undefined && !isTab(msg.tab)`), and the file is modified
    against HEAD.
  - **Likely cause:** another session ran a mutation in the real tree rather than in a copy.
  - **Asks:** check who, and diff `server/gateway.js` before committing.
