# p7-collab report (phase 7, part 1: collaboration UI behind a collab port)

**Status: done, ready for a verifier.** Everything is in `web/collab/**` and `test/web/collab/**`, and nothing
outside them was touched. `bun test` passes: 390 tests at the last run, 0 failing. This job adds 38 of them. The baseline was 347 when I started, and other files in this worktree (p6-land's work in progress) kept adding tests while I worked. Nothing is committed.

## The port as built (what p7-wire must provide)

The full contract is written as JSDoc at the top of `web/collab/port.js`. `missingFromPort(port)` lists any member
that is absent, and `mountCollab` throws if one is missing.

| Member | Shape | Brief? |
|---|---|---|
| `role` | protocol role (owner, editor, annotator, commenter, viewer); never the UI role | yes |
| `me` | `{ user, name, client }` | yes |
| `status` | web/sync.js names: connecting, catching-up, live, refused, stopped | yes |
| `onStatus(fn(status, role))` → unsubscribe | fires when status or role changes | **added** |
| `send(kind, fields)` | sends `{ t: "presence", k: kind, ...fields }` as given; kind is the **wire** name: `cursor`, `select`, `laser`, `emote` | yes (the brief said `selection`; the wire and the port say `select`) |
| `onPresence(fn(batch))`, `onLeave(fn(user, client))` | batch items are `{ user, client, k, … }`; a `leave` inside a batch also works | yes |
| `previews(stream)` | returns `[{ el, user, client }]` | yes, but it **needs the sender**: `Replica.previewsOf` returns bare elements (`Replica.previewBy` has the user) |
| `onHere(fn({ writers, writerCount, viewers }))`, `onEmotes(fn({ counts }))` | as on the wire | yes |
| `records()` | returns `{ threads, pending: [{ op }] }`: threads = `Replica.recordsState()`; pending = this client's unacked `records` ops, oldest first | `pending` **added** (the snapshot shape can't show what is pending) |
| `onRecords(fn())` | records may have changed | yes |
| `thread`, `reply`, `resolve`, `reopen`, `react`, `unreact`, `deleteComment` | each sends one `records` op: `react`/`unreact` become `{ do: "react", id, emoji, on: true/false }`; `deleteComment` becomes `{ do: "delete", id }` | yes |
| `onRefused(fn({ op, code, message }))` | a `records` op refused under rule 5 | **added** |
| `noteAuthor(id)` | user or null | yes |
| `notes()` | live elements of the notes stream | **added** |
| `element(stream, id)` | `{ x, y, width, height }` or null when absent or deleted | **added** (needed so anchors can follow elements) |
| `jumpTo?({x, y})`, `editNote?(id)`, `deleteNote?(id)` | optional; the drawer shows jump, edit and delete only when these exist | **added** |

**Not built:** the protocol's `edit` and `move` record actions. The brief's port doesn't list them, so there's no UI for them.

### What p7-wire calls on the mounted UI

`mountCollab({ root, canvasOverlay, port, view, theme })` returns an object with:

- **`parts`:** `{ avatars, emotes, emoteButton, drawer }`. These go in the top bar, the bottom-center bar
  (desktop), the bottom-right corner (phone: one 👏 button that opens the picker, because the app hides `.hud-bc` on phones) and the drawer.
- **Input calls:** `pointer(world)`, `selection(stream, ids)`, `laser(world)`, `startComment(world, on?)`,
  `openThread(id)`, `showDrawer("notes" | "comments")`.
- **`layout()`:** call it when the view moves.
- **`draw(ctx)`:** use it when you paint into your own context instead of passing `canvasOverlay`.
- **`setTheme(t)`** and **`destroy()`**.
- **`view`:** anything with `toScreen`, `toWorld` and a scale (as `scale` or `view.scale`). A core `Editor` works as is.
- **`root`:** the positioned canvas container. Pins, the popover, floating emotes and the toast are placed in its coordinates.

## Files

| File | What |
|---|---|
| `web/collab/limits.js` | Protocol constants mirrored here (presence table, `EMOTES` in protocol order, sizes, roles, stream writers, records caps), because web/collab may not import the protocol package |
| `web/collab/flags.js` | One flag per open CEO question. Only `viewersSeePresentersOnly` (true) is read by code. `followPresenter` (false) and `reactionsOnCommentsOnly` (true) are placeholders that record the decision; flipping them changes nothing until someone builds that path |
| `web/collab/port.js` | The port contract (JSDoc) plus `PORT_MEMBERS` and `missingFromPort` |
| `web/collab/gate.js` | `mayPresence` and `recordProblem` (role and cap checks before sending), plus `createOutbox` (presence pacing) |
| `web/collab/presence-model.js` | Others' cursors, selections, lasers, floating emotes and crowd counts; expiry; names and roles taken from `here` |
| `web/collab/records-model.js` | Threads view: ordering, pending marks, anchors (follow or detach), rights per role, ids, "3 min" times |
| `web/collab/notes-model.js` | Notes drawer rows with authors from `noteAuthor`, locks, and `safeColor` |
| `web/collab/draw.js` | Pure canvas draw functions: selections, previews, laser trails, cursors with name tags |
| `web/collab/dom.js` | Text-only element builder |
| `web/collab/ui.js` | `mountCollab`: avatar row, emote bar and picker, pins, thread popover, compose box, comments list, notes drawer, toast |
| `web/collab/collab.css` | Extra styles on top of `web/style.css`, built from tokens so both themes work |
| `web/collab/fake-port.js` | The fake port, including `applyRecord` (a records reducer) |
| `web/collab/dev.html`, `dev.js` | The dev page over the fake port |
| `test/web/collab/*.test.js` | Tests, with `clock.js` (a fake clock) and `fake-dom.js` (a fake DOM whose HTML setters throw) |

## Behaviour decisions

- **Live controls are updated in place, not rebuilt:**
  - Emote buttons, pins (one per thread) and floating emotes (one per emote) keep their elements.
  - The thread popover and its reply textarea stay mounted while that thread is open.
  - The compose box lives from `startComment` until it is sent or cancelled.
  - The drawer's header, tabs and scroller are kept; rows are rebuilt only when what they show changed.
  - So a busy room (`here` 1/s, `emotes` 2/s, a stream of entries) doesn't wipe drafts, blur a textarea, swallow clicks or reset scroll. Tests check the element identities.
- **Presence pacing** coalesces input to the latest value and sends it on a trailing edge, at most one send per 1000/rate ms.
  - That spacing is stricter than the gateway's bucket, so none of these sends is ever dropped.
  - Cursor and select each repeat 10 s after their own last send, so receivers never go more than 10 s without hearing a still user.
  - After a reconnect, the last cursor and selection go out again, so a still user reappears.
  - A laser batch holds at most 64 points, keeping the newest.
  - An emote over 4/s is dropped rather than held, because a late emote means nothing.
  - Nothing is sent unless status is `live`.
- **Others' presence:**
  - Ignored while not live, and cleared when the connection goes down.
  - Previews are hidden while not live.
  - A peer is dropped on `leave` or after 30 s of silence.
  - My own (user, client) echo is ignored; my other tabs still show.
- **Viewers:**
  - With the flag on, a viewer sees only owners' and editors' cursors, selections and previews.
  - A sender whose role is unknown (not among the 50 writers `here` lists) is hidden from viewers.
  - A viewer's emote never floats; it shows up only in the counts. Writers' emotes float, including my own.
  - Crowd counts sum the last 10 s of `emotes` windows.
- **Anchors:**
  - An element-anchored pin sits at the element's top-right corner and follows it.
  - When the element is deleted or absent, the pin shows "detached" at the anchor's own x, y.
  - `startComment` sets that x, y to the element's corner at creation time.
  - The spec only says "show the thread at x, y", so this reading is mine.
- **Records ops are not gated on live:** they queue offline as pending, as the mock shows. Only role and caps block them.
- **Pending author names** (null in `recordsState`) show as `me.name`.
- **Hostile data:**
  - Names and text go in only as text nodes or attribute text.
  - Element colors reach a style only if they are plain hex; `url(…)` and anything else are refused.

## Tests (38 new)

- **Mirrored constants (`limits`):** every constant matches packages/protocol, emote order included.
- **The seam (`limits`):** no file in web/collab imports packages/protocol or sync.js.
- **No HTML sinks (`limits`):** a grep finds no `innerHTML`, `outerHTML`, `insertAdjacentHTML` and similar in web/collab.
- **Presence gating (`gate`):** for all 5 roles × every kind, only what the protocol allows is sent, and every message passes `presenceProblem`.
- **Rates (`gate`):** 2 s of 1 kHz input through the protocol's own `presenceLimiter` on the same clock drops nothing, and the latest value lands.
  - Every laser point arrives, in order, in batches of 64 or fewer.
- **Repeat and offline (`gate`):**
  - Cursor and select repeat every 10 s, and a move mid-interval never leaves a gap over 10 s.
  - They are resent after a reconnect.
  - Nothing is sent, and nothing stale goes out, while not live.
- **Record gating (`gate`):** agrees with `canWrite` plus `Records.check` for 5 roles × 3 users × 15 actions. Caps are covered too: text, emoji length, 20 distinct emoji, id length.
- **Presence model (`presence`):**
  - 30 s expiry, with the 10 s repeat keeping a peer alive.
  - `leave`, alone and inside a batch.
  - The protocol's `presenceCoalescer` output is read correctly.
  - Lasers fade.
  - The viewer flag works, and unknown-role senders are hidden.
  - Writers' emotes float; viewers' emotes are counts only.
  - `here` is capped at 50 writers.
- **Records model (`records`):** order with the pending overlay; pending resolve, reaction and delete; refusal leaves the overlay; anchors follow and detach; hidden threads; rights per role.
  - The fake port's reducer equals the protocol's `Records` on 20 actions, no-ops and dead targets included.
- **UI in the fake DOM (`ui`), where every HTML sink throws:**
  - Hostile names and comment or note text appear only as text, and only expected tags are ever created.
  - Avatar row (+N, "N watching", greyed when not live).
  - Emote bar (viewer vs writer, disabled offline, the full picker set).
  - Compose, reply, react and resolve through the port; pins follow and detach.
  - Viewers get read-only threads.
  - A refused comment is dropped, with a toast saying why.
  - Both drawers, with note authors and 🔒 on others' notes.
  - Cursors and previews drawn per role, cleared offline and back when live.
  - Live controls survive events: the same emote button, reply textarea (with its text), compose textarea, drawer scroller and pin through `emotes`, ticks, a status flap, others' entries, `here` and `layout()`.
  - `destroy` leaves no timers behind.

## How I checked it

- **`bun test`:** 390 pass, 0 fail at the last run (38 in `test/web/collab`).
- **Headless Chrome screenshots of `web/collab/dev.html`:**
  - The page was served by a static Bun server on port 0, killed by its PID afterwards.
  - Each Chrome ran `--screenshot` with its own profile and its PID logged; none was left running.
  - Phone shots load a 390 px iframe and are cropped, because Chrome won't lay out narrower than 500 px.
- **Ten shots** are in `/private/tmp/claude-501/-Users-r-repos-plenary-p2/4b8c3f49-052d-4fc0-aca7-dabde932477e/scratchpad/shots/`:

  | Width | Shots |
  |---|---|
  | 1440 px | editor light, annotator light with the compose box, commenter dark with a pending reply and reaction, editor light offline, owner dark with the notes drawer, viewer dark with a resolved thread |
  | 390 px | viewer dark and light, annotator light with the picker open, editor dark with a thread |

- **Bugs the shots caught, all fixed:**
  - Presence and previews still showed while offline (fixed, with a test).
  - Reaction chips overlapped the author line (CSS fix, checked by eye only).
  - The phone had no emote control: the app hides `.hud-bc` on phones (fixed with `parts.emoteButton`, checked by eye only).
- **A reviewer found re-render problems after my first pass:** full re-renders would wipe drafts and lose clicks, and the 10 s repeat ran on a fixed phase (gaps up to 20 s). All fixed, with tests, and every shot was retaken afterwards.
- **Phone floats:** floating emotes don't show in the 390 px iframe shots. A direct 600 px shot (`w600-annotator-light.png`, where the `max-width: 640px` rules apply) shows them. So it's the iframe plus Chrome's virtual time, not the phone CSS.
- **Hostile data on the page:** a hostile display name, comment and note show as literal text, with no alert.

## Not verified

- **Real input:** I took no clicks, typing or pointer moves in a real browser, so `pointer`, `laser`, compose by click, reply by Enter and the picker were not exercised there.
  - They are exercised in the fake-DOM tests only.
  - The page's own event wiring (`dev.js`) is untested.
- **Animation:** shots use `still=1` (a frozen frame).
  - Laser fade, emote float animation and the 1 s tick are covered by tests, not by eye.
- **Real focus and scroll behavior:** the fake DOM has none. The in-place updates are tested by element identity, not by focus or `scrollTop` in a browser.
- **The real port:** none of this ran against `web/sync.js`, the Replica or a server; that is p7-wire's job.
- **Accessibility:** no screen-reader or keyboard pass beyond `aria-label`s, real `<button>`s, and Enter or Space on thread rows.
- **Load:** performance with thousands of pins or a full 50-writer presence load is untested. Each records change computes the whole records view and a JSON signature per surface.

## Risks and notes for p7-wire

- **Two connections per tab:** `web/ui/session.js:68` binds one connection per stream (board and notes), each with its own client id and status. So:
  - **Presence in:** feed `onPresence` from one connection only, or lasers and emotes arrive twice.
  - **`me.client`:** set it to the id of the connection that sends presence, or the echo filter misses my own cursor.
  - **`port.status`:** decide how the two statuses merge into one.
- **Two port gaps need engine or p7-wire work:**
  - `previews(stream)` needs the sender; the Replica has it in `previewBy`, but `previewsOf` drops it.
  - `records().pending` must list unacked `records` ops; the Replica's `pending` map has them.
- **`onStatus` must also fire on a role change:** the UI reads `port.role` live.
- **The mock's emote set differs from the protocol's.** The mock used ❓ and 👀; the protocol wins, as the manager asked: 👍 ❤️ 😂 🎉 👏 😮 🙏 🔥. The bar shows the first six.
- **`+N` on phones:** CSS shows two avatars, but N is counted against five (as in the mock), so the number undercounts by up to 3 on phones.
- **Style overrides:** `web/style.css`'s `.react-chips` is `position: absolute` (from the mock), so `collab.css` overrides it for the popover. If p6 changes those shared classes, check the popover.
- **Popover drafts:** a reply draft survives records updates while the same thread stays open. Switching threads keeps it per thread in memory only.

## Open questions

None blocking. The CEO questions stay behind `web/collab/flags.js` at the mock's defaults.
