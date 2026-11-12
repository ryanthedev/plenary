# Brief: p7-wirev (verify collab over sync, mounted in both roots)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md (§ Presence, § Records, v1.1). You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p7-wirev (client) · <id>: collab over sync`. Name `plenary-p7-wirev`. Manager:
  `manager client` (t14k). Report to your manager only (never message the proxy).
- **Where:** main. Read only. You own docs/m2/reports/p7-wirev.md and your scratchpad.

## The job you check

Builder brief: docs/m2/briefs/p7-wire.md (all of it, including "From engine"). Builder report: docs/m2/reports/p7-wire.md.
The work: `git status --short web test/web` and `git diff web test/web` (new web/adapters/collab/sync.js,
test/web/contracts/collab-contract.js, test/web/adapters/collab{,-rig}.js, test/web/collab/wire.test.js; modified sync.js,
session.js, roles.js, presence-model.js, ui.js, app.js, local.js, main.js, dev-main.js, index.html, …). Other dirty files
(server/, PROTOCOL.md, deploy/, test/server/ …) belong to other tracks: ignore them. Engine's 050ef13 (static serving of
web/adapters/collab/) is on main.

## Check

1. **Must-close really closed:** p7-collabv M1–M4 (docs/m2/reports/p7-collabv.md), the count-only `here`
   (`{t:'here', writerCount, viewers}`, no `writers`: keeps the last list and names, only counts change; an explicit `[]`
   still clears), the `stale-setting` consumer (`refusedSettings` / `retryReady`), the writer-cap `limit` (no retry loop,
   shown to the user), congestion on the pill. Re-run the builder's mutations where cheap; add your own for anything it
   didn't mutate.
2. **Contract:** collabContract runs the same tests on the fake and the sync adapter; nothing adapter-specific hides a
   gap; no test/web assertion weakened or deleted without a stated reason (`git diff test/web`).
3. **Presence rules:** presence and transient previews only at `backlogBytes()` ≤ ~16 KB, never real ops; presence from
   my own second connection is dropped; only the board connection carries presence and records; role never null once seen.
4. **Boundaries and serving:** test/web/architecture.test.js still bites; main.js's graph has no dev module; served through
   the rig (test/server/rig.js, port 0) the production page boots with no 404 (favicon aside) and collab runs over `/ws`
   with the token only in hello.
5. **Headless Chrome:** the dev page (web/dev-main.html) with three tabs (presenter, annotator, viewer): cursors, avatars,
   selections, laser, emotes, reactions, comment threads, status pill. Try to break it: drop a connection mid-thread,
   refused op + resync, a role change mid-session, many reactions quickly.
6. **CHECKER:** the design section of the report: the board-only choice, coalescing (M4) and the records rebuild cost,
   pin layout per frame, behaviour on drop/resume, 10×. The known double count (one tab = 2 viewers, writer cap at the 5th
   tab) is already with engine: rate how bad it is, don't fix it.

## sdd, processes

Single harness unless more pass check_adapter; confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p7-wirev.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check (CHECKER)";
what you did NOT check. HIGH = a Must-close item not really closed, a weakened test, a boundary rule that doesn't bite,
a dev module in the production graph, a token leak, presence sent over the backlog gate or real ops dropped by it. Stop.

## Round 2 (manager, 2026-11-12)

The builder ran the fix round docs/m2/briefs/p7-wire2.md. Its report is docs/m2/reports/p7-wire.md § Round 2, and the
work is `git diff web test/web` plus the new files test/web/collab/wire2.test.js and web/adapters/dom/collab/frame.js.
Check:

1. **MEDIUM-1:** a `limit` before welcome counts as a failed attempt under rule 12 and reconnects by itself on rule 12's
   backoff (no extra floor). PROTOCOL.md § Pacing's ~30 s + backoff promise holds. Retry still tries at once. A `limit`
   after welcome, or one with an `id`, is not treated as the cap.
2. **MEDIUM-2:** each of your 12 mutants is now killed. Re-run them yourself; also try the builder's 9 new ones.
3. **LOW-1 and LOW-2:** only the cap banner shows, with the cap tooltip; `destroy()` releases the port; a frame queued
   before destroy does nothing.
4. **Serving:** the new web/adapters/dom/collab/frame.js is reachable from main.js (served, no 404 through the rig).
5. **No `tab` in hello;** no test weakened; test/web/architecture.test.js still bites.
6. **Chrome:** on the production rig (port 0) with 5 tabs as one user, close one, and tab 5 goes live with no click.

Report: append "## Round 2" to docs/m2/reports/p7-wirev.md, PASS or FAIL first, then hc t14k. Stop.

## Round 3 (manager, 2026-11-12): R2-M1 only

The builder's fix is in docs/m2/reports/p7-wire.md § Round 3: `refreshStatus` checks `needAuth` before `limited`, and the
`limited` getter reads null while refused. Check only this: your repro (capped, then `auth` on the retry) now gives
`refused` and the sign-in banner with no more hellos; the old-order mutant dies; Retry and the plain cap path still work;
nothing else in the diff changed since round 2. Append "## Round 3" to docs/m2/reports/p7-wirev.md, PASS or FAIL first,
then hc t14k. Stop.
