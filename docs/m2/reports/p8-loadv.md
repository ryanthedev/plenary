# Report: p8-loadv (verify p8-load, the load client)

**Verdict: FAIL (round 1). No HIGH findings: the client works, but 3 MEDIUM findings need a round 2.**

- **Works:** the load client, its counting and its stats are correct on every check I ran. No token leaked on
  any path I tried. The `--rig` field names match `scripts/cluster-rig.js`. The builder's 13 caught mutations
  reproduce, and `bun test test/load` passed 3 times in my copy.
- **MEDIUM 1, calibration knee not reproduced:** I re-ran 5,000 clients with 105 writers 3 times (twice on the
  current server, once on the server before `5b272ad`). Viewer p99 was 723, 881 and 732 ms, with 0 resyncs. The
  report says the same setup collapses to 12.4 s p99 with 5 resyncs. The "knee between 75 and 105 writers" claim
  rests on two degraded runs from a server state that held another session's uncommitted edits. It does not
  reproduce on the current server.
- **MEDIUM 2, saturation detection is untested end to end:** replacing the worker's lag sampler or CPU sampler
  with zeros leaves every test green. The `valid` test feeds in hand-made numbers, so it checks the thresholds
  but never the measuring.
- **MEDIUM 3, "counted once" is untested for reconnects, rejoins and resent ops:** double-counting reconnects,
  counting every welcome as a first join, or counting a resent op as a new send all leave every test green.
  The brief names this check explicitly.

Scope: verifier for p8-load (brief `docs/m2/briefs/p8-loadv.md`). I edited no code and committed nothing. All
mutations and load runs ran in a copy under my scratchpad, never in `/Users/r/repos/plenary`. The one run in the
real tree was the full `bun test`, with no mutations applied.

## Findings

| # | Grade | Finding | Where |
|---|---|---|---|
| 1 | MEDIUM | Calibration knee (75 vs 105 writers) does not reproduce (details below) | `docs/m2/load/2026-11-12-calibration/README.md`, report "Calibration" |
| 2 | MEDIUM | Lag and CPU samplers untested: mutations V11 and V12 survive | `scripts/load/worker.js:56-62`; test "valid" uses fake workers |
| 3 | MEDIUM | Counted-once untested for reconnects (V1), rejoins vs first joins (V4) and resent ops (V13): all survive | `scripts/load/client.js:83,95-96,129-131` |
| 4 | LOW | M12 (drain stops waiting for acks) is not caught, and the `unacked == 0` assertion does not cover it (below). V10 (`unacked` hard-coded to 0) also survives | `scripts/load/worker.js:77-81` |
| 5 | LOW | Delivery vs catch-up untested: V5 (catch-up entries counted as live delivery) survives | `scripts/load/client.js:107` |
| 6 | LOW | `fdCheck` has no test: V7 (check disabled) survives. Its message works live (below), but it calls `kern.maxfilesperproc` "the hard limit" | `scripts/load/run.js:98-107` |
| 7 | LOW | A run where nobody joined headlines **VALID** and exits 0 (bad URL: "VALID · 0/1 clients joined"). `valid` means only "the generator did not saturate", but a skimming reader will read it as a good run | `scripts/load/run.js:140,174` |
| 8 | LOW | Worker CPU mean is taken over ramp, load and drain together, so idle seconds dilute it. A worker pinned during the load phase can average under 85%. Lag p99 still catches a real stall (shown live below) | `scripts/load/run.js:117,131` |
| 9 | LOW (codex) | `--ramp 0` is accepted: `rampMs` becomes `total × 10⁶` ms, so the run sleeps for hours. Confirmed by reading `run.js:265` | `scripts/load/run.js:74,93,265` |
| 10 | LOW (codex) | Fractional counts are accepted (`--editors 1.5` plans 2 clients but reports 1.5) | `scripts/load/run.js:74` |
| 11 | LOW (codex) | `createBoard` copies the server's `error` field into its message. Our server never puts a token there, so this is defensive only | `scripts/load/run.js:207` |
| 12 | LOW (codex) | On Linux, `fdCheck` ignores `fs.nr_open` | `scripts/load/run.js:100-104` |
| 13 | LOW | `--local` with a tokens file the server rejects waits 20 s and gives a generic error, though the server logged why | `scripts/load/server.js:426-438` |

### Finding 1 in detail: the knee

All runs below used the same command as the calibration:
`run.js --local … --ramp 500 --duration 20 --drain 15 --procs 6`. The load average was 5 to 9 on 12 cores,
because other sessions were running.

| Run | Writers | Echoed | Resyncs | Editor ack p50 / p99 | Viewer delivery p50 / p99 / max | Gen lag p99 | Server CPU mean / max |
|---|---|---|---|---|---|---|---|
| builder `2000/` | 45 | 433/433 | 0 | 10 / 25 | 7 / 25 / 35 | 2.5 | 32 / 42 |
| **mine, 2,000** | 45 | 437/437 | 0 | 10 / 24 | 7 / 22 / 37 | 1.7 | 33 / 44 |
| builder `5000-75-writers/` | 75 | 750/750 | 0 | 66 / 448 | 73 / 480 / 1,281 | 3.9 | 76 / 95 |
| **mine, 5,000, 75 writers** | 75 | 766/766 | 0 | 73 / 507 | 104 / 508 / 791 | 9.9 | 75 / 94 |
| builder `5000/` | 105 | 931/931 | **5** | 2,700 / 13,354 | 1,471 / **12,432** / 13,667 | 14.3 | 61 / 81 |
| **mine, 5,000, 105 writers** | 105 | 953/953 | 0 | 161 / 642 | 247 / **723** / 824 | 6.3 | 81 / 97 |
| **mine, again** | 105 | 964/964 | 0 | 299 / 897 | 354 / **881** / 1,160 | 11.5 | 78 / 97 |
| **mine, server before `5b272ad`** (worktree at `ff62bca`, current `scripts/load`) | 105 | 958/958 | 0 | 180 / 663 | 248 / **732** / 1,079 | 6.0 | 81 / 97 |

- **2,000 and 75 writers reproduce.** My 2,000-client run matches the builder's within noise, and so does my
  5,000-client run with 75 writers.
- **105 writers does not reproduce.** Three runs gave viewer p99 between 0.72 and 0.88 s, with no resyncs.
  Latency rises smoothly from 75 to 105 writers (p99 about 0.5 s to 0.7–0.9 s). There is no collapse.
- **The new server commit is not the cause.** `5b272ad` (p4-host, 13:54) landed after the builder's runs
  (13:45), but the pre-commit server gave the same answer (732 ms).
- **The builder had two degraded 105-writer runs, not one.**
  - `5000/` had a viewer p99 of 12.4 s.
  - `5000-no-cursors/` had a viewer p99 of 2.4 s, at 5 times the latency of my cursor-on reruns.
  - Both came from the same 13:45 batch, and in both the server used *less* CPU (61% mean) than in the lighter
    75-writer run (76%).
  - The cause is unknown. Two runs make a one-off stall less likely.
- **There is a confound.** The builder measured the shared working tree while `server/` held another session's
  uncommitted edits: the role cache, since committed as `15210d3`. The `role-cache` test was failing then and
  passes now.
  - Neither of my server states is exactly that one. My copy was taken after 13:55, with those edits, and I
    also tested `ff62bca`.
  - So the collapse may have been real for a server state that no longer exists.
- **What to change:** the README and report should not say "this Mac sustains 5,000 clients with 75 writers;
  105 collapses".
  - **Say instead:** "on the current server, 5,000 clients with 105 writers stayed under 1 s viewer p99 in 3
    runs. Two earlier runs on a mid-edit server degraded, for an unknown cause."
  - **Suspects for engine:** mark the list as resting on those two runs only.
  - **Old folders:** `5000/` and `5000-no-cursors/` also predate the current drain logic, which the README
    already says.
- **Raw files:** `/private/tmp/claude-501/-Users-r-repos-plenary/7bf42cbf-529f-46f1-8527-71d26fec8d82/scratchpad/k75/result.json`,
  `…/scratchpad/k105/result.json`, `…/scratchpad/k105b/result.json`, `…/scratchpad/k105old/result.json`,
  `…/scratchpad/cal2000/result.json` (all under the scratchpad path above).

### Finding 4 in detail: M12 and the `unacked == 0` assertion

The assertion does not pin M12: M12 (drain stops waiting for acks) and V10 (`unacked` always 0) both pass 8/8.

- **The race is real on one node.** Acks and entries take different paths:
  - **Acks** go from the room host to the gateway as replies (`server/room-host.js:445-449`, the `REPLIES` set).
  - **Entries** are published on `.entries` and fanned out by the gateway.
  - So an entry can overtake its ack. The builder's `5000-no-cursors/` run shows exactly that: 943 echoed,
    942 acked.
- **It is too rare at test scale to fail reliably.** With 100 clients it did not show in my runs or the
  builder's, so the assertion only turns a regression into an occasional flake.
- **A deterministic test is cheap:** run `runWorker`, or the drain predicate, against a fake server that sends
  the entry and holds back the ack.

## Checks against the brief

| Check | Result | Evidence |
|---|---|---|
| Replica used as consumer only | **PASS** | Details below the table |
| Secrets | **PASS** | Details below the table |
| Stats | **PASS** | Nearest-rank percentiles (`ceil(p·n)`) are right for empty, one value, ties and p99 of 1..100. Mutations M1 and V6 are caught. `--procs` merges count maps (`Hist.merge` adds counts; M2 caught); percentiles are never averaged |
| Counting | **PASS on code, gap in tests** | Details below the table |
| Validity | **PASS on code, gap in tests** | Details below the table |
| Open-file limit | **PASS** | `--viewers 250000 --procs 1` stops with exit 2 and the message: "each worker needs ~250257 open files (250001 clients + 256) but the hard limit is 245760 (ulimit -Hn unlimited, kern.maxfilesperproc 245760). Use more --procs, or raise the limit (…)". Untested (finding 6) |
| Calibration | **FAIL on the knee** | Finding 1 |
| `--rig` field names | **PASS** | `cluster-rig.js:25-27,186,288` writes `lb.wsUrl` and `tokensFile` (absolute), version 1, and no board. `rigConfig` reads exactly those first, and the test uses that shape. Not run against a live rig. Note: `rigConfig` ignores `state`, so a rig still `starting` gives `lb: null` and the error "need --url" |
| Mutations | **13/14 builder, 6/14 mine caught** | Table below |
| Gates | **PASS** | Section below |

- **Replica as consumer only:**
  - **Imports:** `scripts/load` imports only `packages/protocol/{replica,codec,envelope}.js`,
    `packages/core/model.js` and its own files.
  - **Packages and protocol untouched:** `git diff --stat -- packages` is empty.
  - **The `PROTOCOL.md`, `server/*` and `test/server/*` edits seen at the start are not this job's.** They have
    since been committed as `15210d3` ("p5-load: per-gateway role cache"). After that, `git status` shows no
    change under `server/`, `test/server/` or `PROTOCOL.md`.
  - **Mutation of Replica state:** the client mutates the Replica's own pending `msg` (the stamp in
    `client.js:204-207`). That is after `outgoing()` has restamped it, and a resend sends the same bytes, so it
    is benign.
- **Secrets:**
  - **Files and output:** `tokens.js` output holds no token, and both files are mode 600.
  - **Failing runs print only the error class:**
    - Passing the `.env` file as `--tokens` gives "JSON Parse error: Unexpected identifier "PLENARY_DEV_TOKENS"".
    - A bad URL gives a normal result, with no token in it.
    - A missing file gives the ENOENT path only.
    - `--create-board` with the server down gives ECONNREFUSED.
  - **Malformed JSON with token-like text** gives a generic parse error.
  - **How I checked:** every token was grepped in each output. All the live outputs (stdout, stderr,
    `result.json`, `report.md`, `server.log`) are also asserted clean by the live test, and M6 and M7 are caught.
  - **`--local` with bad tokens files:** I tried a wrong-role table, a JSON array of the tokens, and truncated
    JSON (`scratchpad/leakprobe.js`, which prints counts only). All 3 had 0 of 5 tokens in stdout, stderr,
    `server.log` and `result.json`.
    - **Usability, LOW (finding 13):** the array and truncated cases wait 20 s, then say only `server: no "dev
      tokens are ON…" log line`. Meanwhile the server's log already says "PLENARY_DEV_TOKENS is not a JSON
      object; dev tokens stay off". That line should end the wait with a clear message.
  - **One caveat:** the `--local` server gets its tokens through its environment (not argv), which `ps eww`
    can read as the same user. That is acceptable for dev tokens.
- **Counting:**
  - **In the code, each count happens once:**
    - Each close code is counted in `onclose` once.
    - `reconnects` is counted in `retry()` once per retry. After a resync the old socket's `onclose` returns
      early, because `this.ws` is already null.
    - Errors are counted once per frame.
    - A client that never gets a welcome shows as `neverJoined`. V3 is caught, and the live 1013 test shows
      `neverJoined: 1`.
  - **The tests don't pin it:** finding 3.
- **Validity:**
  - **The 100 ms lag p99 threshold works live.** I injected a 150 ms busy-wait every 200 ms into the worker,
    in my copy. The result was "INVALID · worker 0: event-loop lag p99 151 ms > 100 ms", with CPU mean 73.1%.
  - **The threshold is real,** but the samplers are not tested (finding 2), and the CPU mean is diluted
    (finding 8).

## Mutations (each applied alone in the copy, `bun test test/load`, then restored; tree clean after)

Script: `/private/tmp/claude-501/-Users-r-repos-plenary/7bf42cbf-529f-46f1-8527-71d26fec8d82/scratchpad/mutate.js`.
Output: `/private/tmp/claude-501/-Users-r-repos-plenary/7bf42cbf-529f-46f1-8527-71d26fec8d82/scratchpad/mutations.txt`.

| Mutation | Result | Failing test(s) |
|---|---|---|
| M1 percentile `ceil` → `floor` | CAUGHT | stats fixed inputs; merge |
| M2 `Hist.merge` keeps first count | CAUGHT | stats merging |
| M3 merge first worker only | CAUGHT | merge; live 2 workers |
| M4 echoes not counted | CAUGHT | live 2 workers; live 1013 |
| M5 close codes not counted | CAUGHT | live 1013 |
| M6 run.js logs a token | CAUGHT | live 2 workers |
| M7 tokens in result.json config | CAUGHT | live 2 workers |
| M8 all clients to worker 0 | CAUGHT | live 2 workers |
| M9 write time not stamped | CAUGHT | live 2 workers |
| M10 lag guard removed | CAUGHT | valid |
| M11 CPU guard removed | CAUGHT | valid |
| M12 drain waits for pending only | **NOT CAUGHT** (as the builder said; finding 4) | – |
| M13 `--create-board` skips grants | CAUGHT | live 1013 |
| M14 writer cap check removed | CAUGHT | plan |
| V1 reconnects counted twice | **NOT CAUGHT** | – |
| V2 1013 also counted in `closeOther` | CAUGHT | merge |
| V3 `neverJoined` forced to 0 | CAUGHT | live 1013 |
| V4 every welcome counted as a first join | **NOT CAUGHT** | – |
| V5 catch-up entries counted as delivery | **NOT CAUGHT** | – |
| V6 summary p99 reads p98 | CAUGHT | stats fixed inputs |
| V7 fd check disabled | **NOT CAUGHT** | – |
| V8 server error codes not counted | CAUGHT | live 1013 |
| V9 tokens files 0644 | CAUGHT | tokens |
| V10 `unacked` always 0 | **NOT CAUGHT** | – |
| V11 lag sampler records 0 | **NOT CAUGHT** | – |
| V12 CPU sampler records 0 | **NOT CAUGHT** | – |
| V13 a resent op counted as a new send | **NOT CAUGHT** | – |
| V14 joins-per-second buckets dropped | CAUGHT | live 2 workers |

**Round 2 fix list, smallest that closes findings 2–5:**

- **Live saturation test:** run `runWorker` in process with a busy-wait injected, or a tiny `--local` run with
  an env-gated busy loop, and assert `valid: false`. This covers V11 and V12.
- **Live reconnect test:** force one reconnect of a welcomed writer with a pending op. Assert `reconnects`,
  `rejoins`, `joined` and `opsSent` exact. This covers V1, V4 and V13.
- **Catch-up test:** a client joining after ops exist must show 0 delivery samples for them. This covers V5.
- **Unit tests:** the drain predicate with entry-before-ack (M12, V10), and `fdCheck` with a stubbed limit (V7).

## Gates

- **`bun test test/load` in the copy, 3 times:** 8 pass, 0 fail each time (9.0 s each).
- **Full `bun test` in the real tree, once, no mutations:** 1,415 pass, 153 skip, 1 fail (1,569 tests, 83
  files, 178.8 s).
  - **The one failure:** `test/core-source.test.js` "packages/core is still herdr-draw's core". It is known and
    unrelated, not this job's.
  - **`test/architecture.test.js` now passes,** because the manager added the 6 `scripts/load` files to
    `COMPOSITION_ROOTS`.
  - **The builder's other failure no longer shows:** `role-cache` passes now.

## Ensemble review (sdd)

- **codex (effort high):** returned 4 findings, all LOW after checking: `--ramp 0`, fractional counts, the
  `createBoard` error echo, and Linux `fs.nr_open`. They are findings 9–12. I confirmed `--ramp 0` and
  fractional counts by reading the code. The echo is defensive only, because our server never puts a token in
  `error`.
- **agy:** failed. `check_adapter` says "RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in
  48h".
- **Other harnesses (`check_adapter`):**
  - **grok:** ok, so I dispatched it.
  - **kimi:** failed, with "No model configured".
  - **mistral:** failed, with "Missing MISTRAL_API_KEY".
  - **qwen:** missing.
- **grok:** "Clean, no findings".
  - **Refuted in part:** it claims the 1013 test "would catch a reconnect or close-counting regression". My
    mutation V1 (reconnects counted twice) survives that test.
- **Agreement:** codex and grok agree on no HIGH, so there is no HIGH candidate. None of codex's 4 LOWs was
  raised by grok.
- **Review copies:** separate copies under the scratchpad (`rev-codex` for codex; `rev-agy` for agy, then
  grok), not the real tree.

## Housekeeping

- **Leftover processes:** after my runs, `ps` showed no `server/main.js` or `scripts/load` processes from my
  copy.
- **Scratch worktree:** the `ff62bca` worktree was removed with `git worktree remove`.
- **Stray file:** I wrote one file outside the scratchpad, `/tmp/x` (a stray copy of `worker.js`), and deleted
  it.
- **Real tree:** nothing in `/Users/r/repos/plenary` changed except this report.

## Not verified

- **Live rig:** not run. The `--rig` check was by reading the code only.
- **Machine contention:** the knee reruns shared the Mac with other sessions (load average 5–9). A quiet-machine
  rerun of 105 writers would firm up finding 1, but the rerun was below 1 s three times under *more* contention
  than a quiet machine.
- **Worker crash mid-run:** not tested.
- **CHECKER mode on the design:** this job is a test tool, not part of the system's design, so I did not apply
  the distributed-systems-design skill. I checked the measurement design directly: clock start points, the
  merge, and validity.
