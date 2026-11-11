# Brief: p6-mockv (verify the phase-6 design mock)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work"), docs/m2/PLAN.md (phases 6, 7),
CLAUDE.md first. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-mockv: design mock`. Manager: `manager client`.
- **You own:** docs/m2/reports/p6-mockv.md and a scratch dir (your session's scratchpad). Read only everywhere else.
  Don't edit docs/m2/design/; findings go in your report.

## The job you check

Builder brief: docs/m2/briefs/p6-mock.md (goal, the surface list, "Honesty", done-when). The work: every file under
docs/m2/design/ (all new, untracked: `git status docs/m2/design`). Open it with `open docs/m2/design/index.html`.

## What to check

1. **Every surface present.** Go down the brief's lists (canvas UI and collaboration) one by one and find each in the
   mock, for presenter, annotator and viewer where it applies. Take your own screenshots (headless Chrome or the Mac
   screenshot tools) at 1440 px and 390 px, light and dark, and look at them; don't trust the builder's shots/.
2. **Honesty.** Nothing claims a feature core's Editor (packages/core: editor.js TOOLS, panel.js SECTIONS, export.js,
   mermaid.js, library.js, anim.js) or the protocol plan (PLAN.md phases 1 and 7, PROTOCOL.md as it stands now, a v1
   draft in progress) can't support, unless it is labelled "new in web/" or "needs protocol v1". Grep names against core.
3. **Security.** A MEDIUM DOM XSS was reported in phone.html (URL params into innerHTML) and the builder says it is
   fixed in phone.html and mock.js. Confirm it yourself: read every innerHTML/insertAdjacentHTML/outerHTML/document.write
   and every place location/URL params flow, and try hostile params (`"><img src=x onerror=…>`, `__proto__`, very long
   values) in a real headless browser.
4. **Offline/no build.** No network fetch beyond fonts; works from file://. `bun test` passes.

Things the builder said it did NOT verify (check what you can): 11 of 28 screenshots never looked at (desk annotator
dark, viewer light, point dark, reconnecting light; phone presenter dark, annotator dark, viewer light, notes sheet
light, offline light, and others); only headless Chrome; contrast not measured; phone shots are a 600 px window cropped
to 390 px; in the read-only state the panel still renders (only tools disabled).

Risks the builder named: it follows an unreviewed protocol v1 draft (reactions on comments only, highlighter as a
freedraw in `notes`, viewers send emotes); annotator tools (pen, arrow, text, eraser in `notes`) go beyond the draft's
`notes` row.

## Report

docs/m2/reports/p6-mockv.md: **PASS or FAIL** on the first line, then findings as HIGH / MEDIUM / LOW with file:line
and how you saw it. HIGH = a listed surface missing, an unlabelled false claim, a live XSS, or broken offline. Say what
you checked and what you did not. Then stop and leave the session idle. Don't commit.
