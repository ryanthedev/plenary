# Brief: p8-tidyv round 3 (re-verify the client tidy job)

You are the p8-tidyv verifier (t1j2), same rules as docs/m2/briefs/p8-tidyv.md (read only on main, mutants in a scratch
worktree, report to t14k only, never message the proxy t1bx). The builder's round-3 brief is docs/m2/briefs/p8-tidy3.md;
its report is the "Round 3" section of docs/m2/reports/p8-tidy.md. Manager ruling: R2-M2 is a HIGH.

## Check

1. **R2-M2:** your page-rig case (probe armed for 7.5 s, drop at 2 s, backoff reopens at 2.5 s, replies held) gives 1
   reopen; the control reopens. Look for other paths to two hellos on one link (pill, Retry, visibility, online, a
   welcome or a hello at fire time). If you can, repeat it in Chrome with a held welcome.
2. **R2-H1, R2-H2, R2-H3:** V-H3c, V-L1c and M1e die. The builder says V-L1d is now equivalent under fix 1: confirm or
   refute.
3. **R2-M1:** the prefix `++`/`--` lines are caught; round 2's postfix cases still pass. Try new evasions of the
   changed rule (a new one that hides an import or a global is a MEDIUM).
4. **R2-L1:** the builder added `S.onHeard` (room messages only). Records ops and `dismissSetting` no longer count as
   heard; check nothing else that should count was dropped (welcome, every room event the probe relied on).
5. **R2-L2:** `of` as a variable name is caught and `for (x of y) /re/` style code is not misread.
6. **No regression:** round 1 and 2 PASS items still pass; re-run round 1's and round 2's mutants; no assertion weakened;
   no file outside the job's list changed; no token in a URL, localStorage or log. `bun test` counts; run p8-tidy,
   ui-app and collab/perf several times.

## Report

Append "Round 3" to docs/m2/reports/p8-tidyv.md: **PASS or FAIL** first line of the section, HIGH / MEDIUM / LOW with
file:line, what you did NOT check. Then hc t14k one line. Stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
