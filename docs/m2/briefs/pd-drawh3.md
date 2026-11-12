# Brief: pd-drawh3 (drawh proposal, round 3 of 3: settings without a clock)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: append "Fix round 3" to
docs/m2/reports/pd-drawh.md. Never pkill/killall; servers on port 0, started from a command that records the PID;
kill only that PID. **This is the last round.** If it does not pass re-check 3, the manager ships option 2 below.

## Read first

docs/m2/briefs/pd-drawh.md (hard rules: ~/repos/herdr-draw is read-only, work only in a fresh `git clone --local`
in your scratchpad, never a worktree), docs/m2/proposals/drawh-server.md, docs/m2/reports/pd-drawh.md, and the
verifier's docs/m2/reports/pd-drawhv.md: the "# Re-check" and "# Re-check 2" sections. Start from the current patch:
`git apply docs/m2/proposals/drawh-server.patch` on a fresh clone of herdr-draw 5dfe352.

## The problem (manager's diagnosis)

R1, R2a and R2b are one defect: board settings (layers, grid, snap, timeline) carry no version, and a save doesn't
say which file it was built on, so a stale save holding an old value and a deliberate revert to that value are the
same bytes. Round 2's 10-second window fixes R1 but must bounce real reverts inside the window (R2a). **Any design
that needs a clock fails re-check 3. Remove the window.**

## Step 1: one check that picks the design (do it first, report it)

In the scratch clone: does an unknown field in the board file's `appState.herdr` (e.g. `appState.herdr.plenaryGen`)
survive (a) a `drawh` command (add, layer, style, move) and (b) a save by the Herdr pane (read herdr-draw's adapter
and editor save path; simulate it with the pane's own save function if one exists). Show the evidence.

## Step 2a, if the field survives both: option 1, a base marker (preferred)

- The bridge writes a generation number into the file on every write it makes and keeps the settings it wrote for
  the last N generations (N small, e.g. 64).
- A file whose generation equals the bridge's latest: every settings difference is the user's: send it.
- An older generation: per key, three-way merge against that generation's settings: unchanged from base = keep the
  room's; changed = the user's change: send it. Unknown/missing generation: treat as option 2 for settings (below)
  and say so once.
- Fixes R2b's root (no stale list at all) and R2a (a revert is a change from base, so it's sent).
- Tests: R1 (stale save, 0 undone; rerun the verifier's settings.sh live), R2a (revert within 1 s sent), R2b
  (bounce then hide/show sent), a stale save that also changes the same key (the user's change wins and is sent),
  generation too old (evicted), missing marker.

## Step 2b, if the pane drops the field: option 2, a scope cut

While connected, settings flow room → file only. A file-side settings change is never sent; it is replaced by the
room's value with one loud line each time ("board settings are set on the board, not from this file: …"). Except:
seeding a board that has no settings yet. The proposal says so plainly under limits.

## Also

- Keep everything else from rounds 1-2 (H1 swap/link, H2, seeding rule, RM1, RM3, RL1-RL4). Fix RL2 (`+` in a token
  decoded as a space): compare against every decoding the URL parser could produce, or refuse any query/userinfo
  that decodes to contain the token. Fix the doubled `--once` refusal text.
- The union() settings rule: give it its own test (round 2 found it untested).
- Re-cut the patch; gates: `git apply --check` in a fresh clone, herdr-draw's tests, plenary `bun test`, herdr-draw
  untouched. Update drawh-server.md (settings section and limits).

## Done when

Step 1's evidence, the chosen option built and tested, gates pass, report appended. Then stop. Do not commit. If
your context passes 60%, write docs/m2/handoff/pd-drawh3.md (state, scratch-clone path, what's left) and stop.
