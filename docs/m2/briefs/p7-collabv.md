# Brief: p7-collabv (verify phase-7 collaboration UI, part 1)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers"), CLAUDE.md,
PROTOCOL.md v1 (§ Streams, § Presence, § Records) first. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p7-collabv (client): collaboration UI`. Manager: `manager client` (t14k).
- **Where:** the worktree /Users/r/repos/plenary-p2 (branch p2-land). Read only there. Other uncommitted files there
  (packages/protocol, PROTOCOL.md, test/*.js, web/sync.js, web/ui/…) belong to other jobs: ignore them. You own
  /Users/r/repos/plenary/docs/m2/reports/p7-collabv.md (main repo) and your scratchpad.

## The job you check

Builder brief: /Users/r/repos/plenary/docs/m2/briefs/p7-collab.md (the collab port, what to build, done-when). The
work: the untracked `web/collab/**` and `test/web/collab/**` in the worktree. The mock: /Users/r/repos/plenary/docs/m2/
design/ (phase-7 rows of README.md). No file outside those two directories may have been changed by this job.

## What to check

1. `bun test` passes in the worktree; test/web/collab tests could not pass with role gating, expiry or the records
   rules broken (mutate them in a scratch copy and see).
2. **Seam:** nothing in web/collab imports packages/protocol; the mirrored constants (rates, caps, the emote set
   👍 ❤️ 😂 🎉 👏 😮 🙏 🔥) match packages/protocol, and the test that compares them would catch a drift.
3. **Role rules** against PROTOCOL.md: viewers send only emotes and read records; commenter writes records only;
   nobody edits or deletes others' comments unless § Records allows; every presence kind respects the role table and
   the § Presence rates. Try to make the UI send what a role can't.
4. **Untrusted data to the DOM:** hostile user names, comment text, reactions, thread anchors (huge, script, quote
   breakouts, RTL overrides, zero-width): textContent only; nothing as HTML; no style injection via colors.
5. **Presence model:** expiry on `leave` and after 30 s, echo of my own presence filtered, laser fade, viewers'
   emotes only as counts, the `here` row (≤ 50, +N, watching count).
6. **The port doc** in web/collab/port.js: is it complete and implementable from sync.js and the Replica as they are
   (packages/protocol/replica.js on p2-land)? List every gap for p7-wire (the builder named: previews need the sender;
   records().pending needs unacked records ops; two connections per tab).
7. **The dev page** web/collab/dev.html in headless Chrome at 1440 and 390 px, light and dark; compare with the mock.

Builder's NOT verified: no real input in a browser (pointer, laser, compose, Enter, picker), animation only by test,
focus/scroll, the real port, accessibility, load with thousands of pins or 50 writers. Its risks: two connections per tab
(presence twice, `me.client`, merged status), `+N` undercounts on phones, shared CSS classes with web/style.css.

## sdd, processes

Single harness (codex only): load `sdd:subagent-driven-development`, check `usage`, run codex on web/collab in a scratch
git copy, write "single harness", confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

/Users/r/repos/plenary/docs/m2/reports/p7-collabv.md: **PASS or FAIL** first line, the worktree head, then HIGH / MEDIUM /
LOW with file:line. HIGH = a role can send what it can't, data reaches the DOM as HTML, a protocol import in
web/collab, a file changed outside the job's two directories, or the port can't be implemented as written. Then stop.
