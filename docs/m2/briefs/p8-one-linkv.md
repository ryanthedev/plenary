# Brief: p8-one-linkv (verify one connection per tab)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md (§ Streams, § Pacing, § Auth), packages/protocol/replica.js (read only). You are the verifier: try to break
it. You were not the builder.

- **Your tab:** `verifier p8-one-linkv (client) · <id>: one connection per tab`. Name `plenary-p8-one-linkv`. Manager:
  `manager client` (t14k). Report to t14k only; never message the proxy (t1bx).
- **Where:** main. Read only. You own docs/m2/reports/p8-one-linkv.md and your scratchpad. Mutants go in a scratch git
  worktree (`git worktree add --detach <scratchpad>/wt HEAD`, then copy the job's files in; remove it at the end), never
  in the shared tree.

## The job you check

Builder brief: docs/m2/briefs/p8-one-link.md. Builder report: docs/m2/reports/p8-one-link.md. Audit findings:
docs/m2/reports/p7-audit.md C-3, C-5, C-12, C-13.

**Its files only:** web/core/sync.js, web/core/session.js, web/core/collab/port.js (new), web/adapters/collab/sync.js,
web/ports/transport.js, web/ports/collab.js, test/web/adapters/collab-rig.js, test/web/one-link.test.js (new),
test/web/contracts/class-transport.test.js (new), and the granted edits in test/web/ui-app.test.js, ui-land.test.js,
collab/wire.test.js, collab/wire2.test.js (`git diff` each). Other tracks' server/, packages/, scripts/ and docs files
are in flight in the tree. Ignore them, but say if this job passes only because of, or fails because of, them.

## Check

1. **One link (C-3):** reproduce the headless Chrome gate on the production rig (test/server/rig.js, port 0): one
   WebSocket, one hello, one snapshot per tab; bytes on join before (HEAD for this job's files) and after, on a board
   with notes. The builder's driver is in its report § 6; write your own or audit theirs.
2. **Also in Chrome (the builder did not):** a writer tab edits board and notes and a second tab converges; a reload
   with a waiting edit keeps it; the writer cap bites at the 9th writer tab on one gateway, not the 5th; an auth refusal
   and a role downgrade show in the chrome.
3. **Granted test edits:** for each of the 7 edits in the report § 2, compare old and new. A dropped or weakened
   assertion (beyond the two-link shape) is a HIGH. Confirm notes are still covered by the writer cap and congestion.
4. **C-5 wrap:** `wrapTransport` keeps every port member of a class-based transport, `fail` included, and adds nothing
   the adapter lacks. The contract still requires `reopen()`; a resync never calls `close()`.
5. **C-12 / note locks:** `sniff` is gone; role, welcome.user, note authors and sequenced note ids come from the link.
   Probe the report's own risk: during a resync (`Replica.reset()` clears authors) can someone else's note ever unlock
   for editing? A lock that opens is a HIGH.
6. **C-13:** web/core/collab/port.js reads no `session.binds` and no browser global; test/web/architecture.test.js is
   green; own presence is filtered by the one client id.
7. **`tab`:** minted once per session from the clock port's random, never sent in hello today, and the report's
   one-line flip (§ 7) is truly one line.
8. **Rate and failure modes (CHECKER):** both streams now share one 20/s op bucket per tab: does any real gesture
   (a long freehand stroke, a multi-select drag, notes typing) hit it? A refusal or resync on one stream now resyncs
   both: say whether pending ops of both survive. `s.onRoom` reporting link-wide events as `"board"`: any consumer
   misled?
9. **Mutants:** re-run the builder's (report § 4) and add your own (feed a stream's entries to the wrong Editor where ids
   collide, drop the `stopped` merge, forget `lastUser` across a resync, open the note lock in the reset window). Each
   claimed rule must be killed; say which survivors are real gaps vs out of scope.
10. **`bun test`:** state counts. The known fail (test/core-source.test.js) is herdr-draw's uncommitted core edits, not
    this job: confirm and move on. Run one-link.test.js and the wire suites several times (flakiness).

## sdd, processes

sdd ensemble review of the diff: single harness unless more pass check_adapter; confirm or refute each finding.
Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p8-one-linkv.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check
(CHECKER)"; what you did NOT check. HIGH = more than one socket or hello per tab, a weakened test assertion, a note lock
that opens for someone else, a lost acknowledged or pending op, a claimed rule a mutant survives, a file outside the job
changed. Then hc t14k one line. Stop.
