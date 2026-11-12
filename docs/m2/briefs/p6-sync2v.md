# Brief: p6-sync2v (verify web/sync.js on the phase-2 Replica, in the p2-land landing)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers"), CLAUDE.md,
PROTOCOL.md (v1) first. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-sync2v (client): sync onto phase-2 Replica`. Manager: `manager client` (t14k).
- **Where:** the worktree /Users/r/repos/plenary-p2 (branch p2-land, head b8bf648). Read only there: don't edit,
  don't commit, don't touch packages/protocol, server/, test/*.js. You own docs/m2/reports/p6-sync2v.md **in the
  main repo** (/Users/r/repos/plenary) and your scratchpad.

## The job you check

Builder brief: /Users/r/repos/plenary/docs/m2/briefs/p6-sync2.md. The work: `git -C /Users/r/repos/plenary-p2 diff`
(web/sync.js, test/web/sync.test.js). The new Replica API it targets: /Users/r/repos/plenary/docs/m2/reports/
p2-recovery.md, "API for the client track", and packages/protocol/replica.js in the worktree.

Must hold: an acknowledged op is never lost; only never-sent pending ops are re-stamped after a resync and resends
keep their bytes; sync.js sets timers only from `wait()`/`reconnectWait()` (no second ack timer); drag previews go
out as presence, never as ops; the strict gate (Editor == Replica, tombstones, versions, nonces) and the gesture ×
ending sweep are not weakened versus f1886d5's tests (compare `git -C /Users/r/repos/plenary-p2 diff
f1886d5 -- test/web/sync.test.js`).

## What to check

1. `bun test` in the worktree passes. Re-run p6-basev's repro tests from
   /private/tmp/claude-501/-Users-r-repos-plenary/ffa42d25-0be0-435b-804d-caef5881c575/scratchpad/tests/ (adapt the
   imports to the new API in your own scratchpad): H1 resync-window edit, H2 Escape mid-drag, D5a busy resync.
2. Was any existing assertion removed or loosened? Each change to an old test needs a stated reason.
3. **The merge with p6-ui (important, the landing must never go red).** p6-ui is on main, untracked:
   /Users/r/repos/plenary/web/index.html, web/app.js, web/style.css, web/ui/**, test/web/ui-*.test.js. It was built
   against the OLD sync.js and its `localRoom` (web/ui/room-worker.js, web/ui/net.js). Copy the worktree into your
   scratchpad, add p6-ui's files, and run `bun test` plus a headless-browser load of web/index.html with two tabs.
   Report every break (e.g. `compact()` now `checkpoint()`, `localRoom` now checks tokens, `timeoutMs` meaning) as
   a finding with the exact call site; these become a fix job for p6-ui or sync.js.
4. Builder's not-verified list: no browser (web/dev.js not loaded), no real gateway/socket, Replica code taken as
   given. Its risks: previews not per stream (Replica), no backoff for transport drops, wider reconcile scan at every
   gesture end, no way to sign in again after `refused`, transport must drop old-connection messages after close.
   Load web/dev.html in headless Chrome and check two panes converge and the Escape case.

## sdd, processes

Single harness (codex only today): load `sdd:subagent-driven-development`, check `usage`, run codex on the diff in a
scratch git copy, write "single harness", confirm or refute each finding. Never pkill/killall; kill only PIDs you
start; `--remote-debugging-port=0`, serve on port 0.

## Report

/Users/r/repos/plenary/docs/m2/reports/p6-sync2v.md: **PASS or FAIL** first line, then HIGH / MEDIUM / LOW with
file:line. HIGH = an acked op lost, a resend not byte-identical, a weakened gate, a second timer, a preview sent as an
op, or p6-ui broken by the merge. Say what you did NOT check. Then stop.
