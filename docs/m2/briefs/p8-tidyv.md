# Brief: p8-tidyv (verify the client tidy job)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md (§ Streams, § Pacing). You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p8-tidyv (client) · <id>: tidy findings`. Name `plenary-p8-tidyv`. Manager: `manager client`
  (t14k). Report to t14k only; never message the proxy (t1bx).
- **Where:** main. Read only. You own docs/m2/reports/p8-tidyv.md and your scratchpad. Mutants go in a scratch git
  worktree (`git worktree add --detach <scratchpad>/wt HEAD`, then copy the job's files in; remove it at the end), never
  in the shared tree.

## The job you check

Builder brief: docs/m2/briefs/p8-tidy.md. Builder report: docs/m2/reports/p8-tidy.md. Source findings: the reports
named in each brief item (p7-chromev, p8-one-linkv, p7-wirev, p7-archtestv, p7-perfv).

**Its files only:** web/adapters/dom/app.js, web/core/session.js, web/core/sync.js, web/core/collab/records-model.js,
web/adapters/transport/ws.js, web/adapters/dom/collab/ui.js, web/adapters/dom/collab/collab.css,
test/web/architecture.test.js, test/web/p8-tidy.test.js (new), test/web/ui-app.test.js, test/web/ui-land.test.js,
test/web/collab/perf.test.js, test/web/contracts/class-transport.test.js (`git diff` each). Other tracks' server/,
packages/, deploy/, scripts/ and docs files are in flight in the tree. Ignore them, but say if this job passes only
because of, or fails because of, them.

**Manager rulings already made (don't re-open, do check they're implemented right):**
- L5: a snapshot carries both streams, so "reload each bind whose stream the snapshot holds" is the correct reading.
  Check that a bind whose stream is absent from a snapshot is not reloaded.
- The second full-suite fail (test/architecture.test.js on untracked scripts/cluster-rig.js, scripts/load/) is another
  track's; confirm it names only those files.

## Check

1. **Jitter by role (item 1):** editors 0–2 s, annotators/commenters/viewers 0–15 s, unknown role 15 s; a click on the
   pill or Retry reconnects at once and cancels the waiting probe; the pill click is refused while refused, stopped,
   capped or mid-gesture. Can any path send two hellos on one live link? Reproduce the Chrome gate yourself on the
   production rig (test/server/rig.js, port 0): several `online` reconnects per role.
2. **L8:** user A's stored `mine` survives a same-tab switch to B; B's notes go under B's key; nothing writes A's key
   after the switch. Probe the window before the first welcome (sign-in user fallback) and a switch back to A.
3. **Emote cooldown (item 3):** 30 quick real clicks in Chrome: every click is either sent or lands on a visibly
   cooling control. Check the cooldown can't stick (tab hidden, clock jumps) and survives re-renders.
4. **regexMayStart (item 4):** the report's line is caught; try your own evasions (`else`, `do`, `return (x) /re/`,
   nested parens, `.if(`). A new evasion that hides an import or a global is a MEDIUM.
5. **zoomToFit (item 5):** a cluster click reaches 8 (the jumpTo clamp, one constant); members on one point or at max
   scale open the list, never a zoom loop. If you can, check the 8× zoom and list in a real browser (the builder didn't).
6. **L2–L6:** dead getters gone and nothing read them; `wrapTransport` adds nothing the adapter lacks and an adapter
   without `reopen()` is refused through createSession; V7 and V11 killed; `dropConnection()` drops and returns live in
   Chrome, and `fail()` after `close()` does nothing.
7. **Changed assertions:** compare old and new for class-transport, ui-app C-17/K1, ui-land `stopped`. A dropped or
   weakened assertion is a HIGH.
8. **No token** in a URL, localStorage or log (p6-hexv's rule). Architecture test green.
9. **Mutants:** re-run the builder's 29 and add your own. Each claimed rule must be killed; say which survivors are real
   gaps vs equivalent.
10. **`bun test`:** state counts; run p8-tidy.test.js, ui-app and collab/perf several times (flakiness).

## Design check (CHECKER)

The 15 s window still leaves a correlated return of 100k tabs at about 6.7k hellos/s, 8× the 830/s join budget; the
rest rests on the visibility "heard recently" skip, engine's E-1 heartbeat and gateway admission (t18m). Say whether
the client side is sound given that, and anything the client should do that it doesn't.

## sdd, processes

sdd ensemble review of the diff: single harness unless more pass check_adapter; confirm or refute each finding.
Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p8-tidyv.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check
(CHECKER)"; what you did NOT check. HIGH = a weakened test assertion, a token leak, two hellos on one live link, a lost
acknowledged or pending op, a user's stored notes overwritten, a claimed rule a mutant survives, a file outside the job
changed. Then hc t14k one line. Stop.
