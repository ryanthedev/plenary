# Brief: pd-drawh4 (drawh proposal, round 4: protocol v1.1)

docs/m2/BRIEF-BASE.md applies (its Architecture line too; drawh itself sits outside Plenary's hexagon, but the bridge
keeps its pure logic in `cli/bridge.js` and its I/O in `cli/plenary.js`/`cli/files.js`, so keep that split).
Manager: `manager platform` (t187). Report only to the manager (t187), never message the proxy. Report: append "Round 4 (v1.1)" to docs/m2/reports/pd-drawh.md. Never
pkill/killall; servers on port 0 from a command that records the PID; kill only that PID.

**Systems design skill:** this round changes the bridge's consistency model (local three-way merge → server
compare-and-set). Apply `distributed-systems-design` in APPLIER mode before coding (if not in your skill list, read
/Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and its `references/`), and put a
short note in the report: what each failure (lost refusal, resync mid-change, epoch change, restart) does now.

## Goal

Protocol v1.1 makes board settings compare-and-set: each settings op names, per key, the `appSeq` it was based on
(`appBase`), and the room refuses a stale one with a soft `stale-setting`. A drawh bridge without `appBase` gets
`bad-op` from a v1.1 room. Move the drawh proposal onto v1.1, and use the room's check instead of local guessing
where that is simpler. This round and engine's v1.1 server land together.

## Read first

- docs/m2/briefs/pd-drawh.md (hard rules: ~/repos/herdr-draw is read-only; work in a fresh `git clone --local` in your
  scratchpad, never a worktree), docs/m2/proposals/drawh-server.md, docs/m2/reports/pd-drawh.md (all rounds) and
  docs/m2/reports/pd-drawhv.md (all re-checks).
- PROTOCOL.md v1.1 and the code at **p2-land 5d55112** (worktree /Users/r/repos/plenary-p2; read-only for you):
  `packages/protocol/`. The API for drawh is in docs/m2/reports/p11-proto.md, "Replica / Room API for drawh and the
  web client" and "API changes for drawh and the client"; engine's to-do for drawh: take this protocol, use
  `keepVersions` and its own renumber/hold-back rule via `roomVersion`, use `refusedSettings`/`retryReady`, read
  `welcome.room`.
- Start from the committed patch (`docs/m2/proposals/drawh-server.patch`, c3adcba: option 2, settings room → file only) on a fresh clone of herdr-draw
  5dfe352.

## Do

1. **Protocol copy:** re-copy `packages/protocol` byte-identical from p2-land 5d55112; SOURCE.json names that commit.
2. **Settings on v1.1:** let the Replica stamp `appBase` (the caller's is ignored). Decide, with evidence, how much of
   round 3's generation marker is still needed: the room now refuses a stale key, but the bridge still has to know
   which file a save was built on to build the right value (a stale save must not become a fresh change based on
   the current appSeq). Keep what is needed, drop what isn't, say why. Bring file-side settings back (option 2 refuses them today); R1, R2a, R2b, R3 (rapid toggles) and case V (an undo with a peer change in between) must hold: refused loudly or sent, never silently lost (see docs/m2/reports/pd-drawhv.md).
3. **`stale-setting`:** soft. The board's value wins and is written to the file; one line names the key. Retry only
   when `retryReady` says so, and only if the file still holds a change the user made.
4. **Epoch:** read `welcome.room`. Missing = unknown epoch, not an error (real servers send it only after engine's
   p2-swap). A lower epoch than one seen, or another board: treat as another room (the round-2 rule).
5. **Elements:** `keepVersions` with the renumber/hold-back rule via `roomVersion` (engine's note); the seeding
   behaviour stays as decided (renumber only elements the room would refuse, to version 1).
6. Keep everything else from rounds 1-3b. Tests in herdr-draw `test/plenary.test.js` against the v1.1 `Room`;
   rerun the verifier's live scripts (settings.sh, toggle*.sh, undo.sh, measure.sh only if the write path changed).

## Gates

`git apply --check` on a fresh clone of 5dfe352; herdr-draw `bun test`; plenary `bun test` in the p2-land worktree
(if a full run fails, name the failing tests: `bun test 2>&1 | grep -E '\(fail\)'`); herdr-draw untouched. Update
drawh-server.md (protocol line, settings section, limits).

## Done when

The above, report appended (what changed, tests, live numbers, not-verified, risks, the skill note). Then stop. Do
not commit. If your context passes 60%, write docs/m2/handoff/pd-drawh4.md and stop.
