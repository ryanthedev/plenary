# Brief: p8-tidyv round 4 (re-verify the client tidy job)

You are the p8-tidyv verifier (t1j2), same rules as docs/m2/briefs/p8-tidyv.md (read only on main, mutants in a scratch
worktree, report to t14k only, never message the proxy t1bx). The builder's round-4 brief is docs/m2/briefs/p8-tidy4.md;
its report is the "Round 4" section of docs/m2/reports/p8-tidy.md. Manager ruling: R3-H1 is a MEDIUM (timing only), fixed
this round anyway.

Context: after this job lands, engine job p-scan moves test/arch-scan.js onto Bun.Transpiler, and a later client job moves
the globals check in test/web/architecture.test.js onto the parser. So a new regex evasion found this round is reported,
but rated LOW unless it is something plain code would write by accident; a MEDIUM or HIGH needs that case made.

## Check

1. **R3-H1:** the new ui-app case fails with V-R3a (`onHeard()` above `if (closed || down) return;` in web/core/sync.js)
   and passes without it.
2. **R3-M1:** your five lines are caught; round 2's and 3's postfix cases still pass; V-ev2 dies.
3. **R3-L1:** the builder departed from the brief: `of` is a keyword only inside a `for (` head, not by the line-break
   rule, because `for (x\nof /re/)` is a legal head. Confirm or refute; your `const z = y\nof / 2; import(d)` case is
   caught and the round-3 `for…of` cases are not misread.
4. **Builder's own evasion:** CR, U+2028 and U+2029 line breaks (also in `//` comments) no longer hide imports.
5. **No regression:** re-run your round-3 mutants; round 1 to 3 PASS items still pass; no assertion weakened; no file
   outside the job's list changed. `bun test` counts. The builder names 7 fails, none its own: core-source (known),
   test/deploy/cluster-rig.test.js x5 (other track's untracked file), a nats-bus stall (load-flaky, passes alone).
   Confirm each is outside the job: the nats-bus one passes alone, and cluster-rig fails the same with the job's files
   reverted.

## Report

Append "Round 4" to docs/m2/reports/p8-tidyv.md: **PASS or FAIL** first line of the section, HIGH / MEDIUM / LOW with
file:line, what you did NOT check. Then hc t14k one line. Stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
