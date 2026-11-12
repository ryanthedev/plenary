# Brief: p8-tidy (client tidy: leftover MEDIUM and LOW findings)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (§ Pacing), then the source findings below, then the files you own.

- **Your tab:** `worker p8-tidy (client) · <your id>: tidy findings`. Name `plenary-p8-tidy`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** web/adapters/dom/app.js, web/core/session.js, web/core/sync.js, web/core/collab/records-model.js,
  web/adapters/transport/ws.js, the emote control's file(s) under web/adapters/dom/ (say which), test/web/** (new
  cases; existing assertions may be tightened, never weakened or deleted), test/web/architecture.test.js,
  docs/m2/reports/p8-tidy.md. Don't touch packages/ (engine is editing replica.js), server/, or any other file.
  Don't commit.

## Findings to fix (source report in brackets; read each)

1. **MEDIUM-1, resume jitter too narrow** [p7-chromev.md MEDIUM-1 and its Design check; app.js:614 `PROBE_JITTER_MS`].
   Manager's decision: widen by role. Editors keep 0–2 s (they need < 150 ms and are few). Annotators and viewers
   spread over 0–15 s (100k tabs over 15 s is about 6.7k hellos/s, versus 50k/s today). A user's own click (Retry now,
   the status pill) skips the jitter. Gateway admission is engine's (t18m); don't build it, name it in the report.
2. **L8, mine set saved under the old user's key** [p8-one-linkv.md L8; app.js:642]. When the user changes, the emptied
   `mine` set must not overwrite the old user's stored set. Test: user A's stored mine survives a switch to user B.
3. **LOW-3, rapid emote clicks dropped silently** [p7-wirev.md LOW-3; 1 of 30 quick clicks got through at 4/s]. Keep
   the 4/s pacing (PROTOCOL.md § Pacing); make it visible (the control shows it is cooling down) or coalesce, so a click
   is never silently lost. Your choice; say why.
4. **R2-MED-2, a regex after `)` blinds `codeOnly`** [p7-archtestv.md R2-MED-2; test/web/architecture.test.js
   `regexMayStart`]. Use the report's fix (a `)` closing `if`/`while`/`for`/`with` allows a regex) or the simpler fail
   rule. Add the report's example line as a test case that must be caught.
5. **zoomToFit capped at scale 4** [p7-perfv.md MEDIUM, records-model.js:163]. A cluster click must be able to reach the
   editor's max scale (8, the jumpTo clamp in app.js), and members on one point must not loop: at max scale, or when
   the fit is infinite, the click opens the drawer listing them. Test 600 threads in a 90×60 spot, as the report did.
6. **p8-one-linkv L2–L6** [p8-one-linkv.md]:
   - **L2:** session.js:139-145 merged getters are dead: remove them, or give each a real reader and a test. The
     ui-land `stopped` merge must stay covered without forcing `binds.board.status`.
   - **L3:** wrapTransport (session.js:35-47) adds `congested`, `backlogBytes`, `reopen` even when the adapter lacks
     them, so sync.js:71's "must have reopen()" can't fire. Wrap only what the adapter has; test that an adapter with
     no `reopen` is refused through createSession.
   - **L4:** `sequenced` ignores the stream (sync.js:155). Check it; kill mutant V7.
   - **L5:** a snapshot while live reloads every bind (sync.js:180). Reload only the snapshot's stream; kill V11.
   - **L6:** `dropConnection()` does nothing on ws.js (no `fail()`). Make the dev hook work on the production
     transport; test it.
7. **LOW-R2-1** [p7-wirev.md]: verifier says close to equivalent, no action. Leave it; say so in the report.

## Gates (the verifier will check each)

- Each item above has a test that fails before your change and passes after; name them in the report.
- Mutants: revert each fix one at a time; each must fail a test (list them).
- Headless Chrome on the production rig (test/server/rig.js, port 0): a viewer's `online` reconnect lands within
  0–15 s and an editor's within 0–2 s; 30 quick emote clicks show the cooldown; `dropConnection()` drops and the
  tab returns live.
- No token in a URL, localStorage or log (p6-hexv's rule). The architecture test stays green.
- `bun test` all green except the known test/core-source.test.js (herdr-draw's uncommitted core edits); state counts.

Report docs/m2/reports/p8-tidy.md (changes per item, tests, mutants, Chrome results, what you did NOT check), hc t14k
one line, stop.

Processes: never pkill/killall; PIDs only; port 0.
