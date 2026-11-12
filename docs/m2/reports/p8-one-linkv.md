**PASS** (round 2, 2026-11-12: H1 fixed with the verifier's own test, L1 fixed and tested; no HIGH or MEDIUM left. Round 1 was FAIL, kept below.)

Round 1 verdict: **FAIL** (one HIGH, test-only: the code is right, but the test that claims the note lock holds during a resync never enters the reset window, and three lock mutants survive. The fix is one test, ready below; no code change.)

# Verify: p8-one-link (one connection per tab)

- **Who:** verifier plenary-p8-one-linkv, terminal t1hx; manager t14k. Read only in the shared tree.
- **Job checked:** web/core/sync.js, web/core/session.js, web/core/collab/port.js (new), web/adapters/collab/sync.js,
  web/ports/transport.js, web/ports/collab.js, test/web/adapters/collab-rig.js, test/web/one-link.test.js (new),
  test/web/contracts/class-transport.test.js (new), and the granted edits in ui-app, ui-land, collab/wire, collab/wire2.
  The files were snapshotted (shasum) after the builder finished (12:37) and were unchanged when this report was written.
- **Where I ran things:** scratch worktrees under my scratchpad: `wt` = HEAD plus only this job's files; `hd` = clean HEAD;
  `rv` = a copy for the sdd reviewer. Mutants, probes and Chrome ran there, never in the shared tree. All removed at the end.

## Verdict by check

| # | Check | Result |
|---|---|---|
| 1 | One link (C-3), Chrome, production rig | **Pass.** 1 socket, 1 hello, 1 snapshot per tab; 188,535 B vs 377,136 B on HEAD |
| 2 | Chrome: converge, waiting edit, writer cap, refusal, downgrade | **Pass** on all five (table below) |
| 3 | Granted test edits | **Pass.** No assertion dropped beyond the two-link shape; notes still under cap and congestion |
| 4 | C-5 wrap, `reopen()` required, resync never `close()` | **Pass**, with two LOWs (L3); a `close()` in the resync path is killed by 85 tests (C6) |
| 5 | C-12, note lock in the resync window | **Code passes; test FAILS (H1).** The lock stays shut, but no test reaches the window |
| 6 | C-13 | **Pass.** port.js reads no `binds`, no browser global; architecture test green |
| 7 | `tab` | **Pass.** Minted once from the clock port's random; never on the wire; the flip is one line |
| 8 | Rate and failure modes | **Pass.** No real gesture hits the shared bucket; a refusal on one stream keeps the other's pending ops |
| 9 | Mutants | **3 claimed-rule survivors (H1)**; the other survivors are equivalent or out of scope |
| 10 | `bun test` | **Pass.** 1375 pass, 150 skip, 1 fail (the known core-source drift) |

## HIGH

### H1. The note-lock test never enters the reset window, and three lock mutants survive

- **Where:** test/web/one-link.test.js:202-232 (the test "note lock from the room's author table … also during a resync").
- **The claim:** its comment says "During a resync (Replica.reset() clears its author table) the lock must not open".
  The report (§ 8) says the same and calls it tested.
- **Why the test misses it:** it starts the "resync" with `di.dropConnection()`. A drop goes through
  `replica.connectionFailed()` and then `failed()`, which never calls `reset()`. Only `discard()` (a rule-5 refusal, a
  changed `welcome.user` with pending ops, a forgotten client, a Store loss) and a `stale` reconnect clear `noteAuthor`
  (packages/protocol/replica.js:86, 409, 425, 429, 434, 521, 528).
  - I asserted it: right after that drop, `connection.noteAuthor(id)` is still `"cy"`, so the window is never entered.
- **Mutants that survive the whole of `bun test test/web`:**

  | Mutant | Where | Survives? |
  |---|---|---|
  | V5: an unknown author means editable (`isMine` returns true instead of `s.mine.has(id)`) | session.js:168 | yes |
  | V6: the lock opens while the link is not live and the author is unknown | session.js:167 | yes |
  | V8: `sequenced` is cleared on a reset, like the author table (the backstop then lets a write through) | sync.js:173 | yes |

- **The code is correct.** I drove the real window with a rule-5 refusal of di's own op:
  - the author table is empty (`noteAuthor(id) === null`) and the status is `connecting`;
  - `isMine(cy's note)` stays false;
  - the backstop blocks a write (`blocked` 1, no op sent);
  - a click on cy's note says "That note is someone else's: locked" and does not select it;
  - after the resync, the lock is still shut.
- **Fix (test only, about 30 lines):** add a test that enters the window through a refusal; the one below passes on the
  job and kills V5, V6 and V8. Also fix the comment and the `dropConnection()` at one-link.test.js:219-220, or use a
  refusal there too.
  - **Helper it needs:** `tab(net, token)` returns `{ s, c }`, where `c.ops` collects sent ops and `c.deliver` is the
    session's onMessage handler. It is built like one-link's `counted()`, plus
    `t.onMessage = fn => { c.deliver = fn; on(fn); }`.
  - **Users:** USERS adds `"t-di": { user: "di", role: "annotator" }`.

```js
test("note lock: someone else's note stays locked in the reset window (a rule-5 refusal clears the author table)", () => {
  const net = localRoom({ users: USERS, clock: true });
  const cy = tab(net, "t-cy"), di = tab(net, "t-di");
  net.settle();
  cy.s.placeNote({ x: 100, y: 100 }, "cy's");
  net.settle();
  const id = di.s.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(di.s.connection.noteAuthor(id)).toBe("cy");
  di.s.dropConnection();
  expect(di.s.connection.noteAuthor(id)).toBe("cy");   // a plain drop never clears it: not the window
  net.settle();
  di.s.placeNote({ x: 500, y: 100 }, "di's");            // di's own op, refused before its ack: Replica.discard -> reset()
  di.c.deliver({ t: "error", id: di.c.ops.at(-1).id, code: "forbidden", message: "probe" });
  expect(di.s.status).not.toBe("live");
  expect(di.s.connection.sequenced("notes", id)).toBe(true);
  expect(di.s.connection.noteAuthor(id)).toBe(null);   // IN the window
  expect(di.s.isMine(id)).toBe(false);
  const before = di.c.ops.length;
  di.s.eds.notes.onOp({ elements: [{ ...di.s.eds.notes.doc.get(id), x: 999 }] });
  expect(di.s.blocked).toBe(1);                        // the backstop
  expect(di.c.ops.length).toBe(before);
  di.s.setTool("select");
  const el = di.s.eds.notes.doc.get(id);
  const p = di.s.eds.notes.toScreen({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
  di.s.pointerDown(p);
  expect(di.s.takeFlash()).toMatch(/locked/);
  expect(di.s.eds.notes.sel.has(id)).toBe(false);
  di.s.pointerUp(p);
  net.settle();
  expect(di.s.status).toBe("live");
  expect(di.s.isMine(id)).toBe(false);
});
```
- **Why HIGH:** the brief counts "a claimed rule a mutant survives" as a HIGH, and item 9 names exactly this mutant
  ("open the note lock in the reset window"). Behaviour is right today, but nothing guards it.

## MEDIUM

None.

## LOW

- **L1. Same-tab sign-in as another user: the lock opens briefly (narrowed, not new).**
  - **Who found it:** codex (the sdd review) called it a MEDIUM regression at session.js:168.
  - **What I found:** I refuted it as a regression by running the same probe on both trees. The probe: annotator cy makes
    a note, then the same tab reconnects with di's token.

    | Tree | No pending ops | With pending ops |
    |---|---|---|
    | HEAD | cy's note unlocked for di for 5 of 6 steps, and still unlocked at the end | the same |
    | Job | never unlocked | unlocked for 2 of 3 delivery steps, locked once catch-up lands |

  - **Why:** on HEAD the old reader's author map never matched a note id (the builder's § 8 finding), so the lock always
    fell back to the page's `mine` set, which still holds cy's ids.
  - **What's left:** with the job, only the reset window falls back to the old user's `mine`. The room refuses such an op
    anyway (rule 5).
  - **Possible fix:** clear `s.mine` when `lastUser` changes.
- **L2. Merged getters are now dead logic** (session.js:139-145). `status`, `congested`, `limited` and
  `limitedNextTry` compare the link with itself, because both binds share it. They are harmless. The ui-land test keeps
  the `stopped` merge alive only by forcing `binds.board.status`.
- **L3. `wrapTransport` (session.js:35-47).**
  - **Defaults it always adds:** `congested` and `backlogBytes`, even when the adapter lacks them. Both are REQUIRED
    port members (web/ports/transport.js:28 and :38), so this only covers a non-conforming adapter.
  - **A missing `reopen()` is no longer caught early:** the wrapper always defines `reopen`, so sync.js:71's
    "must have reopen()" check can't fire through createSession. Probe: a transport without `reopen` is accepted and
    would throw only at the first resync. HEAD's `watched()` wrapper did the same, so this is not new.
    `bindEditor` still throws.
- **L4. `sequenced` ignores the stream in practice** (sync.js:155). Mutant V7 (every id counted under `notes`) survives.
  It matters only if a board id equals a note id, which a client could arrange, since clients mint ids.
  - **Why LOW:** the failure direction is safe. A colliding id counts as a "known" note, so the backstop checks its
    author and locks; it never unlocks.
- **L5. A snapshot while live reloads every bind** (sync.js:180). Mutant V11 (reload only the first bind) survives.
  PROTOCOL.md sends snapshots only as catch-up after a welcome, so this path is effectively unreachable. HEAD had the
  same gap per link.
- **L6. `dropConnection()` does nothing on the production ws transport.** ws.js exposes no `fail()`, and HEAD is the
  same. The dev hook works only on the local and shared-worker transports. Not this job's.
- **L7. A file outside the brief's list.** The builder added docs/m2/reports/p8-one-link.drive.js.txt, its Chrome driver
  kept as a report attachment. It is docs only and touches no code. The manager decides whether to commit it.

## Evidence

### 1. One link, headless Chrome on the production rig

- **Rig:** test/server/rig.js, port 0, seeded by the owner over a real socket with 300 shapes, 50 notes and 100
  threads, then a room checkpoint, so a join's catch-up is a snapshot.
- **Driver:** my own (`<scratchpad>/gate/drive.js`). It uses one Chrome, a CDP session per tab, and Network.webSocket*
  events, and it is run on `hd` (before) and `wt` (after).
- **Real drops:** a page script records the page's WebSockets and closes them (`__kill()`), because
  `dropConnection()` is a no-op on ws.js (L6).
- **Processes:** Chrome PIDs 88840, 8511 and 8512 were recorded in `<scratchpad>/pids`, killed by PID, and confirmed
  gone. No pkill.

| Viewer joins a board with notes | Before (HEAD) | After |
|---|---|---|
| WebSockets | 2 | **1** |
| Hellos | 2 | **1** |
| Snapshots | 2 | **1** |
| Bytes received on join | 377,136 | **188,535** |
| Page shows | 300 board + 50 notes | 300 board + 50 notes |
| hello has `tab` | no | no |
| After a real drop, then `reconnect()`: sockets made / hellos / most open at once | 6 / 6 / 4 | 3 / 3 / 2 |

- **"Most open at once" is 2 after:** that is the old socket's close event arriving after the new socket's create
  during a reopen. It is never two links; one is open at rest.

### 2. The checks the builder did not run in Chrome

| Check | Before (HEAD) | After |
|---|---|---|
| Owner edits board and notes; an editor tab converges (ids and versions equal) | yes, 2 sockets each | **yes, 1 socket each** |
| A real drop, then edits on both streams while down (3 pending) | land, converge; 4 sockets | **land, converge; 2 sockets** (1 open) |
| Page reload, annotator: own note still editable, owner's note locked | yes / locked | **yes / locked** |
| Writer cap, one user: first limited tab | **5th** | **9th** (PROTOCOL.md § Pacing's 8) |
| Cap shown in the chrome | pill "Too many tabs · close one…" + banner | the same, at tab 9 |
| Auth refusal (unknown token) | "Refused · sign in again" pill + banner | the same, 1 socket |
| Role downgrade (grant editor to viewer, then reconnect) | "View only" pill, read-only banner, write blocked | the same |

- **"Reload with a waiting edit" read two ways:**
  - **A link reload:** a real socket drop with unsent edits. They are kept and land. Shown above.
  - **A page reload:** unsent ops live only in memory on both trees; the page keeps only `mine`. My "unsent at reload"
    note had already been sent before the reload fired, so that probe proves nothing. Graded only as "no difference
    from HEAD".

### 3. Granted test edits (git diff of each)

| Test | Removed | What still catches the fault |
|---|---|---|
| ui-app C-4 | `reopens` 2/4/4/6 | `joins === 1` added; `reopens` 1/2/2/3 still check online, a long hide, a short hide and a recent `here` |
| ui-land `stopped` wins | `board.status === "connecting"` on a second stub link | both binds `stopped`; with `board.status` forced to `connecting`, the session is still `stopped` (mutant V3 killed) |
| wire `me.client` | `me.client !== notes.client` | `notes.client === me.client`; the peer still sees my cursor under it |
| wire presence gate | `links.board.backlogBytes` | `link.backlogBytes`, the same object sync.js holds; assertions unchanged |
| wire writer cap | a capped notes link with a welcomed board link | one link capped: the session and both binds say `limited`. Both binds read one getter, so it is one fact asserted twice, not a weakening. The notes stream is under the cap by construction |
| wire2 congested | `links[1]` (notes) congestion | the link's congestion on, off, on; pill asserts unchanged |
| wire2 limitedNextTry | board welcomed, notes capped | the link capped before welcome, retry at 750 ms, then null; unchanged |

### 4. Mutants (bun test test/web in `wt`, each file restored and checked by diff)

| Mutant | Result |
|---|---|
| B1 notes Editor reads the board stream | killed (18) |
| B2 `wrapTransport` is `{ ...t }` | killed (39) |
| B3 `new Replica({ …, tab })` (the brief's one-line flip) | survives: **equivalent**. Today's Replica ignores `tab` (replica.js:30), so the flip is a no-op until engine's Replica takes it |
| B3b `tab` added to the hello on the wire | killed (one-link "NOT sent") |
| B4 role learned after the status fires | killed (40) |
| B5 own presence not filtered | killed (1) |
| B6 a second transport/link for notes | killed (15) |
| V1 `feed` reads the board doc for every bind | killed (15) |
| V2 every entry's ids fed to every bind | survives: **equivalent** (`feed` reads its own stream's doc) |
| V3 drop the `stopped` merge | killed (1) |
| V4 `lastUser` forgotten across a resync | survives: **equivalent** (Replica.reset() never clears `user`; only a welcome sets it) |
| **V5 / V6 lock opens in the reset window** | **survive: H1**; killed by the proposed test |
| V7 `sequenced` ignores the stream | survives: L4 |
| **V8 `sequenced` cleared on reset** | **survives: H1**; killed by the proposed test |
| V9 `pending` summed over binds | killed (2) |
| V10 the wrap drops `fail` | killed (13) |
| V11 a snapshot while live loads only the first bind | survives: L5 (unreachable) |
| V12 refused records not reported | killed (4) |
| C1 refused settings all go to the first bind (builder's) | killed (1) |
| C2 `s.reconnect` calls both binds (builder's) | killed (3) |
| C3 sequenced note ids forgotten (builder's) | killed (2) |
| C4 going live loads only the first bind (builder's) | killed (5) |
| C5 welcome.user not used for the note lock (builder's) | killed (2) |
| C6 a resync calls `transport.close()` (check 4) | killed (85) |

All 13 of the builder's § 4 mutants were re-run as B1-B6 and C1-C5, plus its own-presence one (B5); its "entries fed to
every bind" is my V2. Each one it claims killed is killed.

### 5. Probes (scratch tests)

- **Cross-stream refusal:** a notes op refused (rule 5) while a board op is pending, and the reverse. The whole link
  resyncs, the surviving op lands, pending reaches 0, and both streams converge. Ops of both streams survive.
- **Rate (both streams share one 20/s bucket with a burst of 100):**
  - **Single-op gestures (measured, op count per gesture):** each commits 1 op, so none can reach the bucket:
    - a 200-point freehand stroke;
    - a 60-move drag of 21 selected elements;
    - a note with 200 typed characters.
  - **Held arrow-key nudge at 30/s (the fastest real repeat):** 90 ops in 3 s all go out at once. Held for 20 s, 106
    ops wait, then all land and converge. The bucket delays and never drops.
  - **Before the job:** a tab had 40/s across its two links, but one gesture uses one stream, so a single gesture
    behaves as before.
- **`s.onRoom` labelling link-wide events `"board"`:** consumers are app.js:616 (ignores the stream), the collab port
  (ignores it), and the wire tests (expect `"board"` for presence). None is misled.
- **C-13:** port.js imports nothing and names no browser global or `binds` (grep). test/web/architecture.test.js
  passes in `wt`.

### 6. `bun test`

- **Shared tree:** 1375 pass, 150 skip, 1 fail (1526 tests, 79 files). The fail is test/core-source.test.js; herdr-draw
  has uncommitted edits to core/editor.js and core/geometry.js (git status there), so it is not this job.
- **`wt` (HEAD plus only this job), test/web:** 782 pass, 0 fail. The job neither passes nor fails because of other
  tracks' in-flight files.
- **Flakiness:** one-link, wire, wire2 and class-transport ran 8 times in a row: 84/84 each time.
- **Mid-run note:** my first full run, while the builder was still editing, showed a one-link failure in a test then
  being written. It was gone after the builder finished.

### 7. sdd ensemble review

- **Harnesses:** codex was the only one available (check_adapter ok). agy failed check_adapter: its individual quota
  is exhausted, resetting in about 50 h. So this was a single-harness review, at high effort, in a separate worktree
  with the diff only.
- **Codex's findings:**
  - one MEDIUM (L1 above): refuted as a regression by a probe on both trees, kept as a LOW;
  - "none" on op loss, the wrap, status and label merges, and other two-link assumptions, which matches my own checks.

## Design check (CHECKER)

- **Scope and estimate:** sound.
  - **Measured:** half the sockets, hellos and snapshot bytes per tab.
  - **At the 100k-viewer NFR:** 100k sockets instead of 200k, and about 830 hellos/s in a 2-minute join wave instead
    of about 1,660/s.
  - **Not measured by me:** the gateway's socket and memory savings, and the ~23 MB Replica heap halving.
- **Rate limiting (ch. 4):**
  - The client's token bucket is now per connection, which matches the gateway's per-connection bucket (PROTOCOL.md
    § Pacing, lines 214-218: "The gateway runs the same bucket per connection (20/s, burst 100)").
  - A tab's bucket covers both streams plus records. That is right for the server's fairness, and no real gesture
    reaches it (probe above).
- **Presence (ch. 12):** one client id per tab. Own-echo filtering by that id is tested, and the presence limiter is
  per link, like the gateway's.
- **Failure modes:**
  - A refusal or drop on either stream resyncs both on one backoff, with pending ops of both kept.
  - A notes-caused resync now also reloads the board Editor. An open board drag snaps back until the next pointer move
    (builder § 8; HEAD does the same per link). This is visible but loses nothing.
  - **Writer cap:** a writer tab now uses 1 slot, so the cap bites at the 9th tab, as PROTOCOL.md § Pacing intends.
- **Single point of failure, by design:** one socket per tab means one stalled socket stalls both streams. Before, the
  two links shared a gateway anyway, so nothing real is lost.
- **Gaps (not this job):**
  - client monitoring (C-11);
  - the silent-link watchdog (C-4, waits on engine's E-1);
  - presence fan-out to viewers (E-4).

## What I did NOT check

- **Shared-worker pages (dev-main.js) in Chrome:** only their contract tests ran.
- **A page reload with an unsent edit:** no tree keeps one, and my probe didn't capture one (see § 2).
- **Load:** the shared 20/s bucket was not load-tested at scale or across many tabs, and the gateway's memory per
  socket was not measured.
- **Postgres + NATS cluster:** the Chrome gate ran on the single-node rig only.
- **Ensemble review:** only one harness, because agy is out of quota.
- **Other tracks' in-flight server/ and packages/ edits:** Chrome ran on HEAD plus this job, not on them. The shared
  tree's full `bun test` did include them.
- **Real input events:** Chrome edits were driven through `plenary.S` (the session API), not DOM mouse and keyboard
  events.

## Round 2

**PASS.** H1 is fixed with my test, verbatim. L1 is fixed soundly and tested. All required mutants now fail a test,
and only this job's files changed.

- **Re-checked:** test/web/one-link.test.js and web/core/session.js, against my round-1 snapshot. These are the only
  two job files whose shasum changed. Mutants ran in a fresh scratch worktree (HEAD plus only this job's files),
  since removed.

### 1. The H1 test is as I wrote it

- **The new test** "note lock: someone else's note stays locked in the reset window" matches the H1 block above line
  for line. Its `tab()` helper and the `t-di` user are as specified.
- **The old test** is relabelled "…across a drop". Its comment now says a drop never calls `reset()`. It gained an
  assertion (`noteAuthor(id)` is still `"cy"` after the drop) and lost none. Nothing is weakened.

### 2. Mutants (bun test test/web)

| Mutant | Result | Killed by |
|---|---|---|
| V5: an unknown author means editable | killed (2) | H1 test, L1 test |
| V6: the lock opens while not live and the author is unknown | killed (2) | H1 test, L1 test |
| V8: `sequenced` cleared on a reset | killed (1) | H1 test |
| L1 fix removed (no `s.mine.clear()`) | killed (1) | L1 test |
| L1 over-eager: clear on every read once a user is known | killed (1) | L1 test |

- **My round-1 user-switch probe** (cy, then the same tab reconnects as di), checked at every delivery step:
  - **Now:** 0 unlocked steps, with or without pending ops.
  - **Round 1:** 2 of 3 steps unlocked with pending ops.
  - **HEAD:** 5 of 6 steps unlocked.

### 3. The L1 change (session.js:105-113, :126, :177)

- **What it does:** `mineNow()` clears `s.mine` when the link's `lastUser` changes from one known user to another. The
  first user seen keeps the page's stored `mine`. Both readers inside the session use it: `isMine`'s fallback, and the
  backstop's `add`.
- **Sound:**
  - Rule 13 already drops the old user's pending ops on a user change, so their unacked note ids have no claim on the
    new user.
  - With the author table present, `isMine` never reads `s.mine` for a sequenced note, so clearing loses nothing for
    the new user.
- **Scope:** only J3's files. `git status` of web/ and test/web/ shows only this job's files. The builder's mutants ran
  in its own scratchpad.
- **LOW (L8, new, minor):** the clear is lazy, and app.js reads `S.mine` directly in two places.
  - **app.js:381, the "You" label:** the same render calls `S.isMine` first (app.js:377), which clears it. So no stale
    "You" shows.
  - **app.js:642, the stored `mine`:** after a switch, the emptied set is saved under the root's display user key
    (`plenary.mine.<board>.<me.user>`), which is still the old user's. The old user's stored `mine` for that board is
    lost.
  - **Effect of that loss:** the lock doesn't need it, because the room's author table decides for every sequenced
    note. Only the drawer's "You" label for that user's notes after a later reload is lost.
  - **Not new:** the key using the root user, not `welcome.user`, predates this job.

### 4. `bun test`

- **Shared tree:** 1377 pass, 150 skip, 1 fail (1528 tests, 79 files). The fail is the known test/core-source.test.js
  (herdr-draw's uncommitted core edits).
- **Worktree (HEAD plus this job only), test/web:** 784 pass, 0 fail.
- **Flakiness:** one-link.test.js ran 8 times: 13/13 each time.

### Still open (LOW, for the manager)

- **L2-L7:** unchanged, report-only.
- **L7 (the builder's docs/m2/reports/p8-one-link.drive.js.txt):** keep it or drop it at commit.
- **L8:** above.
