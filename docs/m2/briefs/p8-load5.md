# Brief: p8-load5 (fix round 5 for the load client: the MEDIUM and 2 LOWs from p8-load4v)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load5.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall, no ipcrm: stop only PIDs you started and recorded. Do not
commit. **Work, tests and mutations only in a copy in your scratchpad: `git archive HEAD` plus this job's files from
the real tree (scripts/load/*, test/load/*, docs/m2/load/2026-11-12-calibration/README.md). The copy must never
contain .env; check with `find <copy> -name .env` before every run.** Set `TMPDIR` to your scratchpad for every run.
When done and green, sync only your files back into /Users/r/repos/plenary (check first that the real-tree versions
still equal what you copied). Leave alone processes you did not start. Never edit server/*, packages/*, PROTOCOL.md,
scripts/cluster-rig.js, test/deploy/* or deploy/README.md. Ports from port 0. After every mutation batch, `ps` for
leftovers of your copy and stop them by PID. Stop at 60% context after writing what you have.

## Job

Verifier p8-load4v FAILED p8-load4 (round 4): docs/m2/reports/p8-load4v.md (read it whole; its probes, `var.js`
included, are in `/private/tmp/claude-501/-Users-r-repos-plenary/43028fc9-84a7-4fcf-8c22-11568d0d98b9/scratchpad/probes/`,
read-only for you: copy what you need). Manager's ruling: the "not judged" disclosure does not close finding 1; the
p8-load4 brief required it. Fix:

1. **MEDIUM, drop everyone mid-run and refuse rejoins reads VALID.** Rule on staying connected, not only on ops
   made. Both of these make the run INCOMPLETE (exit 1), each with a reason naming the numbers:
   - `clients.connectedAtEnd < clients.planned` (any client not connected when generation ends), and
   - for a due writer role, ops skipped offline exceed ops made (`skippedOffline > made`).
   Re-check both against the 15 calibration `result.json` files (the verifier found neither flips one; confirm) and
   against a healthy `--local` run. Turn `dropMid` and `dropMidErr` (and a partial form: drop half the clients for
   good) into tests. Update the README "Not judged" lines and the `run.js` header comment so they are true.
2. **LOW, the due rule ignores join time.** Start each client's due clock at its welcome, not at connect, so a slow
   welcome on a healthy server cannot read INCOMPLETE. Test: the verifier's `slowWelcome` repro reads VALID.
3. **LOW, unknown flags and flag-as-value.** Refuse unknown flags (`--op_rate 5`) and a value that is itself a flag
   (`--tokens --local`) with exit 2 and a message naming the flag. Also read `--rig` through `parseOptions` before
   `rigConfig`, so `--rig " "` gets the normal empty-flag message. Optional: cap the ramp duration (state it in
   `--help`).

## Done when

Each fix has a test, and a mutation that reverts it alone fails `bun test test/load`; re-run the verifier's
`dropMid`, `dropMidErr` and `slowWelcome` repros, and p8-load3v's stall/crash probes. Gates: `bun test test/load`
3x in your copy, `bun test test/architecture.test.js` in the real tree (read-only). Report docs/m2/reports/p8-load5.md:
changes and guards per finding, mutations, gates, housekeeping (processes before/after), not verified. Then stop.
