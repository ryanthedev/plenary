# Report: p8-load4v (verify p8-load4, fix round 4 for the load client)

**Verdict: FAIL (round 4), on 1 MEDIUM. A server that answers the first ops and then drops every client and refuses
every rejoin still headlines VALID and exits 0 (5 of 5 runs). This brief lists "rejoin refused mid-run" among the
cases that may not read VALID. The builder's own brief (p8-load4.md item 1) named "closes everyone and refuses
rejoins" too. The builder closed only the before-the-first-op form and disclosed the rest as "not judged". The other
fixes hold under my breaking inputs. 2 new LOWs.**

- **What holds:**
  - **Round-3 probes:** `stall.js` and `crash.js` now read INCOMPLETE, exit 1.
  - **New variants:** stall after some ops, acks without echoes, echoes without acks, and refused rejoins with the
    sockets left open all read INCOMPLETE.
  - **Healthy runs:** `--local` (default rates and `--op-rate 0`) and a healthy fake server read VALID, exit 0.
  - **Orphans:** SIGKILL to `run.js` before listening, mid-ramp and mid-drain (with the server stopped) leaves nothing.
    The watches are sound under PID reuse (by reading).
  - **Arguments:** behave as `--help` says, caps included.
  - **Secrets:** no secret on any error path.
  - **Docs:** the README matches its `result.json` files.
- **Mutations:** 11 of 11 CAUGHT (8 of the builder's and 3 of mine).
- **Gates:** `test/load` 43 pass ×3; architecture 16 pass.
- **Not done:** a real-server form of finding 1 (SIGKILL the `--local` server mid-run, k of n). My command was denied,
  so finding 1 rests on the fake-server repro.
- **Fix for the MEDIUM (small):** also rule on staying connected. For example, INCOMPLETE when
  `clients.connectedAtEnd < clients.planned`, or when ops skipped offline exceed some share of ticks (say
  `skippedOffline > made`) for a due role. Add `dropMid` (below) as a live test. **Checked against the
  15 calibration `result.json` files:** neither candidate would flip a documented run. `connectedAtEnd` equals
  `planned` in all 15, and `skippedOffline` is at most 66 (`k200`) against 931-1,482 ops made. Both rules are still
  candidates, untested against live runs; I did not implement them. **For t187 to rule on:** the builder
  disclosed this gap (README "Not judged", lines 139-140), while this brief requires it closed.

Scope: verifier only. No code edited, nothing committed. The real tree got this report and one read-only
`bun test test/architecture.test.js`. Distributed-systems-design CHECKER mode was not applied: this is a test tool's
exit rule, argument checks and process hygiene, not system design (the same call as p8-load2v/3v and the builder).

## Copies

- **`copy`:** `git archive HEAD` (`40cba26`; the builder used `2703540`, the one commit between is p-tab) plus this
  job's 10 files from the real tree (`diff -r` of `scripts/load` and `test/load`: same), `node_modules` symlinked.
  Probes, gates and the mutation batch ran here.
- **`probe2`:** built during the mutation batch so repeat probes never ran against a mutated file. HEAD had moved to
  `ad61c4f` by then (`ddc484a` p4-wire2, a `server/` change, landed mid-session), so `probe2` is `ad61c4f` plus the
  same job files. The 5 `dropMid` repeats and the S2a re-run ran there.
- **`rev-codex`, `rev-agy`:** `.env`-free copies with `JOB.diff`, one per ensemble reviewer.
- **Paths:** all in `/private/tmp/claude-501/-Users-r-repos-plenary/43028fc9-84a7-4fcf-8c22-11568d0d98b9/scratchpad/`.
- **`.env`:** `find <copy> -name .env` was empty when each copy was built, before the gates and at the end. It was
  not re-run before every single probe, as the brief asks; no copy ever received a `.env` (built from `git archive`
  plus named files only). `TMPDIR` was the scratchpad's `tmp/` for every probe and gate, but not for the read-only
  architecture run in the real tree, nor for the reviewers (grok says it ran `--help` and a short `--local` in its
  copy).

## Findings

| # | Grade | Finding | Where | Repro |
|---|---|---|---|---|
| 1 | **MEDIUM** | **Drop everyone mid-run and refuse rejoins: VALID, exit 0.** The rule asks only that every op *made* was answered and that each due role made at least one. `canWrite()` skips ops while offline without making them, so once the server drops everyone, no op is made and nothing is owed. `connectedAtEnd` and `skippedOffline` are reported, not ruled on. The `run.js:47-48` comment ("drops everyone for good … must not read VALID") and README line 132 hold only when the drop comes before the first op | `scripts/load/run.js:224-225`; `scripts/load/client.js:161-165`; README 139-140 | `probes/var.js <copy> dropMid --duration 10` (fake server: healthy for 1.5 s, then closes every socket 1013 and closes every later hello 1013): **5/5 `exit 0 \| **VALID**`**, made 12-17, all acked and echoed, `skippedOffline` 104-112, `connectedAtEnd 0`, 12-13 closes 1013. At `--duration 20` with the drop at 0.6 s: VALID, 6 ops made against 236 skipped offline. `dropMidErr` (later hellos get `error unavailable`): VALID too. **Sensitivity:** an op in flight at the moment of the drop is never acked and flips the run to INCOMPLETE. The fake acks at once, so that never happened in my runs; a real server with a slower ack would sometimes, not always, read INCOMPLETE |
| 2 | LOW | **The due rule ignores join time,** so a healthy, slow-joining server can read INCOMPLETE. The `run.js:17` header says "its first op comes within 1.5/rate s", but generation starts at connect (`worker.js:67`) and ticks before the welcome are skipped offline. At rate × duration = 1.5 a single client's second tick can fall after `genEndAt` | `scripts/load/run.js:51,128-130` | `WELCOME_DELAY=900 var.js <copy> slowWelcome --editors 1 --op-rate 1.5 --duration 1`: 4/4 `INCOMPLETE (no editor op was made though 1 editor(s) were due to (1 ops skipped offline…))`. With 3 editors (`--op-rate 0.1 --duration 15`, welcome 7 s) it read VALID 2/2. An edge config; it fails safe (INCOMPLETE, not VALID) |
| 3 | LOW | **Unknown flags are accepted silently; a flag value may be another flag.** `--op_rate 5` (typo) runs at the default 2/s with no word. `--tokens --local` takes `--local` as the tokens path. Observation, not a contradiction: the per-flag caps still allow `--viewers 1000000 --procs 256 --ramp 1`, a ramp of 1,000,000 s (11.6 days) (by reading; the `run.js:100` comment says only "no flag plans years") | `scripts/load/run.js:56-66`, `101` | `parseArgs(["--op_rate","5"])` → `{op_rate:"5"}`, and `parseOptions` accepts it. `parseArgs(["--tokens","--local"])` → `{tokens:"--local"}` |

### Checked and holding

| Claim | My input | Result |
|---|---|---|
| 1: stall / crash | `stall.js <copy> stall`, `crash.js` (round-3 probes, copied) | `exit 1 \| INCOMPLETE (35 of 35 ops made were never acked (35 never sent)…)`; `exit 1 \| INCOMPLETE (no editor op was made though 3 editor(s) were due to (36 ops skipped offline…))` |
| 1: variants | `var.js` modes: `stallAfter` (ignores ops after 1.5 s, sockets stay open), `ackOnly`, `echoOnly`, and two more stall variants (later hellos refused, ops after 1.5 s ignored, but the open sockets never closed) | All exit 1, INCOMPLETE: 33/48 unacked; 48/48 never echoed; 42/42 never acked; 31/47 and 34/50 unacked |
| 1: healthy | fake `healthy`; fake `healthy --op-rate 0`; `--local` 3 editors + 2 annotators + 20 viewers, 5 s; `--local --op-rate 0`, 3 editors + 5 viewers | All VALID, exit 0 (47/47, 0/0 with `due: []`, 30/30, 0/0) |
| 2: orphans | `sig.js` SIGKILL: as soon as the first child appears (2 runs, server not yet logged, 1 descendant), after "listening" (3 runs), mid-ramp, mid-drain on `--local` (server SIGSTOPped 400 ms before the generation end so the drain waits, `run.js` SIGKILLed 1.5 s later, then SIGCONT), mid-drain on a fake that never acks; mid-ramp again with the repo reached through a symlinked path (`/tmp/…` and a symlinked copy dir), since the server watch is gated on `Bun.main === MAIN` | Exit 137 and 0 descendants alive after 2.5 s, every time |
| 2: PID reuse | By reading (`server.js:104-111`, `worker.js:117-118`) | Sound. The watch compares `process.ppid` with the recorded PID. Once the parent dies the child is reparented (to launchd/init or a subreaper, all alive at once with the dead parent, so never that PID), and a later process that reuses the PID is never this child's parent, so `ppid === loadParent` cannot become true again. The only exception is a run.js that is PID 1, where its death ends the namespace. Not forced live. The pre-listening SIGKILL result may also owe something to the broken stdout pipe; only an S2a-mutated copy would tell them apart, and S2a is CAUGHT by the builder's test |
| 4, 5: arguments | In-process `parseOptions` over all 14 numeric flags × `""`, `" "`, `0x1`, `1e3`, `+5`, `" 5"`, `"5 "`, `5.`, `.5`, `Infinity`, `-1`, `1_000`, `٥`, `99999999999999999999`, `5.0`, `05`; each cap at and just past it; 5 string flags × `""`, `" "`, tab. CLI: `--duration 1e12`, `--editors 0x1`, `--drain 601`, `--procs 0`, `--op-rate Infinity`, `--viewers-per-user 10001`, `--duration 3601`, `--ramp 0.5`, `--tokens ""`, `--url ""`, `--out <tab>`, `--rig " "` | Every malformed value refused; exit 2 on the CLI. `5.`, `.5`, `5.0` accepted for decimals and `05` everywhere: consistent with "plain decimal". Each cap accepted at the bound and refused past it. The `--help` bounds match `MAX`. One nit: `--rig " "` exits 2 but via `rigConfig` ("no rig.json in  "), because `run()` reads the rig before `parseOptions` |
| Secrets | 7 tokens files (non-string `domain`, a bad `name`, unknown role, duplicate names, admin-only, two malformed JSONs), each with and without `--create-board`, `--local`; every `var.js` run | Exit 0, 1 or 2 as expected; `SECRET`/`zz1`/`varTOK` in none of stdout, stderr, `result.json`, `report.md` or `server.log` |
| 6: docs | Load-phase server CPU recomputed from `cpuSeries` with each run's own ramp: `2000/`, `3500/`, `5000/`, `5000-75-writers/`, `5000-no-cursors/`, `p8-load2/k125b`, `k200`, `k105c` | 35.4, 68.9, 65.9, 90.1, 73.0, 73.3, 75.0, 92.6 against the README's 35, 69, 66, 90, 73, 73, 75, 93. Ramps 4, 7 and 10 s as stated |

## Mutations

Each mutation was applied alone, then `bun test test/load` was run and the file restored from memory.

- **Script:** `scratchpad/mutate.js`. The builder's text is byte-identical from its `mutate.js` (8 picked), plus 3 of mine.
- **Pre-flight:** a `--dry` run found every pattern exactly once.
- **Output:** `scratchpad/mutations.txt`.
- **Result:** **11 of 11 CAUGHT.** `tree after: clean` (diffed against `scratchpad/snap`).

| Mutation | Result | Failing test(s) |
|---|---|---|
| O2 worker orphan watch disabled | CAUGHT | SIGKILL mid-load; worker parent-gone |
| F1a judged on sent, not made | CAUGHT | answered (guards4); live stall |
| F1b a due role with no op passes | CAUGHT | answered (guards4); live crash |
| F1c client never counts made | CAUGHT | live 2 workers; live swallow; live stall |
| S2a server orphan watch disabled | CAUGHT | SIGKILL mid-load. In the batch the live crash test failed too; re-run alone on a quiet machine (`probe2`), only SIGKILL mid-load failed (42 pass, 1 fail). The extra failure came from load: my `dropMid` probes, the adapter probes and both reviewers ran at some point during the batch (no timestamps kept) |
| S2d worker parent from ppid only | CAUGHT | worker parent-gone |
| S3 loadMean = whole-run mean | CAUGHT | serverStats |
| S5c no upper bounds | CAUGHT | arguments; CLI exit 2 |
| **Mine:** V1 `DUE_TICKS` 1.5 → 0.5 | CAUGHT | due roles; answered |
| V2 server load CPU keeps the drain (upper bound `s.at <= genEndAt` dropped) | CAUGHT | serverStats |
| V3 `--rig` left out of `STRING_FLAGS` | CAUGHT | arguments |

- **Gap the mutations cannot show:** finding 1 is not a mutation survivor. It is a case no rule covers, so no test
  fails for it.

## Gates

- **`bun test test/load` 3 times in `copy`:** 43 pass, 0 fail each time (59.8 s, 59.5 s, 59.9 s). Some light
  fake-server probes ran in `probe2` during the first of them; it passed anyway.
- **`bun test test/architecture.test.js` in the real tree (read-only):** 16 pass, 0 fail. `git status --short` of
  `scripts/load` and `test/load` was the same before and after.

## Ensemble review (sdd)

- **Adapters:** codex `ok`; agy `failed` (quota exhausted, 429, resets in 44 h); grok `ok` and used in its place.
  Each got its own `.env`-free copy plus `JOB.diff` and the same neutral prompt (not my conclusions).
- **codex (effort high):** HIGH, "a writer role can pass after some clients are dropped" (`run.js:224`: `missing`
  only asks whether the role made any op; `skippedOffline` and `connectedAtEnd` are not ruled on). It is the same
  root cause as finding 1, which I confirmed live (all clients dropped, 5/5 VALID). I keep it at MEDIUM: a test
  tool's false VALID, disclosed by the builder, the same grade as round 3's equivalent. codex's second item,
  MEDIUM "the echo floor lets 1% of entries go missing", is the documented 99% tolerance (`ECHO_FLOOR_PCT`, kept
  for echoes cut off by a resync at the drain's end), working as designed. Not a finding.
- **grok:** "CLEAN, no findings". Discarded: it cites lines that do not exist (`server.js:580-600` in a 113-line
  file, `worker.js:700`, `tokens.js:610`).
- **Agreement:** codex and I agree on finding 1's root cause; no second harness confirmed a HIGH.

## Not verified

- **Live rig:** `--rig` was not run against a live rig.
- **Linux:** the orphan watches were tested on macOS only.
- **The real tree's `server/` and `packages/protocol/`:** others' uncommitted edits there were not exercised; the
  copy uses HEAD's.

## Housekeeping

- **Before:** `ps` for `server/main.js`, `scripts/load`, nats-server, postgres and `bun test` showed only two
  `bun test` processes (18257, 44228) from other sessions. I never signalled them.
- **During:** every probe stopped its own children. `sig.js` kills any survivor by PID and found none. No
  `kill` by pattern. One `rm -rf` of my own probe output folder was denied; I used fresh folders instead.
- **After:** the same `ps` shows nothing, mine or otherwise (the two `bun test` runs had ended on their own).
- **`.env`:** `find <scratchpad> -name .env` was empty at the end.
- **Scratch left in my scratchpad:** `copy`, `probe2`, `snap`, `rev-codex`, `rev-agy`, `copylink` (a symlink to
  `copy`), `probes/`, `tmp/`. None hold a `.env`. The reviewers' copies may hold their own edits; they are scratch.
- **Real tree:** only this report. `diff -r` of the real `scripts/load` and `test/load` against `snap`, and of the
  calibration README against my copy, were clean at the end (the reviewers had unrestricted writes in their own
  copies only).
- **Engram:** nothing written. No verified lesson here that the repo and these reports do not already hold.
