# Brief: p5-tidy3v (verify round 3 of p5-tidy)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-tidy3v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or tokens. No pkill/killall. Containers you start: record the id, remove only that one. Do not edit code; do not
commit. Mutations and scratch worktrees in your scratchpad. Stop at 60% context after writing what you have.

## Job under check

Builder ran p5-tidy3 (brief docs/m2/briefs/p5-tidy3.md; "Round 3" at the end of docs/m2/reports/p5-tidy.md), fixing
V1-V8 from docs/m2/reports/p5-tidyv.md. Read the builder's claims as claims. Diff the job files against HEAD.

## Check

- **V1:** every CLI path that echoes operator input (argv, env, DB names, paths) reaches stderr escaped; `od -c` on
  real stderr for DEL, C1, RLO via `--data-dir`, `PLENARY_DATA_DIR`, `DATABASE_URL` db name (Podman Postgres).
- **V2/V3:** rerun your round-2 `drop.js` probes against the new code: mid-body reset (200, 500) gives
  `idp_unreachable`; empty bodies match the documented label; timeouts still `idp_timeout`. No other L2 row moved
  without a stated reason.
- **V4:** long values with a trailing unsafe char never show a half escape and never hide the reason.
- **V5:** redo E8, E9, E11, E12, E13; each must now be killed. The table test reads p5-google2.md (e).
- **V6-V8:** wording matches the code.
- **No regressions:** redo round 2's 13 mutations and the builder's new ones. Nothing logged leaks a secret.
- **Gates:** as in p5-tidyv.md; name each failure and whether it is this job's.
- **sdd ensemble review** of the diff (codex + one more harness passing check_adapter). Confirm or refute each with a
  run.

## Done when

docs/m2/reports/p5-tidy3v.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets). Then stop.
