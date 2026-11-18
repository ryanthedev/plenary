# Brief: p8-load4 (fix round 4 for the load client: the MEDIUM and LOWs from p8-load3v)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load4.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not commit.
**Work, tests and mutations only in a copy in your scratchpad: `git archive HEAD` plus this job's files from the real
tree (scripts/load/{run,server,tokens,worker,client}.js as needed, test/load/*, docs/m2/load/2026-11-12-calibration/
README.md). The copy must never contain .env; check with `find <copy> -name .env` before every run.** Set `TMPDIR` to
your scratchpad for every run. When done and green, sync only your files back into /Users/r/repos/plenary (check
first that the real-tree versions still equal what you copied). Leave alone processes you did not start (nats-servers,
any other session's postgres, `server/main.js` or `scripts/load/run.js`). Never edit server/*, packages/*, PROTOCOL.md,
scripts/cluster-rig.js or test/deploy/*. Ports from port 0. After every mutation batch, `ps` for leftovers of your copy
and stop them by PID. Stop at 60% context after writing what you have.

## Job

Verifier p8-load3v FAILED p8-load3 (round 3) on 1 MEDIUM plus 5 LOWs: docs/m2/reports/p8-load3v.md (read it whole;
its probes `stall.js`, `crash.js`, `sig.js`, `presig.js` are in
`/private/tmp/claude-501/-Users-r-repos-plenary/7ff487de-a6fe-4d9f-8162-d8694f2f765e/scratchpad/probes/`, read-only
for you: copy what you need). Fix all of them:

1. **MEDIUM, welcome-then-stall reads VALID.** A server that welcomes and then never sends catch-up, or closes
   everyone and refuses rejoins, gives 0 ops sent and VALID, exit 0. The rule must make that INCOMPLETE (exit 1):
   count ops when made, not when first written, and/or require `ops.unanswered === 0` and `sent > 0` whenever writers
   with a positive op rate were planned. A healthy run with `--op-rate 0` (no ops planned) must still be judged
   sensibly; say what it reads and why. Turn both probes into tests.
2. **LOW, SIGKILL to run.js leaves the server running.** Make the `--local` server exit when its parent dies (as
   the workers do, or another way you can test), and add a test for the worker orphan watch (mutation O2 survived).
3. **LOW, `server.cpuPct.loadMean` untested** (mutation O4 survived): guard it.
4. **LOW, `--tokens ""` ignored:** refuse empty string flags with exit 2, like the empty numbers.
5. **LOW, no upper bounds and `Number()` quirks:** sane caps on durations and counts (state them in `--help`), and
   accept only plain decimal numbers (`0x1`, `1e3` for counts refused).
6. **LOW (docs), README "same window as below"** is wrong for `2000/` and `3500/`: fix the wording.
7. **Also:** a test for R2 (an ack counted twice must not make a missing ack look answered).

## Done when

Each fix has a test, and a mutation that reverts it alone fails `bun test test/load`; re-run p8-load3v's O2 and O4
and the G3 series. Gates: `bun test test/load` 3x in your copy, `bun test test/architecture.test.js` in the real tree
(read-only). Report docs/m2/reports/p8-load4.md: changes and guards per finding, mutations, gates, housekeeping
(processes before/after), not verified. Then stop.
