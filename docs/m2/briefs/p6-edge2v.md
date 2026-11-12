# Brief: p6-edge2v (verify ws backpressure + sign-in test gaps)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md).
Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers"). You are the verifier; you were not the builder.

- **Your tab:** `verifier p6-edge2v (client) · <id>: ws backpressure`. Name `plenary-p6-edge2v`. Manager: `manager
  client` (t14k). Report to your manager only (never message the proxy).
- **Where:** main. Read only. You own docs/m2/reports/p6-edge2v.md and your scratchpad.

## The job you check

Builder brief: docs/m2/briefs/p6-edge2.md, plus the manager's decision: the hard-cap drop needs BOTH bytes over the cap
AND no drain progress for 10 s (a slow but moving link is never dropped). The work: `git diff -- web test/web` on main
(web/ports/transport.js, web/adapters/transport/ws.js, test/web/contracts/{transport-contract,reference-transport}.js,
reference-transport.test.js, test/web/adapters/transport-ws.test.js, test/web/core/signin.test.js). The findings it
closes: docs/m2/reports/p6-edgev.md M1 and M2.

## Check

1. `bun test` passes; no existing contract assertion weakened (diff).
2. Mutations in a scratch copy, each must fail a test: no watermark; `congested()` always false; the pre-open queue capped
   by count only; drop on bytes alone (slow link dropped); no drop when fully stalled; drop counted for an old
   connection; console logging of code/token in signin; Math.random used for jitter; a percent-encoded code accepted.
3. Timing: the 10 s no-progress window and the watermark run on the injected clock (no global timers when a clock is
   given); a slow-drain fake that drains 1 byte per tick never drops; flakiness: run the new tests 30 times.
4. CHECKER: does the port text tell the core enough to drop presence and keep ops; ops still wait behind the backlog
   (builder's residual): is that acceptable for the < 150 ms editor NFR, and what should p6-hex/engine do.
5. Risks the builder named: other transports (localRoom, sharedNet) don't implement `congested()` yet (p6-hex);
   clock fallback to global timers if the root forgets it.

## sdd, processes

Single harness unless more pass check_adapter; confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p6-edge2v.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check
(CHECKER)"; what you did NOT check. HIGH = a surviving mutant above, a weakened contract, a slow link dropped, a stalled
link never dropped, or a flaky new test. Stop.
