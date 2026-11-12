# Report: p8-load2 (fix round for p8-load after the p8-loadv FAIL)

**Status: done. All 3 MEDIUM and all 10 LOW findings are fixed, plus one new bug (`drainMs`); 39 of 39 mutations
are caught; gates green.**

- **Calibration corrected (MEDIUM 1):** the "105 writers collapses (12 s)" claim is withdrawn. On the committed
  server, 105 writers sits around the 1 s viewer line: p99 0.72–1.32 s in 7 runs (the verifier's 3 and 4 of
  mine), and 3.4 s in an 8th.
- **Where degradation starts, reproduced:** around 105 writers at 5,000 clients, and clear by 125 (p99 8.5 s and
  12.4 s in 2 runs). 150 writers collapsed twice (p99 18–20 s, 5 resyncs each); 200 reached 25 s with 189
  resyncs. The machine was busy (load average 4–15), so the exact edge is not pinned down.
- **New bug found and fixed:** `ops.drainMs` was the sum over workers (6× the real drain with `--procs 6`), in
  every calibration `result.json` too. It is now the slowest worker's drain.
- **Tests:** 12 new tests in `test/load/counting.test.js`. They run against a scripted fake server
  (`test/load/fake-server.js`) and the worker's real samplers. `bun test test/load` gives 20 pass, 3 times.
- **No new `scripts/load` file,** so t187 has nothing to add to COMPOSITION_ROOTS. The fake server lives under
  `test/load/`.

Scope: my files only (`scripts/load/*`, `test/load/*`, `docs/m2/load/*`, and a correction section appended to
`docs/m2/reports/p8-load.md`). Nothing committed.
- **Where things ran:** all mutations and load runs ran in a `cp -R` copy at
  `/private/tmp/claude-501/-Users-r-repos-plenary/a99c25cf-9818-41bd-8912-be553b6e7147/scratchpad/plenary`.
  Its `server/` and `packages/` match HEAD `15210d3`.
- **Real tree:** the only run there was `test/architecture.test.js`.

## Findings: change, guarding test, mutation

All mutations come from the verifier's `mutate.js`, plus N1–N10 (mine). Each was applied alone, then
`bun test test/load` was run and the file restored. Full output:
`/private/tmp/claude-501/-Users-r-repos-plenary/a99c25cf-9818-41bd-8912-be553b6e7147/scratchpad/mutations.txt`.
Script: `/private/tmp/claude-501/-Users-r-repos-plenary/a99c25cf-9818-41bd-8912-be553b6e7147/scratchpad/mutate.js`.

| # | Change | Guarding test (`counting.test.js` unless noted) | Mutations: result |
|---|---|---|---|
| 1 MED | README and p8-load report corrected (below) | – (docs and runs) | – |
| 2 MED | none needed in the samplers; tests now drive them | "a worker whose event loop stalls…": `runWorker` in-process, the test blocks 160 ms then idles 240 ms (40% busy), and only the lag reason must appear. "a worker pinned during the load phase only…": 2 s idle, then 4 s burned in 25 ms slices, and only the CPU reason must appear. "a quiet worker…" is the control | V11 CAUGHT, V12 CAUGHT, M10 and M11 CAUGHT |
| 3 MED | none needed in the client; now tested | "a dropped writer reconnects once…": a `LoadClient` against the fake. The server drops the connection on an op's first copy and applies the resend. Exact counts: connects 2, welcomes 2, joined 1, rejoins 1, reconnects 1, opsSent 1, acks 1, echoes 1. The server saw the same op id twice | V1, V4, V13 CAUGHT |
| 4 LOW | none needed; now tested | "the drain waits out an ack held…": `runWorker` against the fake. The editor's acks arrive 800 ms after its entries; the annotator's never arrive. Asserts acks = editor ops, unacked = annotator ops, and a full drain | M12, V10 CAUGHT |
| 5 LOW | none needed; now tested | "entries a client catches up on…": 2 catch-up entries give 0 delivery samples; 1 live entry gives 1 | V5 CAUGHT |
| 6 LOW | `fdCheck` takes injectable limits (`readFdLimits()`). The message now says "one process may open at most N here (the lower of ulimit -Hn … and kern.maxfilesperproc …)", not "the hard limit" | "fdCheck refuses…": stubbed limits, plus this machine's real ones | V7 CAUGHT, N10 CAUGHT |
| 7 LOW | **Rule:** a run is good only if it is valid **and** complete. Complete means every planned client got a welcome at least once (`result.clients.complete`). The headline reads INVALID, then INCOMPLETE ("k of n planned clients never joined"), then VALID. Exit codes: 0 good, 1 finished but not good, 2 bad arguments or setup. This is documented in the `run.js` header and `--help` | "headline and exit code…" (unit); "live CLI: a URL nobody answers…" (exit 1, INCOMPLETE headline) | N2, N3 CAUGHT |
| 8 LOW | The worker returns `cpuLoad`: the samples wholly inside [ramp end, generation end]. `cpuPct.mean` (what validity checks) is the load-phase mean; `meanAllPhases` is kept alongside it. A run too short to hold a whole sample falls back to all samples | the "pinned during the load phase" test: its all-phase mean is < 85% and its load mean is > 85% | N1 CAUGHT |
| 9 LOW | `--ramp` must be > 0, checked before anything starts | "arguments…" | N4 CAUGHT |
| 10 LOW | Counts must be whole numbers: editors, annotators, viewers, clients, procs (≥ 1), pool (≥ 1) and viewers-per-user (≥ 1). Rates and seconds stay real numbers. A run with 0 clients is refused | "arguments…" | N5 CAUGHT |
| 11 LOW | `createBoard` echoes the server's `error` only if it looks like a code (`^[a-z_-]{1,40}$`) | "createBoard: a refused POST…" | N9 CAUGHT |
| 12 LOW | On Linux, `fdCheck` also reads `fs.nr_open` (`/proc/sys/fs/nr_open`). Untested on Linux | covered by N10 on macOS only | – |
| new | `mergeResults` reports `drainMs` as the slowest worker's, not the sum (seen in run `k125b`: 41 s from 6 drains of ~7 s) | "merge: two workers…" (`load.test.js`): 700 and 900 merge to 900 | N11 CAUGHT |
| 13 LOW | `--local --tokens` reads the file before starting the server, and the error names only the path. The parser's message is dropped, because it quoted file text. `startServer` stops waiting at the server's "PLENARY_DEV_TOKENS …" log line and reports it, instead of timing out after 20 s | "a bad tokens file fails at once…": an array file and a truncated file both fail in under 3 s, and `startServer` fails in under 10 s. No token text appears in any message | N6, N7, N8 CAUGHT |

**Every mutation result:** 39 of 39 CAUGHT. That is M1–M14 and V1–V14 from p8-loadv, plus N1–N11 (N11 was run
alone after the `drainMs` fix; the other 38 ran as one batch before it, and the fix touched only `mergeResults`
and the merge test). No pattern was SKIPPED: I kept the verifier's target lines byte-identical.

One thing the new validation caught live: my first 150/200 loop passed `--annotators --viewers` by a shell
mistake, and the run refused it ("--annotators must be a whole number ≥ 0: --viewers") instead of running.

## The new runs (MEDIUM 1)

- **Command:** `bun scripts/load/run.js --local --editors 5 --annotators A --viewers 5000-5-A --ramp 500
  --duration 20 --drain 15 --procs 6`, on HEAD `15210d3` in the copy.
- **Machine:** M2 Max, 12 cores. Load average (1-minute) was 4.1 before the first run and 14.8 before the last.
  Other sessions were busy: Herdr at ~100% of a core and a VM at ~50%.
- **Full table:** `docs/m2/load/2026-11-12-calibration/README.md`, "Re-runs on the committed server". The
  folders are under `…/p8-load2/` (`result.json` and `report.md` only). I grepped each run's tokens against its
  folder: none found.

| Writers | Runs | Viewer p99 | Resyncs | Generator |
|---|---|---|---|---|
| 105 | 5 | 1.32, 0.85, 1.13, 1.16, 3.4 s (the last right after a degraded 125) | 0 | valid (lag p99 ≤ 18 ms, load-phase CPU ≤ 68%) |
| 125 | 2 | 8.5, 12.4 s | 0, 6 | valid |
| 150 | 2 | 20.0, 17.7 s | 5, 5 | valid |
| 200 | 1 | 25.2 s | 189 | valid |

- **What the runs show:**
  - **105 writers is around the 1 s line, not over a cliff,** and noisy on a busy machine.
  - **Degradation is clear by 125 writers,** in both runs; 150 collapsed twice the same way.
  - **Server CPU stayed at a 55–81% mean (91–97% max) in every run,** so the cause is not diagnosed.
  - **No op was lost:** every op sent was acked. In `k125b`, one acked op's echo had not reached its client
    (which was resyncing) when the drain ended.
- **README changes:**
  - Corrected header note.
  - The two old folders are labelled "degraded, not reproduced".
  - The engine suspects and the "load × fan-out" and "presence is the larger share" claims are marked as
    resting only on those two runs.
  - Editor ack p99 over 150 ms at 5,000 clients is kept as a real finding.
- **Engram:** an earlier session stored the stale knee claim. I ingested a correction (see Housekeeping).

## Gates

- **`bun test test/load` in the copy, 3 times (after the last code change):** 20 pass, 0 fail each time (28.1 s,
  27.9 s, 27.7 s).
- **Full `bun test` in the copy, once:** 1,436 pass, 153 skip, 0 fail (1,589 tests, 84 files, 211 s).
- **`bun test test/architecture.test.js` in the real tree:** 16 pass, 0 fail.
- **Files in sync:** after the gate, `scripts/load/*.js` and `test/load/*.js` were copied back to the real tree,
  and `diff -r` against the copy was clean.

## Not verified / risks

- **Timing in the sampler tests:** they burn the test process's own CPU.
  - **CPU test:** needs > 85% of a core over 3 or more whole 1 s samples. A heavily loaded machine could starve
    it, which would show as a false failure, never a false pass. It passed 3 of 3 gate runs plus the 38
    mutation runs at load average 4–9.
  - **Lag test:** must stay under 85% CPU while blocking 160 ms of every 240 ms.
- **Not done:** the knee on a quiet machine, a finer step between 105 and 125, and a server profile at the knee.
- **Live rig:** `--rig` against a live rig is still untested (as in p8-load).
- **Linux:** `fs.nr_open` is untested.

## Design skill

I did not apply distributed-systems-design: this job is a test tool's measurement and test fixes, not part of the
system's design (the verifier made the same call). I checked the measurement design directly: what each counter
counts, the load-phase window, and the drain.

## For t187

- **`docs/m2/reports/p8-load.md`:** I struck the withdrawn claims in place (summary bullet, plus a note at the top
  of its Calibration section) and appended a "Correction" section.
- **Nothing for COMPOSITION_ROOTS:** no new file under `scripts/load/`.

## Housekeeping

- **Processes:** I started only the `--local` servers and workers. A `ps` after the last run and the full suite
  shows none left from my copy. Running at that time, not mine and left alone: `scripts/load/run.js` and 2 workers
  from the real tree under Bun 1.3.14 (PIDs 69704, 69713, 69714), probably another session's test run.
- **One `server/main.js` was running from the real tree** (PID 49733, Bun 1.3.14). It is not mine, and I left it
  alone.
- **nats-server:** 53168 and 62656 untouched.
- **Engram:** correction ingested for the stale "105 writers collapses / knee is load × fan-out" memory.
