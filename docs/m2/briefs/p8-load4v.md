# Brief: p8-load4v (verify p8-load4, fix round 4 for the load client)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load4v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not edit code; do
not commit. **Mutations and load runs only in a copy of the repo in your scratchpad (`git archive HEAD` plus the
uncommitted files below, never .env), never in /Users/r/repos/plenary. The copy must never contain .env; check with
`find <copy> -name .env` before every run.** Set `TMPDIR` to your scratchpad for every run. Leave alone processes you
did not start (nats-servers, any other session's postgres, `server/main.js` or `scripts/load/run.js`). Another worker
(p8-rig4v) works on scripts/cluster-rig.js and test/deploy/*: ignore those. Ports from port 0. Stop at 60% context
after writing what you have.

## Job under check

Round 3 verifier p8-load3v FAILED p8-load3 (docs/m2/reports/p8-load3v.md: MEDIUM welcome-then-stall reads VALID, plus
LOWs: SIGKILL to run.js leaves the server, `server.cpuPct.loadMean` untested, `--tokens ""` ignored, no upper bounds
and `Number()` quirks, README "same window" wording, R2 test). Builder p8-load4 claims all fixed (brief
docs/m2/briefs/p8-load4.md, report docs/m2/reports/p8-load4.md). Files (real tree, uncommitted):
scripts/load/{run,server,tokens,worker,client}.js, test/load/{counting,load,guards,guards4}.test.js,
docs/m2/load/2026-11-12-calibration/README.md. Read claims as claims. CHECKER mode: try to break it.

## Check

- **MEDIUM:** re-run p8-load3v's `stall.js` and `crash.js` probes (in
  `/private/tmp/claude-501/-Users-r-repos-plenary/7ff487de-a6fe-4d9f-8162-d8694f2f765e/scratchpad/probes/`, read-only:
  copy them) plus new variants: welcome then stall after some ops; acks but no echoes; echoes but no acks; rejoin
  refused mid-run. None may read VALID. A healthy run, and a healthy `--op-rate 0` run, must not read INCOMPLETE.
- **Orphans:** SIGKILL run.js before the server, mid-ramp and mid-drain: no server or worker left (process list
  before and after). Is the server's parent-death watch sound if the PID is reused?
- **Arguments:** empty strings for every string flag; `0x1`, `1e3`, `+5`, ` 5`, `5.`, `Infinity`, huge values: each
  refused with exit 2, or accepted, as `--help` says. Caps stated in `--help` match the code.
- **Secrets:** no token or .env value in stdout, stderr, result.json or the markdown output on any error path.
- **Docs:** README wording now matches the folders it describes (spot-check against the result.json files).
- **Mutations:** re-apply 8 of the builder's mutations of your choice plus 3 of your own, each alone; each must fail
  `bun test test/load`.
- **Gates:** `bun test test/load` 3x in your copy; `bun test test/architecture.test.js` in the real tree (read-only
  run). Process list before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-load4v.md: PASS or FAIL (round 4), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping. Then stop.
