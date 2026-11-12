# Manager client: report

## Now (kept current every turn; a refreshed manager starts here)

- **Me:** manager client, terminal t14k. Report to the proxy **t1bx**; engine manager **t18m**; platform manager **t187**.
- **In flight:** nothing running. p6-ports committed (round 2 PASS); t18r and t1b9 closed.
- **Waiting on engine:** the p2-land merge into main (carries phase 2, v1.1, p6-land, p7-collab). t18m pings first.
- **Next, in order:** p6-hex (docs/m2/briefs/p6-hex.md: move web/ onto the ports, auth HTTP adapter per
  docs/m2/contracts/auth-exchange.md, test/web/architecture.test.js on engine's test/arch-scan.js) → p7-wire
  (docs/m2/briefs/p7-wire.md) → an architecture audit of web/.
- **Start command:** OFFICE.md "Starting a session" (names plenary-<job>[v], --model opus --permission-mode auto,
  systems-design plugin, zsh -lic wrapper). Tab: `worker <job> (client) · <id>: <what>`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| (none running) | | | waiting on engine's p2-land merge; next p6-hex |

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

- p6-ui committed 3c32a5f; engine told (p2-land must include it). t160 and t172 closed, killed, removed.
- Sequencing (told the proxy): after t176's verdict, ONE worktree job "p6-land" = previewsOf/connectionFailed
  wiring + p6-ui breaks under the new sync.js + p6-uiv M1 (draft lost on disconnect). Not a parallel web/ui job on
  main: it would collide with the same files at merge. Phase 7 (docs/m2/briefs/p7-collab.md, DRAFT) starts when
  p2-land merges; it needs the new Replica's presence and records.
- Engine committed the Replica fixes on p2-land (3ba2495): previewsOf(stream), connectionFailed(); backoff now resets
  only after a connection has caught up AND stayed up 10 s (rule 12). For p6-land: re-run sync tests against
  3ba2495 (a backoff-reset assumption may change). p2-land's rebase onto main (incl. p6-ui 3c32a5f) comes after the
  scaffold fix round; engine pings first.
- Platform p5-http (4fad32a, via proxy): the post-login session token arrives in the URL fragment `#token=`; web/
  reads it, keeps it for the hello, clears the hash. Dev tokens stay (sign-in answers 503 until the CEO's Google
  client exists). Folded into p6-land (brief docs/m2/briefs/p6-land.md, ready), which starts after t176's verdict.
- Engine rebased p2-land onto main 2f0dda2 (incl. p6-ui 3c32a5f, platform 4fad32a); head 794298e. Worktree bun test
  292/292 including p6-ui's tests under the new sync.js. t176 told. p6-land can start right after t176's verdict.
- p6-sync2v FAIL at 794298e (docs/m2/reports/p6-sync2v.md): sync.js holds every gate, but merged with p6-ui a resync
  leaves a SharedWorker tab "Connecting..." for good and loses its waiting edit on reload (H1): sync.js's close()
  means "reopen follows", while net.js/room-worker.js's close() means "finished". M1: a transport without reopen()
  loops forever. M2: `stopped` shows "Connecting...". M3 is engine's (restamp() skips when the top of the chain
  leads, so mid-resync chains send stale versions); sent to t14j.
- DECISION (mine, reversible): one transport contract. reopen() is required and drops the old connection (a
  generation per connection); close() means finished, called only by handle.close(); resync never calls close().
  p6-land (t17s, fresh session: t173 was idle over 1 h) does it plus a SharedWorker resync test.
- Engine accepted M3: restamp() re-stamps the whole never-sent chain per element (room version r -> r+1, r+2, ...;
  fresh nonces; sent ops keep their bytes). t15q is doing it in replica.js + test/replica.test.js only, so there's
  no collision with p6-land. p6-land's verifier must re-run p6-sync2v's D5a busy-window seeds after it lands.
- Engine's M3 fix verified (t171 PASS) and committed on p2-land: the whole never-sent chain is re-stamped. p6-land files untouched. p6-land's re-verify re-runs D5a.
- p6-land done (t17s): worktree bun test 321/321 (re-run by me), no files outside client paths. One flaky test seen,
  platform's test/auth/http.test.js:503 (wall-clock ratio, 2 of 132 full runs): to the proxy for platform.
- p6-landv (t181) started fresh (t176 was idle ~1 h). p6-sync2v's FAIL report committed on main; t176 closed.
- Proxy: start phase 7 now in the worktree, disjoint from p6-land. sync.js exposes no presence/records API yet and is
  under verification, so DECISION (mine): p7-collab (t18g) builds all of phase 7 in web/collab/** and
  test/web/collab/** behind a "collab port" interface (JSDoc in web/collab/port.js; a fake port for tests and a dev
  page); no protocol imports there (constants mirrored in web/collab/limits.js, checked by a test). A later p7-wire job
  (after p6-landv passes) makes bindEditor provide the port and mounts the UI in app.js.
- Watch: engine runs "p11-proto: protocol v1.1 code" now. If v1.1 changes presence/records shapes, p7-collab's
  limits test catches the constants; ask engine for the v1.1 delta before p7-wire.
- Engine on v1.1 (PROTOCOL.md cb343b9 on p2-land): no change to presence/records/here/emote shapes or roles. The
  emote set is fixed: 👍 ❤️ 😂 🎉 👏 😮 🙏 🔥 (told t18g). Other v1.1 changes, for p7-wire / sync.js later:
  welcome.room {board, epoch}; settings ops carry per-key appBase with a soft `stale-setting` refusal (drop that op
  only, no resync); the Replica splits mixed element+settings changes; op frames start {"t":"op","id":; a writer
  connection cap of 8 per (user, board) per gateway (`limit`, close), which the UI must show, not retry in a loop.
  Engine pings if p11-proto adds sync.js-facing API.
- p7-collab done (t18g): only web/collab/** + test/web/collab/** (+ report); worktree 390/390 re-run by me. Port gaps
  sent to engine: previewsOf drops the sender; no accessor for unacked records ops. For p7-wire: two connections
  per tab (feed presence from one, me.client = that connection, merge statuses), onStatus on role change, the
  writer cap `limit` close. Verifier p7-collabv (t18j) started.
- Engine accepted both, additive: `replica.previewEntries(stream)` -> [{ element, user, client, at }] (others' live
  previews; previewsOf unchanged) and `replica.pendingOf(stream)` -> [{ id, op, sent }] (this client's unacked ops in
  send order; for `records` the pending overlay). They land after engine's v1.1 verification round; engine pings with
  the p2-land commit. p7-wire builds to these names.
- CEO rule (1f25e61, via proxy): hexagonal everywhere + the distributed-systems-design skill (builders APPLIER
  before coding, verifiers CHECKER). New sessions add `--plugin-dir /Users/r/repos/systems-design.skill`.
  Client plan: p6-hex (brief docs/m2/briefs/p6-hex.md) after p6-landv and p7-collabv pass: web/core (sync,
  session, collab models), web/ports (transport, storage, clock + contract tests), web/adapters/{transport,storage,
  clock,dom}, web/main.js as the composition root; web/ boundary rules in test/web/architecture.test.js (asked
  engine whether to reuse its helper; engine owns test/architecture.test.js). Then p7-wire builds in that shape. An
  architecture audit of web/ runs after p6 and p7 land. Running verifier t18j told to add a CHECKER pass.
- Engine agreed (a): its p-arch job adds test/arch-scan.js (importsOf, checkBoundaries; shrink-only allowlist); client
  writes test/web/architecture.test.js reusing it. Contract shape: mirror test/auth/registry-contract.js
  (xContract(name, makeAdapter), a fresh adapter per test, describe.skipIf for real services). p6-hex brief updated.
  Engine pings with the arch-scan commit.
- p7-collabv PASS (docs/m2/reports/p7-collabv.md): no HIGH; MEDIUM M1 the port gaps p7-wire closes, M2 no test for a
  mid-session role change, M3 +N undercount on phones, M4 records change costs O(all records). CHECKER: shape sound
  for the NFRs. All carried into docs/m2/briefs/p7-wire.md (draft; after p6-hex). p7-collab's code stays
  uncommitted in the worktree for engine's p2-land merge. t18g, t18j closed; t173 (p6-sync2, superseded by p6-land)
  closed too.
- Engine agreed: merge p2-land without waiting for p6-hex/p7-wire; those run on main afterwards (briefs updated).
  The merge carries phase 2 + v1.1 + p6-land (once t181 passes) + p7-collab. Engine's gates first: scaffold commit,
  rebase, p2-swap (server onto v1) verified. previewEntries/pendingOf land on p2-land before the merge.
- Engine manager is now t18m (t14j retired; handoff docs/m2/handoff/manager-engine.md). Message t18m from now on.
- Engine v1.1 code committed on p2-land 5d55112 (previewEntries/pendingOf included). LOW for client: refusedSettings/retryReady need a consumer in web/; added to the p7-wire brief.
- p6-landv PASS (docs/m2/reports/p6-landv.md), heads 2c53a90 and 5d55112: no HIGH; p6-sync2v H1/M1/M2 and p6-uiv
  M1/L2 closed. MEDIUM M1: Chrome's History DB (and the navigation-timing entry, L1) keeps the post-login URL with
  `#token=`; history.replaceState can't undo a visit already recorded. DECISION (mine, reversible): does NOT block
  the merge (not fixable in web/; the brief's storage rule targets what the client stores). Escalated to platform via
  the proxy: deliver a short-lived single-use code in the fragment and exchange it by POST for the session (or an
  HttpOnly cookie), so no long-lived token ever sits in a URL. LOWs L2–L5 go to p6-hex/p7-wire.

- t17s and t181 closed, killed, removed. No client sessions running; p6-hex starts when engine (t18m) sends the merge id.
- Proxy agreed: no merge block. Platform's p5-code puts a single-use code (≤ 60 s) in the fragment, exchanged by POST /auth/exchange. Wired in p6-hex as an auth port plus an HTTP adapter; platform sends the shape.
- Engine committed the client files on p2-land (3fa2d3a, worktree 398/0); the merge still waits on engine's gates.
  No new work in the worktree. p6-hex touches files p2-land changes, so it waits for the merge, but its first half
  is all new files: p6-ports (t18r, on main, brief docs/m2/briefs/p6-ports.md) builds web/ports (transport, storage,
  clock, auth), the storage/clock/auth-fake adapters and contract tests now. The p6-hex brief now includes platform's
  code exchange (auth port + HTTP adapter).
- Platform (t187) sent the sign-in exchange shape; saved as docs/m2/contracts/auth-exchange.md. p6-ports (auth port + fake) and p6-hex (HTTP adapter + wiring) point at it.
- p6-ports done (t18r): web/ports (transport, storage, clock, auth), web/adapters/{storage,clock,auth/fake},
  test/web/contracts + adapters. bun test 556 run, 0 fail, 78 skip (re-run by me). Transport contract passes against
  p2-land's real localRoom (13/13). For p6-hex: bindEditor's `close?` must become required (import the port);
  web/collab/ui.js's clock shape { now, setTimer, clearTimer } must move to the port's { now, set, clear, random }.
  Asked platform (t187) whether user/name/email are always strings, domain null outside a Workspace, and whether
  `{error: "network"}` is OK. Verifier p6-portsv (t1b9) started (CHECKER on the port design).
- Platform answered: user always a non-empty string; name/email/domain each string or null; exp integer seconds; {error:"network"} agreed. Saved in docs/m2/contracts/auth-exchange.md. web/ports/auth.js:28 types name/email as plain strings: verifier t1b9 told to judge against the real shape.
- Naming rule (7f680a3): new sessions get --name plenary-<job>[v] (a-z0-9-, <=32) in both hc run --name and claude -n; tab 'worker <job> (<track>) · <id>: <what>' / 'verifier <job>v (<track>) · <id>: <what>'.
- p6-portsv FAIL (docs/m2/reports/p6-portsv.md): 4 HIGH. H1 the transport contract misses late far-side traffic on an
  old connection (the localRoom gen-check mutation survives); H2 auth name/email must be string|null; H3 authContract
  can't catch collapsed errors; H4 storageContract misses key collisions. M1 virtual clock exact-boundary timer; M2
  no monotonic time in Clock. Import rules hold. Fix round 1 sent to t18r (16%); t1b9 kept to re-verify.
- The proxy is now t1bx (t14h retired; handoff 9d06783). Report to t1bx.
- p6-ports fix round 1 done (t18r): all 4 HIGH, both MEDIUM, named LOWs; bun test 585 run, 0 fail (re-run by me). t1b9 on round 2.
- p6-portsv round 2 PASS (0 HIGH, 1 MEDIUM R2-M1 auth `force` optional, 4 LOW). bun test 588 run, 0 fail (me). Committed p6-ports; R2-M1/L1/L2/L4 carried into p6-hex. t18r, t1b9 closed.
