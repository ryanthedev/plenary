# Report: p8-one-link (J3 of p7-audit: one connection per tab)

**Done: each tab now opens one connection, sends one hello and gets one snapshot.** In headless Chrome on the
production rig, a viewer joining a board with notes received **188,514 B on 1 socket**. Before the change it received
**377,126 B on 2 sockets**: half the bytes and half the hellos. C-3, C-5, C-12 and C-13 are closed, and the `tab` id is
minted per session but not sent.

- **Who:** worker plenary-p8-one-link; manager t14k. Not committed.
- **`bun test`:** 1374 pass, 150 skip, 2 fail (1526 tests, 79 files).
  - **Known fail:** `test/core-source.test.js` (herdr-draw's uncommitted core edits).
  - **Not mine:** test/auth/signin-cause.test.js "hand-off cause table…". Another job was editing server/auth/oidc.js,
    deploy/README.md and that test during the run. Rerun alone right after, it passes 13/13.
  - **`bun test test/web`:** 782 pass, 0 fail.
- **Systems design skill:** APPLIER mode (systems-design v0.1.0). § 5 says exactly what was done before coding and
  what was added after.

## 1. Changes (files)

| File | What changed |
|---|---|
| web/core/sync.js | `bindEditor` is split. `openLink(o)` holds the transport, the Replica, the one timer, status, hello, presence, records and the writer cap. `link.bind(editor, stream)` adds one Editor per stream (onOp, load, feed, syncSettings, reconcile, previews, resets, refused settings). `link.start()` sends the one hello. `bindEditor(editor, o)` is now `openLink` plus one bind plus `start`, with the same handle as before, so `web/dev.js` and the ~50 `bindEditor` tests are unchanged. A handle has the link's members (status, pending, role, client, user, limited, presence, records) plus its stream's. New link members: `lastUser` (welcome.user kept through a resync) and `sequenced(stream, id)` (ids the room sequenced, from entries and snapshots; never cleared, as `sniff` did). `roleSeen`/`userSeen` are set right after `replica.receive`, before `pump()` fires a status change, as `sniff` used to. Refused settings go to their own stream's bind. Going live, or a snapshot while live, loads every bound Editor. |
| web/core/session.js | Calls `join()` **once**. One `openLink`; `binds.board` and `binds.notes` are the two binds' handles. `s.connection` is the link alone; the collab port reads it. `sniff` is deleted (C-12): the role, welcome.user, note authors and sequenced note ids all come from the link. `wrapTransport(t)` (exported) wraps each port member explicitly (C-5), keeps `fail` where the adapter has one, and leaves out optional members the adapter lacks. `s.pending` counts the link once. `s.reconnect` does one reopen. `s.dropConnection` fails the one link. `s.links` is now **`s.link`** (the one transport). `mintTab(random)` gives `s.tab`, 16 base-36 characters from the clock port's random. `s.onStatus` listeners get `fn(status)` (once per link). `s.onRoom` listeners still get `(stream, ev)`: the stream for `settings` events, else `"board"`, the name those events had when the board link carried them. |
| web/core/collab/port.js (new) | The collab policy (C-13), moved from the adapter: `collabPort(session, { name, frame, jumpTo })`. It reads only `session.connection`, `onStatus`, `onRoom` and `roomUser`, never `binds`. `frame` is required, because core reads no browser timer. Own presence is filtered by the link's one client id. |
| web/adapters/collab/sync.js | Now a thin adapter: `syncCollabPort(session, o)` passes `frame` (default `requestAnimationFrame`, else a 16 ms timeout) to `collabPort`. Its path is kept, so main.js, dev-main.js and architecture.test.js:319 need no change. |
| web/ports/transport.js, web/ports/collab.js | Header comments only: one link per tab, and the class-based wrap rule. |
| test/web/adapters/collab-rig.js | Its own `{ ...t }` spread replaced by wrapping `send` on the transport itself. |

## 2. Unowned tests edited (granted by t14k, 2026-11-12): the link shape only

Each edit keeps what the test checked; only the two-link assumption changed.

| File:test | Old intent | New intent |
|---|---|---|
| ui-app.test.js "C-4: back online…" | `reopens` 2 / 4 / 4 / 6: both links reopen once per probe | `joins.length === 1`, then `reopens` 1 / 2 / 2 / 3. It still asserts that a reopen happens on `online` and on a long hide, and that none happens on a short hide or a recent `here`. |
| ui-land.test.js "p6-sync2v M2: `stopped` wins…" | A notes-only stub link was `stopped` while the board link stayed `connecting`; the merged status was `stopped` | One join (asserted). Both binds are `stopped`. The merge rule is still checked: with `binds.board.status` forced to `connecting`, the session status stays `stopped`. The pill assertions are unchanged. |
| collab/wire.test.js "me.client is the board connection's wire id…" | `me.client !== binds.notes.client` (two ids) | `binds.notes.client === me.client` (one id for both streams). The peer-sees-my-cursor check is unchanged. |
| collab/wire.test.js "the presence gate…" | Stubbed `d.me.links.board.backlogBytes` | Stubs `d.me.link.backlogBytes` (the same wrapper object sync.js holds). Assertions unchanged. |
| collab/wire.test.js "writer cap: merged status…" | Board link welcomed, notes link capped, so the session showed `limited` | One link (asserted). The cap's refusal on it shows `limited` on the session and on **both** binds, so the notes stream is still covered by the cap. |
| collab/wire2.test.js "congested…" | `links[1]` (notes) congested, then `links[0]`; either one turns the pill on | One link (asserted). Its congestion turns `s.congested` on, off and on again. The viewer pill asserts are unchanged. |
| collab/wire2.test.js "LOW-1: limitedNextTry…" | Board welcomed, notes capped, next try at 750 ms | One link (asserted), capped before its welcome. Still `limited` and next try at 750 ms, then null after the retry. |

## 3. Tests added

- **test/web/one-link.test.js** (11 tests):
  - one join, one hello and one snapshot per tab (viewer, annotator and editor on a compacted board with shapes and notes), with both Editors equal to the presenter's;
  - each Editor writes and reads only its own stream;
  - `reconnect` and a drop cost one reopen and one hello, and offline ops on both streams land;
  - `pending` is counted once;
  - a refused settings change goes to its own stream's bind;
  - `tab`: minted, 16 characters, different per tab, a given one kept, and **no hello carries `tab`**;
  - C-12: role, welcome.user, and the backstop on someone else's sequenced note, all through the link;
  - the collab port drops a batch entry naming its own client id, and requires `frame`;
  - over ws.js (async fake WebSocket): two tabs with one socket each, board and notes converge through a server-side close;
  - the note lock from the room's author table: a fresh tab of the same annotator may edit its own note, and another
    annotator may not, also during a resync (the lock never opens);
  - a link resync with a notes op pending: both Editors reload, an open board drag survives and commits, and both
    streams converge.
- **test/web/contracts/class-transport.test.js:** the full transport contract (35 cases) on a class-based transport
  (every member on the prototype) through `wrapTransport`, plus a test that a spread copies none of those members and
  the wrap keeps them, `fail` included.

## 4. Mutants (each run with `bun test test/web`, then the file restored and checked by `diff`)

| Mutant | Result | Killed by (first failure) |
|---|---|---|
| notes Editor reads the board stream (`doc = streams.board`) | killed, 15 fails | ui-app C-2/C-8 and others |
| a second transport/openLink for notes | killed, 12 fails (after adding the ws test: one-link 6 of 9 fail too) | ui-app C-4, one-link |
| `wrapTransport` returns `{ ...t }` | killed, 39 fails | class-transport contract, C-4 |
| hello carries `tab` | killed | one-link "tab: … NOT sent" |
| `pending` summed over both binds | killed | one-link "pending counts once" |
| refused settings all to the first bind | killed | one-link "refused settings… own stream" |
| `s.reconnect` calls both binds | killed | ui-app C-4, one-link reconnect |
| sequenced note ids forgotten | killed | one-link C-12 backstop |
| role learned after the status fires | killed, 37 fails | ui-app, ui-session roles |
| going live loads only the first bind | killed | one-link "both Editors loaded" |
| welcome.user not used for the note lock | killed | one-link C-12 |
| collab: own presence not filtered | survived at first; **killed** after adding the own-echo test | one-link collab port |
| entries fed to every bind whatever their stream | **survives: equivalent.** `feed` looks ids up in its own stream's doc, so another stream's ids are dropped. It would differ only if an id existed in both streams. | none |

## 5. distributed-systems-design, APPLIER mode

- **Before coding:** I loaded the skill and read SKILL.md (4-step framework, APPLIER phases). Scope, estimate and the
  shape below came from that pass, together with the brief and p7-audit's numbers. I did not open a chapter file then.
- **After coding (advisor's catch):** I read Ch12's and Ch4's DESIGN REVIEW CRITERIA. What they turned up is under
  "Deep dives". Nothing in them changed the code.

- **Scope:** the NFRs in CLAUDE.md (100k viewers per board, viewers < 1 s, 100k joins in 2 min ≈ 830/s), client side only.
  Features: one connection, one Replica and one hello per tab, with no protocol change.
- **Estimate:**

  | Per tab | Before | After |
  |---|---|---|
  | Sockets | 2 | 1 |
  | Hellos | 2 | 1 |
  | Snapshot bytes (measured, § 6) | 377 KB | 188 KB |
  | Replicas in the heap (p7-audit: ~23 MB for a mid-size board) | 2 | 1 |
  | Presence down (p7-audit E-4 numbers) | ~210 KB/s | ~105 KB/s |

  - **At 100k viewers:** 100k sockets instead of 200k, and ~830 hellos/s in the join wave instead of ~1,660/s.
- **High-level design:** tab → one wsTransport → one gateway connection → one Replica holding every stream → two
  Editors (board, notes) plus the collab port, each a bind on the link.
- **Deep dives:**
  - **Ch12 criteria:**
    - **"Connection count estimated (~10 KB per connection)":** 100k viewers now hold ~1 GB of gateway socket memory
      instead of ~2 GB.
    - **"cur_max_message_id tracked per device":** the Replica's `applied` seq is now one watermark per tab. Before,
      it was two equal watermarks.
    - **"Heartbeat timeout handles intermittent network":** C-4 and E-1, not this job.
    - **"Presence fan-out for large groups":** E-4, not this job.
  - **Ch4 criteria:** "algorithm matches the traffic pattern" and "synchronization": the client's token bucket is now
    one per connection, the same unit as the gateway's bucket. Before, there were two client buckets per tab.
  - **Ch12 (WebSocket, presence):** one client id per tab. The collab filter drops only that id. The presence limiter is
    one per link, matching the gateway's per-connection limits. A tab's own notes previews no longer echo back as a
    peer's (before, the board link saw them).
  - **Ch4 (rate limit):** the Replica's op bucket (20/s, burst 100) now covers both streams plus records for the tab.
    Before, each link had its own: 40/s per tab. This matches the gateway's per-connection bucket. An honest tab is
    unaffected, because a burst of 100 covers any gesture.
- **Failure modes:**

  | Failure | Before | After |
  |---|---|---|
  | Socket drop | Each link resynced on its own | Both streams resync together on one backoff. They shared a gateway anyway. |
  | Rule-5 refusal on either stream | One link resynced from 0 | The whole link resyncs from 0, the same bytes as one link before. Pending ops of both streams are kept and resent. |
  | Backstop reconnect | Reloaded one stream | Reloads both Editors. An open gesture and text edit are kept, as before. |
  | Writer cap | A writer tab used 2 of 8 slots, so the cap bit at the 5th tab | 1 slot: it now bites at the 9th tab, as PROTOCOL.md § Pacing intends |

- **Wrap-up:**
  - **Remaining bottlenecks:** E-4 (presence to viewers), E-2 (reconnect herd) and E-5 (static join wave), all engine's.
  - **Monitoring:** still none on the client (C-11).
  - **At 10×:** E-4 and E-5 dominate.

## 6. Gate: headless Chrome on the production rig

- **Setup:**
  - **Rig:** test/server/rig.js, port 0, production index.html and main.js over ws.
  - **Board:** seeded over a real socket by the owner: 300 shapes, 50 notes, 100 comment threads. Then a room checkpoint,
    so a join's catch-up is a snapshot.
  - **Tab:** a viewer, signed in through a stored session in sessionStorage.
  - **Counting:** CDP Network.webSocket* events, enabled before navigation.
  - **Driver:** docs/m2/reports/p8-one-link.drive.js.txt. Copy it to a scratch folder as drive.js and run
    `SP=<scratch> bun drive.js <repoRoot> <label>`. It appends the Chrome PID to `$SP/pids` and kills it in `finally`.
- **Before:** a scratch copy of the working tree with only this job's files reverted to HEAD (`git show HEAD:`) and
  its new files removed. Other workers' uncommitted server and protocol edits are the same on both sides.

| Viewer joins (board with notes) | Before (HEAD for this job's files) | After |
|---|---|---|
| WebSockets | 2 | **1** |
| Hellos | 1 + 1 | **1** |
| Snapshots | 1 + 1 | **1** |
| Frames in | welcome, snapshot, here, here (×2) | welcome, snapshot, here |
| Bytes received on join | 188,563 + 188,563 = **377,126** | **188,514** |
| Page shows | live, 300 board + 50 notes | live, 300 board + 50 notes |
| hello has `tab` | no | no |

- **Processes:** the Chrome PIDs (67615, 74400, 82697) were recorded in scratchpad/pids, killed by their own script, and
  confirmed gone. No pkill.

**Other regression gates:**

- **Transport contract:** holds. `reopen()` is still required (sync.test.js "throws without reopen"), and a resync
  never calls `close()` (sync.test.js; the class contract).
- **Waiting edits:** I found no written rule for "a waiting edit survives reload". The only related wording is p6-landv's
  "a reload loses nothing acknowledged". The app's `stopped` banner says how many unacknowledged edits a page reload
  loses, so unsent ops are not kept across a page reload today, before or after this job.
  - **What I tested instead:** the Editor reload a resync does. Unsent ops of both streams survive a drop and a
    reconnect and land, and an open drag survives a link reload (one-link tests; sync.test.js M3).
  - **Not tested:** a page reload with an unsent edit, in Chrome. The p8-one-linkv brief asks the verifier to check it.
- **Convergence across two tabs:** on the ws rig, board and notes (new test); on localRoom, the existing ui-session,
  ui-land and wire suites.
- **Writer cap, auth refusal, role downgrade in the chrome:** ui-app.test.js and ui-land.test.js pass (K1, C-9, C-17,
  the downgrade tests).

## 7. Turning `tab` on (when engine pings)

**One line:** web/core/sync.js, in `openLink`: `const replica = new Replica({ client, now, random });` becomes
`new Replica({ client, now, random, tab });`. The line above it is marked. The id already flows from `createSession`
(`s.tab`) into `openLink({ tab })`. The one-link test "NOT sent in the hello" must flip then: expect `hello.tab === s.tab`.

## 8. What I did NOT check, and risks

- **Not checked in Chrome:**
  - a writer tab, the writer cap at the 9th tab, and a refused or downgraded role;
  - a reload with a waiting edit (covered in unit tests only);
  - shared-worker transport pages (dev-main.js). The shared-worker contract and unit tests pass.
- **`s.onRoom` stream argument:** link-wide events are still reported as `"board"` for compatibility with
  collab/wire.test.js. A later cleanup could make it `fn(ev)`.
- **`sequenced` vs `sniff`:** the same sources (entries, and snapshot ids from the Replica's confirmed versions). The
  difference is that the set now lives in the link, not the session.
- **The note lock changed behaviour (a fix):**
  - **Before:** the snapshot sends `noteAuthor` as `[[id, user], …]` pairs (packages/protocol/room.js:150,
    replica.js:446), but `sniff` ran `Object.entries` over that list, keying its map by array index. So it never
    matched a real note id, and the lock was in practice the page's own `mine` set.
  - **Now:** `isMine` follows the room's table (snapshot, then entries). A fresh tab of the same annotator may edit
    their own note, where before it was locked. Another user's note stays locked.
  - **During a resync:** `Replica.reset()` clears the table, and `isMine` falls back to `mine`, then the root's
    `noteAuthor`. So it locks, never unlocks, and the backstop still blocks any sequenced id. Tested.
- **Two-link assumptions elsewhere:** none found. I searched PROTOCOL.md, server/, scripts/ and the web adapters for
  two links, per-tab counts and `-board`/`-notes` client ids.
- **Drag preview across a reload:** a link reload during an open drag puts the dragged elements back to the Replica's
  copy until the next pointer move. HEAD does the same (checked in a scratch run on both trees). With one link, a resync
  caused by the notes stream now does this to a board drag too. Not a protocol problem, but visible as a jump.
- **Rate:** a tab's ops on both streams now share one 20/s bucket (§ 5). Not load-tested.
- **The C-4 watchdog and the app.js resume jitter:** not touched, per the brief.
- **No sdd ensemble review:** optional for builders, and not run.

## Round 2 (fix round after p8-one-linkv FAIL, H1 and L1)

**H1 is fixed (test only), and L1 is fixed in session.js.** All three lock mutants the verifier found surviving (V5, V6,
V8) now fail a test, and so does a mutant that removes the L1 fix.

- **Changed:**
  - **test/web/one-link.test.js:**
    - **New `tab(net, token)` helper:** `c.ops` collects the ops a session sends, and `c.deliver` is its message handler.
    - **New user:** `t-di` (annotator) in USERS.
    - **The verifier's H1 test, as written in p8-one-linkv.md:** a rule-5 refusal of di's own op runs
      `Replica.discard`, then `reset()`. In that window the author table is empty. The test checks that cy's note
      stays locked: `isMine` is false, the backstop blocks the write, a click flashes "locked" and doesn't select it,
      and the lock is still shut after the resync.
    - **New L1 test:** the same tab, with a pending op, reconnects as di. Once `lastUser` is `"di"` the author table is
      empty, and cy's note is neither in `s.mine` nor `isMine`.
    - **The old test's misleading part (formerly :219-220) is relabelled:** its title now says "across a drop". Its
      comment says a plain drop never calls `reset()`, so it is not the reset window, and the next test covers that.
      It now asserts `connection.noteAuthor(id)` is still `"cy"` after the drop.
  - **web/core/session.js (L1):** `mineNow()` clears `s.mine` when the link's `lastUser` changes from one known user to
    another. `isMine`'s fallback and the backstop's `s.mine.add` both go through it. So after the same tab signs in as
    someone else (rule 13), the reset window can no longer fall back to the old user's notes. The first user seen
    never clears it, so the page's `mine` passed in at start is kept.
- **Mutants:** run on a scratch copy of the tree
  (`/private/tmp/claude-501/-Users-r-repos-plenary/12dd3097-7de7-4d5f-a9de-8ac04c9565a4/scratchpad/r2b`), with
  `bun test test/web`, each restored afterwards. Script: `…/scratchpad/mut2.py`.

  | Mutant | Result | Killed by |
  |---|---|---|
  | V5: an unknown author means editable (`isMine` fallback returns true) | killed (2 fails) | H1 test, L1 test |
  | V6: the lock opens while not live and the author is unknown | killed (2 fails) | H1 test, L1 test |
  | V8: `sequenced` cleared on a reset | killed (1 fail) | H1 test (the backstop) |
  | L1 fix removed (`s.mine` never cleared on a user change) | killed (1 fail) | L1 test |

- **`bun test`:** 1377 pass, 150 skip, 1 fail (1528 tests). The fail is the known `test/core-source.test.js`.
  `bun test test/web`: 784 pass, 0 fail. The signin-cause failure from round 1 did not recur.
- **Not changed:** L2 to L7 (LOW, report-only). In particular L7: docs/m2/reports/p8-one-link.drive.js.txt is still
  there, because the round-2 grant didn't cover removing it. Delete it at commit if you don't want it kept.
