**PASS** (no HIGH; 4 MEDIUM, 9 LOW). p7-wire must close the port gaps in M1 before it can mount this.

Worktree /Users/r/repos/plenary-p2, branch p2-land, head `cb343b987223307eb4bc5bf8ded316226d0eae6a`, with the job's
`web/collab/**` and `test/web/collab/**` untracked. Verifier: p7-collabv, 2026-11-11.

## HIGH

None. Each HIGH criterion was checked directly:

- **No role sends what it can't.** I read the code and ran 34 mutants; every one was killed.
- **No data reaches the DOM as HTML.** I checked this in real Chrome with hostile data.
- **No protocol import in web/collab.** `grep -rnE "protocol|sync\.js" web/collab` finds no import, and every import in `web/collab/*.js` and `*.html` is `./…`.
- **No file changed outside the job's two directories**, as far as git can show (see "How I checked").
- **The port can be implemented**, but it needs the new sync.js APIs listed in M1.

## MEDIUM

- **M1. The port can be implemented, but nothing in sync.js or the Replica provides most of it yet** (`web/collab/port.js:7-51`). p7-wire must do every item below.
  - **Two connections per tab, one per stream** (`web/ui/session.js:66-68`, client ids `…-board` and `…-notes`). The port must name one connection for:
    - **Presence in and out:** if both forward `onPresence`, others' emotes float twice and laser batches draw twice. If both send, my other connection's presence shows as a peer, because the echo filter matches only `me.client`.
    - **`me.client`:** it must be that connection's client id.
    - **`status`:** `session.js`'s `status` is the worse of the two connections (`session.js:98`). If the port uses that, presence stops whenever the notes connection is catching up. Use the presence connection's status, or say in the port doc which one it is.
    - **Records:** each Replica holds its own records copy, so ops, `records()`, `pending`, `onRecords` and `onRefused` must all come from the same Replica.
    - **Recommended:** the board connection for all of these.
    - **Unverified:** whether the gateway counts each tab twice in `here` and `viewers`. Two writer and two viewer connections per tab suggest it does; I did not run a gateway.
  - **`role` is null during a resync.** The handle returns `replica.role ?? null` (`web/sync.js:233`), and `Replica.reset` clears it. `session.js` keeps `lastRole` for this reason.
    - If `port.role` is wired straight through, `recordProblem` forbids every records op while reconnecting.
    - That breaks the documented behaviour that records ops queue offline (`gate.js`, `ui.js:211`).
    - The port must keep the last role it was given.
  - **`me` is read once at mount** (`ui.js:36`, passed to `createPresence`). But `welcome.user` is unknown before the first `welcome` and can change (rule 13).
    - The port doc should require that `me` is valid before `mountCollab`.
    - It should also say what happens on a change: remount, or `me` is a stable object whose fields update.
  - **`me.name` has no source.** `welcome` carries no name (PROTOCOL.md § Messages), so it must come from the sign-in session or token.
  - **`onHere` and `onEmotes`:** `Replica.receive` ignores `here` and `emotes` (`packages/protocol/replica.js:344-363`). They must be read off the transport, as `session.js`'s `sniff` does.
  - **`onPresence`, `onLeave` and `send`:** the Replica reads only `preview` and `leave` (`replica.js:504-511`), and the `bindEditor` handle has no presence in or out.
  - **`previews(stream)` with the sender:**
    - The handle's `previews()` returns bare clones of one stream (`sync.js:244`).
    - `Replica.previewBy` has user and client, but it isn't exposed.
    - Both streams' previews reach either connection.
  - **`records()` with `pending`:** `recordsState()` exists (`replica.js:544`). Pending records ops sit in `replica.pending` (`replica.js:36`); the handle gives only a count (`sync.js:230`).
  - **Records ops:** they need a handle method that calls `replica.local("records", op)`, then `pump()`.
  - **`onRecords`:** p7-wire must watch `recordsRev`.
  - **`onRefused`:**
    - `did.dropped` mixes rule-5 refusals with rule-13 and horizon drops (`replica.js:393, 403, 470`).
    - p7-wire must look the op up before `receive` and fire only for an `error` with an `id` on a `records` op.
  - **`noteAuthor`, `notes()` and `element()`:** `replica.noteAuthor` and `replica.streams[s]` exist but aren't exposed. `element()` needs a not-deleted check.
- **M2. No test catches role-gating regressions on a mid-session role change** (`test/web/collab/gate.test.js`, `ui.test.js`).
  - Three mutants survived the whole collab suite:
    - freezing the outbox's role at mount;
    - making `presence.setRole` a no-op;
    - freezing the role `recordProblem` gets.
  - The code reads the role live today, but brief item 1 fails for a downgrade.
  - **Wanted:** downgrade through `onStatus` (editor → viewer, editor → commenter), then check that cursor, laser and records ops stop and the viewer flag applies.
- **M3. On phones, "+N" undercounts by 3** (`web/collab/ui.js:65`, `web/collab/collab.css:59`).
  - `more = writerCount − 5`, but phone CSS hides avatars 3 to 5.
  - `p390-editor.png` shows 2 avatars and "+37" for 42 writers (should be +40).
  - The builder flagged this risk; it is still unfixed.
- **M4. Each records change re-reads every record** (design check D1, measured).
  - On every `onRecords`, `recordsView` walks all threads and comments, and pins and the drawer are rechecked. The real `Replica.recordsState()` also rebuilds a whole `Records` copy on each change.
  - **Measured in Bun at 10k threads × 3 comments:**

    | Step | Per change |
    |---|---|
    | `recordsView` | 6 ms |
    | `Replica.recordsState` rebuild | 28 ms |
    | Whole mounted path over the fake port, with its deep copy | 43 ms |

  - So in a busy room (200 people reacting), each entry costs about 35 ms of main thread, and several entries a frame would stall it.
  - **For p7-wire:** fire `onRecords` at most once per animation frame. The port's "records() may have changed" contract allows it. Write this into port.js.
  - The deeper fix, incremental records, belongs to packages/protocol, not this job.

## LOW

- **L1. The seam test misses two import forms** (`test/web/collab/limits.test.js:10, 30`). Both mutants survived:
  - a template-literal dynamic import;
  - a `<script src="../../packages/protocol/…">` in `dev.html`.
  - It also doesn't scan subdirectories.
- **L2. Bidi controls in names aren't isolated** (no `unicode-bidi`, `dir=auto` or `<bdi>` in web/collab).
  - **Observed** (`hostile.png`): an RLO inside a name or note reverses that string's own tail ("gnp.exe" shows as "exe.png").
  - **Not observed:** sibling text in message headers being reversed. Those headers are flex rows, so each name is its own item.
  - **Still exposed:** strings that join a name with other text: the pin `title` (`ui.js:124`, `${name}: ${text}`), the lock label `🔒 ${author}'s` (`ui.js:246`) and the toast.
  - Zero-width characters pass through, so look-alike names are possible.
  - **Fix:** wrap names in `<bdi>` or isolate them.
- **L3. Notes text isn't clamped in the drawer** (`hostile.png`, `ui.js:240`). A 100k-char note fills the whole drawer. Notes text is bounded only by the 1 MB op cap. Clamp it with CSS `line-clamp` or a slice.
- **L4. Bad element bounds make a thread vanish** (`web/collab/records-model.js:55-59`). Non-numeric bounds from `port.element` drop the thread instead of showing it detached at its anchor.
- **L5. Global CSS classes** (`web/collab/collab.css:7-27`): `.pin`, `.msg …` and `.chip-r` are unscoped and will restyle web/style.css's own classes. The builder flagged this risk.
- **L6. A new reply can hide under the reply box** (`d1440-dark.png`). With a pending reply, the newest message sits under the reply box; the popover doesn't scroll to it.
- **L7. Differences from the mock:**
  - **Desktop** (`desk-thread-light.png`):
    - The anchor reads "On an element of the board", not `On "Ship" · Launch flow`. `element()` returns bounds only.
    - No "Maya · laser" label.
    - Notes rows have no time.
    - Pins overlap cursor and preview tags.
  - **Phone** (`p390-*.png`): it matches `phone-thread-dark.png` and `phone-viewer-dark.png` in layout (bottom-sheet thread, 2 avatars and "+N"), apart from M3.
- **L8. Two client-side checks differ from the room** (`gate.js:29, 51`), both harmless:
  - The 20 MB records cap isn't checked. The client can't know the room's byte count; the room refuses and a toast shows.
  - A reply to a hidden thread is checked against the 500-comment cap, which the room skips. It is unreachable, because hidden threads aren't shown.
- **L9. Tests that run only on the model or the fake port:**
  - Expiry is tested on the model, not through the UI's 1 s tick.
  - Rule-5 refusal is tested only via `fakePort.refuseNext`.
  - p7-wire should test both against the real Replica.

## Design check (CHECKER)

I applied distributed-systems-design in CHECKER mode, using `SKILL.md` § 3 and the chat-system chapter's review criteria
(presence, heartbeat, large-group fan-out) and the rate-limiter chapter (drop vs enqueue). The skill's infrastructure checklist
(load balancer, database replication, CDN, sharding) is about server tiers. That part isn't in scope here; the protocol design doc covers it. This section checks the client-side port and models.

| Check | Verdict | Evidence |
|---|---|---|
| **Heartbeat, not connect/disconnect** | ✓ | cursor and select repeat every 10 s (`gate.js:100`); peers are dropped after 30 s of silence or on `leave` (`presence-model.js:88`). Same shape as the chapter's 5 s / 30 s heartbeat, so a brief drop doesn't flap |
| **Large-group fan-out** (100k viewers) | ✓, with one gap | Viewers see aggregates only: `here` (≤ 50 writers plus counts), emote counts and presenters' cursors. No per-viewer pub-sub. **Gap:** the client relies on the gateway thinning cursors to 50 and has no cap of its own on `peers`. The gateway only "may thin" (§ Presence), so an unthinned 2k-annotator room draws 2k cursors a frame for writers. LOW |
| **Rate limits: client side** | ✓ | Pacing is stricter than the gateway bucket (one send per 1000/rate ms), so nothing is dropped server-side. Drop vs enqueue is explicit: cursor and select coalesce to the latest, laser batches keep the newest 64, emotes over 4/s are dropped. An emote drop is **silent** to the user (`ui.js:74`): LOW |
| **Records pacing** | ✓ (Replica) | Records ops go through the Replica's 20/s bucket. The port doc should say the UI relies on it |
| **Ordering** | ✓ | Records are in `seq` order from the Replica, with my pending ops last. Presence is latest-wins, so no order is needed. Laser age is measured from the receiver's arrival time, not the sender's clock, so clock skew can't keep a trail alive |
| **Expiry** | ✓ | Presence 30 s; laser 1.2 s after arrival; floaters 2.4 s; emote counts over 10 s windows; previews 5 s (Replica) |
| **What drops under load** | ✓, by design | Presence may drop at any hop. Laser points beyond 64 a batch, emotes over 4/s and annotator cursors beyond the gateway's 50 drop. Records never drop: they stay pending until acked or refused. Nothing tells the user the view is thinned: acceptable for presence |
| **Failure / offline** | ✓, one gap | Off live, presence is cleared and the outbox reset. On resume, my last cursor and selection go out again. Records queue offline. **Gap:** `role` is null during a resync (M1) |
| **Per-change cost** | ✗ | O(all records) per entry: M4 |
| **Hexagonal: models** | ✓ | `presence-model`, `records-model`, `notes-model` and `gate` have no DOM, globals or timers. The clock, `rand` and flags are injected; a grep found only `newRecordId(rand = Math.random)` as an injectable default |
| **Hexagonal: renderers** | ✓ | `draw.js` holds pure functions over a 2D context and the view. `ui.js` alone touches the DOM, through `dom.js`, which sets text only |
| **Hexagonal: port and adapters** | ✓ | `port.js` is the one driven port. `fake-port.js` is an adapter that imports only `limits.js`. Its own records reducer is tested equal to the protocol's `Records` on 20 actions. p7-wire's sync.js adapter is the second adapter |

Design verdict: the shape is sound for the NFRs (100k viewers on aggregates; editors and annotators on a capped,
heartbeat-expired presence). Before load testing, settle two things in the port doc: which connection carries presence and records (M1), and records-change coalescing (M4).

## How I checked

- **`bun test`** in the worktree: 390 pass, 0 fail (28 files); `test/web/collab` has 38 tests.
- **Mutation testing** on a scratch git copy of the worktree (scratchpad `copy/`, `mutate.sh`, `mutants.txt`):

  | Mutants | Result |
  |---|---|
  | 34 on gating, records rules, rates, the repeat, expiry, `leave`, echo, the viewer flag, laser fade, the `here` cap, viewer emotes, HTML sinks, `safeColor` and offline clearing | all killed |
  | 6 on drift (3 protocol-side, 3 mirrored timing constants) | all killed |
  | 3 role-change mutants | all survived (M2) |
  | 2 seam mutants | both survived (L1) |

- **The role × user × action matrix** is in the tests: 5 roles × 3 users × `OPS` against `Records.check` (`test/web/collab/gate.test.js:122`).
- **Hostile data in headless Chrome**, over the fake port as owner:
  - **Names and text:** RLO, zero-width characters, 100k-char names, `"><svg onload>`, `<img onerror>`, `</style><script>` and CSS-breakout names in comments, `here`, presence, reactions, the refusal message and thread ids.
  - **Colors:** note colors `url(javascript:…)`, `expression(…)` and `red; background-image:url(…)`.
  - **Anchors:** element bounds and anchors given as strings.
  - **Result:** no alert fired, no element or `on*` attribute was injected, and no style held `url(`. Swatches fell back to grey.
- **Load probe** (Bun, on the test fake DOM and the fake port): numbers in M4. The probe is in scratchpad `copy/test/web/collab/zz-*.probe.js`.
- **Dev page screenshots** in headless Chrome:
  - **1440 px:** editor light and commenter dark (pending items).
  - **390 px:** viewer dark, annotator light with the picker, editor light. These ran in a 390 px iframe, because headless Chrome lays out at 500 px minimum; a probe confirmed `scrollWidth` is 390.
  - **Compared with:** `desk-thread-light.png`, `phone-thread-dark.png` and `phone-viewer-dark.png`.
  - **Location:** `/private/tmp/claude-501/-Users-r-repos-plenary-p2/e905e7c6-db10-4494-999e-a1a05c275b68/scratchpad/shots/`. Use `d1440-*`, `p390-*` (uncropped) and `hostile.png`. Ignore `d390-*`, which are 500 px crops.
- **Single harness (codex only, effort high)** on its own scratch copy. Its findings and my verdicts:

  | Codex finding | Verdict |
  |---|---|
  | Port needs new sync.js / Replica APIs | **Confirmed**: M1 |
  | No role-change tests | **Confirmed by mutants**: M2 |
  | 20 MB cap not checked client-side | **Confirmed, LOW**: L8 |
  | Expiry and refusal tested only on the model or fake port | **Confirmed, LOW**: L9 |

  Codex found no HTML or CSS sink and no gating defect, which matches my reading.
- **Files outside the job:**
  - `git status` shows the job added only `web/collab/**`, `test/web/collab/**` and its report.
  - None of the 19 modified tracked files mentions collab. They are the other jobs' files the brief lists.
  - Caveat: git can't prove who made an uncommitted edit.
- **Processes:** one Bun static server (port 0) and 13 headless Chromes, all tracked by PID; all exited or were killed by PID.

## Not verified

- **Real pointer and keyboard input** in a browser: laser drag, compose, Enter, picker clicks, focus, scroll.
- **Accessibility.**
- **Animation**, beyond static shots.
- **The real port**, which doesn't exist yet.
- **The double counting** of `here` and `viewers` (M1).
- **Load in a real browser.** The probe ran in Bun.
- **An exact pixel diff** against the mock; the comparison was by eye.
