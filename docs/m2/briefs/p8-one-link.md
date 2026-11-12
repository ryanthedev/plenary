# Brief: p8-one-link (J3 of p7-audit: one connection per tab)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (§ Streams, § Pacing, § Auth), docs/m2/reports/p7-audit.md (all; yours
are C-3, C-5, C-12, C-13; C-4's watchdog is NOT yours, see below), packages/protocol/replica.js (read only), then the
files you own.

- **Your tab:** `worker p8-one-link (client) · <your id>: one connection per tab`. Name `plenary-p8-one-link`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** web/core/sync.js, web/core/session.js, web/adapters/collab/sync.js (it moves to web/core/collab/port.js:
  you own the new file), web/ports/transport.js, web/ports/collab.js, test/web/sync.test.js,
  test/web/ui-session.test.js, test/web/adapters/collab-rig.js, test/web/contracts/** (new cases), new test/web/*-link*.test.js,
  docs/m2/reports/p8-one-link.md; and (granted 2026-11-12) the two-link assertions in test/web/ui-app.test.js, ui-land.test.js, collab/wire.test.js, collab/wire2.test.js. Don't touch packages/ (engine is editing replica.js now), web/adapters/dom/app.js,
  server/, or any other file. Don't commit.

## Why now

Today each browser tab opens two connections (board and notes), and each gets a full snapshot of every stream
(218 KB each, measured in p7-audit). At 100k viewers that is 200k sockets and 200k hellos. The Replica already holds
every stream (`replica.streams[s]`), so one Replica per tab can feed both Editors without a protocol change.

## Do

1. **C-3:** one transport, one Replica, one hello per tab. Both Editors (board and notes) bind to that Replica's
   streams. Keep each Editor's behaviour as today: pending ops, resend after resync, refused handling, previews,
   settings, role, collab room events. `s.links` (the dev hook `dropConnection()`) becomes the one link.
2. **C-5:** wrap each transport member explicitly instead of `{...t}` (a class-based transport loses its prototype
   members). Add a contract case with a class-based transport.
3. **C-12:** delete `sniff`; read what it read (stream members, note authors) from the Replica or the handle.
4. **C-13:** move the collab policy out of web/adapters/collab/sync.js into web/core/collab/port.js; it must not reach
   into `session.binds`. Update imports; the architecture test (test/web/architecture.test.js) must stay green.
5. **Room for `tab` (don't send it):** engine is adding `new Replica({ tab })` (hello.tab, one random id per browser
   tab). Mint the id once per session from the clock port's `random`, keep it in `createSession`'s options, and do
   NOT pass it to the Replica yet. Test that the hello carries no `tab`. When engine pings, turning it on must be a
   one-line change; say which line in the report.
6. **Not yours:** the C-4 silent-link watchdog waits for engine's E-1 downstream heartbeat (not in PROTOCOL.md yet); an
   idle timer without it would resync every quiet board. The resume jitter (p7-chromev MEDIUM-1) is in app.js: leave it.

## Gates (the verifier will check each)

- **One link:** headless Chrome on the production rig (test/server/rig.js, port 0): one WebSocket, one hello and one
  snapshot per tab; bytes received per tab on join, before (HEAD) and after, on a board with notes.
- **No regressions (p6-land rules):** the transport contract still holds (`reopen()` required; a resync never calls
  `close()`); a waiting edit survives reload; board and notes ops still converge across two tabs (ws rig from
  p7-archtest); writer cap, auth refusal and role downgrade still show in the chrome.
- **Mutants that bite:** e.g. bind notes to the board stream, re-add a second transport, drop the class-member wrap,
  send `tab`. Each must fail a test.
- `bun test` all green except the known test/core-source.test.js (herdr-draw's uncommitted core edits); state counts.

Report docs/m2/reports/p8-one-link.md (changes, tests, mutants, the before/after bytes, what you did NOT check), hc
t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0.
