# Brief: p-tabv (verify p-tab: hello.tab, per-tab counting, writer caps)

You are the p-tab verifier, a CHECKER: try to break it, don't fix it. Don't edit any tracked file and don't commit.
Tab: `verifier p-tab (engine) · <id>: verify hello.tab`. Manager: `manager engine`, terminal `t18m`. Report to t18m
only; never message the proxy (t1bx), the builder (t1kn) or other managers.
Report: docs/m2/reports/p-tabv.md: verdict PASS / FAIL first, then findings ranked HIGH / MEDIUM / LOW, each with a
repro (a command or a scratch test) and the file:line. Then one short `hc send` to t18m and stop.

## What is under test

- **Brief:** docs/m2/briefs/p-tab.md. **Builder's report:** docs/m2/reports/p-tab.md: every claim is unproven until you
  reproduce it.
- **The diff** (`git diff` against HEAD) in PROTOCOL.md (§ hello, § Messages `hello.tab`, § here), packages/protocol/
  envelope.js, packages/protocol/replica.js, server/gateway.js, test/envelope.test.js, test/replica.test.js and the new
  test/server/tab.test.js. Other changed files (server/main.js, room-host.js, bus/nats.js, test/load/*, architecture
  tests) belong to other builders; ignore them except to name a failure.

## Attack

1. **Leftover mutations:** the builder ran mutations in the real tree before being told not to. Read the whole
   gateway.js/replica.js/envelope.js diff hunk by hunk and confirm nothing is disabled, inverted or off by one.
2. **Cap evasion:** can one user hold more than 8 writer tabs or more than 2 connections on a tab on one gateway?
   Try hellos that wait together (slow rooms.open, slow sign-in), a socket closed mid-hello, a refused hello's
   cleanup, mixing no-tab and tab hellos, a viewer and a writer on the same tab, two users with the same tab string,
   a tab string like `c:<id>` lookalikes (format forbids `:`; confirm the prefix keys can't collide).
3. **Leaks:** after churn (opens, refusals, mid-hello closes, token expiry closes, room-host failure closes) every map
   (`writersBy`, `tabConns`, `b.hvTabs`) returns to empty and `here.viewers` to 0.
4. **here.viewers:** distinct (user, tab) per board per gateway; a no-tab connection counts once each; the count goes out
   on the bus as one number (nothing new on the bus).
5. **Wire:** a bad tab (wrong type, empty, 33 chars, unicode, `:`) gets the usual hello refusal; `tab` is never forwarded
   to the room; Replica puts `tab` only when given; the spec matches the code (caps, codes, messages). Note the two
   stale PROTOCOL.md lines the builder lists (v1.1 table ~26, § Limits ~191): say whether the spec now contradicts itself.
6. **Mutations:** in a scratch worktree only, re-run at least three of the builder's (include M7 and M11) and one of your
   own; say whether the tests catch them.
7. **Gates:** `bun test test/server` 5x (0 failures; a known pacing flake in test/server/v1.test.js: re-run it alone and
   report it); `bun test` once (name every failure; test/core-source is known drift; test/server/main.test.js is
   another builder's work in progress: re-run alone before naming it); test/purity.test.js and
   test/architecture.test.js green.

## Rules

- **Mutations run only in a scratch worktree** (`git worktree add` in your session scratchpad, then copy the uncommitted
  diff over), **never in /Users/r/repos/plenary**. Remove the worktree at the end (`git worktree remove`).
- Never pkill/killall; kill by recorded PID only. Port 0 where you can.
- Never read, print or log `.env` or a real secret; tests use fakes. Any scratch copy excludes `.env`; no folder holding
  `.env` goes to a review tool (codex, grok, agy ...).
- Read big files in ranges (≤ 200 lines); filter test output. Delete your scratch at the end.
