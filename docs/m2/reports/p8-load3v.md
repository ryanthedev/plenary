# Report: p8-load3v (verify p8-load3, fix round 3 for the load client)

**Verdict: FAIL (round 3), on 1 MEDIUM. Finding 3 is only partly closed: a server that welcomes every client and then
stalls (or drops everyone) still headlines VALID and exits 0, because no op ever counts as sent. The README and
`run.js:38-40` say exactly that case "must not read VALID". The other 9 fixes hold under my breaking inputs. 5 new
LOWs.**

- **What holds:**
  - **Secrets:** no secret on any path I tried.
  - **Signals:** SIGTERM, SIGINT and SIGHUP leave nothing running, at every point I tried, including before the
    server is listening.
  - **A failing worker:** stops the server and its sibling worker.
  - **CPU:** judged over the load phase only, and an unmeasured phase is INVALID.
  - **Arguments:** an empty value, `--ramp` under 1 and `--duration` under 1 are all refused with exit 2.
  - **`drainMs` merge:** correct in any worker order.
  - **Docs:** they match the `result.json` files.
- **Mutations:** 19 of 21 CAUGHT. That is 14 of the builder's (G-series plus X6, X7 and L3) and 5 of my 7. My 2
  survivors are real gaps, filed as LOWs 2 and 3.
- **Fix for the MEDIUM (small):** count an op when it is made (`local()`), not when it is first written. Or require
  `ops.unanswered === 0`, plus `sent > 0` whenever writers with a positive op rate were planned.

Scope: verifier only. I edited no code and committed nothing. The real tree got two things: this report and one
read-only `bun test test/architecture.test.js`. Distributed-systems-design CHECKER mode was not applied: this is a
test tool's exit rule and measurement, not system design (the same call as p8-load2v). I checked that rule and the
measurement windows directly.

## Copies

- **`copy`:** an rsync of the working tree (HEAD `9fca849` plus every uncommitted file), `.env` and `.rig` excluded.
  Used for the first probes and the main mutation batch.
- **`head`:** `git archive HEAD` plus only this job's 7 files (`diff -r` against the real tree: same). This is
  "HEAD plus the job", free of other workers' uncommitted `server/` and `packages/protocol/` edits. The MEDIUM, the
  pre-listening signal probe, the empty-`--tokens` probe and the limits probes were re-run here with the same
  results.
- **Paths:** both live in `/private/tmp/claude-501/-Users-r-repos-plenary/7ff487de-a6fe-4d9f-8162-d8694f2f765e/scratchpad/`.
- **`.env`:** `find <scratchpad> -name .env` was empty before every run and at the end. `TMPDIR` pointed at the
  scratchpad for every run.

## Findings

| # | Grade | Finding | Where | Repro |
|---|---|---|---|---|
| 1 | **MEDIUM** | **Welcome-then-stall reads VALID, exit 0.** `opsSent` counts at first write (`client.js:132`). The Replica never writes a new op until catch-up to `welcome.seq` is done (`replica.js` `outgoing()`), and `canWrite` skips ops while offline. So a server that welcomes and then never sends catch-up, or closes everyone and refuses rejoins, yields `sent = 0`, `answered = true`, `complete = true`. `ops.unanswered`, `skippedOffline`/`skippedBacklog` and `connectedAtEnd` are not part of the rule. codex found the same independently (as the `--op-rate 0` / no-ops-sent case) | `scripts/load/run.js:174`; README "What the headline means"; `run.js:38-40` | Scratchpad `probes/stall.js` (welcome with `seq: 100`, nothing after), 3 editors: `exit 0 \| **VALID** · 3/3 clients joined · 0/0 ops echoed`, `unanswered 34`. At `--duration 25`: still VALID, `unanswered 150`, `skippedBacklog 114`, 6 resyncs. `probes/crash.js` (welcome once, close 1013 after 5 ms, refuse every rejoin): VALID, exit 0, `skippedOffline 38`, `connectedAtEnd 0`, 9 closes 1013. All in `head` |
| 2 | LOW | **SIGKILL to `run.js --local` leaves the server running,** reparented to PID 1 on loopback with dev tokens on. The workers exit within about 1 s through their ppid watch. That watch is itself untested: mutation O2 (watch disabled) survives. The builder disclosed this as untested | `scripts/load/server.js:27`, `scripts/load/worker.js:116-117` | `probes/sig.js <copy> SIGKILL startup`: exit 137; server 62588 alive afterwards (I stopped it). The workers were gone |
| 3 | LOW | **`server.cpuPct.loadMean` is untested.** Mutation O4 (it takes every sample, not the load window) survives. The README now quotes load-phase server CPU, so this number feeds the docs | `scripts/load/run.js:382` | Mutation O4 below |
| 4 | LOW | **`--tokens ""` with `--local` is ignored, not refused.** `if (!tokensPath)` treats it as absent, makes fresh tokens and runs (VALID, exit 0). Finding 6's empty-value rule doesn't cover string flags. Found by codex, confirmed live | `scripts/load/run.js:341` | `run.js --local --tokens "" --editors 1 --duration 1 --drain 1`: exit 0, VALID |
| 5 | LOW | **No upper bounds; `Number()` quirks.** `--duration 1e12` plans 31,700 years and waits, and `--drain 1e12` is accepted: the class of finding 5, for the other durations. `--editors 0x1` reads as 1 | `scripts/load/run.js:90-92` | `--duration 1e12`: plan "then 1000000000000 s". `--editors 0x1`: plan "1 editors" |
| 6 | LOW (docs) | **"Same window as below" is wrong for `2000/` and `3500/`.** README "Server CPU": their ramps are 4 s and 7 s, not 10 s. The values still agree: their own load windows give 35.4% and 68.8%, against the README's 35% and 69% | `docs/m2/load/2026-11-12-calibration/README.md` (Server CPU bullet) | Recomputed from `cpuSeries` (below) |

### Checked and holding (breaking inputs beyond the builder's tests)

| Fix | My input | Result |
|---|---|---|
| 2: secret on an error path | 7 tokens files (`{"ltSECRETzz1": 5}`, `null` entry, bad `name`/`role`, non-string `domain` with admin, empty-string token key, a bare JSON string, duplicate keys), each with and without `--create-board`, `--local` | Exit 1 or 2. `SECRET`/`zz1` appear in none of stdout, stderr, `result.json`, `report.md` or `server.log`. `rigConfig`'s bare `JSON.parse` (`run.js:66`) reads `rig.json`, which cluster-rig.js says never holds a secret: not a leak |
| 3: the answered rule | Off-by-one: 990/1000 VALID, 989 INCOMPLETE (tests). `acks` and `echoes` cannot exceed `sent` (guarded by `writeAt`). A healthy `--local` run with `--op-rate 10` and `--drain 0`, and with `--drain 15` | Both VALID: 73/73 and 79/79 acked and echoed. The hole is finding 1 |
| 4: signals | SIGTERM, SIGINT and SIGHUP before "server listening": the window pinned with `serverEnv: { LOG_LEVEL: "error" }`, so the server never logs it (`probes/presig.js`). Also mid-ramp, and mid-drain (a fake server that never acks, `--drain 30`) | Exit 2 and no child left, every time. The pre-listening probe discriminates: under O7 (`onChild` removed) the server survived (PID 6105, stopped) |
| 4: failing worker | SIGKILL one worker mid-run, `--local --procs 2` | `load: worker 0 exited (137) without a result`, exit 2. The server and the other worker were stopped |
| 8: CPU | Unmeasured paths: a null `cpuLoadMean`, a missing field, a timer pinned past `genEndAt` | All give "not measured", INVALID. A live `--duration 2` run: `loadMs` 2000, worker mean 2.8%, `server.cpuPct.loadMean` 3%. The mark is taken after the generation sleep and before the drain, so drain CPU is excluded (also by test) |
| 9: `drainMs` merge | `mergeResults` with 3 workers, the slowest first, in the middle or last; one worker without `drainMs` | Always the maximum: 900, 900, 900 and 500 |
| 5, 6 | `--ramp 0.0001`, `--editors ""`, `" "` | Refused, exit 2 (tests and live). Gaps: findings 4 and 5 |

## Mutations

Each mutation was applied alone, then `bun test test/load` was run and the file restored from memory.

- **Script:** `scratchpad/mutate.js`. It takes the builder's mutation text byte-identical from its `mutate.js`.
- **Output:** `scratchpad/mutations.txt`.
- **Tree after the batch:** diffed clean against the snapshot.

| Mutation | Result | Failing test(s) |
|---|---|---|
| G2 createBoard parses bare | CAUGHT | createBoard: a tokens file that is not JSON… |
| G3a acks ignored | CAUGHT | answered… |
| G3b echo floor ignored | CAUGHT | answered… |
| G3d headline ignores ops | CAUGHT | answered…, live CLI swallow |
| G4a `finally` stops nothing | CAUGHT | setup failure…, SIGTERM/INT/HUP |
| G4c handler skips children | CAUGHT | SIGTERM/INT/HUP |
| G4d no SIGHUP | CAUGHT | SIGHUP… |
| G5b duration floor 0 | CAUGHT | arguments… |
| G6b empty number accepted | CAUGHT | arguments… |
| G8a 500 ms minimum ignored | CAUGHT | CPU burned in the drain… |
| G8c run.js passes no `loadFrom` | CAUGHT | live, 2 workers… |
| X6 setup error exits 1 | CAUGHT | createBoard…, exit code 2… |
| X7 parse error exits 1 | CAUGHT | exit code 2… |
| L3 unmeasured not a reason | CAUGHT | CPU burned in the drain… |
| **Mine:** O1 null CPU passes the `>` check | CAUGHT | live 2 workers, CPU burned in the drain… |
| O2 worker orphan watch disabled | **NOT CAUGHT** | Finding 2 |
| O3 echo floor `>` instead of `>=` | CAUGHT | answered… (990/1000 case) |
| O4 server load CPU over all samples | **NOT CAUGHT** | Finding 3 |
| O5 worker load mark at t0 | CAUGHT | 3 tests |
| O6 tokens reader rethrows the parser error | CAUGHT | 2 tests |
| O7 server not tracked until listening | CAUGHT | SIGTERM/INT/HUP (and my pre-listening probe, above) |

**The builder's 6 survivors (X2, R1, R2, T1, G8b, plus G8c guarded since), judged by reading:**

- **X2:** equivalent. `neverJoined === 0` already implies that every client joined.
- **G8b:** equivalent. A `setTimeout(…, ≤ 0)` takes the same mark one tick later.
- **T1:** harmless. Both messages carry the path only.
- **R1:** a known LOW from p8-load2v. A rejoin's catch-up could be counted as delivery.
- **R2** (an ack counted twice): no longer quite "near-equivalent". `acks` now gates VALID, so a buggy server
  that repeated one op's ack before its echo, and never acked another, would read answered. The real server never
  repeats an ack, so I'm not grading it; it is worth a test.
- **Live re-run in `head`:** X2, R1, R2 and T1 all NOT CAUGHT (31 pass each), as judged above. G8b was cut off:
  t187 asked me to stop the batch. `head/scripts/load/worker.js` was restored from the snapshot afterwards and diffs
  clean.

## Docs (spot-checks against `result.json`)

| Claim | README | `result.json` |
|---|---|---|
| `p8-load2/k125` viewer p99 and load average | 8,523 ms, 14.8 | 8,523 ms. Load average as in the p8-load2 log; the corrected slip (14.8 vs 10.4) is right |
| `p8-load2/k125b` load-phase server CPU | 73% | 72.1% over seconds 12–30 (my 19-sample slice; the builder's window convention may differ by a sample) |
| `5000-no-cursors/` "would now read INCOMPLETE" | 942 of 943 acked | sent 943, acked 942, echoed 943 |
| `p8-load2/k105`, `k200`, `k125`; `5000-75-writers/` load-phase CPU | 90%, 75%, 90%; 90% | 90.6, 75.4, 89.8; 90.0 |

- **125-writer range:** 1.8–12.4 s over 4 runs, with p8-load2v's load averages (9.6 and 4.5). Matches p8-load2v.
- **Correction note in p8-load2.md:** accurate.
- **The one slip:** finding 6.

## Gates

- **`bun test test/load` 3 times in `copy`:** 31 pass, 0 fail each time (39.9 s, 40.0 s, 40.1 s).
- **`bun test test/load` 3 times in `head`:** 31 pass, 0 fail each time (40.2 s, 39.9 s, 39.8 s).
- **`bun test test/architecture.test.js` in the real tree (read-only):** 16 pass, 0 fail. `git status` of
  `scripts/load` and `test/load` was unchanged before and after.

## Ensemble review (sdd)

- **Adapters:** codex and grok both passed `check_adapter`. Each reviewed its own `.env`-free copy of `head` plus
  the job's diff (`rev-codex`, `rev-grok`).
- **codex (effort high):** 1 MEDIUM, the no-ops-sent pass (the same root cause as finding 1; confirmed live by my
  probes), and 1 LOW, the empty `--tokens` (confirmed live as finding 4).
- **grok:** "no findings". Discarded: it cites functions and line numbers that do not exist in these files (for
  example `worker.js:248-265 success: false`, and `cleanup()`).
- **Agreement:** no HIGH candidate.

## Not verified

- **Live rig:** `--rig` against a live rig, as before.
- **Linux:** the `fs.nr_open` limit.
- **G8b in `head`:** not re-run live; its batch was stopped (judged equivalent by reading, as the builder did).
- **Re-runs after the probes:** CAUGHT results whose failing test is not the mutation's own guard were not re-run
  alone. Some probes ran during the batch, but every mutation the brief cares about failed its own guard test.

## Housekeeping

- **Processes I started and stopped, all by PID, after confirming each command path was under my scratchpad:**
  - **Server 62588:** left by my SIGKILL probe (finding 2).
  - **Server 6105:** left by the O7 discrimination probe.
  - **Servers 27482 and 27832:** from my copy, left by mutation-batch tests while G4a/G4c disabled the cleanup.
    Found after the batch.
  - **Leftover check:** every other probe checked its own descendants afterwards and found none.
- **Survivor batch, stopped on t187's request by PID:** `mutate2.js` 32286, its `bun test` 46953 (no children left
  at that point) and its shell 18266.
- **Final `ps`:** nothing from my scratchpad is running.
- **Not touched:** nats-servers 9944, 25838 and 85354, and postgres 25827 (other sessions).
- **Scratch copies left in my scratchpad:** `copy`, `head`, `head-o7` (O7-mutated), `rev-codex` and `rev-grok`. All
  are `.env`-free. My `rm -rf` of `head-o7` was denied, so I left it.
- **Real tree:** only this report.
