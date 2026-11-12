# Brief: pd-drawhv (verify pd-drawh: drawh proposal patch)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/pd-drawhv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit.

## Hard rules

- **~/repos/herdr-draw is read-only.** No edit, commit, branch, stash, worktree, or release script there. Test the
  patch only in a fresh `git clone --local ~/repos/herdr-draw <scratch>/hd` in your scratchpad. At the end, show
  herdr-draw is untouched (`git -C ~/repos/herdr-draw status --short` empty, HEAD unchanged, no stash/worktree).
- Never pkill/killall. Start servers from a script that records the PID; kill only that PID. Use port 0.

## Goal and done-when (docs/m2/briefs/pd-drawh.md: read it)

`drawh --server URL --token TOKEN --board ID` connects herdr-draw to a Plenary server: token in the first message
(hello), never a header, never logged, never written to disk; without `--server`, drawh behaves exactly as today;
plenary's packages/protocol copied byte-identical into herdr-draw with a SOURCE.json (commit + sha256). Done when
the patch applies cleanly to herdr-draw HEAD (`git apply --check`), herdr-draw's tests pass with it applied,
plenary's `bun test` passes, and the proposal doc exists. The CEO approves or rejects it; your job is whether it
is fit to put in front of the CEO.

## The job's files (new, untracked)

`docs/m2/proposals/drawh-server.patch`, `docs/m2/proposals/drawh-server.md`.

## Try to break it

- Apply to a fresh clone at herdr-draw HEAD; run herdr-draw's tests; diff the test count before/after.
- Byte-identity: sha256 of every copied protocol file vs plenary's packages/protocol at the commit SOURCE.json
  names, and vs the working tree now.
- Token handling: grep the patch for any path that prints, logs, writes, or puts the token in a URL, header, argv
  visible in `ps`, or an error message. Run it and check `ps`/state files/stdout.
- Without `--server`: existing drawh commands behave identically (run a few in both clones and compare output).
- Run the bridge against a stand-in (the reference `Room` behind a Bun WebSocket on port 0): edits flow both ways,
  reconnect, a refused token, a bad URL, a server that closes mid-stream. Does anything hang, crash, or lose
  an edit silently?
- Does the proposal doc say plainly what is untested (real server, Herdr runtime, v1 protocol)?
- plenary `bun test` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load the `sdd:subagent-driven-development` skill first. Check `usage`, then run an ensemble review of the patch
(it's large: point harnesses at the cli/ and SOURCE.json hunks, not the copied protocol files) with codex + agy +
every other harness that passes `check_adapter`. Two agreeing = HIGH candidate: confirm or refute it yourself.
List which harnesses ran. If only one passes `check_adapter`, say so.

## The builder's not-verified list and risks (only these, not its claims)

- No real Plenary server; the copied protocol is v0 (no `v: 1`, no wait for `welcome`, no presence/records).
- Herdr QuickJS / live Herdr WebSocket not used; `herdr-app check` not run on the built mod.
- Back-off timer after `unavailable` untested; `wss://`, large boards, long runs, two bridges on one file untested.
- The protocol copy goes stale when phase 2 rewrites packages/protocol.
- Elements > 1,000 versions ahead are refused by the room, so old boards can't be fully seeded.
- A room behind the saved state is re-seeded from the file automatically.
- A non-empty file pointed at an existing board publishes its shapes without confirmation.
- File write is check-then-rename; a write in the last instant before the rename is lost.

Grade HIGH: token leak, herdr-draw modified, patch doesn't apply, tests fail, drawh without `--server` changed,
or silent loss of a user's edit. Then stop and leave the session idle.
