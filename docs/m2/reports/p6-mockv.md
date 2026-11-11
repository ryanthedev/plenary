# Round 2 (fix round 1, re-verified 2026-11-11)

**PASS**: the HIGH is fixed, and so is every other finding but one. One MEDIUM is left: on phone, read-only still
leaves the "More" tools sheet live.

I judged the files under docs/m2/design/, not the builder's "Fix round 1" claims. I ran the DOM probe the builder
couldn't: 28 page loads in my own headless Chrome (port 0, PID 23515, killed by PID afterwards). All 28 had no JS
errors, no dialogs, and no request other than `file:`.

## Probe results: 3 roles × 4 connection states × 1440 and 390 px, each with a comment thread open

| Check | Result |
|---|---|
| "edits wait" text | **Viewer: 0 in every state** at both widths. The pill reads "Reconnecting…" or "Offline", and the banner says "the live view is paused". Presenter and annotator still show "3 edits waiting", which is correct |
| `mine` reaction chips | **0 for viewer** in every state, and **0 in read-only** for every role, with no ＋ react, reply box or Resolve either. 1 for presenter and annotator when they can write |
| Disabled write controls, read-only, desktop | Presenter: tools 1 of 18 enabled (Hand); panel 7 of 95 enabled, all view-only (▤ ▭ ⊟ ⚙ mode and fold, frame ‹ › and "all"); Mermaid and Export buttons gone from the top bar; Mermaid dialog "Insert as shapes" and both elbow chips disabled; Export dialog: every option and Download disabled. Annotator: tools 1 of 12, panel 0 of 33. Notes: "jump to" only; compose reads "Read-only: you can't add or change notes" |
| Phone docks | Presenter: Select, Pen, Rectangle, Text, More, Style, Notes, Comments. Annotator: Select, Note, Highlighter, Pen, More, Style, Notes. Viewer: Prev, Fit, Next, Notes, Comments (one Fit; the HUD has none). In read-only the drawing tools are disabled and More, Style and Notes stay usable |
| Phone emote button, not live | Disabled when reconnecting or offline for every role. Enabled when connected and in read-only, which is right: read-only still sends emotes |
| Phone Style sheet, read-only | Presenter: 52 controls disabled; only the 6 section tabs work. Annotator: all 33 disabled |
| Horizontal scroll | None (scroll width = viewport width in all 24 states) |

## Findings

- **MEDIUM, open (was #2): on phone, read-only leaves the More sheet live.** With `role=presenter&conn=readonly&sheet=tools`,
  all 19 buttons are enabled, including Rectangle…Laser, Image, Note, Highlighter, Mermaid, Export and Lock tool.
  The annotator gets 11. Cause: the tool grid has no `canEdit()` guard (`mock.js:381-383`). The README's claim
  that every write control is disabled (`README.md:78`) is too broad by this sheet. The Mermaid and Export dialogs
  it opens are disabled, so no write can be completed. Fix: add the guard, as the desktop toolbar does.
- **#1 HIGH (viewer "3 edits waiting", viewer's own reaction): fixed.** Seen in the probe above.
- **#3 (note authors tagged v0): fixed.** `mock.js:241`, `:293`, the README Annotations row and the legend now say v1
  `noteAuthor`. The draft still has `noteAuthor` in the snapshot (PROTOCOL.md:103, :184), so my round-1 caveat
  doesn't apply.
- **#5, #6 (phone docks), #7 (phone emote), #8 (emote tooltip), #10 (cosmetics): fixed.** I saw the docks and emote
  state in the probe, and read the tooltip and label changes in the code.
- **#9 contrast: fixed.** I recomputed the tokens in `mock.css` with the WCAG formula:

  | Text | Contrast |
  |---|---|
  | Light `--dim` `#676c75` | 5.28:1 on white, 4.89:1 on chrome |
  | Dark `--dim` `#8e8e98` | 4.64:1 or better on surface, raised, chrome and page |
  | White on name tags | Maya 5.18, Dev 5.59, Sam 6.11, laser 5.06, Priya 5.82, Tom 5.02, own colour 4.68 |
  | Frame names | Now `--muted`, 5.59:1 on chrome |

  The laser tag uses `var(--laser-tag)` (`mock.js:278`); no hard-coded tag colour is left.

## Other checks

- **shoot.sh: clean.** No `pkill` or `killall`, no debugging port, no server. Each Chrome gets a throwaway
  profile, its own `$!` is recorded, and only that PID is killed, after 30 s hung (`shoot.sh:10-18`). It now runs
  `mkdir -p shots`.
- **XSS: unchanged and clean.** The URL whitelist is unchanged (`mock.js:82-87`), and phone.html is unchanged.
  I didn't re-run the payload set, since no sink takes new inputs.
- **bun test:** 143 pass, 0 fail.
- **Ensemble: single harness.** One codex run (high effort) on the changed files, in an isolated scratch copy. It
  reached the same result on its own: #1 and #3-#10 fixed, #2 still open on the phone More sheet, and no
  regressions (no new injection path, no fetch, nothing wrong in shoot.sh).

## Not verified in round 2

- **Screenshots:** I took one (phone read-only Style sheet) and didn't view it; this round was DOM probes.
- **The builder's 32 retaken shots:** not opened.
- **Other browsers:** headless Chrome only, as before.

---

# Round 1

**FAIL**: one HIGH. The mock shows a viewer with durable writes the protocol rules out: "3 edits waiting", and a
reaction of its own on a comment. Everything else is MEDIUM or LOW.
Security and offline are clean: no XSS, no network requests, works from file://, `bun test` 82/82.

# p6-mockv: verification of the phase-6 design mock

Verifier: `verifier p6-mockv: design mock`, 2026-11-11. Job checked: every untracked file under docs/m2/design/,
against docs/m2/briefs/p6-mock.md. I edited nothing outside this report and my scratchpad.

## Verdict in one table

| Area | Result |
|---|---|
| Every listed surface present | Yes, all reachable through the MOCK bar for all three roles, both widths, both themes. Three product-UI gaps on phone and in read-only (MEDIUM) |
| Honesty | Every core name and value checks out. One false state, a viewer with pending edits (**HIGH**). Wrong source tags on note authors (MEDIUM) and one viewer reaction (MEDIUM) |
| Security | Clean. The phone.html XSS fix holds, and nothing reaches innerHTML from the URL |
| Offline / no build | Clean. Zero non-file requests in 60+ page loads; system fonts only; `bun test` 82 pass, 0 fail |

## Findings

### HIGH

1. **A viewer who loses the connection is told it has edits waiting.**
   - **Where:** `mock.js:128-129` (pill), `mock.js:319-320` (banners).
   - **The bug:** `pending = 3` is hard-coded for every role. With `?role=viewer&conn=reconnecting`, the pill reads
     "Reconnecting… · 3 edits waiting" and the banner says "Keep working: they're resent with the same ids". With
     `conn=offline` it says "3 edits wait in this tab… Closing the tab loses them".
   - **Why it's false:** a viewer writes nothing durable under both v0 and the v1 draft (PROTOCOL.md § Streams:
     "Viewers write nothing durable"). The claim isn't labelled, so it falls under the brief's HIGH rule
     ("an unlabelled false claim").
   - **How I saw it:** in my own headless Chrome run, the pill text and banner DOM for viewer × reconnecting and
     viewer × offline, at both 1440 and 390 px.
   - **Ensemble:** both codex runs reported it on their own (see Ensemble below). My browser check independently
     confirms it.
   - **Fix (small):** when the role is viewer, show the pill without the "N edits waiting" part, and banners that say
     only that the live view is paused.
   - **Second instance, same rule:** a viewer is shown owning a durable reaction. `mock.js:63` (`["👀", 14, true]`) is
     rendered as `mine` for every role (`mock.js:308`), including `?role=viewer&open=thread`, but v1 `react` is
     limited to commenter and above. I saw this in the code and did not re-run the browser for it. Codex (sol) found
     it too. Fix: render `mine` only for roles that can react.

### MEDIUM

2. **Read-only goes further than the builder disclosed: write controls stay live.**
   - **Where:** `mock.js:143-145`, `:240-247`, `:384-401`, and the panel chips.
   - **What stays live:** with `?conn=readonly` (presenter), the Mermaid ◇→ and Export ⤓ buttons, the Mermaid
     dialog's "Insert as shapes", every panel control (95 buttons, none disabled), and note edit/delete plus the
     compose box. Annotator read-only also keeps "edit delete" on its own note and the compose box.
   - **Why it misleads:** the pill tooltip says "nothing you do is sent" (`mock.js:160`), and the read-only thread
     popover says "Viewers read comments" to a presenter.
   - **How I saw it:** DOM probe in headless Chrome (counts of disabled buttons, the acts text, the dialog buttons).
   - Codex (sol) found the same thing.
3. **Note authors and the 🔒 locks are tagged v0, but v0 clients can't know authors.**
   - **Where:** `mock.js:289` (`data-src="v0 notes (author)"`), README "Annotations" row, legend "Who can touch what".
   - **The gap:** v0's snapshot holds only `streams` and `appSeq` (`packages/protocol/room.js:97`). `noteAuthor`
     lives only in the room, so a client that joined from a snapshot can't show authors or locks.
   - **Where it is supported:** the v1 draft adds `noteAuthor` to the snapshot so that clients know
     (PROTOCOL.md § Recovery, "Snapshot (sent to clients)").
   - **Grade:** the feature is supportable under the protocol plan, so this is a wrong tag, not an unsupported claim.
     MEDIUM, not HIGH. Retag it "v1".
   - **Caveat:** this grade rests on a draft that changed during my session. My first read of PROTOCOL.md said the
     snapshot "never holds op ids or note authors"; a later read had `noteAuthor` in it. If the draft drops
     `noteAuthor` from the snapshot again, this finding becomes HIGH.
   - Codex (sol) rated this HIGH. I refute HIGH for the reason above, and confirm it as MEDIUM.
4. (Moved: the viewer's own reaction is now the second instance under HIGH #1.)
5. **Phone presenter can't reach the notes stream or the comments list from the product UI.**
   - **Where:** the top-bar Notes button is `desk-only` (`mock.js:146`), and the presenter dock (`mock.js:355-356`)
     has no Notes or Comments button.
   - **What's left:** at 390 px only the MOCK bar's `sheet` select opens them. Annotator and viewer docks have them.
   - **How I saw it:** dock and top-bar DOM probe at 390 px.
6. **Phone annotator has no way to open Style (the Properties for their own note).**
   - **Where:** the annotator dock is `mock.js:357-358`. Only `?sheet=panel` reaches it.
   - Codex (default) rated this HIGH. I confirm the gap, but the surface exists and the MOCK bar reaches it, which the
     brief allows. A missing dock button is a design gap, so MEDIUM.

### LOW

7. **Phone emote button stays enabled offline and while reconnecting.**
   - **Where:** `mock.js:348`, which has no `live` check (desktop disables it).
   - **What happens:** tapping it sets `open=emote`, but the picker is suppressed. Seen in the offline phone
     screenshot.
8. **Emote tooltip vs protocol.** "everyone's in the last few seconds" (`mock.js:346`). In v1, `emotes` counts are
   viewers' emotes summed per 500 ms, and writers' emotes travel as presence. Wording only.
9. **Contrast below WCAG AA for small text (measured from the tokens in `mock.css:4-19`).**
   - **Light `--dim`:** `#9097a0` on white is 2.95:1, and on chrome 2.73:1. It is used for 9-12 px text: key hints,
     note meta, `.msg .who span`.
   - **Dark `--dim`:** 3.55:1.
   - **Name tags:** white on the user colours is 3.45-3.58:1 (Maya, Sam, laser).
   - Fix this before web/ copies the tokens.
10. **Cosmetic.** The "Dev K. selected" tag overlaps the "yes" edge label in frame 2 (desk dark). "Fill" labels two
    different rows (colour and fill style) in Properties (`mock.js:171,176`). The phone viewer has Fit twice (HUD
    and dock).

## Ensemble (OFFICE.md "sdd helpers")

**Single harness.** Only codex passed `check_adapter`:

| Harness | Status |
|---|---|
| codex | ok (5% of the 5 h window used) |
| agy | out of quota: 429, resets in about 70 h |
| grok | not signed in |
| kimi | no model configured |
| mistral | no API key |
| qwen | not installed |

- **The two runs:** default model, and `gpt-5.6-sol`, both at high effort, each in its own scratch git copy so
  neither could write to the real tree.
- **Independence:** two codex runs are not two harnesses. Where they agree, I used my own browser check as the
  independent confirmation.

| Finding | codex | codex sol | Me | Outcome |
|---|---|---|---|---|
| Viewer "3 edits waiting" | MEDIUM | MEDIUM | browser | **Confirmed, graded HIGH** (#1) |
| Read-only write controls live | — | MEDIUM | browser | Confirmed MEDIUM (#2). Codex also flagged the "nothing you do is sent" tooltip vs live emotes: folded in |
| Note authors tagged v0 | — | HIGH | code | Confirmed as MEDIUM; HIGH refuted (#3) |
| Viewer owns a reaction | — | MEDIUM | code | Confirmed; graded HIGH as the second instance of #1 |
| Annotator Style unreachable on phone | HIGH | — | browser | Confirmed as MEDIUM (#6) |
| Phone emote enabled offline | MEDIUM | — | screenshot | Confirmed LOW (#7) |
| Emote count timing | — | LOW | — | Confirmed LOW (#8) |
| `shots/` missing; shoot.sh doesn't mkdir | LOW | MEDIUM | — | **Refuted.** My review copies left `shots/` out. The real tree has 28 PNGs in `docs/m2/design/shots/` |

## What I checked, and how

- **Surfaces.** I went down the brief's canvas and collaboration lists one by one, for every role, at 1440×900 and
  390×844 (a true 390 px viewport through DevTools emulation, not the builder's crop), light and dark.
  - **DOM probes, 30 states:** tool lists per role, disabled controls, pill text, banners, cursors shown, dock and HUD
    contents, panel, drawer and sheet geometry, no horizontal scroll.
  - **Viewed:** 24 of the 26 screenshots I took, through montages. The two I first skipped (desk annotator light,
    desk viewer dark) were viewed at the end.
  - **The builder's never-viewed list, all viewed:** desk annotator dark, viewer light, point dark, reconnecting
    light; phone presenter dark, annotator dark, viewer light, notes sheet light, offline light.
  - **Also viewed:** the tools and panel sheets, the phone thread, viewer comments, export dark, tabs mode, emote
    picker, and sources on.
  - **Not viewed as screenshots:** the resolved-comment popover (`open=resolved`) was never loaded. The Mermaid
    dialog was seen only through a DOM probe, in the read-only run.
  - **Library at 900 px:** reachable; the panel scrolls (`overflow-y: auto`, 1360 px content).
- **Honesty.**
  - **Matched verbatim against packages/core:** `TOOLS` (ids, keys, icons, names), `STROKES`, `FILLS`, `WIDTHS`,
    `STYLES`, `SECTIONS`, `PRESET_NAMES`.
  - **Grepped, all exist:** every API name the mock cites (toolLock, addImage, addFiles, setStyle, align, distribute,
    reorder, group/ungroup, cloneSelection, toggleLock, rotateBy, resetRotation, goToFrame, stepFrame, animate,
    clearAnimation, playToggle, stopPlay, time, duration, the layer ops, libraryItem, insertLibraryItem, MODES,
    applyPanel, addColor, importMermaid with its `elbow` option, isMermaid, exportScene, zoomAt, DARK/LIGHT).
  - **Values checked:** panel width 180–520, 150 ms stagger, 32-unit export padding, roughness 0/1/2, the hachure and
    cross-hatch fills, all 9 `ARROWHEADS`, the Mermaid directions and subgraph frames, `.excalidrawlib`, and every
    keyboard shortcut shown against `shortcuts.js`.
  - **Protocol tags:** checked against `git show HEAD:PROTOCOL.md` (v0) and the working-tree v1 draft (presence
    kinds and who sends them, `here`, `emotes`, `records` actions and roles, anchors, notes writers).
  - **Annotator pen, arrow, text and eraser in `notes`:** labelled in the legend and README as beyond the v1 draft,
    an open question. That is honest.
- **Security.**
  - **Every sink read:** each innerHTML in mock.js takes only constants and `S` values that passed the
    `VALID[k].includes()` whitelist (`mock.js:87`), and `set()` checks the same list. phone.html builds the frames
    with DOM calls, and `fr.src` always starts with `index.html?`. A wider grep (hash, referrer, window.name,
    postMessage, Storage, srcdoc, `.src=`, `.href=`) found nothing else.
  - **Browser probes:** 22 runs, of which 19 tested something. The other three: the 1 MB index.html run and the
    500 KB phone.html run both landed on Chrome's error page (the index one was redone at 280 KB over file://), and
    the file:// phone.html run couldn't see inside the iframe (the localhost runs cover that).
  - **Payloads:** in headless Chrome, 5 payloads (`"><img src=x onerror=…>`, a quote breakout,
    `<svg onload>`, `javascript:`, an attribute breakout) went into all 9 params plus an unknown one on index.html,
    and into `q=` and `bare=` on phone.html.
  - **The iframe was checked too:** I served the files over localhost so the iframe was same-origin and inspectable.
  - **Also tried:** `__proto__[polluted]`, `__proto__`, `constructor`, `hasOwnProperty` and `toString` as keys, and a
    280 KB value over file://.
  - **Result:** no flag set, no dialog, no injected element or handler, no prototype pollution, and every case fell
    back to its default.
- **Offline.** Every network request in every run was `file:` (or my localhost server for the iframe test). No
  `@import`, `@font-face` or `url(` in the CSS. The README is right that no web fonts are fetched.

## What I did NOT verify

- **Other browsers:** Safari, Firefox and real touch devices. Headless Chrome only.
- **Interaction:** I didn't click through the MOCK-bar flows. I loaded states by URL; `set()` uses the same whitelist.
- **Reading order:** I didn't judge the visual design, only completeness and correctness.
- **Phone viewer with a sheet open over the HUD:** not checked.
- **Visual check of two dialogs:** the resolved-comment popover and the Mermaid dialog were not looked at as
  screenshots.
- **A very long `q=` value on phone.html:** untested, because that run hit Chrome's error page.

## Process notes for the manager

- **Engram:** recall failed (the resolver returned zero addresses). I worked without it.
- **The 9333 clash:** my headless Chrome (pid 44281) held port 9333; p6-base's Chrome (58635) had no listener on it.
  - **The risk:** p6-base's tooling may have been driving my Chrome, and lost it when I stopped mine.
  - **What I did:** stopped my own PIDs 44281 and 44279 after checking them with `ps`. No pattern kills.
  - **Who connected where:** my harness opened and closed tabs only in the Chrome listening on 9333, which was mine.
- **Scratch only:** my harness, outputs and screenshots are in my session scratchpad, not the repo.
