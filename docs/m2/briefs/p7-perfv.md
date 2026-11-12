# Brief: p7-perfv (verify collab per-frame cost: pins, notes, selections, clock)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md (NFRs:
60–120 fps), PROTOCOL.md (§ Presence, § Records). You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p7-perfv (client) · <id>: collab per-frame cost`. Name `plenary-p7-perfv`. Manager:
  `manager client` (t14k). Report to t14k only; never message the proxy (t1bx).
- **Where:** main. Read only. You own docs/m2/reports/p7-perfv.md and your scratchpad (mutants go in a scratch copy or
  are reverted at once; leave the tree as you found it).

## The job you check

Builder brief: docs/m2/briefs/p7-perf.md. Builder report: docs/m2/reports/p7-perf.md. Audit findings it fixes:
docs/m2/reports/p7-audit.md C-1, C-6, C-7, C-15.

**Its files only:** web/adapters/dom/collab/{ui,frame}.js, web/core/collab/{records-model,notes-model}.js,
test/web/collab/perf{,-bench,-fixture}.js (`git diff` / read the new ones). The tree also holds two other in-flight jobs:
p7-chrome (app.js, roles.js, main.js, dev-main.js, test/web/ui-app.test.js) and p7-archtest (architecture.test.js,
ws-rig.js, ws-sync.test.js, core-runtime-globals.test.js), plus other tracks' server/ and docs files. Ignore them, but say
if p7-perf's files depend on any of them.

## Check

1. **The numbers:** re-run perf-bench (new and `OLD_FRAME=`) yourself; the pan-frame DOM writes (80,002 → 1) and pin
   counts hold on the 10k-thread fixture. The bench measures what a real frame does, not a shortcut path.
2. **C-1 pins:** cache, layer transform, culling, cap and clusters are right: no pin lost or duplicated at the view edge,
   a cluster opens to its threads, a new/resolved/deleted thread shows within one frame, zoom changes re-cluster.
   `HASH_EVERY` = 15: can a change go unseen for longer than a frame? (D2: the cache keyed on `port.records()` identity
   plus an onRecords counter: find a path where records change and neither moves.)
3. **C-7 / C-15:** notesView runs only while visible; nameOf is a map; no selection join per frame; behaviour unchanged.
4. **C-6 / D1:** `mountCollab({clock, frame})`. D1 (accepted by the manager): the default `domClock()` in frame.js copies
   browserClock's behaviour; check it really matches web/adapters/clock/browser.js (now, mono, set, clear, random) and that
   ui.js reads no `Date`, `setTimeout`, `performance`, `Math.random` or `requestAnimationFrame` directly.
5. **Mutants:** re-run the builder's 14; add your own for anything it didn't mutate (each must be killed by a test).
6. **Boundaries and serving:** test/web/architecture.test.js still bites; served through the rig (test/server/rig.js,
   port 0) the production page boots with no 404 (favicon aside) and frame.js loads.
7. **Tests:** `bun test`. The 1 known failure (test/core-source.test.js on editor.js) is herdr-draw's uncommitted
   core/editor.js, not this job: confirm and move on. No test/web assertion weakened or deleted (`git diff test/web` on
   its files).
8. **CHECKER:** per-frame cost at 10k threads and 2k annotators' cursors; what is still O(all) per frame or per op; 10×.

## sdd, processes

sdd ensemble review of the diff: single harness unless more pass check_adapter; confirm or refute each finding.
Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p7-perfv.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check (CHECKER)";
what you did NOT check. HIGH = a number that doesn't reproduce, a pin/thread lost or stale, a weakened test, a surviving
mutant on a claimed fix, a boundary rule that doesn't bite, a direct global in ui.js. Then hc t14k one line. Stop.
