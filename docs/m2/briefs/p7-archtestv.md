# Brief: p7-archtestv (verify architecture tests that bite, and core over a ws rig)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md (§ Pacing, § Presence). You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p7-archtestv (client) · <id>: architecture tests`. Name `plenary-p7-archtestv`. Manager:
  `manager client` (t14k). Report to t14k only; never message the proxy (t1bx).
- **Where:** main. Read only. You own docs/m2/reports/p7-archtestv.md and your scratchpad. Mutants go in a scratch git
  worktree (`git worktree add --detach <scratchpad>/wt HEAD`, then copy the job's files in; remove it at the end), never
  in the shared tree.

## The job you check

Builder brief: docs/m2/briefs/p7-archtest.md. Builder report: docs/m2/reports/p7-archtest.md. Audit findings:
docs/m2/reports/p7-audit.md C-10, C-14, C-16 (test side).

**Its files only:** test/web/architecture.test.js (`git diff`), new test/web/core-runtime-globals.test.js,
test/web/adapters/ws-rig.js, test/web/adapters/ws-sync.test.js. The tree also holds p7-perf (web/**/collab/**,
test/web/collab/perf*) and p7-chrome (app.js, roles.js, main.js, dev-main.js, test/web/ui-app.test.js), plus other
tracks' server/ and docs files. Ignore them, but say if this job's tests pass only because of, or fail because of, them.

## Check

1. **Mutants:** re-run the builder's 6 audit mutants (M1–M6) and 3 ws.js mutants yourself. Add your own: e.g. a core
   global by another route (`globalThis.setTimeout`, `self.crypto`, `Reflect.get(globalThis, "Date")`, a destructured
   `const { now } = Date`, `new Function`, `structuredClone`/`Intl`-style escapes you judge relevant), a core global on a
   path the drive doesn't run, a dev module reached from main.js by a dynamic import or a `new URL` in an adapter. Each
   claimed rule must be killed; say which surviving mutants are real gaps vs out of scope.
2. **Runtime check isn't vacuous:** the child process really runs with the stubs; caller attribution really finds
   web/core frames (break it, e.g. a renamed path, and see that something fails, or say it passes silently, a HIGH if
   so with no guard). The `drove` asserts fail if the drive does nothing.
3. **C-16:** DEV_MODULES vs static.js `denied()` both ways; the shrink-only `DENY_GAPS_C16` fails both on a new gap and
   on a fixed one; the skipped test is the only C-16 skip and says why. Confirm the 4 gaps the report lists are real
   (fetch them through the rig, test/server/rig.js, port 0: are they served today?).
4. **C-10 rig:** really asynchronous (pre-open queue, `bufferedAmount`, FIFO per direction), drives the production
   `wsTransport` unmodified, the collab contract (all cases) and the ported convergence scenarios run on it, `settle()`
   can't hide a hang (bounded) or fire watchdogs mid-delivery. The `fail()` hook is rig-only and named as such.
5. **Tests only:** no file under web/, server/, packages/ or test/arch-scan.js changed by this job; no existing
   test/web assertion weakened or deleted (`git diff test/web/architecture.test.js`); any new skip is justified.
6. **`bun test`:** state counts. The known fail (test/core-source.test.js) is herdr-draw's uncommitted core edits, not
   this job: confirm and move on. Run the job's three files several times (flakiness: seeds, timers).
7. **CHECKER:** what the tests still can't see (half-open link, real browser timing, bun stack format), and whether that
   is acceptable for M2.

## sdd, processes

sdd ensemble review of the diff: single harness unless more pass check_adapter; confirm or refute each finding.
Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p7-archtestv.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check
(CHECKER)"; what you did NOT check. HIGH = a claimed rule a mutant survives, a vacuous runtime check, a weakened test,
a non-test file changed, a rig that is secretly synchronous. Then hc t14k one line. Stop.
