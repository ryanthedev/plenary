# Report: manager engine

Manager terminal: `t18m` (tab `manager engine`; successor of t14j, retired 2026-11-11). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p3-fix4 (builder) | t18c | worker p3-fix4 (engine): scaffold fix round 4 | RUNNING (from the handoff) |
| p2-recovery (builder) | t15q | done p2-recovery (engine) | reported, idle (kept for a fix round) |
| p2-recoveryv (verifier) | t171 | verifier p2-recoveryv (engine): room recovery | RUNNING (in worktree plenary-p2) |
| p3-scaffoldv (verifier) | t158 | done p3-scaffoldv (engine): FAIL, 1 HIGH | FAIL reported, idle |
| p4-pg (builder) | t17d | done p4-pg (engine) | reported, idle |
| p4-pgv (verifier) | t17p | verifier p4-pgv (engine): Postgres store + registry | PASS, idle |
| p4-natss3 (builder) | t17f | done p4-natss3 (engine) | reported, idle |
| p4-natss3v (verifier) | t17m | verifier p4-natss3v (engine): NATS bus + S3 blobs | RUNNING |
| p1-v11 (builder) | t186 | done p1-v11 (engine) | reported, idle |
| p1-v11v (verifier) | t188 | verifier p1-v11v (engine): protocol v1.1 spec | RUNNING |
| p11-proto (builder) | t18b | worker p11-proto (engine): protocol v1.1 code | RUNNING (worktree: packages/protocol, test/*.js) |
| p3-scaffoldv2 (re-verifier) | t16y | verifier p3-scaffoldv2 (engine): server scaffold, round 2 | FAIL reported, idle |
| p3-scaffoldv3 (re-verifier) | t17j | verifier p3-scaffoldv3 (engine): server scaffold, round 3 | RUNNING |

## 2026-11-11 phase 1 (protocol v1 spec)

- Baseline `bun test`: 29 pass, 0 fail.
- Brief: docs/m2/briefs/p1-spec.md.
- Added to the builder by prompt (also on the verifier's checklist): hello never creates a board (POST /boards
  only); Store port says how one-sequencer-per-board is fenced on host replacement, or defers it to phase 4;
  from the proxy/client track: how highlighter (durable vs fading presence), notes (notes stream) and image
  (element + blob, tenant+SHA-1, 10 MB) travel.
- Builder reported (docs/m2/reports/p1-spec.md): 29/29 tests, three CEO questions (durable reactions by viewers;
  commenter = records only; blob reads tenant-wide). Verifier brief: docs/m2/briefs/p1-specv.md.
- Standing rule (owner via proxy): every session I start gets `--label plenary.reports-to=t14j`, and its tab
  name carries the track: `worker <job> (engine): <what>`, `verifier <job>v (engine): <what>`.
- Deferred (platform via proxy): next time packages/core is re-copied, write the full 40-char SHA in
  SOURCE.json and make test/core-source.test.js accept it. Not a job on its own.
- sdd ensemble is codex-only today (agy out of quota; grok/kimi/mistral not signed in): verifiers report it as
  "single harness", never as meeting the two-harness rule.
- Queued spec edits from platform via proxy (fix round if t151 FAILs, else follow-up p1-seam after PASS):
  (a) § Auth: null = refused (`auth`), a throw = infrastructure error (`unavailable`, client may retry);
  (b) § Tenancy: tenants created by an operator in M2 (first sign-in from a domain doesn't create one);
  share-link guests sign in with Google (no anonymous guests). Registry signatures confirmed final.
  (c) Seeding a board from a local file (drawh): decision (protocol owner, reversible): **no first-write
  exemption** from the 1,000 version-jump cap (an absent element counts as version 0; an exempt first write could
  claim a version near 2^53 and lock the element). Seeding is a **client-side import**: before sending, the client
  rewrites each element's `version` to 1 and draws a fresh `versionNonce`, keeping ids. No new message.
  drawh's patch copies protocol v0 and needs a refresh after phase 2.
  (d) § Tenancy invite matching (from platform's p5-auth verifier): an email is trusted only where Google is
  authoritative for it: `@gmail.com`, or `email_verified` plus an `hd` claim equal to the email's domain. A
  consumer account with a verified third-party address and no `hd` can't claim an invite to that address.
  (e) Drags past the version-jump cap (client p6-base): decision **Option A**, normalize on send. The jump rule
  and core stay. `Replica.local()` rewrites each outgoing element's `version` to (highest version this replica
  knows for that id: confirmed or its own pending) + 1 and draws a fresh `versionNonce`; same idea as seeding (c).
  Drag previews travel as presence in v1, so only the final op is durable. web/sync.js's workaround goes once
  phase 2 lands. Rejected B (a looser cap weakens the anti-lock rule) and C (herdr-draw, CEO gate).
  (f) Client's Replica asks, into phase 2: `receive()` returns what it applied; `reset()` keeps pending ops
  overlaid (no flicker); rule 5 states a since-0 resync **closes and reconnects** (one hello per connection, L6).
- Standing rule (proxy, 9218fdf): verifiers add an sdd ensemble review (two harnesses agree = HIGH candidate);
  builders may farm file-disjoint sub-tasks to harnesses. Told t151 and t14z; BRIEF-BASE.md carries it for new briefs.
- Standing rule (proxy, 6a75b8f): on commit, close the job's builder and verifier tabs, `hc kill` + `hc rm` their
  terminals, kill their servers/scratch terminals, drop them from the roster. p1: t14n, t14p, t151.
- Standing rule (proxy, 0fe5159): the CEO is never a gate; phase 2 starts the turn the spec passes. Phase 2 brief
  drafted: docs/m2/briefs/p2-recovery.md. Auth port shape (async verify + role) sent to the proxy for platform.
- Seam gaps from platform (via proxy): Store has no board create; invites/share links/grants have no port; member
  default role. Plan: a named **Registry** port in PROTOCOL.md (boards create/get with server-minted id, title,
  memberRole default `viewer`; tenants; invites; share links; grants), matching server/auth/registry.js; Store keeps
  log + checkpoints only. Goes in the verifier's FAIL fix, or a small follow-up job p1-seam after PASS.
- Verifier t14p: **FAIL** (docs/m2/reports/p1-specv.md). HIGH: H1 acked op double-logged when the op-id record
  is evicted between welcome and resend; H2 group commit leaves speculative vs resolved state unstated (a
  checkpoint can hold a phantom entry). 7 MEDIUM, 10 LOW. Sent back to builder t14n (13% context) with all
  findings plus the Registry seam. Phase 2 held until the spec passes (it implements the parts being fixed).
- Re-verifier t151: **PASS** (docs/m2/reports/p1-specv2.md): H1/H2 closed (model: 3.19M entries, 8,231 rebuilds,
  nothing double-logged or lost); 8 MEDIUM, 17 LOW, all text. Codex ran as a single harness. My `bun test`:
  143 pass, 0 fail. Committed PROTOCOL.md v1 + reports + briefs.
- Manager decisions on the three MEDIUMs that change phase 2 (go into PROTOCOL.md in follow-up p1-seam, and into
  the p2 brief now):
  - M1 rate vs resend: the client paces every send, resends included, to the published rate (Replica, clock
    injected). Over-rate is **backpressure, never a refusal**: the gateway queues; past its queue cap it closes the
    connection (ops stay pending, client reconnects). Rate is per user per board. `limit` stays for content caps.
  - M2 unknown connection after a rebuild: a room answers `unavailable` to any op from a connection it did not
    welcome in this incarnation; the gateway tells the room when a connection closes; the room drops its `n` state.
  - M5 records races: a refusal on `records` only drops that op from the pending overlay (no reset, no resync);
    no-op record actions (repeat resolve/react, dead target) are accepted, logged and acked.
- p1 committed 28fa91d. Cleanup: t14n, t14p, t151 tabs closed, terminals killed and removed (checked with
  `hc ls --all`); dropped from the roster. Started p2-recovery (t15q) and p1-seam (t15r) the same turn.
- Standing rule (owner, 2f29f47): new sessions start via `zsh -lic 'exec "$@"' zsh claude …` so Engram gets its
  env. Running sessions pick it up when they recycle.
- p1-seam reported (docs/m2/reports/p1-seam.md): all 12 items + round-2 findings in PROTOCOL.md (461 to 630
  lines), no renames, 143/143. It lists platform code that now disagrees with the spec (port.js swallows throws;
  oidc.js accepts any hd; registry.js has no last-owner check) and extra phase-2 rows. Verifier p1-seamv t165 started.
- p3-scaffoldv t158: **FAIL** (docs/m2/reports/p3-scaffoldv.md). H1: a few deeply nested (~30,000 levels) but
  valid ops stall the whole process ~2 s on every join, permanently (they're in the log). Held: kill -9 x6 (3,593
  acked ops, 0 lost/duplicated), late append, slow reader, traversal, pre-auth reach. 5 MEDIUM, 8 LOW.
  Fix: t14z (gateway depth scan <= 64 before decode, encode catch-up once; its MEDIUM/LOWs); t15r (§ Limits depth
  64); t15q (opProblem depth check, iterative). t165 told to include the new spec edit.
- Proxy decision: engine owns the durable Registry. p3-registry (t169) builds a SQLite adapter in server/registry/
  against server/auth/registry.js, incl. atomic last-owner in setGrant; must pass platform's factory contract test
  (test/auth/). main.js wiring goes to t14z after its fix round.
- p1-seamv t165: **PASS** (docs/m2/reports/p1-seamv.md): 12 items + all round-2 findings closed; late edits
  (setGrant wording, secondary-domain limit, depth 64) checked; 2 MEDIUM, 7 LOW (text; queued for the next spec
  touch: M1 op too big for the bus, M2 pacing "may happen" for multi-tab users, L1 id-less refusal, L3 where depth
  is counted, L5 crash between createBoard and owner grant). My `bun test`: 205 pass, 0 fail. Committed.

- p1-seam committed 7e834d2. Cleanup: t15r, t165 tabs closed, terminals killed and removed; off the roster.
- p3-registry reported (docs/m2/reports/p3-registry.md): SQLite Registry passes platform's contract (18) + 5 own
  tests; 206 pass. main.js wiring diff in its report (persists the dev board id in dev-board.json; keeps owner on
  restart), routed to t14z after its fix round. Postgres needs SELECT ... FOR UPDATE in setGrant. Verifier t16m.
- p3-registryv t16m: **PASS** (docs/m2/reports/p3-registryv.md): 4 LOW; 3-process race (owner count never < 1),
  SIGKILL durability, differential fuzz vs memoryRegistry identical, no injection, tenant isolation, injected clock.
  **Commit held:** its test imports test/auth/registry-contract.js, still
  uncommitted in platform's p5-fix. Commit right after p5-fix lands (asked the proxy to ping).
- p5-fix landed (4e16752). Registry committed; my `bun test` before commit is the line below in git log's body.
- Registry committed f2eb88b (my bun test 254 pass, 0 fail). Cleanup: t169, t16m closed, killed, removed.
- t14z fix round reported (254 green); asked it to wire the SQLite Registry into main.js + a restart test before
  re-verification.
- Queued for the next spec touch: § Tenancy authoritative email = email_verified AND (@gmail.com OR hd == email
  domain) (platform; gmail does not skip email_verified). Plus p1-seamv's 2 MEDIUM / 7 LOW.
- t14z: fix round + Registry wired into main.js (restart and 3x kill -9 tests through main.js); 261 pass.
  Gateway now refuses v0 `transient` previews (`bad-op`): client's drag previews stop reaching peers until
  presence (told the proxy). Re-verifier p3-scaffoldv2 t16y started.
- On phase 2 commit: tell manager client (t14k) directly with the commit id, as well as the proxy (client's p6-sync2 moves drag previews to presence on it).
- p2-recovery (t15q) reported: built, 79 top-level tests (25 runs green); landing alone turns 31 other-track
  tests red (17 test/server, 14 test/web). **Decision: land as one commit with the seam swaps, never red.** Patch
  applied on branch `p2-land`, worktree /Users/r/repos/plenary-p2, commit 359c50d (167 green there); patch copy in
  my scratchpad. Accepted readings: resends keep their bytes (only never-sent ops re-stamped), eight emotes,
  records.js. Verifier p2-recoveryv t171 runs in the worktree. Next: after p3-scaffoldv2 passes and the scaffold
  commits, rebase p2-land and start an engine swap job (room-host.js, gateway.js, rig.js) on it; recommended to the
  proxy that client's p6-sync2 builds web/sync.js on the same branch. Leftover: t15q's scratch worktree at its
  scratchpad/wt (remove with `git worktree remove --force` after landing).
- Queued for the next spec touch: name the emote set and add records.js to the phase-2 file list.
- Proxy approved the landing plan: client commits p6-base on main and pings me; I rebase p2-land (after the
  scaffold commits too); client's p6-sync2 works in the p2-land worktree on web/sync.js + test/web/ only; my swap
  job does room-host.js, gateway.js, rig.js there. One commit, all green, after the verifiers pass; I merge; the
  proxy audits phase 2 on that commit before pushing.
- p2-land rebased onto client's f1886d5 (head b8bf648); top-level 79/79, 54 test/web reds expected (p6-sync2). Told t14k the worktree is ready and that Replica wait()/reconnectWait() own ack timeout + backoff; told t171 the new commit id.
- Phase 4 env (confirmed to platform t14q): DATABASE_URL, NATS_URL, S3_* (Bun S3), PLENARY_NODE_ID (unique, stable per node), PLENARY_ROLES=gateway,host (default both; compose runs a gateway-only and a host-only node). NATS max_payload 2 MB per § Bus, not the 1 MB default.
- p2-recoveryv t171: **PASS** (docs/m2/reports/p2-recoveryv.md): no HIGH/MEDIUM, 4 LOW; 6,000 convergence runs with restarts, 800 recovery runs with records, resend-after-resync logged once; the loosened assertion is a nonce tie (harmless). Swap brief drafted: docs/m2/briefs/p2-swap.md (starts after the scaffold commits and p2-land is rebased).
- Platform's cluster env committed 33b4cd8: deploy/cluster.compose.yml (Postgres, NATS 2 MB, S3, 3 nodes with PLENARY_ROLES gateway/host/both behind Caddy); CI has Postgres + NATS services with TODO hooks for phase-4 tests.
- Client p6-sync2 built in the worktree (252/252); verifier t176 there. Two Replica findings from it (presence ignores stream; no backoff growth for a socket that drops before welcome) sent to t15q as fix round 2 in the worktree (replica.js + test/replica.test.js, backward-compatible). Ping t14k before any p2-land rebase.
- t15q fix round 2 done (previewsOf(stream), connectionFailed(); 254/254 in worktree). Verifier t171 re-checking it; API sent to t14k.
- t171 fix-round-2 check: FAIL (MEDIUM): backoff resets on welcome when already caught up, so welcome-then-drop storms at 500 ms (rule 12 as written). Decision: reset only after caught up AND 10 s connected (checked at the next failure). t15q fix round 3: rule 12 in the worktree's PROTOCOL.md + replica.js + test.
- Client p6-ui committed on main 3c32a5f (built on old sync.js); p2-land needs it on the next rebase. Rebase order: wait for t15q round 3 + t171 check, t16y scaffold verdict + scaffold commit, then ping t14k, then rebase --autostash.
- p3-scaffoldv2 t16y: **FAIL** (docs/m2/reports/p3-scaffoldv2.md). H1: catch-up sent as one frame vs a 256 MB bound:
  an annotator's 280 legal ~1 MB rewrites make a board unjoinable (survives restart); non-reading viewers pin ~a
  board's size each (no budget, presence keeps them alive). M1 burst freezes the process; M2 unmarked spec
  divergences. Flaky gateway convergence test = L5, a test timing bug in rig.js settled() (not a server bug).
  Sent back to t14z (31%): stream catch-up in bounded frames with backpressure; fold tail by bytes; process
  buffered-bytes budget + per-user connection cap; yield in bursts; fix settled(); 50x stability run.
- t171: fix round 3 PASS. Committed fix rounds 2-3 on p2-land as 3ba2495 (PROTOCOL.md rule 12, replica.js, test/replica.test.js); client's web files stay uncommitted in the worktree. Phase 2 protocol side is done; waiting on the scaffold fix round 2 (t14z) before rebase + swap.
- Agreed with platform (t14q) on HTTP mount: server/auth/http.js httpRoutes(deps) -> async (req, url) => Response|null, passed as createServer({ http }); engine routes first; reserved /health, /ws, /blobs/*, /metrics; Bearer OK for browsers/admin, nothing drawh needs behind Bearer-only. main.js wiring is engine's, after http.js lands.
- Platform's server/auth/http.js landed uncommitted (verifier p5-httpv). Wire main.js against the committed version when t14q sends the commit id: http: httpRoutes({ registry, sessions, oidc, tenancy, now, config, dev? }).
- Phase 4 adapters started in parallel (proxy: keep the train moving), new files only, disjoint from t14z:
  p4-pg (t17d): Postgres Store + Registry (Bun.sql, registryContract, FOR UPDATE last-owner), store-contract.js;
  p4-natss3 (t17f): NATS Bus + S3 Blobs (Bun S3Client), bus/blobs contract files, adds the NATS client dep. Tests
  skip without DATABASE_URL / NATS_URL / S3_ENDPOINT. Allowed local installs: brew postgresql@17, nats-server (no
  brew services); minio already installed. Leases/takeover wait for phase 3's commit.
- drawh seeding refined (platform, agreed): send elements unchanged except ones the room would refuse (absent AND version > 1,000), renumbered to 1 (platform's test showed 1,000 lets stale 1,001-2,000 copies overwrite silently; I agreed), fresh nonce. Queued for the next spec touch.
- t14z fix round 2 done (315 pass, 3 full runs). Round-3 verifier t17j started; it re-runs round 2's attacks against main.js from a separate process and the flaky test 100x.
- Platform's p5-http committed 4fad32a. Its main.js wiring is folded into the p2-swap brief (main.js is under t17j's verification now; p2-swap runs on the rebased branch that will include 4fad32a).
- p2-land rebased onto main 2f0dda2 (p6-ui + p5-http) at client's request; head 794298e; client's uncommitted files re-applied; worktree 292/0. Told t14k and t176. One more rebase after the scaffold commits.
- p4-natss3 (t17f) reported: NATS Bus + S3 Blobs pass contracts vs real nats-server 2.15.3 + MinIO; added @nats-io/transport-node@3.4.0 + bun.lock. Verifier t17m started. Bus-cap risk (room-host frames > 2 MB) folded into p2-swap brief. Platform asks sent to proxy (Dockerfile bun install --frozen-lockfile; CI MinIO for S3 tests).
- Platform's p8-deps (Dockerfile bun install --frozen-lockfile; CI MinIO + S3_* vars) commits only after my p4-natss3 commit (package.json + bun.lock): send t14q that commit id.
- p4-pg (t17d) reported: Postgres Store + Registry pass contracts vs local Postgres 17.11 (brew postgresql@17; brew's post-install initdb'd /opt/homebrew/var/postgresql@17, never started). Async factories; pool max must be sized. Verifier t17p started.
- Client's p6-sync2v M3 (replica restamp skips when the chain's top already leads; ops during a resync go out stale, 2/40 seeds lose a tie): decision, re-stamp the whole never-sent chain per element (r+1, r+2, ...). t15q fix round 4 in the worktree (replica.js + test only); client's p6-land runs there on web/** concurrently.
- Fix round 4 PASS (t171); committed on p2-land.
- p4-pgv t17p: **PASS** (docs/m2/reports/p4-pgv.md): both contracts vs real Postgres 17.11; conditional-append
  and last-owner races hold across OS processes; 1 MEDIUM (start-up DDL needs the app role to own its tables, so
  a migration-style deploy with a least-privilege role fails: queue for phase 4 wiring, e.g. skip DDL when the
  schema exists or a separate migrate step), 3 LOW. **Commit held:** server/store/postgres.js imports
  server/ids.js, which is still untracked (scaffold); commit right after the scaffold.
- p4-natss3v t17m: **FAIL** (docs/m2/reports/p4-natss3v.md). H1: Bun's S3Client reads S3_SESSION_TOKEN/AWS_SESSION_TOKEN from env despite explicit config (every call fails on hosts with AWS session env). M1 no S3 call timeout (hangs 300 s+). M2 NATS outage buffers publishes unbounded (800 MB measured). Sent back to t17f (14%).
- Committed package.json + bun.lock alone as 0d40b86 so platform's p8-deps could land (t14q told). NATS/S3 adapter code commits later (fix round + depends on the scaffold's server/ids.js, bus/memory.js).
- Platform's p8-deps committed 723f6c6: CI cluster-services exports S3_* (MinIO on 127.0.0.1:9000) next to DATABASE_URL and NATS_URL; Docker image installs from bun.lock.
- p4-natss3v round 2: PASS (H1, M1, M2 fixed live). New M3: a frozen (SIGSTOP) NATS server still buffers unbounded and replays stale messages. Since the commit waits on the scaffold anyway, sent M3 to t17f now (short pings + outbound byte cap + no replay).
- p4-natss3v round 3: **PASS** (M3 frozen NATS fixed). NATS/S3 adapters verified; commit held until the scaffold commits (imports server/ids.js, bus/memory.js).
- p3-scaffoldv3 t17j: **FAIL** (docs/m2/reports/p3-scaffoldv3.md). Round 2 closed and measured (joins 2 ms; 48 non-readers 282 MB, cut in 15 s; /health 32 ms in a 6,400-op burst). H1: since-0 catch-up > 64 MiB per-user budget always refused (frames admitted before drain). H2: kill -9 test boundary flake 1/30. Lead: malformed snapshot frames in Bun's WS client 1/14. Sent to t14z (42%) as fix round 3: shared catch-up frames don't count against the user budget, pulled on drain; durability assertion instead of a count; handoff if > 55%.
- Proxy: if scaffold round-4 verify fails, the fix goes to a fresh builder (t14z writes docs/m2/handoff/p3-scaffold.md first), not a 4th round in t14z. Next scaffold verifier's PASS bar includes the kill -9 gate rerun 30+ times.
- p1-v11 (t186) started: spec-only v1.1 on the worktree's PROTOCOL.md: settings compare-and-set by per-key base appSeq (soft refusal), welcome room {board, epoch}, plus all queued spec items. Lands with phase 2. Code follow-up after it passes.
- p1-v11 reported (worktree PROTOCOL.md, 321/0 there); its 13 open-question decisions accepted provisionally (D1-D13: all-or-nothing settings op, one in flight per key, epoch via Store.openEpoch in the lease record, <= 8 writer conns per user/board/gateway, 4 s append timeout, ...). Verifier t188 started. Note: manager platform is now t187 (recycled).
- t14z fix round 3 done (328 pass, 70 skip, 0 fail x3; lead not reproduced: 800/800 frames identical). Round-4 verify by t17j (24%): joins above the 64 MiB budget, kill -9 gate 30x, full bun test 20x.
- p1-v11v t188: PASS (no HIGH; 4 MEDIUM text gaps: multi-key settings retry, dead-socket counting in the 8-conn cap, rule 12 vs room identity epoch checks, settings base after stale). Sent back to t186 to close before commit (lands with phase 2 anyway); t188 re-checks.
- p1-v11 (v1.1 spec) committed on p2-land as cb343b9 (R2-M1 'passed' fix in; protocol tests 89/0 there). Lands with phase 2. v1.1 code (settings CAS, room epoch + Store.openEpoch) is a follow-up job after phase 2 merges, timed with drawh's round. t186/t188 kept until the merge.
- p11-proto (t18b) started: v1.1 code in packages/protocol on p2-land (settings CAS, epoch, appBase, keepVersions, codec id-first, openEpoch). Server half later (with/after p2-swap). Told platform t187: commit id on p2-land when verified; don't assume API beyond the spec; treat missing welcome.room as unknown epoch until the server half.
- p3-scaffoldv3 round 4 (t17j): **FAIL**. Round 3's H1/H2 closed and measured (all catch-ups over budget join; kill -9 30/30; 20/20 concurrent joiners). R4-H1: full suite 8/20 failed (outbound.test.js:399 assumes a socket-buffer size; :358 timing; 1 platform test timeout under load). R4-H2: a snapshot over Bun's backpressureLimit (~138 MB UTF-8) can't be sent (1006, no log). Per the proxy: fresh builder p3-fix4 (t18c) from t14z's handoff. Decision: admit by UTF-8 bytes; backpressureLimit above the largest snapshot the stream caps allow; loud log otherwise; stable event-driven tests; pass bar 20/20 full runs.

- t14z retired: handoff committed 346ccd9; tab closed, terminal killed and removed.
- Client's p7-collab (t18g) runs in the p2-land worktree (web/collab/**, test/web/collab/** only); its verified files join the phase-2 merge. Told t14k: v1.1 doesn't change presence/records/here/emote shapes or roles (emote set named: EMOTES).
- p11-proto (t18b) reported: v1.1 code in packages/protocol (worktree, uncommitted); choices C1-C6 accepted provisionally. Verifier t171 (25%) re-tasked as p11-protov.
- p11-protov t171: PASS, 2 MEDIUM: M1 settings changed mid-resync always refused (base reset to 0); M2 after Store loss a gate can stick. Decisions: M1 option (a) base = what the user saw (keep confirmed appSeq across reset; held-after-stale rule edited in the worktree PROTOCOL.md); M2 mark pending settings ops on the Store-lost path, no gate. Sent to t18b; t171 re-checks; then commit and send platform t187 the commit id.
- Client p7-collab asks (accepted, additive): replica.previewEntries(stream) -> [{element,user,client,at}]; replica.pendingOf(stream) -> [{id,op,sent}] in send order. Queued for t18b right after t171's v1.1 round 2; then quick verify, commit, ping t14k.
- p11-protov round 2: FAIL (2 MEDIUM): R2-M1 a released held change can carry appBase with missing keys after the Store-lost path (bad-op); R2-M2 held release uses the release-time base, so it can overwrite an unseen value (spec contradiction). Decisions: held change base fixed at local() time (max of confirmed then and own settled preceding op); forgetSettings drops held patches it can't base and reports them. Folded the client accessors (previewEntries, pendingOf) into the same round. t18b fix round 2.
- CEO rule (OFFICE.md Architecture, 1f25e61): hexagonal (core -> ports only; adapters isolated; only composition roots wire); systems-design skill APPLIER for builders / CHECKER for verifiers in every design-bearing brief; launcher now adds --plugin-dir systems-design.skill. Plan: p-arch (test/architecture.test.js with a shrink-only allowlist) starts after the scaffold's gate (to not disturb t18c's 20-run bar); architecture audit job (hexagonal + skill CHECKER vs NFRs) on p2-land after phase 2 lands.
- Platform p5-hex (t187): Registry port pieces (mint, RegistryError, typedef) move to server/auth/registry-port.js; agreed its builder changes only the import lines in server/registry/sqlite.js:18, postgres.js:20,:38. In-memory Registry stays in server/auth/ until the architecture audit. Fold its server/auth import-rule test into p-arch later.
- p-arch brief: shared scanner test/arch-scan.js (importsOf, checkBoundaries) for client (test/web/architecture.test.js) and platform.
- p11-protov round 3: FAIL on one narrow MEDIUM R3-M1 (a second change to a held key re-stamps its base past an unseen peer entry); R2-M1/M2 fixed; fuzz 900/900, convergence 4,000, recovery 800 pass. Decision: a held key's base is fixed by its first held change (+ own floor). t18b fix round 3 incl. R2-L1.
- Client: p7-collab verified (46ca1cd report), files uncommitted in the worktree for the merge. Agreed: merge at p6-landv PASS (+ engine gates: scaffold commit, rebase, p2-swap verified); client's p6-hex and p7-wire run on main after.
- Handing off to a successor manager at ~52% context (both running jobs are in waiting states). Handoff: docs/m2/handoff/manager-engine.md.
- t18m took over as manager engine from t14j's handoff (94b1ae9). Told client t14k, platform t187, proxy t14h. Watching t18c (scaffold final gate, background batch running) and t171 (v1.1 code round 4).
- p11-protov round 4: **PASS** (398/0 in the worktree, re-run by me). v1.1 code committed on p2-land as 5d55112. Told t187, t14k, t14h. Closed t18b and t171. Open LOWs L1/L3/L4 carried to the architecture audit; nit: 'acknowledged' -> 'settled' at the next spec touch.
