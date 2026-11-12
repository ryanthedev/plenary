# Handoff: p2-swap (worker, engine; manager t18m)

Brief: docs/m2/briefs/p2-swap.md. Worktree /Users/r/repos/plenary-p2 (branch p2-land). Don't commit; manager merges.
Report (design already written): docs/m2/reports/p2-swap.md.

## Done (uncommitted, in the worktree)

- server/bus/port.js (new): subjects (+ `grants`), MAX_BUS_BYTES, busBytes, utf8Length. memory.js re-exports
  subjects and refuses publishes over `maxBytes` (default 2 MB); nats.js imports the cap from port.js, exposes `maxBytes`.
- Store epoch: sqlite.js `leases` table, openEpoch/epoch; postgres.js `pl_leases`, `migrate()` creates only missing
  tables via to_regclass (least privilege). Contract test added (store-contract.js "epoch: …"); SQLite passes.
  Postgres NOT run yet (local binaries exist: /opt/homebrew/bin/pg_ctl; start a temp cluster on a free port, set
  DATABASE_URL, run test/server/pg-store.test.js, then a non-owner-role test).
- server/room-host.js: rewritten on Room.rebuild/receive/fail/sweep/listed/heartbeat; log adapter over the Store;
  entries published on `.entries` as `{from,to,items:[json…]}` split under the cap (splitEntries); only
  welcome/ack/error go to `.gw.<gateway>`; every `unavailable` closes the conn (1013); heartbeat on build + every 2 s.
- server/feed.js (new): per board per gateway: base checkpoint (validated) + tail, encode-once shared catch-up
  frames, live in seq order, gap/heartbeat/5 s-silence repair from the Store, rebase on a newer checkpoint.
- server/gateway.js: v:1 required; joins the board feed before forwarding; viewers welcomed by the gateway (never
  reach the room); writers: hello forwarded w/o token and w/o since; catch-up after the room's welcome; op bucket
  per conn (opRate/opBurst, maxOpQueue/Bytes → unavailable); ≤ 8 writers per (user, board) → `limit`; too-large
  with id when the inbox envelope exceeds the bus cap (size checked before `n` is used); live c.q cap; presence
  relay (presenceProblem/limiter/coalescer, 50 ms, own entries filtered), viewer emote sums per 500 ms window;
  close notice + `leave`; 5 s connection lists; `grants` subject → recheck roles (null → auth close, changed →
  unavailable 1012); identity.exp (seconds) closes at expiry. server.js passes `store` to the gateway.
- test/server/rig.js: client drives the Replica v1 way (pump: outgoing()/wait()/reconnectWait capped by maxWaitMs).
  Raw hellos got `v: 1`, raw ops `sentAt: 0` in gateway/outbound/main tests.

## Since the first handoff note (also done)

- gateway.test.js: every test passed when run in its group, but the WHOLE file was not re-run after the later rig,
  room-host, feed and welcome-ordering edits (unverified as a whole; v1 semantics: viewers never reach the room, ops before welcome
  get `auth`, entries before acks, room throws handled by seq+unresolved mark, corruption test hides the clean-stop
  checkpoint).
- room-host: byte-triggered checkpoint `tailFoldBytes` (default 8 MB, only when tail*2 ≥ state: the 2× bound);
  feed rebases on `rebaseEvery` entries or `rebaseBytes`. Rig maps host.chunkBytes/tailFoldBytes onto limits.feed
  and turns the gateway op pace off by default (opRate/opBurst 1e6; pacing test sets it).
- main.js: httpRoutes mounted; googleOidc when both GOOGLE_* set (fetch injectable: start(env, { fetch }));
  COOKIE_KEY (short → throw; cluster = DATABASE_URL||NATS_URL → required; else random + warn); SESSION_KEY
  (default COOKIE_KEY); PUBLIC_URL/POST_LOGIN_URL/BOARD_URL; `announcingRegistry` publishes `grants` on
  setGrant/createInvite/revokeInvite/createLink/revokeLink/addLinkUse. Entry point is the only process.env reader.
  main.test.js: spawned children run with cwd = empty temp dir (no .env auto-load); 4 new in-process tests pass.
- test/server/v1.test.js (new, 9 tests, all pass): presence relay + never logged, viewer emote sums, resend after
  restart same seq (+ epoch 2), unknown connection → unavailable with id, bus cap split + too-large without
  burning `n`, ninth writer → limit, op bucket + queue cap, token exp, rule 6 lists vs 30 s silence.

## Next

0. FIRST: run the done-when command in the worktree and save the output:
   `bun test test/*.test.js test/server test/auth` (ports, store, nats-bus and test/auth have not run since the
   memory-bus cap and main.js changes). test/server/scratch/ is deleted.
1. outbound.test.js: 11 of 22 still fail (scratchpad run). They were written for room-host catch-up and byte
   folding; now the feed serves catch-up. Look first at: "H1 annotator rewriting one note" (peek.tailBytes /
   room.tail after the host's byte fold; feed rebase timing), "a cap on connections per user" (expects room
   conns: viewers no longer reach the room), "R4-H2" (snapshot frames now from the feed), "joiners parked across
   folds" (fold now = checkpoint + feed rebase). Adapt tests to v1, or fix the server where it is a real bug.
2. Postgres: run pg-store.test.js against a temp cluster (pg_ctl initdb in a scratch dir, free port, kill only that
   PID) and add a non-owner-role test of `migrate()` (owner migrates, app role with only DML grants starts).
3. Remove test/server/scratch/. `grep -rn "SEAM(p2)" server/` (memory.js header, sqlite.js L3 note: rewrite or
   explain). Run `bun test test/*.test.js test/server test/auth` in full. Architecture: core files import
   ./bus/port.js, not adapters (check gateway/room-host/feed imports; test/auth/architecture.test.js covers auth only).
4. Checks the previous session flagged but didn't do: (a) idle timeout went 120 s → 30 s and rawSock never answers
   pings: rerun one outbound test that fails at ~60 s with limits idleTimeoutSec: 120; (b) feed rebase only looks
   when entries arrive and the host's byte fold runs after the bus delivered: keep a writer connected, fold, join at
   since 0, see snapshot vs long tail; (c) missing tests: live-state c.q overflow; an idle viewer survives the idle
   timeout while a non-ponging socket is closed. Welcome ordering is FIXED (c.welcomed set as the welcome is queued).
5. Finish docs/m2/reports/p2-swap.md (design step 4, files, tests, not verified, risks, what platform must do).

## Report notes already decided

- Byte-triggered checkpoint is an extension of § Recovery "When" (spec ask). `here` not built. Viewers never
  reach the room or build it (rule 8): a viewer-only board has epoch from the Store / heartbeat.
- Platform: session.js verify() should return `exp` (seconds) so the gateway closes at expiry (tested with a fake).
  Registry mutations announce via main.js's wrapper today; platform may prefer to publish themselves.
- Bun idleTimeout 30 s + sendPings stands in for "ping after 10 s idle" (Bun's own cadence; not measured).
- test/auth: 2 baseline failures in google-live.test.js (network sandbox), not this job's.
- Queue overflow answers `unavailable` (PROTOCOL.md § Pacing), where the brief said "close with `limit`".
- deploy/cluster.compose.yml sets DATABASE_URL and NATS_URL but no COOKIE_KEY: its nodes now refuse to start.
  Platform must add the key (blocks that stack after the merge). Cluster adapters are still not wired in main.js;
  cluster mode only gates COOKIE_KEY.
- Registry Postgres least privilege is platform's (server/registry/).
- This handoff and the report are uncommitted in the shared tree (BRIEF-BASE: workers don't commit).
