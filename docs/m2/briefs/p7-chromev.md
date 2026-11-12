# Brief: p7-chromev (verify page chrome, link liveness, token expiry)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md (§ Pacing, § Auth). You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p7-chromev (client) · <id>: chrome and liveness`. Name `plenary-p7-chromev`. Manager:
  `manager client` (t14k). Report to t14k only; never message the proxy (t1bx).
- **Where:** main. Read only. You own docs/m2/reports/p7-chromev.md and your scratchpad. Mutants go in a scratch git
  worktree (`git worktree add --detach <scratchpad>/wt HEAD`, then copy the job's files in; remove it at the end), never
  in the shared tree.

## The job you check

Builder brief: docs/m2/briefs/p7-chrome.md. Builder report: docs/m2/reports/p7-chrome.md. Audit findings:
docs/m2/reports/p7-audit.md C-2, C-4 (page side), C-6 (app.js side), C-8, C-9, C-17.

**Its files only:** web/adapters/dom/app.js, web/core/roles.js, web/main.js, web/dev-main.js (`git diff` each), new
test/web/ui-app.test.js. p7-archtest (802ddbe) and p7-perf (b1d0b6e) are committed; other tracks' server/, packages/
and docs files are in flight in the tree. Ignore them, but say if this job passes only because of, or fails because of,
them.

## Check

1. **C-2/C-8 rebuilds:** a wheel pan (60+ frames, ctrl-wheel too) and 100 incoming ops rebuild no chrome part; a real
   change to what a part shows still rebuilds it (pick cases the tests don't: a remote op that changes the notes count,
   the layer counts, the frames list, the selected element's props; undo of a style chip). Look for stale chrome: a part
   key that misses something its render reads is a HIGH. Memos are per `Doc.rev`, not per frame; nothing per frame scans
   all elements or notes.
2. **C-4 resume:** `online` and visible-after-hide > 30 s reconnect after a jitter from the clock port's random; skipped
   when the room spoke < 10 s ago, while refused, stopped, capped or mid-gesture. Many tabs waking at once spread out
   (say how well 0–2 s spreads for 100k viewers, CHECKER). Only `reconnect()` on the session handle is used; nothing in
   web/core/{sync,session}.js or packages/ changed.
3. **C-9 expiry:** the refused banner's "Sign in again" and the 5-min warning; the return board round trip
   (sessionStorage `plenary.return`, used once, cannot redirect off-site or inject into the address bar: try a hostile
   stored value). **The token** never reaches a URL, localStorage, sessionStorage or a log (p6-hexv's rule); grep and
   run it.
4. **C-6/C-17 clocks:** no `setTimeout`, `setInterval`, `performance.now`, `Date.now` left in app.js; the countdown and
   collab UI run on the clock port. The HEAD-ui.js aliases (`setTimer`, `clearTimer`, `raf`) are now dead since p7-perf
   is committed: confirm and list them as a follow-up, not a block.
5. **`jumpTo({x, y, scale})`:** scale is clamped to the editor's limits; NaN/0/negative do not break the view.
6. **Mutants:** re-run the builder's mutants and add your own (drop a field from a part key, drop the 10 s skip, drop
   the jitter, put the token in the return URL, use `Date.now` in the countdown). Each claimed rule must be killed;
   say which survivors are real gaps vs out of scope.
7. **Headless Chrome** on the production rig (test/server/rig.js, port 0): reproduce the 65 to 0 rebuild counts
   (`plenary.ui.rebuilds`) on a busy board, and the expiry banner path.
8. **`bun test`:** state counts. The known fail (test/core-source.test.js) is herdr-draw's uncommitted core edits, not
   this job: confirm and move on. Run ui-app.test.js several times (flakiness).

## sdd, processes

sdd ensemble review of the diff: single harness unless more pass check_adapter; confirm or refute each finding.
Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p7-chromev.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check
(CHECKER)"; what you did NOT check. HIGH = stale chrome (a key that misses what its part shows), a token in a URL or
storage or log, an open redirect, a reconnect herd with no jitter, a claimed rule a mutant survives, a file outside the
job changed. Then hc t14k one line. Stop.
