# Report: p6-mock (phase-6 design mock)

**Status: done, ready for a verifier and then the CEO.** Open it with `open docs/m2/design/index.html`. Every
surface in the brief, for presenter, annotator and viewer, in light and dark, at desktop and phone width, is
reachable from the MOCK bar or URL parameters. `bun test`: 29 pass, 0 fail. Nothing committed.

## Files (all new, all under docs/m2/design/ plus this report)

| File | What |
|---|---|
| `index.html`, `mock.css`, `mock.js` | The mock: static, no build, no network (system fonts only; no web fonts, no CDN). The board is hand-drawn inline SVG. |
| `legend.html` | Source-tag key, role matrix (who can touch what), connection pill states, what's left out on purpose. |
| `phone.html` | The mock in real 390 px iframes. Desktop Chrome won't open a window narrower than about 500 px. |
| `README.md` | Checklist: each brief surface, where it is in the mock, and its source (core API, PROTOCOL.md section, or new). |
| `shoot.sh` | Retakes all 28 screenshots with headless Chrome. |
| `shots/*.png` | 17 at 1440×900 and 11 at 390×844, light and dark, all three roles, plus one per state. 3.6 MB. |

## How I checked

- **Screenshots, looked at:** I opened these 17 shots after the final changes, or shortly before them:
  - desk: presenter light and dark, annotator light, viewer dark, presenter tabs dark, thread light, resolved light,
    emote light, Mermaid light, export dark, offline dark, read-only light, sources light
  - phone: presenter light, panel sheet light, tools sheet dark, thread dark, viewer dark, annotator light

  I did NOT open these 11, which the script made from the same code: desk annotator dark, viewer light, point dark,
  reconnecting light; phone presenter dark, annotator dark, viewer light, notes sheet light, offline light.
  Fixed what I saw:
  - shape fills were hidden by a CSS rule
  - phone-only controls showed on desktop
  - the top bar overflowed at 1440 px
  - the 390 px shots were really 500 px layouts cropped (now shot through phone.html and checked with `sips`)
  - presence still showed while offline
  - the source tags broke the layout of absolutely placed overlays
- **Names checked against packages/core:**
  - `TOOLS` (ids, names, icons, keys) and `SECTIONS`, copied verbatim
  - `STROKES`, `FILLS`, `WIDTHS`, `STYLES`, and the 7 `PRESET_NAMES`
  - from herdr-draw's panel: roughness 0/1/2, opacity 100/75/50/25, fonts hand/sans/mono, text sizes 16/20/28/36, arrow sharp/curve/elbow
  - the Editor methods named in README.md (grepped)
- **Honesty:**
  - Export: core has `exportScene` only. Its comment names `toSvg`, but that writer lives in herdr-draw's
    adapters/svg, not in packages/core (grepped). So both the SVG and PNG writers are marked "new in web/". The export
    preview is a board-only thumbnail: no notes, selection or presence.
  - Animate: `duration()` is shown as a read-only "0.8s / 2.4s", not an editable field.
  - Mermaid: the dialog says flowcharts only, per mermaid.js's header.
- **Aligned with the phase-1 draft:** PROTOCOL.md changed to a v1 draft while I worked, so I matched it:
  - reactions are on comments only (chips under messages), not on elements or the board
  - viewers may send emotes, counted
  - the highlighter is a `freedraw` element in `notes`
  - pictures are in `notes`, so annotators get the image tool
  - the avatar row comes from `here`; cursors, selections and laser are presence
  - the live stroke is a `preview`
  - one fixed emote set of eight: the bar shows the first six, and ✨ shows all eight
  - when not connected: others' cursors, selection, laser and live stroke are hidden; the emote bar is disabled; the viewer count is dimmed
- **Security fix (manager's request, MEDIUM DOM XSS):**
  - **phone.html:** now builds the figcaption and iframe with `createElement`, `textContent` and `setAttribute`. The `src` comes from `URLSearchParams`.
  - **mock.js:** URL parameters are now checked against a list of allowed values per key, so URL text never reaches the `innerHTML` templates. The thread lookup uses `Object.hasOwn`, so `?open=__proto__` falls back to nothing.
  - **Tested:** I loaded both pages with an `"><img onerror=…>` payload in headless Chrome (`--dump-dom`). No `<img>` was injected, the title was unchanged, and an invalid `role` fell back to presenter.
  - **Other `innerHTML`:** every remaining use renders only constants and fake data.
- `bun test` passes. `git status` shows only my new files. PROTOCOL.md, COMMITMENTS.md and the p1 briefs are changed or
  new from other sessions; I didn't touch them.

## Not verified

- **Other browsers:** only headless Chrome on macOS. Not Safari, Firefox, or a real phone. Emoji and `color-mix()` depend on the browser.
- **Contrast:** I didn't measure it (WCAG); I only eyeballed it.
- **Interaction:** this is a picture that can switch states, not a working canvas. Tools, sliders and drags do nothing.
- **Phone screenshots:** taken through an iframe in a 600 px window and cropped to the middle 390 px. A real device may differ (safe areas, the on-screen keyboard).
- **Engram recall:** the search failed (DNS error, "produced zero addresses"), so I had no stored memory to check.

## Risks

- **The v1 protocol draft isn't reviewed yet.** If the CEO changes it, the "v1" tags and the reactions and emotes
  design change with it. README.md and legend.html name the draft's terms, so a diff is easy to spot.
- **One Editor or two:** annotating needs the web/ client to send notes to the `notes` stream. Core's Editor edits one Doc, so the client
  probably runs two Editors (board and notes), or a routing layer over one. That's a phase-6 build question the mock hides.
- **Read-only state:** the panel still renders in the read-only state (a presenter downgraded to viewer); only the
  tools are disabled. The real client should grey the panel out too.
- **Highlighter and note tools:** they have no keyboard keys. I didn't invent any (N and M are free in `Editor.key` if wanted).

## Open questions (for manager client, and the CEO where marked)

1. **(CEO) Annotator cursors for viewers:** should 100k viewers see annotators' cursors? The mock shows viewers only the presenters'
   cursors and laser. The v1 draft caps annotator cursors at 50 per board but doesn't say who receives them.
2. **(CEO) Follow the presenter:** should viewers get a "follow presenter" view? It's not in the brief, so it's not in the mock. Without it,
   viewers pan and zoom on their own, and use frames ‹ ›.
3. **Commenter role:** the v1 draft's `commenter` role (comments only, no notes) isn't shown as its own view. Does it need one?
4. **Exporting notes:** should export include the notes stream? core `exportScene` takes one doc. The mock exports the board only.
5. **Read-only for a non-viewer:** the mock shows a banner when the role drops to viewer mid-session. Can that happen (phase 5 roles)? Or
   is "read-only" only ever `welcome.role = viewer`?
6. **Viewers reading comments:** the mock lets viewers read notes and comments but not reply or react. Confirm.
7. **(CEO) Reactions:** reactions exist only on comments (per the v1 draft). The crowd bar is emotes and is never saved,
   so the "1.2k 👏" numbers are live counts, not a record. Is that OK, or do you want saved reactions on elements or the board?
8. **Annotator tools beyond the v1 draft:** the mock gives annotators pen, arrow, text and eraser in `notes`. Tom's
   arrow is a note. The v1 draft's `notes` row lists only sticky notes, highlighter strokes, pins and pictures. Should the
   draft widen, or the toolbar shrink? It's flagged in README.md and legend.html.

Manager: please rename my tab `done p6-mock` (OFFICE.md). I'm stopping here.

## Fix round 1 (from docs/m2/reports/p6-mockv.md)

**Status: every finding from p6-mockv is fixed, in docs/m2/design/ only.** `bun test` passes (143 pass, 0 fail).
Nothing committed.

| # | Finding | Fix |
|---|---|---|
| HIGH 1 | A viewer was shown "3 edits waiting", and a reaction of its own | Viewers' pill reads just "Reconnecting…" or "Offline". Their banners say only "the live view is paused". A reaction chip is `mine` only when the session can react: not a viewer, and not read-only |
| MEDIUM 2 | Read-only left write controls live | When the session can't edit, these are disabled and dimmed: Mermaid ◇→, Export ⤓, "Insert as shapes", Download, and every panel chip and swatch. Frame ‹ › and "all" stay live, because they only move the view. Note edit/delete become "jump to" only. The compose box becomes "Read-only: you can't add or change notes". A presenter now reads "Read-only: you can't reply or react". The pill tooltip now says "nothing durable… Emotes still are" |
| MEDIUM 3 | Note authors and locks were tagged v0 | Now "v1 snapshot noteAuthor" in mock.js, the README Annotations row and the legend role matrix. The annotator panel hint says the rule is v0, and knowing authors is v1 |
| MEDIUM 5, 6 | Phone docks | Presenter: Select, Pen, Rectangle, Text, More, Style, Notes, Comments (Arrow moved to More). Annotator: Select, Note, Highlighter, Pen, More, Style, Notes |
| LOW 7 | Phone emote button live while offline | Disabled when not live |
| LOW 8 | Emote tooltip | Now says presenters' and annotators' emotes float live, viewers' are summed by the room every 500 ms, and the number is viewers' latest count |
| LOW 9 | Contrast | Every dimmed-text and name-tag color is now 4.5:1 or better on its background (measured with the WCAG formula; details below this table). Frame names use `--muted` |
| LOW 10 | Cosmetics | The "Dev K. selected" tag sits below its box, and the "no" edge label moved below its line. The second "Fill" row is now "Pattern". The phone viewer has one Fit (in the dock) |

**Contrast details (LOW 9):**
- **Dimmed text, light mode:** `#676c75`, 5.28:1 on white and 4.89:1 on the toolbar background.
- **Dimmed text, dark mode:** `#8e8e98`, 4.64:1 or better on every dark surface.
- **Name tags:** Maya `#c2410c` 5.18:1, Dev `#0b7285` 5.59:1, Sam `#237032` 6.11:1, laser tag `#d42a20` 5.06:1. Priya, Tom and the user's own color were already 4.68:1 or better.

**Process (the new OFFICE.md rule):** `shoot.sh` opens no ports and starts no server. It uses `--screenshot` only,
gives each Chrome a throwaway `--user-data-dir`, and runs it in the background. It records the PID in
`$TMPDIR/plenary-shoot-pids.log` and waits for it. Only that PID is ever killed, and only after 30 s hung; that never
happened. After the first new run, `ps` found none of the 32 logged PIDs alive. No `pkill` or `killall` anywhere.

**Shots:** I retook all 32; four new ones cover the fixed states:
- desk-viewer-thread-light
- desk-viewer-reconnecting-dark
- desk-readonly-mermaid-light
- phone-viewer-offline-light

**Viewed after the fixes:**
- desk: viewer reconnecting dark, read-only Mermaid light (before and after the dimming), viewer thread light, presenter dark, presenter light
- phone: presenter light, annotator light, viewer offline light

**Not verified this round:**
- **DOM probe:** the scripted check (count of "edits wait", `mine` chips and disabled buttons per state) was denied
  by the permission prompt, so these fixes are checked by screenshot and code reading only.
- **Other shots:** the rest of the 32 were retaken but not reopened.
