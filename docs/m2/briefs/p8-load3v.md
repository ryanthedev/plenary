# Brief: p8-load3v (verify p8-load3, fix round 3 for the load client)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load3v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not edit code; do
not commit. **Mutations and load runs only in a copy of the repo in your scratchpad (rsync/cp of HEAD plus the
uncommitted files, with `--exclude .env`), never in /Users/r/repos/plenary. The copy must never contain .env; check
with `find <copy> -name .env` before every run.** Set `TMPDIR` to your scratchpad for every run. Leave alone
processes you did not start (e.g. nats-server 19379, any other session's postgres, `server/main.js` or
`scripts/load/run.js`). Another worker (p8-rig3v) works on scripts/cluster-rig.js and test/deploy/*: ignore those.
Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Round 2 verifier p8-load2v PASSED p8-load2 with 10 LOWs (docs/m2/reports/p8-load2v.md). Builder p8-load3 claims all
10 fixed (brief docs/m2/briefs/p8-load3.md, report docs/m2/reports/p8-load3.md). It worked on base 448ca84; check on
HEAD. Files (real tree, uncommitted): scripts/load/{run,server,tokens,worker}.js, test/load/{counting,load}.test.js,
new test/load/guards.test.js, docs/m2/load/2026-11-12-calibration/README.md, the correction note at the top of
docs/m2/reports/p8-load2.md. Read claims as claims. CHECKER mode: try to break it.

## Check

- **Each of the 10 findings:** one breaking input each beyond the builder's tests.
- **Finding 3, completeness rule:** can a run with lost acks or echoes still print VALID, or a healthy run print
  INCOMPLETE (off-by-one at 99%, zero ops, ops sent during the drain)?
- **Finding 4, children:** SIGTERM/SIGINT/SIGHUP/SIGKILL to run.js at several points (before the server, mid-ramp,
  mid-drain), and a failing worker: no server or worker left; process list before and after.
- **Finding 8, CPU:** is load-phase CPU measured over exactly the load phase? Can a run be VALID with CPU unmeasured?
- **Secrets:** no token or .env value in stdout, stderr, result.json or the markdown output, including every error
  path.
- **Docs:** the README and the p8-load2.md correction say only what the runs support (spot-check 3 numbers against
  the result.json files).
- **Mutations:** re-apply 10 of the builder's G-mutations of your choice plus 3 of your own, each alone; each must
  fail `bun test test/load`. Check the 6 survivors: are they really equivalent or already known?
- **Gates:** `bun test test/load` 3x in your copy on HEAD; `bun test test/architecture.test.js` in the real tree
  (read-only run). Process list before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-load3v.md: PASS or FAIL (round 3), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping. Then stop.
