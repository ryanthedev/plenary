# Calibration, 2026-11-12: one single-node server on one Mac

> **Corrected 2026-11-12 (p8-load2), after the p8-loadv review.** The first version said "this Mac sustains 5,000
> clients with 75 writers; 105 writers collapses". That does not hold as stated. On the committed server, 5,000
> clients with 105 writers gave viewer p99 under 1 s in the verifier's 3 runs (0.72-0.88 s) and 0.85-3.4 s in 5
> p8-load2 runs on a busier machine: around the 1 s line, never 12 s. Degradation is clear from 125 writers (section
> "Re-runs on the committed server" below). The two degraded 105-writer runs (`5000/`, `5000-no-cursors/`) came
> from a server state that held another session's uncommitted edits; their cause is unknown.
> **`ops.drainMs` in every `result.json` here is the sum over the 6 workers, not the drain's length** (fixed in
> p8-load2: it is now the slowest worker's). Divide by about 6 for these folders.

This is a baseline, not the M2 gate. The gate is about 10k clients on 3 nodes, run through the cluster rig after
p4-wire lands.

- **Machine:** Apple M2 Max, 12 cores, 64 GB, macOS (Darwin 25.2), Bun 1.4.4. Everything ran on loopback.
- **Server:** `bun server/main.js`, started by `run.js --local` with SQLite (`synchronous=FULL`), port 0 and a
  temp data dir, on the dev board.
- **Load:** 6 workers, ramp 500 clients/s, 20 s of load, drain ≤ 15 s. Editors draw at 2 ops/s, annotators
  write notes at 0.2/s and comments at 0.05/s, and every writer sends cursors at 5/s.
- **Command:** `bun scripts/load/run.js --local --clients N --ramp 500 --duration 20 --drain 15 --procs 6 --out <dir>`
  - `--clients N` means 5 editors, 2% annotators, and the rest viewers.
  - The "75 writers" run used `--editors 5 --annotators 70 --viewers 4925` instead.

| Run (folder) | Writers | Ops/s in | Valid | Ops echoed | Ack p50 / p99, editor | Delivery p50 / p99 / max, viewers | Join p99 | Generator lag p99 (worst) / CPU mean | Server CPU mean / max |
|---|---|---|---|---|---|---|---|---|---|
| 2,000 (`2000/`) | 5 + 40 | ~20 | yes | 433/433 | 10 / 25 ms | 7 / 25 / 35 ms | 4 ms | 2.5 ms / 19% | 32% / 42% |
| 3,500 (`3500/`) | 5 + 70 | ~27 | yes | 693/693 | 67 / 301 ms | 74 / 303 / 450 ms | 271 ms | 5 ms / 37% | 60% / 80% |
| 5,000, 75 writers (`5000-75-writers/`) | 5 + 70 | ~27 | yes | 750/750 | 66 / 448 ms | 73 / 480 / 1,281 ms | 87 ms | 4 ms / 48% | 76% / 95% |
| 5,000 (`5000/`), **degraded, not reproduced** | 5 + 100 | ~35 | yes | 931/931, 5 resyncs | 2,700 / 13,354 ms | 1,471 / 12,432 / 13,667 ms | 1,054 ms | 14 ms / 40% | 61% / 81% |
| 5,000, no cursors (`5000-no-cursors/`), **degraded, not reproduced** | 5 + 100 | ~35 | yes | 943/943 | 426 / 2,797 ms | 1,070 / 2,402 / 3,035 ms | – | 8 ms / 39% | 61% / 86% |

**Notes on the data:**

- **Server CPU:** taken from cumulative CPU time (`ps -o time`), sampled every second. An earlier 5,000 run,
  not kept, used macOS `ps %cpu` and read about the same (64% mean, 83% max). The mean includes the idle
  seconds at the start of the ramp and in the drain.
- **Older runs:** `3500/`, `5000/` and `5000-no-cursors/` ran before the drain waited for acks and before
  `ops.unacked` existed, so that field is absent from their `result.json`. All their ops were echoed. In
  `5000-no-cursors/`, one op of 943 was echoed but its ack arrived after the drain ended (acked 942). That is
  the race the drain now waits out, not a lost op.
- **Percentiles mix phases:** they cover the ramp and the steady state together.

## Re-runs on the committed server

All on the committed server, **HEAD `15210d3`** (`server/` and `packages/` clean against it), in a copy of the
repo, with the p8-load2 load client. Same command and machine as above, 5,000 clients, varying only the
annotators (writers = 5 editors + annotators). Run one after another, in the order listed, with nothing else of
mine running. **The Mac was busy:** load average 4 to 15 (1-minute) across the runs, partly from the run itself (6
workers + the server ≈ 5 cores) and partly from other sessions (Herdr at ~100% of a core, a VM at ~50%). Folders
under `p8-load2/` hold `result.json` and `report.md` (no tokens). Generator CPU is the load-phase mean (worst
worker); every run was valid and complete (5,000/5,000 joined).

| Run (folder) | Writers | Load avg before | Echoed | Resyncs | Editor ack p50 / p99 | Viewer delivery p50 / p99 / max | Gen lag p99 (worst) / CPU mean | Server CPU mean / max |
|---|---|---|---|---|---|---|---|---|
| `p8-load2/k105` | 105 | 4.1 | 952/952 | 0 | 215 / 1,320 | 318 / **1,316** / 1,497 | 18 ms / 66% | 79% / 95% |
| `p8-load2/k105b` | 105 | 6.8 | 944/944 | 0 | 241 / 782 | 304 / **852** / 1,058 | 7 ms / 68% | 79% / 96% |
| `p8-load2/k105c` | 105 | 8.5 | 956/956 | 0 | 154 / 1,152 | 279 / **1,133** / 1,486 | 9 ms / 67% | 80% / 97% |
| `p8-load2/k150` | 150 | 8.1 | 1,205/1,205 | **5** | 3,957 / 20,801 | 3,212 / **19,982** / 20,896 | 28 ms / 56% | 77% / 94% |
| `p8-load2/k200` | 200 | 11.6 | 1,482/1,482 | **189** | 4,590 / 26,189 | 4,466 / **25,219** / 27,959 | 36 ms / 56% | 69% / 91% |
| `p8-load2/k150b` | 150 | 13.6 | 1,225/1,225 | **5** | 3,229 / 18,932 | 2,866 / **17,689** / 19,283 | 23 ms / 58% | 79% / 94% |
| `p8-load2/k105d` (right after `k150b`) | 105 | 13.8 | 970/970 | 0 | 330 / 1,119 | 420 / **1,164** / 1,370 | 9 ms / 64% | 79% / 96% |
| `p8-load2/k125` | 125 | 14.8 | 1,119/1,119 | 0 | 2,466 / 9,056 | 1,283 / **8,523** / 9,311 | 19 ms / 60% | 81% / 95% |
| `p8-load2/k125b` | 125 | 4.5 | 1,096/1,097 acked 1,097 | **6** | 1,562 / 13,211 | 2,029 / **12,380** / 24,876 | 36 ms / 41% | 55% / 95% |
| `p8-load2/k105e` (right after `k125b`) | 105 | 10.4 | 969/969 | 0 | 454 / 3,843 | 609 / **3,385** / 3,944 | 18 ms / 61% | 79% / 96% |

(Order of the runs: as listed. No op was lost in any run: every op sent was acked. In `k125b` one acked op's echo
had not reached its client, which was resyncing, when the drain ended.)

## Reading (corrected)

- **What is measured:** on the committed server, 5,000 clients against one node with 105 writers (5 editors,
  100 annotators) stayed under the 1 s viewer NFR in the verifier's 3 runs (p8-loadv: viewer p99 0.72, 0.88 and
  0.73 s). In 5 p8-load2 runs on a busier machine it gave 1.32, 0.85, 1.13, 1.16 and 3.4 s (the 3.4 s right after
  a degraded 125-writer run). No resyncs at 105 writers.
- **75 writers and 2,000 clients reproduce:** the verifier's re-runs matched the builder's numbers within noise.
- **Editors' ack p99 is over the 150 ms editor target at 5,000 clients** (448 ms at 75 writers, 0.6-0.9 s at
  105 writers). That is a real finding for engine, not tied to the degraded runs.
- **Two earlier 105-writer runs degraded, cause unknown.** `5000/` (viewer p99 12.4 s, 5 resyncs) and
  `5000-no-cursors/` (p99 2.4 s) ran at 13:45 on the shared working tree while `server/` held another session's
  uncommitted edits (the role cache, since committed as `15210d3`). In both, the server used less CPU (61% mean)
  than in the lighter 75-writer run. Neither the server before `5b272ad` nor the one at `15210d3` reproduced it.
- **Resting only on those two degraded runs** (so: unconfirmed leads, not findings):
  - "the knee is load × fan-out, not viewer count", and the step of 8 ops/s and 30 cursor senders as its trigger;
  - "presence fan-out is the larger share" (from cursors off: 12.4 s down to 2.4 s);
  - editor ack p99 (13.4 s) far above annotator ack p99 (3.3 s);
  - the engine suspects: the gateway's per-board send path (one send at a time, with `breathe()` yields), Bun's
    per-socket send cost, and the macOS loopback.
- **The knee:** on this (busy) Mac and the committed server, **degradation starts around 105 writers at 5,000
  clients and is clear by 125.** 105 writers: viewer p99 0.72-1.32 s in 7 runs, 3.4 s in an 8th. 125 writers:
  8.5 s and 12.4 s (6 resyncs) in 2 runs. 150 writers: 18-20 s with 5 resyncs, twice. 200 writers: 25 s, 189
  resyncs. The generator stayed valid throughout (lag p99 ≤ 36 ms, load-phase CPU ≤ 68%). The server's mean CPU
  stayed at 55-81% of a core (max 91-97%), so it is not simply pinned at 100%; where it saturates is still not
  diagnosed. Not checked: the same steps on a quiet machine, and finer steps between 105 and 125.
- **The generator was never the limit.** In the first table's runs, event-loop lag p99 stayed ≤ 14 ms per worker
  (the limit is 100 ms); in the re-runs ≤ 36 ms. Every run is valid. (Since p8-load2 the CPU limit is judged over the load phase only; these runs' load-phase
  means were not recorded separately.)
- **Joins:** the ramp ran at 500/s with 0 refusals at every size. The OS listen backlog (`kern.ipc.somaxconn`
  128) never showed up as connect errors.
