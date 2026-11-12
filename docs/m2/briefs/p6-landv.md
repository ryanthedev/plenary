# Brief: p6-landv (verify the client half of the p2-land landing)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers"), CLAUDE.md,
PROTOCOL.md (v1) first. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-landv (client): client landing`. Manager: `manager client` (t14k).
- **Where:** the worktree /Users/r/repos/plenary-p2 (branch p2-land, head 2c53a90 plus uncommitted client files).
  Read only there. You own /Users/r/repos/plenary/docs/m2/reports/p6-landv.md (main repo) and your scratchpad.

## The job you check

Builder brief: /Users/r/repos/plenary/docs/m2/briefs/p6-land.md. The work: `git -C /Users/r/repos/plenary-p2 status`
and `diff` (web/sync.js, web/app.js, web/index.html, web/ui/{net,roles,room-worker,session}.js, new
web/ui/{room-host,token}.js, test/web/sync.test.js, new test/web/ui-land.test.js, ui-token.test.js), on top of the
earlier p6-sync2 work in the same files. Earlier findings it must close:
/Users/r/repos/plenary/docs/m2/reports/p6-sync2v.md (H1 merge: a resync leaves a SharedWorker tab "Connecting…";
M1 no-reopen loop; M2 `stopped` label) and /Users/r/repos/plenary/docs/m2/reports/p6-uiv.md (M1: a draft typed
during a drop is lost; L2 silent drop on downgrade).

## What to check

1. `bun test` passes in the worktree. Is the strict sync gate and the gesture × ending sweep as strong as at f1886d5
   (`git -C /Users/r/repos/plenary-p2 diff f1886d5 -- test/web/sync.test.js`)? Any loosened assertion is HIGH.
2. **H1 in a real browser:** three tabs of web/index.html on the SharedWorker room (`?as=ada|bo|cy&board=x`); force a
   refused op in one, and a drop (`S.dropConnection()`); each comes back `live` and the next drawing converges;
   Retry works; a reload loses nothing acknowledged. Also `?net=local` and web/dev.html.
3. **Transport contract:** no message or drop report from an old connection is delivered after `reopen()`; try
   races (a reply in flight during reopen, two reopens back to back, drop during catch-up, drop before welcome).
   Repeated drops back off (`connectionFailed`); a close sync.js started never counts.
4. **Drafts:** a text box or drag open when the connection drops commits and lands after reconnect; a role downgrade
   mid-typing tells the user and sends nothing.
5. **Sign-in token (security):** `#token=` is cleared from the address bar at once; the token is never in
   localStorage, a URL, the DOM or a console log; hostile fragments (huge, two `token=`, odd characters, script) are
   rejected; `?as=` dev path still works; the unverified identity is display-only text (textContent).
6. **Engine's restamp fix (2c53a90):** re-run p6-sync2v's busy-window repro (D5a, 40 seeds) through sync.js; no
   stale versions sent, no lost tie.

Builder's NOT verified: no real WebSocket/server; a SharedWorker crash reports no drop; no UI to sign in again after
`refused`; `stopped` only unit-tested; token checks are shape-only. One flaky test outside client files
(test/auth/http.test.js:503, a wall-clock ratio): note it if seen, but it is not this job's.

## sdd, processes

Single harness (codex only today): load `sdd:subagent-driven-development`, check `usage`, run codex on the diff in a
scratch git copy, write "single harness", confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

/Users/r/repos/plenary/docs/m2/reports/p6-landv.md: **PASS or FAIL** first line, head verified, then HIGH / MEDIUM / LOW
with file:line. HIGH = H1 not fixed, an acked op or a draft lost, an old connection's message delivered after reopen,
the token leaking (storage, URL, DOM, log), or a weakened gate. Say what you did NOT check. Then stop.
