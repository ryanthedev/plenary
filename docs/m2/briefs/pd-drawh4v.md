# Brief: pd-drawh4v (verify drawh round 4: protocol v1.1)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report: append
"# Round 4 check (v1.1)" with PASS or FAIL and HIGH/MEDIUM/LOW to docs/m2/reports/pd-drawhv.md. Report only to t187;
never message the proxy. Never pkill/killall; servers on port 0 from a command that records the PID; kill only that
PID. ~/repos/herdr-draw is read-only: work in a fresh `git clone --local` in your scratchpad, never a worktree.

## Job under check

Goal: move the drawh `--server` proposal (patch for herdr-draw 5dfe352, never applied) onto Plenary protocol v1.1:
settings ops carry `appBase` (per-key compare-and-set; the room refuses a stale key with a soft `stale-setting`),
`welcome.room {board, epoch}`, `keepVersions`. Bring file-side settings back (the committed c3adcba refuses them).
Brief: docs/m2/briefs/pd-drawh4.md. Patch: docs/m2/proposals/drawh-server.patch (sha256 0cbf6109011b43b2…), doc
drawh-server.md; protocol at p2-land 5d55112 (worktree /Users/r/repos/plenary-p2, read-only). Diff against the
committed proposal: `git diff -- docs/m2/proposals/`.

The bar (same as every round): **no silent loss of a user's edit, no peer change undone.** Loud refusal is fine.
Known and accepted (do not re-grade): an agent's save that read the file before the user's settings change undoes it
(MEDIUM, documented); a hand-written invalid value in a never-set key.

Builder's not-verified list and open questions (not its claims): no real v1.1 server, real pane, Linux or wss.
(1) A snapshot answer to the tip check counts as "another room" (shapes resent) even when `welcome.room` vouches.
(2) After `stale-setting`, the write-back overwrites whatever the file holds for that key at that moment: can that
silently overwrite a NEWER user change made after the refused one? Probe it live and in-process; grade it.

## Check

- Your own live scripts (settings.sh, toggle*.sh, undo.sh, the case-V probe, measure.sh and the builder's
  measure_s.sh) against a v1.1 stand-in you control; R1, R2a, R2b, R3, case V; loud or sent, never silent.
- Epoch: missing `welcome.room` = unknown, not an error; a lower epoch or another board = another room.
- Retry: only when `retryReady`, only if the file still holds the user's change.
- Gates: `git apply --check` on fresh 5dfe352; herdr-draw `bun test`; plenary protocol tests in p2-land; plenary
  `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'` in the main tree (name any failing test);
  herdr-draw untouched; protocol copy byte-identical to p2-land 5d55112 with SOURCE.json.
- Run `distributed-systems-design` in CHECKER mode on the bridge's consistency model (if not in your skill list, read
  /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md); report what it found.
- sdd ensemble review of the new hunks (codex + agy + any harness passing check_adapter). Two agreeing = HIGH
  candidate; confirm or refute. If your context passes 60%, write what you have and stop.
