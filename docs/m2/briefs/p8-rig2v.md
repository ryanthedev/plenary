# Brief: p8-rig2v (verify p8-rig2, the fix round for the local cluster rig)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig2v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded (a rig's own
`down` on a rig dir you created counts). Do not edit code; do not commit. **Mutations and rig runs only in a copy of
the repo in your scratchpad (`git worktree add` or `cp -R`), never in /Users/r/repos/plenary.** Leave nats-server
PIDs 53168 and 62656 alone (not yours). Another worker (p8-load2) works on scripts/load/* and test/load/*: ignore
those. Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Round 1 verifier p8-rigv FAILED p8-rig (docs/m2/reports/p8-rigv.md: H1 TZ/locale process identity, M1 saves to
rig.json's dir not --dir, M2 loopback binding untested, plus LOWs). Builder p8-rig2 claims all fixed (brief
docs/m2/briefs/p8-rig2.md, report docs/m2/reports/p8-rig2.md). Files: scripts/cluster-rig.js, test/deploy/*,
deploy/cluster/RIG.md, deploy/cluster/Caddyfile, deploy/cluster.compose.yml, `.rig/` in .gitignore, and the manager's
COMPOSITION_ROOTS line in test/architecture.test.js. Read claims as claims. CHECKER mode: try to break it.

## Check

- **H1 for real:** `up` under one TZ and locale, then `status`, `kill <node>` and `down` under others (several TZs,
  LC_ALL/LANG variants, e.g. de_DE, ja_JP): every rig process stops; a second `up` against a live dir refuses and
  never rmSyncs. The old-rig.json refusal: is the message clear, and can it wrongly refuse or wrongly allow (PID
  reused by an unrelated process; partially-live rigs)? Any other place lstart or ps output is read without PS_ENV?
- **M1:** a rig.json copied or moved to another dir; every command uses and writes only the dir named.
- **M2:** the binding tests; re-apply the round 1 binding mutations and any others you think of; each must fail.
- **Regressions:** the round 1 checks still hold (only-ours teardown, crash midway leaves nothing, no secrets in
  output/logs/status --json, 0600 files, real main.js through Caddy with POST /boards and a WebSocket hello).
- **Gates:** `bun test test/deploy` 3x in your copy; `bun test test/architecture.test.js` in the real tree
  (read-only run). Process list before and after your work: nothing of yours left.

## Done when

docs/m2/reports/p8-rig2v.md: PASS or FAIL (round 2), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping. Then stop.
