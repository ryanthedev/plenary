# Brief: pd-drawh-livev (verify drawh live fixes + security fixes, re-run live)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187;
never prompt, hc send or SendMessage to the proxy (t1bx) or engine. Report: docs/m2/reports/pd-drawh-livev.md with
PASS or FAIL and findings graded HIGH/MEDIUM/LOW. Never pkill/killall; servers on port 0 from a command that records
the PID; kill only those PIDs. Never print .env values or tokens. ~/repos/herdr-draw is READ-ONLY: work in a fresh
`git clone --local` in your scratchpad, never a worktree. Note: its working tree now holds someone else's uncommitted
edits (CLAUDE.md, core/, mods, a test); do not touch, stash or commit them; `git clone --local` takes the committed
5dfe352, which is what the patch targets.

## Job under check

pd-drawh-live (brief docs/m2/briefs/pd-drawh-live.md, report docs/m2/reports/pd-drawh-live.md, all sections) ran
`drawh --server` against the real v1.1 server, then fixed its live findings (M1-M4, "Fix round") and three MEDIUM
security findings ("Security fixes": `python -I` for the swap helper; scratch files with random names created
O_EXCL, never following a symlink; `say()` strips terminal escapes/controls/bidi, caps length, masks the token before
and after cleaning, never prints a non-JSON frame). Patch: docs/m2/proposals/drawh-server.patch, sha256
680ec536efb94dc1090b6976b68722590da78a406254d9b64c43c41afeead2ca; diff against the committed 6961449 with
`git diff -- docs/m2/proposals/`. Read the builder's claims as claims, not facts.

The bar (every round): **no silent loss of a user's edit, no peer change undone, no acknowledged op lost**; loud
refusal is fine. Known and accepted, do not re-grade: an agent's save that read the file before the user's settings
change undoes it (documented MEDIUM).

## Check

- **Gates:** `git apply --check` and apply on a fresh clone at 5dfe352; herdr-draw `bun test`; the 7 protocol files
  byte-identical to plenary HEAD (say if the working tree's uncommitted packages/protocol/ports.js differs, and
  whether that difference matters to drawh); plenary `bun test` in the main tree (name any failing test with
  `bun test 2>&1 | grep -E '\(fail\)'`); herdr-draw's committed state untouched.
- **Live re-run, your own scripts:** the real server from plenary HEAD single-node (main.js's env header; dev tokens;
  temp data dir; port 0), board via dev Bearer `POST /boards`, token via PLENARY_TOKEN only. Shapes both ways with a
  second client, settings with `appBase` incl. a stale one, `--once` exit codes, restart and catch-up, `welcome.room`,
  kill the server mid-run and restart (no acked op lost, bridge reconnects). Re-check each of M1-M4 live.
- **Security fixes, adversarially:** plant `ctypes.py` in cwd and on PYTHONPATH; pre-create files and symlinks at
  scratch names and race them if you can; a hostile stand-in server sending escapes (OSC 52, CSI, DCS), bidi, huge
  frames, non-JSON, a frame echoing the token split by an escape. Mutate each fix once and confirm a test fails.
- **Design skill:** run `distributed-systems-design` in CHECKER mode on the bridge's reconnect/catch-up path (if not in
  your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md); report.
- **sdd ensemble review** of the hunks changed since 6961449 (codex + agy + any harness passing check_adapter). Two
  agreeing = HIGH candidate; confirm or refute each with a test or a run.

## Done when

Report written (gates, live commands and outputs minus secrets, each claim confirmed or refuted, findings). Then stop.
Do not commit; do not edit the patch. If your context passes 60%, write what you have and stop.
