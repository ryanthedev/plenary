# Brief: p8-tidyv round 2 (re-verify the client tidy job)

You are the p8-tidyv verifier (t1j2), same rules as docs/m2/briefs/p8-tidyv.md (read only on main, mutants in a scratch
worktree, report to t14k only, never message the proxy t1bx). The builder's round-2 brief is docs/m2/briefs/p8-tidy2.md;
its report is the "Round 2" section of docs/m2/reports/p8-tidy.md.

## Check

1. **H3:** the resume probe is skipped when the link was heard since the probe was armed. Re-run your Chrome case
   (viewer, random 0.99, `online` then `dropConnection()`) and an editor's: one hello per return. Try to find any other
   path to two hellos on one live link (probe vs pill, probe vs Retry, visibility vs online, a welcome that arrives
   exactly at fire time).
2. **H1:** V-1g dies; the refused, capped and mid-gesture cases each expect 0 reopens, and a control case does reopen.
3. **H2, M1, L6:** V-4c/d/e die; the `while`, `for`, `for await` and `i++ / 2` lines are caught; `x.if(a) / 2;
   // import(y)` stays 0. Try new evasions of the fixed rules (a new one that hides an import or a global is a MEDIUM).
4. **L1:** a double-click while a reconnect is in flight opens one socket.
5. **L3 and L4:** the builder says neither can be made to fail (the Replica throws on a snapshot missing a stream;
   nothing adds to `mine` before a welcome). Confirm or refute each claim.
6. **No regression:** round-1 PASS items still pass; no assertion weakened; no file outside the job's list changed; no
   token in a URL, localStorage or log. `bun test` counts; run p8-tidy.test.js, ui-app and collab/perf several times.

## Report

Append "Round 2" to docs/m2/reports/p8-tidyv.md: **PASS or FAIL** first line of the section, HIGH / MEDIUM / LOW with
file:line, what you did NOT check. Same HIGH list as round 1. Then hc t14k one line. Stop.

Processes: never pkill/killall; PIDs only; port 0.
