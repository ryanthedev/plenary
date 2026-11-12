# Brief: pd-drawh (drawh proposal: `drawh --server URL --token`)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/pd-drawh.md.

## Goal (PLAN.md, drawh proposal row)

"drawh proposal (`drawh --server URL --token`): a patch file under docs/m2/proposals/, never applied to herdr-draw
without the CEO." Done when the CEO approves or rejects it; your part is a patch that applies cleanly and a short
proposal doc the CEO can decide on in two minutes.

## Hard rules

- **herdr-draw (~/repos/herdr-draw) is read-only.** Never edit, commit, branch, stash or run its release script in
  that checkout. To make and test the patch, copy it to your session scratchpad (`git worktree` is NOT allowed
  either: it writes into herdr-draw's .git). E.g. `git clone --local ~/repos/herdr-draw <scratch>/hd`, work there,
  `git diff > docs/m2/proposals/drawh-server.patch`.
- **packages/core is not edited** (CLAUDE.md); the protocol is copied into drawh byte-identical with a SOURCE.json
  (CLAUDE.md M2 decision), never a published package.
- Nothing published, nothing pushed.

## Files you own

- `docs/m2/proposals/drawh-server.patch` (a `git diff` against herdr-draw's current HEAD; name the commit in it)
- `docs/m2/proposals/drawh-server.md` (one page: what it does, how to try it, what's untested, risks)
- docs/m2/reports/pd-drawh.md

## What the patch should do

Read herdr-draw's CLAUDE.md, cli/drawh, adapters/herdr and mods first, then plenary's PROTOCOL.md (working tree,
v1 being verified) and packages/protocol/ (Replica, codec, envelope).

- `drawh --server URL --token TOKEN --board ID` connects herdr-draw to a Plenary server: hello with the token **in
  the first message, never a header** (Herdr refuses credential headers), `since` from local state, then live ops
  via a protocol `Replica`. Without `--server`, drawh behaves exactly as today.
- Protocol files copied byte-identical from plenary's packages/protocol into herdr-draw (pick a path), with a
  SOURCE.json (plenary commit + sha256 per file), like plenary's packages/core/SOURCE.json.
- Token from a flag or an env var; never logged, never written to disk.
- Tests in herdr-draw's own style for the parts that don't need a server (arg parsing, hello shape, SOURCE.json
  check); a test against an in-process `Room` from packages/protocol if feasible.

There is no Plenary server yet (phase 3). Test against a stand-in (a local Bun WebSocket server wrapping the
reference `Room`) in your scratch dir; say so in the report.

## Done when

The patch applies cleanly to herdr-draw HEAD in a fresh scratch clone (`git apply --check`), herdr-draw's tests
pass with it applied in that clone, plenary's `bun test` passes, the proposal doc exists. Report what you did NOT
verify (e.g. inside Herdr's QuickJS runtime, a live Herdr WebSocket). Then stop. Do not commit.
