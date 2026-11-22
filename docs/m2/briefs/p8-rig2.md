# Brief: p8-rig2 (fix round for p8-rig after verifier FAIL)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig2.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not
commit. **Mutation runs only in a copy of the repo in your scratchpad (`git worktree add` or `cp -R`), never in
/Users/r/repos/plenary.** Leave nats-server PIDs 53168 and 62656 alone (not yours). Ports from port 0. Stop at 60%
context after writing what you have.

## Context

p8-rig (builder report docs/m2/reports/p8-rig.md) built the local cluster rig. Verifier p8-rigv FAILED it:
read docs/m2/reports/p8-rigv.md in full first. Your files: scripts/cluster-rig.js, test/deploy/*,
deploy/cluster/RIG.md (only if behaviour you document changes). Nothing else.

## Fix

- **H1 (HIGH), process identity depends on TZ/locale.** `psInfo`/`isOurs` (scripts/cluster-rig.js ~63-76) compare
  `ps -o lstart=` text produced under the caller's env. Run ps with a fixed env (`{ PATH, LC_ALL: "C", TZ: "UTC" }`)
  wherever lstart is recorded or compared, including the test helper (test/deploy/cluster-rig.test.js ~111). Old
  rig.json files recorded under another TZ: decide (refuse with a clear message, or re-normalise) and say which.
  **Test:** `up` under TZ=UTC (and one locale), then `status`/`down` under a different TZ and LANG/LC_ALL: every
  rig process stops; a second `up` in another TZ against a live rig dir refuses and does not rmSync it.
- **M1 (MEDIUM), saves to rig.dir from rig.json, not the --dir given.** `stopRig`/`rigStatus`/`killNode`
  (~80-84, 311-329): use the dir passed in; refuse on mismatch with rig.json's `dir` (or overwrite `rig.dir`; pick
  one, say why). **Test:** a rig.json copied to another dir never writes the original rig's file.
- **M2 (LOW), loopback binding untested.** Add a test that, with a rig up, proves Postgres, NATS and Caddy listen
  on 127.0.0.1 only (lsof, NATS /varz, or `show listen_addresses`; whatever is robust on macOS). The verifier's 3
  surviving binding mutations must now fail.
- **Optional, if cheap:** L1 (test the SIGKILL escalation and health-wait timeout), L5 (secrets test also scans
  logs/). Leave L2-L4 documented in RIG.md as known limits if not fixed.

## Gates

- Redo the verifier's H1 repro and the 3 binding mutations in your copy; each must now fail a test.
- `bun test test/deploy` 3x in your copy, all green.
- `bun test test/architecture.test.js` in the real tree (read-only run).

## Done when

docs/m2/reports/p8-rig2.md lists each finding with the change, the test that guards it, mutation results and gate
output. Then stop.
