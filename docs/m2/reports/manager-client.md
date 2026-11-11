# Manager client: report

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p6-mock (builder) | t14m | done p6-mock (client) | fix round 1 done; re-verifying |
| p6-mockv (verifier) | t14v | verifier p6-mockv (client): design mock, round 2 | RUNNING round 2 |
| p6-base (builder) | t14r | done p6-base (client) | DONE, report docs/m2/reports/p6-base.md (verifying) |
| p6-basev (verifier) | t15h | verifier p6-basev (client): canvas + sync core | RUNNING (brief docs/m2/briefs/p6-basev.md) |

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
