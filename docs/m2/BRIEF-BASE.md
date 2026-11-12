# Base brief (every builder and verifier)

- You are one session on the Plenary M2 team. Manual: docs/m2/OFFICE.md. Plan: docs/m2/PLAN.md. Rules: CLAUDE.md.
- Touch only the files your brief says you own. Need a change elsewhere? Write it in your report; don't make it.
- Protocol changes start in PROTOCOL.md, then code, then a test. packages/protocol stays pure (test/purity.test.js).
  Plain JS + JSDoc, no build step, where code may run in Herdr.
- Every feature gets tests; `bun test` must pass before you report.
- Don't commit or push unless your brief says so; your manager commits.
- Hand off at ~60% context (OFFICE.md, Recycling).
- Report to docs/m2/reports/<job>.md: what changed (files), tests added, how you checked it, what you did NOT
  verify, risks. Then stop and leave your session idle.
- Blocked on a decision? Write the question as the last line of your pane and in the report; your manager reads it.
- sdd helpers (OFFICE.md, "sdd helpers"; load `sdd:subagent-driven-development` first): verifiers add an sdd
  ensemble review of the diff (codex + agy + any harness passing check_adapter; two agreeing = HIGH candidate,
  confirm or refute it); builders may farm file-disjoint sub-tasks (tests, fixtures, boilerplate) to harnesses in
  git worktrees and own the diff; check usage/quota before a big fan-out. Your Herdr tab still owns the job.
- Never `pkill`/`killall` by pattern (OFFICE.md, Cleaning up sessions): record the PIDs of browsers and servers you
  start, kill only those, and use free ports (port 0), never hard-coded ones.
- Architecture (OFFICE.md, "Architecture"): hexagonal. Core code depends only on ports; adapters live in their own
  folder and never import each other; only composition roots (server/main.js, the web entry) wire adapters; every
  adapter passes its port's contract test. For any design-bearing job, apply the `distributed-systems-design` skill
  (builders: APPLIER mode before coding; verifiers: CHECKER mode on the design) and say so in your report.
