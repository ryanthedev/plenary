# Brief: p8-rig3v (verify p8-rig3, fix round 3 for the local cluster rig)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig3v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded (a rig's own
`down` on a rig dir you created counts). No `ipcrm` of any segment you did not create in this job. Do not edit code; do
not commit. **Mutations and rig runs only in a copy of the repo in your scratchpad (rsync/cp with `--exclude .env`),
never in /Users/r/repos/plenary. The copy must never contain .env; check with `find <copy> -name .env` before every
run.** Set `TMPDIR` to your scratchpad for every run. Leave alone processes you did not start (e.g. nats-server 19379,
any other session's postgres or main.js). Another worker (p8-load3) works on scripts/load/* and test/load/*: ignore
those. Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Round 2 verifier p8-rig2v FAILED p8-rig2 (docs/m2/reports/p8-rig2v.md: H2 `ps` failure fails open, M3 initdb-window
race, L6 moved rig dir, L7 stale e2e skip, L8 refusal message). Builder p8-rig3 claims all fixed plus a Leaks item
(no leaked nats-server/postgres/node after a failed or killed run), SysV segment cleanup after a SIGKILLed postmaster,
and the e2e now running real cluster mode on HEAD (brief docs/m2/briefs/p8-rig3.md, report docs/m2/reports/p8-rig3.md).
Files (real tree, uncommitted): scripts/cluster-rig.js, test/deploy/*, deploy/cluster/RIG.md,
deploy/cluster.compose.yml (comments), deploy/cluster/Caddyfile, `.rig/` in .gitignore, the manager's COMPOSITION_ROOTS
lines in test/architecture.test.js. Read claims as claims. CHECKER mode: try to break it.

## Check

- **H2:** PATH without ps, a stub ps that exits non-zero, one that prints garbage, one that hangs: `up`, `down`,
  `kill`, `status` and the old-format refusal each refuse clearly; rig.json and `pg/` untouched. A process started but
  not yet recorded is still stopped by `down` and by a failed `up`'s cleanup.
- **M3:** two and three concurrent `up`s on one dir: exactly one proceeds, the dir is never wiped. Stale lock (holder
  dead, or PID reused by an unrelated process): handled without wrongly refusing forever or wrongly proceeding.
- **L6:** a moved/copied rig dir: every command uses only the dir given.
- **Leaks:** SIGTERM, SIGINT and SIGKILL an `up` at several points, and kill a test run midway: no nats-server,
  postgres or node tied to the rig dir remains. `ipcs -m` segment count before and after each; say which of your runs
  left a segment and whether the new removeOrphanShm logic can ever remove a segment that is not the rig's own
  (key/id reuse, NATTCH > 0, another user's or session's postgres).
- **e2e:** is it really real cluster mode (2 gateway-only + 1 host-only nodes, shared Postgres + NATS, through Caddy),
  and does it pass 3x? Any hidden skip?
- **p4-wire constraints (docs/m2/reports/p4-wirev.md):** NATS auth-less in compose and rig; every app node sets
  PLENARY_ROLES; node ids start and end alphanumeric. Stale compose comments gone.
- **Regressions:** round 1 and 2 checks still hold (TZ/locale identity, only-ours teardown, 0600 files, no secrets in
  output/logs/status --json, loopback binding).
- **Mutations:** re-apply each builder mutation alone plus your own; each must fail `bun test test/deploy`.
- **Gates:** `bun test test/deploy` 3x in your copy; `bun test test/architecture.test.js` in the real tree (read-only
  run). Process list and `ipcs -m` before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-rig3v.md: PASS or FAIL (round 3), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping (processes and segments). Then stop.
