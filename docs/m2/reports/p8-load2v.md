# Report: p8-load2v (verify p8-load2, the load client fix round)

**Verdict: PASS with LOWs (round 2). The 3 MEDIUMs are closed: all 39 named mutations are caught, each by the test
built for it. The tests drive the real samplers and counting paths. The calibration now says what was measured,
within noise. 10 LOW findings remain; one is a secret that can be quoted on a malformed-file error path (finding 2).**

- **MEDIUM 2/3 closed:**
  - **Real code under test:** the new tests run the real `LoadClient` and `runWorker` (with their own lag and CPU
    samplers) against a scripted fake server. Nothing under test is stubbed.
  - **Mutations:** V1, V4, V5, V7, V10–V13, M12 and N1–N11 each fail their guard test.
  - **Gate:** `bun test test/load` passed 3 times, 20 of 20 each time.
- **MEDIUM 1 closed, with a widened range (LOW):** I re-ran 105 writers once and 125 writers twice.
  - **105 writers:** p99 0.80 s, inside the README's 0.72–1.32 s.
  - **125 writers:** p99 1.78 s and 3.54 s, with 0 resyncs. The README's two runs gave 8.5 s and 12.4 s. All 4 are
    over the 1 s line, so "degradation clear by 125" holds, but the magnitude at 125 is 1.8–12.4 s, not 8.5–12.4 s.
- **New LOWs, worth fixing:**
  - **A secret can be quoted in an error.** `--create-board` parses the tokens file at a second site that still
    passes the JSON parser's message through (finding 2).
  - **VALID with 0 acks.** A run where no op was ever acked headlines VALID and exits 0 (finding 3).
  - **Server left running.** A setup failure, or SIGTERM, leaves the `--local` server running (finding 4).
- **Housekeeping problem:** my first scratch copies included the repo's `.env`, and two of them were handed to the
  codex and grok review harnesses. The same pattern appears in 38 other copies, from other sessions. See
  Housekeeping.

Scope: verifier only. I edited no code and committed nothing. All mutations and load runs ran in copies under my
scratchpad, never in `/Users/r/repos/plenary`. The real tree got one read-only run: `test/architecture.test.js`.
Distributed-systems-design CHECKER mode was not applied. This job is a test tool's measurement, not system design
(the same call as p8-loadv). I checked the measurement design directly: the sampling windows, the merge and the
exit rule.

## Findings

| # | Grade | Finding | Where | Repro |
|---|---|---|---|---|
| 1 | LOW | Calibration: the 125-writer range is wider than the README says, and server CPU is quoted as a whole-run mean (detail below) | README "The knee" bullet and re-run table; `docs/m2/reports/p8-load.md:291-293`; `docs/m2/reports/p8-load2.md:9-11,75-77` | My `k125` and `k125b` (below) |
| 2 | LOW | `createBoard` still parses the tokens file with bare `JSON.parse`, and the error carries the parser's message. Finding 13's rule ("the parser's message can quote the file's text") was applied in `readTokensByRole` but not here. This parse runs before `readTokensByRole` (`run.js:298` vs `:302`) | `scripts/load/run.js:237` | A file whose text starts with a bare identifier-shaped secret (`ltSECRETbare999`): `run.js --url ws://127.0.0.1:1/ws --create-board --tokens <file> --editors 1` prints `load: JSON Parse error: Unexpected identifier "<the secret>"`, exit 2. A real `lt-…` token leaks only `lt`, because the parser stops at `-`. A `.env`-shaped file leaks only the variable name. `--rig … --create-board` takes the same code path (by reading, not run). `--local --create-board` is clean, because the safe precheck at `:292` runs first |
| 3 | LOW | Finding 7's rule counts joins only. A run where every client joined but no op was ever acked or echoed headlines **VALID** and exits 0. Once the gate is a CI check, a server that welcomes everyone and then stalls would pass it | `scripts/load/run.js:160,194,197-201` | A fake server that swallows ops (scratchpad `noack.js`): `exit 0 \| **VALID** · 1/1 clients joined · 0/6 ops echoed`, `unacked 6` |
| 4 | LOW (codex, confirmed) | Two ways to leave the `--local` server running. (a) A setup error after `startServer`, before the `try` (a failed `createBoard`, or no board), skips `server.stop()`; the server keeps running on loopback with dev tokens on, reparented to PID 1. (b) SIGTERM to `run.js` orphans its server and workers: there is no signal handler | `scripts/load/run.js:293-301` | (a) `run.js --local --create-board --tokens <file with no admin> --editors 1`: exit 2; server PID 52390 stayed up on 127.0.0.1. (b) `kill -TERM` on a running `run.js` left server 59687 and worker 59691 with ppid 1. I stopped all of them |
| 5 | LOW | Finding 9 is half fixed: a tiny positive ramp still sleeps for hours | `scripts/load/run.js:81,304` | `--editors 1 --ramp 0.0001` plans "ramp 10000000 ms" (2.8 h) and waits |
| 6 | LOW | Finding 10 edge: an empty count reads as 0 (`Number("") === 0`) | `scripts/load/run.js:80` | `--editors "" --viewers 1`: plan "0 editors", VALID, exit 0 |
| 7 | LOW | Exit code 2 (bad arguments or setup) is documented but untested: X6 and X7 survive. Live it works: every setup and argument error I hit exited 2 | `scripts/load/run.js:346,352` | Mutations below |
| 8 | LOW | Load-phase CPU blind spot. A load phase too short to contain a whole 1 s sample falls back to all samples (documented). Live, the pinned window was not sampled at all, because the worker returns before the next sample. L1 (drain samples in the window) and L3 (no fallback) both survive | `scripts/load/worker.js:83`, `scripts/load/run.js:136` | `runWorker` with a 0.9 s load phase burned at 100% of a core (scratchpad `shortload.js`): samples `0.4 0.3 5.1`, `cpuLoad` empty, judged mean 1.9%, `valid: true` |
| 9 | LOW | `drainMs` merge: "last worker wins" survives, because the test's slowest worker is also its last (D1). `drainMs` measured from t0 also survives (D4): the drain test checks only a lower bound | `test/load/load.test.js:50-56`, `test/load/counting.test.js:96` | Mutations below |
| 10 | LOW | Docs slips. (a) The p8-load2 report says load average "14.8 before the last" run; 14.8 was before `k125`, and the last run (`k105e`) had 10.4. (b) The README header says `drainMs` is summed in "every result.json here". That is true of the `p8-load2/` runs too (`k200` shows 78 s against a 15 s cap), but only the old folders are named | `docs/m2/reports/p8-load2.md:61`; README header | – |

### Finding 1 in detail

**My runs.** All in a clean copy at HEAD `15210d3`; its `scripts/load` and `server/` diff clean against the real
tree. Run one after another, with nothing else of mine running. Command: `run.js --local --editors 5 --annotators A
--viewers 5000-5-A --ramp 500 --duration 20 --drain 15 --procs 6`.

| Run | Writers | Load avg before (1/5/15 min) | Result | Echoed | Resyncs | Editor ack p99 | Viewer delivery p50 / p99 / max | Gen lag p99 / load CPU (worst worker) | Server CPU mean / max | Server CPU, load phase* |
|---|---|---|---|---|---|---|---|---|---|---|
| k105 | 105 | 4.11 / 5.36 / 5.72 | VALID, exit 0 | 973/973 | 0 | 665 ms | 272 / **802** / 939 ms | 10 ms / 68% | 79.5% / 95% | 92% |
| k125 | 125 | 9.56 / 6.58 / 6.15 | VALID, exit 0 | 1,096/1,096 | 0 | 2,248 ms | 686 / **1,784** / 2,677 ms | 11 ms / 67% | 82.5% / 96% | 93% |
| k125b | 125 | 4.48 / 5.46 / 5.78 | VALID, exit 0 | 1,093/1,093 | 0 | 4,748 ms | 675 / **3,539** / 4,920 ms | 12 ms / 66% | 80.1% / 95% | 90% |

\* The mean of `server.cpuSeries` over seconds 12–31: after the 10 s ramp plus the 1.5 s start, for the 20 s of load.

- **105 agrees** with the README's range: 0.80 s is inside 0.72–1.32 s.
- **125 is over the line in all 4 runs**, but with a wider magnitude: 1.8, 3.5, 8.5 and 12.4 s. The resyncs at 125
  (6) came in only 1 of the 4 runs.
- **Suggested README wording:** "125 writers: viewer p99 1.8–12.4 s in 4 runs (2 by p8-load2v), resyncs in 1".
- **Server CPU through the load phase**, same window, for the builder's runs:
  - **105 writers:** 89–92%.
  - **125 writers:** 90% (`k125`) and 72% (`k125b`).
  - **150 writers:** 84% and 86%.
  - **200 writers:** 76%.
- **What that says:**
  - **The README's whole-run means (55–81%) understate the load phase:** they include the idle first seconds of the
    ramp (7–65%).
  - **But the most degraded runs used *less* CPU than the healthy 105 runs,** so the README's hedge ("not simply
    pinned … not diagnosed") stands.
  - **Suggestion:** quote load-phase server CPU, not the whole-run mean.

**Checked and correct.** Every number in the README's re-run table matches its `result.json`:

- valid and complete, 5,000/5,000 joined;
- sent equals acked in all 10 runs;
- resyncs, ack p99 and delivery p99;
- generator lag and load-phase CPU;
- server CPU mean and max.

The "7 runs plus an 8th" count at 105 writers is right. The withdrawn claims are struck in `p8-load.md`, and the
old folders are labelled "degraded, not reproduced". Raw files:
`/private/tmp/claude-501/-Users-r-repos-plenary/4838b8ed-493c-4cad-b6ef-110ae4200d78/scratchpad/runs/{k105,k125,k125b}/result.json`.

## Mutations

Each mutation was applied alone in my copy, then `bun test test/load` was run and the file restored. After the
batch, the copy's `scripts/load` and `test/load` diffed clean against the real tree.

- **Script:** `/private/tmp/claude-501/-Users-r-repos-plenary/4838b8ed-493c-4cad-b6ef-110ae4200d78/scratchpad/mutate.js`.
  It holds the builder's 39 mutations, byte-identical, plus my X, D, L, R and T mutations.
- **Output:** `…/scratchpad/mutations.txt`, in the same scratchpad.
- **Load average:** 5–6 during the batch.

**Named in the brief, all CAUGHT, each by its own guard test (no SKIP):**

| Mutation | Failing test |
|---|---|
| V1, V4, V13 | "a dropped writer reconnects once…" |
| V5 | "entries a client catches up on…" |
| V7, N10 | "fdCheck refuses…" |
| V10, M12 | "the drain waits out an ack held…" |
| V11, M10 | "a worker whose event loop stalls…" |
| V12, M11, N1 | "a worker pinned during the load phase only…" |
| N2, N3 | "headline and exit code…" + "live CLI: a URL nobody answers…" |
| N4, N5 | "arguments…" |
| N6, N7, N8 | "a bad tokens file fails at once…" |
| N9 | "createBoard: a refused POST…" |
| N11 | "merge: two workers…" |

M1–M9, M13, M14, V2, V3, V6, V8, V9 and V14 were also CAUGHT. In total, 39 of 39.

**Mine (the exit rule, the `drainMs` merge, the load window, rejoin):**

| Mutation | Result | Note |
|---|---|---|
| X1 complete = anyone joined | CAUGHT | |
| X2 complete drops `joined === planned` | NOT CAUGHT | Equivalent: `neverJoined === 0` already implies all joined |
| X3 headline INCOMPLETE before INVALID | CAUGHT | |
| X4 exitCode ignores complete | CAUGHT | |
| X5 CLI always exits 0 | CAUGHT | |
| X6 setup error exits 1, not 2 | **NOT CAUGHT** | Finding 7 |
| X7 bad-argument parse exits 1, not 2 | **NOT CAUGHT** | Finding 7 |
| X8 INCOMPLETE count off by one | CAUGHT | |
| D1 `drainMs`: last worker wins | **NOT CAUGHT** | Finding 9 |
| D2 `drainMs`: min | CAUGHT | |
| D3 `drainMs`: first worker wins | CAUGHT | |
| D4 `drainMs` measured from t0 | **NOT CAUGHT** | Finding 9 |
| L1 load window includes drain samples | **NOT CAUGHT** | Finding 8 |
| L2 load window includes ramp samples | CAUGHT | |
| L3 no fallback when the load window is empty | **NOT CAUGHT** | Finding 8 |
| L4 validity judged on the all-phase mean | CAUGHT | |
| R1 `liveFrom` kept from the first welcome on rejoin | **NOT CAUGHT** | LOW gap: catch-up after a rejoin would count as delivery |
| R2 an ack counted again if repeated | NOT CAUGHT | Near-equivalent: the server never repeats an ack |
| T1 tokens: ENOENT message replaced | NOT CAUGHT | Harmless: both messages carry the path only |

## LOW fixes, one breaking input each (all run in the clean copy unless marked)

| Fix | Input | Result |
|---|---|---|
| `--ramp 0` refused | `--ramp 0.0001` | Accepted; plans a 2.8 h ramp (finding 5) |
| Fractional counts refused | `--editors 1e400`, `--editors 1.5` | Refused, exit 2. But `--editors ""` reads as 0 (finding 6) |
| Tokens-file error | `.env` as `--tokens`; truncated, array, unquoted-key, bare-token and `.env`-shaped files | `--url` and `--local`: path only. `--url --create-board`: parser text, which can quote an identifier-shaped secret (finding 2) |
| CPU over the load phase only | 0.9 s load phase, burned | `valid: true`, judged mean 1.9% (finding 8) |
| Exit codes 0/1/2 | bad argument; setup error; dead URL | 2, 2, 1. Code 2 is untested (finding 7) |
| Headline INVALID/INCOMPLETE/VALID | dead URL (closed port); joins fine but 0 acks | INCOMPLETE, exit 1 (correct); VALID, exit 0 (finding 3) |
| fdCheck wording | `fdCheck(1e12)` (the test) | "one process may open at most N here (the lower of …)": correct |

## Secrets

- **My three 5,000-client runs:** clean. Every token of each run (259, 279 and 279 tokens) was grepped against
  `result.json`, `report.md`, `server.log` and the console log: 0 hits.
- **Dead-URL and no-ack runs:** no token in stdout, stderr, `result.json` or `report.md`.
- **The real `.env` passed as `--tokens`:** its 3 values were grepped (never printed) against stdout and stderr on
  3 paths: 0 hits. Each exited 2 with a path-only message, except the `--create-board` variant, which quoted only
  the variable name. This was run in the first copy, outside the mutation window for `createBoard`.
- **The one leak:** finding 2.

## Gates

- **`bun test test/load` in my copy, 3 times before the mutations:** 20 pass, 0 fail each time (27.8 s, 28.2 s and
  27.7 s).
- **`bun test test/architecture.test.js` in the real tree, read-only:** 16 pass, 0 fail.

## Ensemble review (sdd)

- **Adapters:** codex and grok both passed `check_adapter`. Each reviewed its own copy (`rev-codex`, `rev-grok`).
- **codex (effort high):** 2 MEDIUM; I graded both LOW after checking.
  - **Empty load-window fallback:** documented by the builder, and confirmed live as finding 8.
  - **Server left running after a setup failure:** confirmed live as finding 4. It listens on loopback only.
  - **Secret paths:** it reported none, so it missed finding 2.
- **grok:** "CLEAN, no findings". It calls `run.js:237` a "safe parse", which finding 2 refutes.
- **Agreement:** no HIGH candidate.

## Not verified

- **Live rig:** `--rig` against a live rig, including the `--rig --create-board` leak path (by reading only).
- **Linux:** the `fs.nr_open` limit.
- **Quiet machine:** the knee. The load average was 4–10 during my runs.
- **Exit 1 for an INVALID run:** live only in the test, not the CLI.
- **The `.env` copies:** whether the codex or grok harness opened the `.env` copy in its review directory.
- **Order of the first probes:** they ran in the first copy while mutations M1–M5 were applied. Every finding above
  was re-run in a second, clean copy (`scratchpad/clean`), except the real-`.env` check.

## Housekeeping

- **`.env` was copied into my scratch copies.**
  - **What happened:** my first `rsync` copies did not exclude `.env`. A copy of the real `.env` sat, mode 600, in
    three of them: `scratchpad/plenary`, `rev-codex` and `rev-grok`. It holds 3 values, including the Google OAuth
    client values. The codex and grok review harnesses ran in the last two.
  - **Did they read it?** Neither review quotes or mentions a value. I can't prove either did not open the file.
  - **Cleanup:** I deleted all 3 copies when I found them. Later copies exclude `.env`.
- **The same pattern is team-wide (for t187).**
  - **Count:** `find` shows 38 more `.env` copies in other sessions' scratchpads under
    `/private/tmp/claude-501/-Users-r-repos-plenary/`.
  - **Copies handed to harnesses:** the review copies `105aabb2…/rev-codex`, `…/rev-grok`, `…/r2rev-codex`,
    `…/r2rev-grok` and `853a8827…/rev`. I left them alone: not mine.
  - **Suggestion:** OFFICE.md's "copy the repo" step should exclude `.env`. Whether to rotate the Google OAuth client
    secret is the person's call.
- **Processes I started and stopped, all by PID:**
  - **From probes run under `timeout`:** servers 14107 and 15450, workers 14141 and 15453.
  - **From a `--create-board` setup failure:** server 52390.
  - **From the SIGTERM probe:** server 59687 and worker 59691.
- **Final `ps`:** nothing from my scratchpad is running.
- **Not touched:** other sessions' nats-servers (64909, 75685, 81988 and 85354 at the start).
- **Real tree:** the only change is this report. `TMPDIR` pointed at my scratchpad for every run.
- **Engram:** the builder's stored fact says "125 gives 8.5 s". I added a correction with the 4-run range.

## Suggested fixes (LOW, for the next round or the backlog)

1. **Finding 2:** parse the tokens file in `createBoard` through `readTokensByRole`'s safe path.
2. **Finding 4:** move `startServer` inside the `try`, and stop the server and workers on SIGINT and SIGTERM.
3. **Finding 3:** decide whether `acked < sent` after the drain makes a run INCOMPLETE.
4. **Finding 8:** with an empty `cpuLoad`, mark the CPU as unmeasured, or take one last sample at `genEndAt`.
5. **Finding 1:** README: give the 125-writer range as 1.8–12.4 s over 4 runs, and quote load-phase server CPU.
6. **Findings 5, 6, 9:** cap `rampMs` (or refuse a ramp under 1 client/s), refuse an empty count, and reverse the
   merge test's worker order.
