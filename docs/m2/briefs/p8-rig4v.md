# Brief: p8-rig4v (verify p8-rig4, fix round 4 for the local cluster rig)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig4v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded (a rig's own
`down` on a rig dir you created counts). No `ipcrm` of any segment you did not create in this job. Do not edit code; do
not commit. **Mutations and rig runs only in a copy of the repo in your scratchpad (rsync with `--exclude .env
--exclude .rig --exclude .git`), never in /Users/r/repos/plenary. The copy must never contain .env; check with
`find <copy> -name .env` before every run.** Set `TMPDIR` to your scratchpad for every run. Leave alone processes you
did not start (nats-servers, any other session's postgres or main.js). Another worker (p8-load4v) works on
scripts/load/* and test/load/*: ignore those. Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Round 3 verifier p8-rig3v FAILED p8-rig3 (docs/m2/reports/p8-rig3v.md: HIGH A a `ps` failing once leaves an
unrecorded child; MEDIUM C a failing `save` in the catch skips cleanup; LOWs B lock race, D one-shot shm cleanup,
E compose comments). Builder p8-rig4 claims all fixed, B closed in code with an `up.lock.break` lock (brief
docs/m2/briefs/p8-rig4.md, report docs/m2/reports/p8-rig4.md). Files (real tree, uncommitted): scripts/cluster-rig.js,
test/deploy/*, deploy/cluster/RIG.md, deploy/cluster.compose.yml (comments), deploy/cluster/Caddyfile, `.rig/` in
.gitignore, the manager's COMPOSITION_ROOTS lines in test/architecture.test.js. Engine's p4-wire2 (uncommitted,
server/*) is in the tree: run the e2e against it. Read claims as claims. CHECKER mode: try to break it.

## Check

- **A:** re-run p8-rig3v's A repro (attack scripts under
  `/private/tmp/claude-501/-Users-r-repos-plenary/*/scratchpad/atk/`, read-only: copy them) for nats-server and for
  postgres, plus `ps` failing on the 2nd and 3rd probe: no process left, `pg/` never wiped under a live postmaster.
- **C:** the `rig.json.tmp`-is-a-directory repro and another way to make `save` throw: cleanup still runs.
- **B:** 2 and 3 concurrent `up`s with a stale lock, with a left-over `up.lock.break`, and with the break holder
  killed midway: never two holders, never refused forever without a clear message naming the file to remove.
- **D:** can the retry ever remove a segment that is not the rig's own (id/key reuse, another user's or session's
  postgres, NATTCH rising again)? Is the 5 s bound honoured?
- **E and RIG.md:** compose comments and RIG.md's env lines true against server/main.js as it is now.
- **Regressions:** round 1-3 checks still hold (only-ours teardown, 0600 files, no secrets in output or status
  --json, loopback binding, `ps` missing/failing/hanging refuses clearly).
- **Mutations:** re-apply each builder mutation alone plus 3 of your own; each must fail `bun test test/deploy`.
- **Gates:** `bun test test/deploy` 3x in your copy; `bun test test/architecture.test.js` in the real tree (read-only
  run). Process list and `ipcs -m -o -p` before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-rig4v.md: PASS or FAIL (round 4), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping (processes and segments). Then stop.
