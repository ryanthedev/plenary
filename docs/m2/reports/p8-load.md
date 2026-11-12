# Report: p8-load (load client for the M2 ~10k-client test)

**Status: done; one item is blocked on a file I don't own.**

- **Working:** the load client runs and the tests pass 3 times in a row. 13 of 14 mutations are caught; the
  miss (M12, a race guard) is explained in the mutation table. Calibration is done.
- **Calibration (corrected by p8-load2, see "Correction" at the end):** ~~this Mac sustains 5,000 clients
  with 75 writers; with 105 writers it collapses (p99 12 s); the knee is write and presence volume times
  fan-out~~. Measured since: 105 writers sits around the 1 s viewer line, degradation is clear by 125 writers, and
  the cause is not diagnosed. The load generator never saturated.
- **Blocked:** the full `bun test` has one new failure, `test/architecture.test.js`. That test requires every
  `scripts/` file to be a registered composition root, and it isn't my file. The one-line fix for the manager
  is under "Full `bun test`".

## Files (all new; nothing outside the brief's list was touched)

| File | What it does |
|---|---|
| `scripts/load/run.js` | CLI and `run()`: plans clients, spawns the workers, merges their results, writes `result.json` and `report.md`. Also `--local` (starts its own server) and `--rig` |
| `scripts/load/worker.js` | One generator process: runs its clients, samples its own event-loop lag and CPU, sends one result over IPC |
| `scripts/load/client.js` | One simulated client: a real WebSocket driven by `Replica`, following the 5 steps in replica.js's header. Roles: editor, annotator, viewer |
| `scripts/load/stats.js` | `Hist`: an exact, mergeable histogram (0.1 ms resolution, nearest-rank percentiles) |
| `scripts/load/tokens.js` | Makes dev tokens: `dev-tokens.json` and `dev-tokens.env`, both 0600, plus one admin owner in domain `load.test`. Prints only their paths |
| `scripts/load/server.js` | Starts `server/main.js` (port 0, temp data dir, empty cwd, raised `ulimit -n`) and samples its CPU and RSS from `ps` |
| `test/load/load.test.js` | 8 tests (below) |
| `docs/m2/load/2026-11-12-calibration/` | README.md plus `result.json` and `report.md` for each of the 5 calibration runs |

- **Replica use:** consumer only; packages/ was not edited. The engine's future `{tab}` option is a one-line
  change in `makeReplica()` (`client.js`).
- **Distributed-systems-design skill:** not applied. This job designs a test tool, not part of the system's
  design: no protocol, server or port changes. The measurement choices that matter are listed under "How it
  measures".

## How to run

**Single node, now.** The simplest way is to let the client start its own server:

```
bun scripts/load/run.js --local --clients 2000 --ramp 500 --duration 20 --drain 15 --procs 4 --out /tmp/run1
```

This makes tokens in `<out>/tokens/`, starts `server/main.js` on port 0, uses its dev board, samples the
server's CPU, and stops the server at the end.

**Against a server you started yourself:**

```
bun scripts/load/tokens.js --out /tmp/tok --editors 5 --annotators 40 --viewers 1955    # prints only file paths
PLENARY_DEV_TOKENS="$(cat /tmp/tok/dev-tokens.json)" PORT=0 bun server/main.js           # or --env-file=/tmp/tok/dev-tokens.env
bun scripts/load/run.js --url ws://127.0.0.1:<port>/ws --board <dev board id> --tokens /tmp/tok/dev-tokens.json --editors 5 --annotators 40 --viewers 1955 --procs 4 --out /tmp/run1
```

**The rig, later:**

```
bun scripts/load/run.js --rig .rig/<name> --create-board --clients 10000 --procs 10 --out <dir>
```

`rigConfig()` in `run.js` is the one place that reads rig.json.

- **What I read:** p8-rig's `scripts/cluster-rig.js` (uncommitted, on disk 13:51 on 2026-11-12, rig.json
  version 1).
- **Fields it writes:** `lb.wsUrl` and `tokensFile` (an absolute path); no board. Those are read first, and a
  test uses that exact shape.
- **Fallbacks, in case it changes:** `wsUrl`, `lbUrl` (http becomes ws `…/ws`), `tokensPath`, and `board`.

**What the rig must provide for a 10k run (for the manager and p8-rig):**

- **Writer tokens.** The rig's default tokens are 8 editors, 32 annotators and 64 viewers, plus an admin owner
  in `rig.test`. `--clients 10000` wants 5 editors and 200 annotators.
  - Writers now share a token when they must, but at most 8 clients per user: that is the writer cap
    `MAX_WRITER_CONNS`, per gateway, and the LB may put a user's connections on one gateway.
  - So 200 annotators need at least 25 annotator tokens; the default 32 is enough (7 per user).
  - More annotators than 8 × the annotator tokens fails up front, with a message.
- **Viewer connections per user.** The rig sets `PLENARY_MAX_CONNS_PER_USER` to 100,000, so 64 viewer tokens
  are plenty.
- **Board.** No board is in rig.json, and each node has its own data dir and so its own dev board. Use
  `--create-board`: it POSTs `/boards` as the tokens file's admin token (memberRole viewer), then PUTs a grant
  for each editor, annotator or owner user. If p8-rig adds a `board` to rig.json, `rigConfig` picks it up.

**Board:** the dev board. The server logs its id ("dev tokens are ON", field `board`) and keeps it in
`<data>/dev-board.json`. Each dev user gets the role its token names, which is how editors, annotators and
viewers get their roles. I did not use `POST /boards`: a board made that way needs a grant per user before
roles differ.

**On the rig,** use `--create-board` (above). `dev-board.json` is per data dir, so each node would have its
own dev board.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--clients n` | – | splits n like the NFRs: the given editors, ~2% annotators, the rest viewers |
| `--editors` / `--annotators` / `--viewers` | 5 / 0 / 0 | explicit counts (they win over `--clients`) |
| `--ramp` | 200 | clients per second: editors first, then annotators, then viewers |
| `--duration` | 30 | seconds of load after the ramp |
| `--drain` | 15 | after the load stops, how long to wait for every op to be answered and applied |
| `--procs` | 1 | worker processes, merged into one result |
| `--op-rate` | 2 | editor board ops per second, per editor |
| `--note-rate` | 0.2 | annotator note ops per second |
| `--comment-rate` | 0.05 | annotator comments per second (a thread, then replies; a new thread every 400 replies) |
| `--cursor-rate` | 5 | cursor presence per second, per writer |
| `--pool` | 20 | elements each writer re-versions, so the board stays bounded |
| `--viewers-per-user` | 32 | `--local` only: viewer clients per dev user |
| `--create-board` | off | make a fresh board with POST /boards and grants (needs an `admin: true` token with a `domain`) instead of using the dev board |

**Tokens:**

- **Writers:** one dev user per editor or annotator client when there are enough tokens, otherwise shared, at
  most 8 per user (`MAX_WRITER_CONNS`, the writer cap per board per gateway).
- **Viewers:** 32 clients share one user, under the gateway's 64-connection cap per user.
- **Admin:** `tokens.js` adds one admin owner (`load-admin`, domain `load.test`), which `--create-board` uses.
  Clients never connect with it.
- **Scale:** 10,000 clients need about 520 tokens, so the env value stays far under ARG_MAX.
- **`--env-file`:** checked. `bun --env-file=<dir>/dev-tokens.env` parses the value into 5 tokens for a small
  set (only the count was printed).
- **Never visible:** tokens never go on argv. Workers get the file path plus an index per client.

**Open files:** `fdCheck()` runs before anything starts. It compares clients per worker plus 256 with
`ulimit -Hn` and, on macOS, with `kern.maxfilesperproc`. If the limit is too low it stops with a message saying
what to raise. Workers and the `--local` server start through `sh -c 'ulimit -n N; exec bun …'`.

## How it measures

- **Start of the clock:** the time the op is first written to the socket, not the time of `local()`. The
  Replica's 20/s pacing queue belongs to the client, not the server. That write time is stamped into the op
  itself (element `customData.lt`, or comment text `load <ms>`), so a client in any worker can measure
  delivery. All workers share one wall clock because they run on one machine.
- **ack:** from that write until its `ack` arrives, per sender role.
- **echo:** from that write until the client's own entry is applied, per sender role.
- **delivery:** from that write until the entry is applied at another client, per receiver role. Only live
  entries count (seq after the welcome's), not catch-up.
- **join:** hello sent until welcome, plus first joins bucketed per second.
- **Merging workers:** histograms merge by adding counts (exact percentiles of every sample), never by
  averaging percentiles.
- **Saturated generator:** if any worker's event-loop lag p99 is over 100 ms, or its mean CPU over 85% of a
  core, `valid` is false and `invalidReasons` says which.
- **Drain:** after the load stops, the run waits until every op is both acked and echoed (or `--drain` runs
  out). An op can settle by its entry before its ack arrives. `unanswered`, `unechoed` and `unacked` count what
  is still missing at the end.
- **Backpressure:** a writer skips an op while it is offline, or while 50 or more of its ops are pending.
  Skipped ops are counted (`skippedOffline`, `skippedBacklog`), so a stalled server shows up as skips, not as a
  growing queue on the client.

## result.json, schema `plenary.load.result/1`

```
{ schema, startedAt, finishedAt,
  config: { url, board, boardCreated, procs, ramp, duration, drain, viewersPerToken, opRate, noteRate, commentRate, cursorRate, pool, rampMs, nofile },
  valid: bool, invalidReasons: [string],
  clients: { planned, byRole: { editor, annotator, viewer }, joined, neverJoined, connectedAtEnd },
  join: { latencyMs: S, perSecond: [{ s, n }], peakPerSecond, firstToLastS },
  ops: { sent: { total, editor, annotator }, acked, echoed: { total, editor, annotator }, dropped, unanswered, unechoed, unacked,
         skippedOffline, skippedBacklog, presenceSent, drainMs },
  latencyMs: { ack: { editor: S, annotator: S, viewer: S }, echo: {…}, delivery: {…} },
  connections: { connects, hellos, welcomes, rejoins, reconnects, resyncs, resets, wsErrors, closes: { "<code>": n },
                 close1013, closeOther, errors: { "<code>": n }, goneAuth, goneVersion, badFrames },
  generator: { lagMs: S, workers: [{ worker, pid, clients, lagMs: S, cpuPct: { mean, max, samples } }], limits: { lagP99Ms, cpuMeanPct } },
  server: null | { pid, samples, cpuPct: { mean, max }, rssMb: { max }, cpuSeries: [pct] },
  histograms: { "<kind>.<role>" | "join": { n, sum, min, max, counts: [[key, count]] } } }   // key × 0.1 = ms; re-mergeable
S = { n, mean, min, p50, p95, p99, max } in ms (nulls when n = 0)
```

- **closes:** counts closes the client saw while running. The client's own closes at the end are not counted.
- **closeOther:** every code except 1000 and 1013.
- **errors:** server `error` codes. Message text is never kept.

## Tests (`test/load/load.test.js`) and mutations

| Test | What it checks |
|---|---|
| stats: nearest-rank percentiles on fixed inputs | 1..100 gives p50 50, p95 95, p99 99. Also: 3-value ranks, 0.1 ms rounding, empty, negative and NaN |
| stats: merging histograms | 90×1 plus (10×1000 and 5×1) equals the union; p95 is 1000, not the 500.5 an average would give; the shared key's counts add |
| merge: two workers | counts, closes, errors and joins per second add; histograms merge; `close1013` and `closeOther` are right |
| plan | the `--clients` split, viewers sharing tokens, a round-robin deal across 2 workers, ramp start times; writers share at most 8 per token, and a 17th fails |
| tokens | both files are 0600; roles grouped (with 1 admin owner); rig.json read in cluster-rig.js's shape and in the fallback shape |
| live, 2 workers, 100 clients (5 editors, 10 annotators, 85 viewers) against a real `server/main.js` | 100/100 joined, 50+50 per worker; every editor and annotator op acked and echoed, with 0 unanswered, unechoed, unacked or dropped; viewer deliveries above 0; no 1013. No token appears in the CLI's stdout or stderr, `result.json`, `report.md` or `server.log` |
| live 1013, on a `--create-board` board | `PLENARY_MAX_CONNS_PER_USER=2` with 3 viewers on one token: 3 joined, 1 never joined, at least one 1013 counted in `closes`, an `unavailable` error, and reconnects. The board came from POST /boards, and the editor's ops were all echoed, so its grant worked |
| valid | a worker with lag p99 150 ms, or mean CPU 92.5%, makes `valid` false with a reason; healthy workers leave it true |

Each mutation was applied alone, `bun test test/load` was run, and the file was restored. Every one made a test
fail:

| Mutation | Failing test(s) |
|---|---|
| M1 `stats.js` percentile rank uses `floor` instead of `ceil` | stats: fixed inputs; merge: two workers |
| M2 `Hist.merge` keeps the first count instead of adding | stats: merging. This failed to fail until I strengthened the test with a value both sides share |
| M3 `mergeResults` uses only the first worker | merge: two workers; live, 2 workers |
| M4 the client stops counting echoes | live, 2 workers |
| M5 close codes not counted | live 1013 |
| M6 run.js logs a token | live, 2 workers (token check) |
| M7 tokens put in result.json's config | live, 2 workers (token check) |
| M8 every client dealt to worker 0 (`--procs` ignored) | live, 2 workers |
| M9 the write time not stamped into the op | live, 2 workers (viewer delivery n is 0) |
| M10 lag guard removed | valid |
| M11 CPU guard removed | valid |
| M12 drain stops waiting for acks (pending only) | **not caught.** The ack-after-entry race is rare on loopback: it was seen once in 5 calibration runs, not in tests. The guard stays, and `unacked` is asserted to be 0 in the live test, so a regression would show as flakiness, not as a deterministic failure |
| M13 `--create-board` skips the grants | live 1013 (the editor is a viewer, so its ops are refused) |
| M14 writer cap check removed | plan |

**Runs:**

- **`bun test test/load`, 3 times in a row:** 8 pass, 0 fail each time, about 9.0 s (re-run after the last
  code change).
- **Cleanliness:** all 7 still pass after the mutations were reverted. A `diff` against my pre-mutation backup
  was clean.

## Calibration (details in `docs/m2/load/2026-11-12-calibration/README.md`)

> **Superseded in part (p8-load2):** the 105-writer rows and the bullets "The knee", "Presence fan-out is the
> larger share", "The server side did" and its suspects rest on two runs that did not reproduce. See "Correction"
> at the end of this report.

- **Machine:** M2 Max, 12 cores, 64 GB.
- **Setup:** one `server/main.js` on SQLite; 6 workers; ramp 500 clients/s; 20 s of load. Editors draw at
  2 ops/s, annotators write at 0.25/s, and every writer sends cursors at 5/s.

| Clients | Writers | Ops echoed | Editor ack p50 / p99 | Viewer delivery p50 / p99 | Generator lag p99 / CPU | Server CPU mean / max |
|---|---|---|---|---|---|---|
| 2,000 | 45 | 433/433 | 10 / 25 ms | 7 / 25 ms | ≤ 2.5 ms / 19% | 32% / 42% |
| 3,500 | 75 | 693/693 | 67 / 301 ms | 74 / 303 ms | ≤ 5 ms / 37% | 60% / 80% |
| **5,000** | **75** | 750/750 | 66 / 448 ms | 73 / 480 ms | ≤ 4 ms / 48% | 76% / 95% |
| 5,000 | 105 | 931/931, 5 resyncs | 2.7 / 13.4 s | 1.5 / 12.4 s | ≤ 14 ms / 40% | 61% / 81% |
| 5,000, no cursors | 105 | 943/943 | 0.4 / 2.8 s | 1.1 / 2.4 s | ≤ 8 ms / 39% | 61% / 86% |

- **Sustained: 5,000 clients with 75 writers.** No resyncs. Viewer p99 was 480 ms, inside the 1 s NFR. Editor
  ack p99 was 448 ms, over the 150 ms target.
- **The knee:** at 5,000 clients, 105 writers instead of 75 (about 8 more ops/s and 30 more cursor senders,
  each fanned out to all 5,000 clients) took viewer p99 from 0.48 s to 12.4 s. Ack p99 passed the 10 s answer
  timeout, so 5 clients resynced. No op was lost.
- **Presence fan-out is the larger share:** turning cursors off cut p99 to 2.4 s.
- **The client didn't saturate:** generator lag p99 stayed ≤ 14 ms on every worker (the limit is 100 ms), so
  every run is valid.
- **The server side did; this is by elimination, not diagnosed.**
  - Server CPU averaged 61–76% of one core, not 100%.
  - **Unverified suspects for engine:** the gateway's per-board send path (one send at a time, `breathe()`
    yields), Bun's per-socket send cost, and the macOS loopback.
  - **Lead:** at the knee, editor ack p99 (13.4 s) was far above annotator ack p99 (3.3 s).
  - A server profile at 5,000 clients with 105 writers would settle it.
- **Percentiles mix phases:** they cover the ramp and the steady state together.
- **Generator cost:** about 48% of a core per 830 clients at this mix. A 10k run on this Mac needs about 10
  workers, which competes with 3 nodes, Postgres, NATS and Caddy for 12 cores.
- **Server CPU method:** taken from cumulative CPU time (`ps -o time`). An earlier run with macOS `ps %cpu`
  read about the same.
## Full `bun test` (re-run after the last change)

- **Totals:** 1413 pass, 153 skip, 3 fail (1569 tests, 83 files).
- **`test/core-source.test.js`:** known and unrelated. herdr-draw's `editor.js` hash drifted.
- **`test/server/role-cache.test.js`, "M7: hellos waiting on the room when a timed pass runs … a lost revoke
  refuses them":** another session's work in progress, not mine.
  - The test file is new and uncommitted, and `server/gateway.js`, `server/auth/port.js`, `server/main.js` and
    the registries have uncommitted edits.
  - It fails alone too, 3 runs of 3.
- **`test/architecture.test.js`, "packages/, server/ and scripts/ follow the hexagonal import rules":** caused
  by my new files.
  - **What it reports:** the 6 `scripts/load/*.js` files are "neither core, adapter nor a composition root".
  - **Why:** the test requires every script to be listed in `COMPOSITION_ROOTS`, and it isn't my file.
    Someone has meanwhile added `scripts/cluster-rig.js` to that list (an uncommitted one-line edit), so only
    mine remain.
  - **Verified fix:** a scratch copy of the test with the 6 files added passed for all of them.

**Manager ask (t187):** add to `COMPOSITION_ROOTS` in `test/architecture.test.js`:
`"scripts/load/run.js", "scripts/load/worker.js", "scripts/load/tokens.js", "scripts/load/client.js", "scripts/load/server.js", "scripts/load/stats.js",   // platform (p8-load): load client; run.js and worker.js are entry points, the rest their modules`

## Not verified / risks

- **The rig:** not run against a live rig. The field names come from reading cluster-rig.js, not from a
  running rig. `--create-board` was tested only on a single node (the `--local` 1013 test).
- **Clock sync:** delivery latency assumes one wall clock, which is true on one machine. Generators on several
  machines would need synced clocks.
- **Viewer cost:** viewers use a full Replica, which applies every entry. That was not the bottleneck up to
  5,000. A lighter viewer mode is not built.
- **Bun IPC:** I did not test a worker crash mid-run beyond the "exited without a result" rejection.
- **Annotator note locks:** each annotator only edits its own notes, so they are never hit.
- **No commit,** per the brief.

## Correction (p8-load2, 2026-11-12, after the p8-loadv review)

**The calibration claim above is withdrawn: "this Mac sustains 5,000 clients with 75 writers; with 105 writers
it collapses (p99 12 s)" did not reproduce.** The corrected numbers are in
`docs/m2/load/2026-11-12-calibration/README.md`; details in `docs/m2/reports/p8-load2.md`.

- **105 writers does not collapse on the committed server (`15210d3`).** Viewer p99 was 0.72, 0.88 and 0.73 s in
  the verifier's 3 runs, and 1.32, 0.85, 1.13, 1.16 and 3.4 s in 5 p8-load2 runs on a busier machine: around the
  1 s line, never 12 s, with 0 resyncs.
- **The two degraded 105-writer runs** (`5000/`, `5000-no-cursors/`) ran on a working tree whose `server/` held
  another session's uncommitted edits. Their cause is unknown.
- **Resting on those two runs only, so unconfirmed:** "the knee is load × fan-out", "presence fan-out is the
  larger share", the editor-vs-annotator ack lead, and the engine suspects (the gateway's per-board send path,
  Bun's per-socket send cost, macOS loopback).
- **The knee, measured fresh:** at 5,000 clients on this (busy) Mac, degradation starts around 105 writers and
  is clear by 125. 105 writers: viewer p99 0.72-1.32 s in 7 runs, 3.4 s in an 8th. 125: 8.5 and 12.4 s in 2 runs.
  150: 18-20 s with 5 resyncs, twice. 200: 25 s, 189 resyncs. The generator stayed valid in every run.
- **`ops.drainMs` was summed over the workers** (6× the real drain with `--procs 6`); fixed in p8-load2.
- **The "M12 not caught" row in the mutation table is superseded:** a fake-server test now catches it
  deterministically (`test/load/counting.test.js`).
