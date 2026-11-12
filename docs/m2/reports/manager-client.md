# Manager client: report

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p6-ui (builder) | t160 | done p6-ui (client) | DONE, report docs/m2/reports/p6-ui.md (verifying) |
| p6-uiv (verifier) | t172 | verifier p6-uiv (client): canvas UI | RUNNING (brief docs/m2/briefs/p6-uiv.md) |
| p6-sync2 (builder) | t173 | done p6-sync2 (client) | DONE in worktree, report plenary-p2/docs/m2/reports/p6-sync2.md (verifying) |
| p6-sync2v (verifier) | t176 | verifier p6-sync2v (client): sync onto phase-2 Replica | RUNNING (brief docs/m2/briefs/p6-sync2v.md) |

## 2026-11-11 — phase-6 design mock

- Brief written: docs/m2/briefs/p6-mock.md. Builder started (t14m).
- Gaps found while briefing (core's Editor vs the brief's tool list), for the mock to label honestly:
  - **highlighter** is not a core tool id (core has Pen/freedraw only).
  - **notes** are the protocol's `notes` stream (PROTOCOL.md), not an Editor tool.
  - **image** is an Editor command (`addImage`/`addFiles`/paste), not a tool id.
  - Comments, reactions, presence (cursors, selections, laser, emotes) wait on protocol v1 (phase 1, engine track).
- Engine manager (t14j) relayed a security-review flag: docs/m2/design/phone.html:34 puts URL params into
  innerHTML (DOM XSS, MEDIUM). Confirmed by reading the line; sent to builder t14m to fix; verifier must re-check.
- Proxy relayed the CEO's standing rule (0fe5159, OFFICE.md "Keep the train moving"): the CEO is never a gate;
  phase-6 building starts when the mock passes verification; keep the next job running in parallel.
- Started p6-base (docs/m2/briefs/p6-base.md) in parallel with the mock: the Canvas2D painter, the Editor–Replica
  binding and the refused-op + resync gate test. None of these depend on the mock's look, and their files
  (web/, test/web/) don't overlap docs/m2/design/. The UI chrome (toolbar, panels, collab surfaces) waits until
  the mock passes verification.
- Proxy seams applied to p6-base: all Replica/Room/codec calls live only in web/sync.js (read-only use of
  packages/protocol); p6-base owns named paths only (paint.js, sync.js, dev.html, dev.js, test/web/paint*, sync*).
  The chrome job will own web/index.html, web/ui/ and the rest; its brief must list p6-base's paths as off limits.
- p6-mock builder finished (19 min). It reports the XSS fixed in phone.html and mock.js (URL params checked
  against an allow-list per key). Verifier p6-mockv (t14v) started and told to confirm the fix itself.
- Open questions from the builder, for the proxy (✱ = the CEO's call; the mock does the first option for now):
  ✱ do viewers see annotators' cursors (mock: presenters only); ✱ "follow presenter" view for viewers (not in the
  mock); ✱ saved reactions on elements/board (v1 draft: on comments only; the crowd bar is live emotes);
  does the `commenter` role need its own view; should export include notes; can a role drop to viewer mid-session;
  should the v1 draft's `notes` row widen to pen, arrow, text and eraser, as the mock's annotator toolbar shows,
  or should the toolbar shrink (engine track's call).
- Phase-6 build risk: annotations go to the `notes` stream, but core's Editor edits one Doc, so web/ likely runs
  two Editors (board and notes) or routes ops. Goes into the chrome job's brief.
- p6-base (t14r) BLOCKED on a permission prompt for `pkill -f "chrome-prof"` (kills by pattern; could hit the
  verifier's headless Chrome). I meant to refuse (press 2) and steer it to kill by PID, but my auto-mode classifier
  denied sending keys to another session's permission dialog. Not worked around; left for the person to answer.
- sdd helpers rule (9218fdf) passed on: verifier t14v told to add an sdd ensemble review; p6-ui brief has an
  sdd section. Future verifier briefs include it.
- Engram (memory service) was unreachable this session; nothing recalled or stored.
- Labelling rule (27bd587): sessions I start get `--label plenary.reports-to=t14k` and tab names carry the track,
  e.g. `worker p6-ui (client): canvas UI`. p6-ui brief updated.
- Verifier t14v BLOCKED on a pkill prompt too (`pkill -f "remote-debugging-port=9333"`, its own scratchpad
  serve.js). Narrow patterns, still pattern kills; can't answer it myself. Escalated both to the proxy, with a
  suggestion that OFFICE.md require killing by recorded PID.
- Correction: I called t14v's pkill patterns safe; they were not. t14r's Chrome (pid 58635) also listens on
  --remote-debugging-port=9333 (proxy caught it). OFFICE.md now bans pkill/killall and hard-coded ports; the rule
  is in the p6-ui brief. Proxy asked the CEO to press 2 in both. On clear I steer: t14r kills its Chrome by PID
  (58635 + helpers, or its proc handle); t14v kills 44281 (Chrome) and 44279 (serve.js); both use a free port.
- sdd ensemble is codex-only today (agy out of quota ~70 h; grok, kimi, mistral not signed in). Verifiers write
  "single harness" in their reports; with one harness there is no "two agree" HIGH signal. Pass to t14v with its steer.
- p6-mockv verdict FAIL (docs/m2/reports/p6-mockv.md): HIGH = viewer shown with durable writes ("3 edits waiting",
  a reaction of its own). MEDIUM: read-only leaves write controls live; note authors tagged v0 (snapshot lacks
  noteAuthor until v1); phone docks miss Notes/Comments (presenter) and Style (annotator). LOW: contrast, emote
  wording, cosmetics. Security and offline clean. Single harness (codex x2 + verifier's own browser check).
- Fix round 1 sent to the same builder t14m (22% context, idle < 1 h): every HIGH, MEDIUM and LOW, plus the
  kill-by-PID rule. Verifier t14v kept to re-check the fix.
- p6-base builder done: gate passes (refused op + resync leaves Editor == Replica, by entries and by snapshot);
  bun test 143/143; its Chrome stopped by PID (58635 gone, checked). Verifier p6-basev (t15h) started.
- For the proxy and engine track, from p6-base (protocol/core changes it wants, not made):
  - core `livePut` bumps version per pointer move; drags over ~1000 moves exceed the room's MAX_VERSION_JUMP and
    resync the board. sync.js works around it by rewriting the Editor's stored version. Proper fix is in core
    (herdr-draw, needs the CEO's OK) or in the protocol's jump rule.
  - Replica.receive() should return what it applied; Replica.reset() should keep pending ops visible (no flicker);
    PROTOCOL.md rule 5 should say whether a since-0 resync reuses the connection.
- Engine's answer on the livePut seam (via proxy): Option A. Phase 2's Replica.local() sends
  version = highest known (confirmed or pending) + 1, with a fresh nonce; the cap stays; core is untouched.
  Phase 2 also: receive() returns what it applied; reset() keeps pending ops overlaid. A since-0 resync closes and
  reconnects (one hello per connection). sync.js already calls transport.reopen(), which matches.
- Queued follow-up job (client), when phase 2's Replica lands: p6-sync2 = drop sync.js's version workaround and
  its re-derivation of applied ids, use the new receive()/reset(), and make the WebSocket transport's reopen() a
  real close + reconnect.
- Fix round 1 done (t14m). I checked the HIGH in code (mock.js:128, :323-327, viewer-gated). The builder's DOM probe was denied, so verifier t14v runs it in round 2.
- Engram fix (2f29f47): new sessions start via `-- zsh -lic 'exec "$@"' zsh claude ...` so they get ENGRAM_ADDR/TOKEN. Running ones pick it up when they recycle.
- p6-mockv round 2: PASS (docs/m2/reports/p6-mockv.md). The HIGH is fixed (probed: 0 viewer "edits wait", 0 viewer
  `mine` chips). One MEDIUM is left open in the mock: on phone, read-only leaves the More tools sheet live
  (mock.js:381-383). Not sent for another mock round; it's carried into p6-ui as a requirement, since the real
  client must guard it anyway. bun test 143/143, re-run by me before commit.
- Mock committed 7536d50. t14m and t14v closed (tab close, hc kill, hc rm) and dropped from the roster. p6-ui started (t15y, zsh -lic wrapper, reports-to t14k).
- BLOCKER: p6-ui (t15y), started with the new `zsh -lic` command, came up as Fable 5.2 in manual permission mode
  (other sessions: Opus 5.5, auto), and blocked on its first prompt within 12 s. My classifier refused reading the
  login env. Escalated to the proxy: fix the profile/command, or relaunch with the old command until then.
- t15y killed and removed; p6-ui relaunched as t160 with --model opus --permission-mode auto (OFFICE.md fix).
- p6-basev FAIL (docs/m2/reports/p6-basev.md): 3 HIGH in web/sync.js. H1: an edit made during a resync goes out at
  version 1, is acked, and loses everywhere (an acked op with no effect). H2: Escape or a tool key mid-drag leaves
  the Editor's version above the Replica's for good, so peers' edits never show (seen in a real browser). H3: the
  gate's equality ignores tombstones/versions, so mutations survive. Plus 5 MEDIUM, 8 LOW. Painter and seam hold.
- Fix round 1 sent to the same builder t14r (20% context): all findings; keep bindEditor's API stable for p6-ui
  (t160) or list the changes; keep the version step in one function so phase 2 can drop it.
- p6-base fix round 1 done (t14r): all HIGH/MEDIUM/LOW addressed; bun test 261/261 re-run by me; `.replica` gone
  from sync.js. API changes for p6-ui are listed in p6-base.md. Verifier t15h started on round 2.
- For engine (from t14r): test/server/main.test.js "kill -9 mid-stream" timed out once in a full run under load
  (passed 5/5 alone, and on the next full run). Looks timing-sensitive.
- Engine (via proxy): the gateway now refuses v0 `transient: true` ops (bad-op, the connection stays open).
  web/sync.js:172-179 sends drag previews that way, so previews won't reach peers through the server. Decision:
  not added to the p6-base fix round (packages/protocol has no presence code yet, and it would reset round 2).
  It is the FIRST item of the queued p6-sync2 job (after phase 2's Replica): previews move to v1 presence.
  p6-ui told not to use transient ops. Until then, through the server, peers see a drag only when it's committed.
- Phase-2 landing plan (proxy, approved): p2-land branch, worktree /Users/r/repos/plenary-p2, one green commit.
  My part: (1) commit p6-base on main as soon as round 2 passes, then tell engine t14j directly (it rebases p2-land);
  (2) then run p6-sync2 in the worktree (brief docs/m2/briefs/p6-sync2.md, ready), against p2-recovery.md's
  "API for the client track"; (3) p6-ui stays on main against sync.js's public API.
- p6-sync2 owns web/sync.js and test/web/sync*/paint* only (not test/web/ui*, which is p6-ui's on main), so the merge
  can't collide.
- p6-basev round 2 PASS (0 HIGH, 3 MEDIUM, 6 LOW). MEDIUMs (per-op ack timer, backoff + version/unavailable codes,
  a held-ops-survive-reconnect test) carried into p6-sync2's brief: the phase-2 Replica owns those timeouts.
- p6-ui (t160) done: two Editors (board, notes), role gating at input plus an onOp backstop, the More sheet gated.
  Verifier p6-uiv (t172) started. p6-ui's wanted sync.js changes (bindEditors sharing one Replica, a role getter
  on the handle, a WebSocket transport) go to p6-sync2 where they fit the phase-2 API.
- p6-base committed f1886d5; engine (t14j) told to rebase p2-land. t14r and t15h closed, killed, removed.
- Engine: p2-land rebased onto f1886d5 (head b8bf648); 54 failures all in test/web (sync.js on v0). The Replica owns
  timing (wait(), per-op OP_TIMEOUT_MS 10 s, reconnectWait() backoff); sync.js must not add its own ack timer.
  Brief updated. p6-sync2 started (t173) in the worktree; no commits there, engine merges.
- p6-sync2 done (t173): worktree bun test 252/252 (re-run by me; main has 11 more, p6-ui's untracked tests). API: adds status
  `stopped`, handle `unconfirmed`/`discarded`/`previews()`, transport `close()`; `timeoutMs` only 0 matters; nothing
  stable removed. Visible regression: peers' drags in flight not drawn until someone paints `previews()` (p6-ui/phase 7).
  localRoom changed (token check, `checkpoint()`), which may break p6-ui's room-worker/net at merge: verifier
  p6-sync2v (t176) runs p6-ui's files against the new sync.js.
- For engine (from p6-sync2): Replica.presence() drops m.stream, so previews aren't per stream; no backoff counted
  for transport drops (Replica.fails only grows on its own timeouts/unavailable).
- Engine accepted both Replica findings; t15q is fixing them in the worktree (previews keyed by (stream, id); a
  connectionFailed()-style call). Once engine gives the exact API, a small follow-up wires sync.js to it (and paints
  nothing yet). Verifier t176 told that replica.js may change under it.
- Engine's Replica fix round 2 is in the worktree (p2-recovery.md "Fix round 2"): `previewsOf(stream)` (others'
  live previews on one stream) and `connectionFailed()` (call on a socket close or error the Replica didn't ask
  for; counts once per connection toward backoff; then reconnectWait() and reconnect; not for closes we started).
  Worktree suite 254/254 with our web files. QUEUED for t173 right after t176's verdict (not now: it would change
  the code under verification): handle.previews() uses previewsOf(stream); transports report unplanned
  close/error, and sync.js calls connectionFailed(); tests for both, plus any t176 findings. Then t176 re-verifies.
- p6-uiv PASS (docs/m2/reports/p6-uiv.md): no HIGH. Role gating held (0 forbidden ops), no annotator touched
  others' notes, no HTML injection, 5 tabs converged. MEDIUM M1: a draft typed when the connection drops is lost
  (session.js:88). LOWs: ownership trusts localStorage, silent drop on downgrade, small mock gaps, a test gap.
  Carried into the next client job.
