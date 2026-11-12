# Brief: p5-load (Registry load at 100k joins: p-audit F4 and F8)

docs/m2/BRIEF-BASE.md applies, including its Architecture line. Manager: `manager platform` (t187). Report only to
t187; never message the proxy or engine. Report: docs/m2/reports/p5-load.md. Never pkill/killall; port 0; kill only
PIDs you recorded. Never print .env values. If a full run fails, name the failing tests
(`bun test 2>&1 | grep -E '\(fail\)'`).

**Systems design skill:** apply `distributed-systems-design` in APPLIER mode before coding (if not in your skill
list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and its `references/`).
A cache over authorization is a consistency decision: say in the report how stale a role can be, on one node and
across nodes, and why that is safe (a revoke must still close the socket; see PROTOCOL.md on grants/re-check).

## Read first

docs/m2/reports/p-audit.md section 2 (F4, F8, the numbers), server/main.js `announcingRegistry` (~line 55-80),
server/auth/tenancy.js `role`, server/gateway.js hello (~599) and the timed role re-check (~560-620), the
`grants` bus subject (server/bus/port.js) and PROTOCOL.md's grants/re-check text.

## Do

1. **F4 HIGH: a share-link redemption must not make every gateway re-check the whole board.** Redemption
   (addLinkUse) gives the redeeming user a role; it changes nothing for anyone else. Either stop announcing on
   addLinkUse, or scope the announcement to that user (e.g. `{ board, user }` on the grants subject, and gateways
   re-check only that user's sockets when `user` is present; a message without `user` keeps today's whole-board
   meaning, so old nodes stay correct). Pick one with evidence: does a user who redeems while already connected on
   another socket need the upgrade pushed? Touch only `announcingRegistry` in main.js (engine's p4-wire edits
   main.js later; keep the hunk small). If gateway.js must read `user`, do not edit it: write the exact change
   into the report as a patch for engine.
2. **F8 MEDIUM: fewer Registry queries per hello and per timed pass.**
   - A role cache per (user, board) in core (tenancy.js or a small core file beside it, ports only), with an
     `invalidate(board, user?)` the gateway calls on a grants message, and a TTL bounded by the soonest expiry it
     depends on (invites and links expire by time, with no message). A revoke must never be hidden by the cache
     longer than today's re-check bound.
   - A batched lookup for the timed pass: propose and implement `rolesFor(boardId, identities) -> Map<user, role|null>`
     (or better, say why), costing O(1) Registry queries per board plus per-user grants where the Registry port
     can't batch. If the Registry port needs a batch method (e.g. `grantsFor(board, users)`), propose its signature
     in the report and add it to the in-memory adapter + port + contract test only; SQLite/Postgres adapters are
     engine's: write the patch for them into the report.
   - Count queries before and after with a counting Registry wrapper in a test: hello warm/cold, timed pass for
     1,000 users on one board. Put the numbers in the report.
3. Tests: the cache never grants after a revoke beyond the bound (revoke, then invalidate, then role -> null);
   expiry without a message is honoured; link redemption announces per your choice; both architecture tests.

## Files you own

server/auth/tenancy.js (and a new core file in server/auth/ if needed), server/auth/registry-port.js and
server/auth/registry.js (only for a new batch method), the `announcingRegistry` hunk of server/main.js, test/auth/.
Not gateway.js, not server/registry/*, not server/bus/*.

## Done when

The above, full `bun test` passes, report (what changed, query counts, the skill note, the engine patches,
not-verified, risks). Then stop. Do not commit. If your context passes 60%, write docs/m2/handoff/p5-load.md and stop.
