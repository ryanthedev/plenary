# Handoff: pd-drawh4 (drawh proposal round 4, protocol v1.1)

**Closed 2026-11-12: all three items done in the second session (report, "Second session").**

Brief: docs/m2/briefs/pd-drawh4.md. Report so far: docs/m2/reports/pd-drawh.md, "Round 4 (v1.1)" (design, as built,
tests, mutation table, gates, not verified). Manager: t187. Not committed.

## State

- **Done:** protocol re-copied (5d55112); bridge on v1.1 (settings by file base + room CAS, `stale-setting`,
  `retryReady` gates, epoch, `keepVersions`); runner sends via `outgoing()` with a `wait()` timer; 46 tests in
  `test/plenary.test.js`; herdr-draw 304 pass in a fresh 5dfe352 clone with the patch; plenary protocol 128 pass;
  patch in docs/m2/proposals/drawh-server.patch (sha256 9b50663e57c8aed1…); drawh-server.md settings section,
  protocol line and limits updated.
- **Working clone:** `/private/tmp/claude-501/-Users-r-repos-plenary/fe5a16fd-b5d6-49a5-aa8d-fbe99e4936d4/scratchpad/hd`
  (patch applied on 5dfe352). Re-cut: `bash scripts/build.sh && cp build/herdr-draw/cli/*.js mods/herdr-draw/cli/`,
  `git add -A`, the three header lines (see the current patch), `git diff --cached`.

## Left to do

1. **herdr-draw `CLAUDE.md` in the patch** still describes option 2 and protocol v0: rewrite its drawh --server
   paragraph (settings by file base + room compare-and-set; protocol v1.1 copy at 5d55112), re-cut, re-run the gates.
2. **Live scripts** (verifier's, in `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r5/probe/`
   and `r7/probe/`): copy, adapt `standin.js` to v1.1 (hello `meta` from `tableAuth(...).check(token, board)`;
   `new Room` without `auth`), say they were changed. Run settings.sh, toggle*.sh, undo.sh, vlive2.sh, and
   **measure.sh** (the stamp write after a settings send is new). Servers on port 0, record PIDs, kill only those.
3. Append the live numbers to the report; then report to t187 and stop.

## Open questions for the manager (also in the report)

- A snapshot answer to the tip check still counts as another room (markers dropped, shapes resent), even when
  `welcome.room` vouches; could be relaxed once real servers send `room`.
- After a `stale-setting`, the write-back overwrites whatever the file holds for that key at that moment.
