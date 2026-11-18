# Brief: p8-rigv (verify p8-rig, the local cluster rig)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rigv.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded (a rig's own
`down` on a rig dir you created counts). Do not edit code; do not commit. **Mutations only in a copy of the repo in
your scratchpad (`git worktree add` or `cp -R`), never in /Users/r/repos/plenary**: p8-rig's own mutation runs in
the shared tree broke another session's test run and left an orphan nats-server (PID 62656; not yours, leave it).
Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Builder p8-rig (brief docs/m2/briefs/p8-rig.md, report docs/m2/reports/p8-rig.md). Files: scripts/cluster-rig.js,
test/deploy/*, deploy/cluster/RIG.md, deploy/cluster/Caddyfile, deploy/cluster.compose.yml, the `.rig/` line in
.gitignore, plus the manager's one line in test/architecture.test.js (COMPOSITION_ROOTS gains scripts/cluster-rig.js).
Read the builder's claims as claims. Diff against HEAD. CHECKER mode: try to break it.

## Check

- **Teardown only-ours:** `down`/`stopRig`/`kill <node>` signal only PIDs recorded in rig.json and only when the
  process still matches (PID reuse: a recorded PID now owned by another program must not be killed; prove with a
  rig.json you edit in your copy). `down` after the `up` process was SIGKILLed works from rig.json alone.
- **Crash midway:** make each start step fail in turn (bad postgres bin, NATS port taken, node that exits, caddy
  missing/failing, SIGINT/SIGTERM to `up` mid-start): nothing it started stays alive, no port held.
- **Secrets:** COOKIE_KEY, SESSION_KEY and tokens never in stdout/stderr of up/status/down/kill, in rig logs you
  would share, or in `status --json`; key and token files are 0600; nodes get only the env they need.
- **Postgres/NATS/Caddy:** trust auth bound to 127.0.0.1 only; NATS max_payload 2 MB; Caddy proxies every path and
  WebSockets; health waits are real (not sleeps) with clear timeout errors.
- **Real main.js:** `up` with the real server, POST /boards and a WebSocket hello through the LB; process list
  before/after `down`.
- **Compose:** `podman compose config` (or podman-compose) parses deploy/cluster.compose.yml; header still says NOT
  FUNCTIONAL and names what main.js is missing; env names match engine's contract (brief "Env contract").
- **Mutations:** redo the builder's guard mutations in your copy and add your own; each must fail a test.
- **Gates:** `bun test test/deploy` 3x in your copy; full `bun test` once in the real tree (no mutations there);
  name each failure and whether it is this job's (scripts/load/* architecture failures are p8-load's, still running).

## Done when

docs/m2/reports/p8-rigv.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets). Then stop.
