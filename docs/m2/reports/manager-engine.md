# Report: manager engine

Manager terminal: `t18m` (tab `manager engine`; successor of t14j, retired 2026-11-11). Parent: proxy `t1bx` (t14h retired).

## Workers (current; updated every turn)

main at ddc484a (p4-wire2; p-tab 40cba26). Phase-2 worktree retired (remove when free:
`git worktree remove /Users/r/repos/plenary-p2`).

| Job | Terminal | Status |
|---|---|---|
| p-hb (E-1 heartbeat) | - | NEXT: brief (gateway idle frame <= 10 s, Replica idle deadline ~25 s); then E-2 jitter, p-fanout |

Closed: t1km, t1m0, t1kn, t1kz, t1ky, t1gj, t1gm, t1g8, t1g3, t1g5, t1fx, t1g0, t1fm, t1fn, t1dh, t15q, t186, t188, t18c, t18b, t171, t16y, t158, t17d, t17p, t17f, t17m, t17j.
Leftover scratch: t17j ~1 GB, t18c 168 MB in their scratchpads.

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
- Platform t187 (p5-hex): agreed sqlite.js:32 JSDoc type -> ../auth/registry-port.js in platform's commit (with :18). postgres.js:20,:38 already changed in the shared tree; they ride with my p4-pg commit. Check they're intact at commit time.
- Proxy: Google OAuth client is in .env (gitignored). p2-swap brief: main.js builds googleOidc from GOOGLE_CLIENT_ID/SECRET, redirect OIDC_REDIRECT_URI default http://localhost:8080/auth/callback, 503 when absent; COOKIE_KEY from env (random + warning on a single node, refuse in cluster). Real sign-in checked after the merge (.env is not in the worktree).
- Proxy approved the COOKIE_KEY design and added a random COOKIE_KEY (32 bytes hex) to .env.
- Proxy/platform: Bun auto-loads .env in the shared tree. p2-swap brief: start(env) reads only its argument (main.js:93 LOG_LEVEL from process.env to fix); main.js tests pass explicit env objects (absent and fake Google vars); never log env.
- Client t14k: p6-landv PASS (M1 token-in-history is platform-side, not blocking). Committed client files on p2-land as 3fa2d3a (398/0); worktree clean. Merge waits on scaffold + rebase + p2-swap.
- Platform t187 (p5-hexv L8): server/registry/postgres.js:22 imports needSchema/ensureSchema from ../store/postgres.js (adapter -> adapter). Queued for p-arch: move them to a shared helper (e.g. server/pg/schema.js) that both Postgres adapters import; allowlist it until then. Commit p4-pg as verified first.
- Platform p5-hex landed 02b7434 (sqlite.js:18,:32). postgres.js:20,:38 confirmed pointing at ../auth/registry-port.js in the tree; commit them with p4-pg, then tell t187 (auth/registry.js re-export of mint/RegistryError can then go).
- New naming rule (OFFICE.md 7f680a3): sessions named plenary-<job> / plenary-<job>v via hc run --name and claude -n; tab labels carry ' · <id>'. Applies to every session I start (next: t17j re-verify is an existing session; p2-swap builder will be plenary-p2-swap).
- p3-fix4 (t18c) reported: R4-H2 real cause was flush() sending past the socket limit behind a big snapshot (fixed: wait for drain; backpressureLimit 450 MB from spec caps at 3 B/char; UTF-8 byte counting; loud log). R4-H1 tests now event-driven. Gate: loaded 21/21, quiet 17/20 (3 = platform test/auth/http.test.js during their edits), kill -9 30/30 + 15/15. Decision (mine): Bun's WS client closes on messages > 128 MiB; not a server bug, not blocking. Queued protocol items: § Limits stated in UTF-8 bytes; snapshot sent in parts (v1.2; also needed by a Bun-based load tool at M4). Round 5 re-verify sent to t17j.
- Proxy is now t1bx (t14h retired, handoff 9d06783). Report there; ping on the scaffold commit.
- Scaffold 7b6a5dd, p4-pg b804f3b, p4-natss3 bbdae0e committed (bun test 512/0 shared tree). p2-land rebased (892ee6e): protocol+web+auth 551/2 (platform google-live, p5-tidy fixing); test/server fails until p2-swap. Security review of 7b6a5dd: 2 MEDIUM (live queue cap; revocation) folded into p2-swap brief d81771c. p2-swap started t1dh.
- R5-M1 committed ffd2a11 (test only; re-ran 3x 22/0). Proxy t1bx told. t1dh told to cherry-pick ffd2a11 into p2-land. t18c closed.
- CEO rule (2026-11-12): never prompt/hc send the proxy t1bx; report by ending the turn with one short message (outcome first, report path); 'URGENT' first if urgent. Phase 3 audited and pushed to origin (378d089, clean 510/0).
- Closed t15q, t186, t188 (work committed); removed t15q's scratch worktree. p2-swap t1dh handing off at 36% (finishing a welcome-ordering fix first); successor expected same turn.
- t1dh handed off to t1fm (plenary-p2-swap2); t1dh closed. Told platform t187: deploy/cluster.compose.yml needs COOKIE_KEY (main.js refuses cluster mode without it after p2-swap).
- p2-swap (t1fm) reported: done-when green (429/0; 488/0 with PG+NATS); feed checkpoint-race fix; queue cap + idle tests; PG least privilege tested; no SEAM(p2) left. Platform asks: session verify() return exp; grants publish from registry. p-arch to absorb test/server/architecture.test.js. Verifier t1fn started (brief docs/m2/briefs/p2-swapv.md).
- Platform t187: p5-exp started (verify returns exp); grants announce stays a main.js decorator (agreed); p5-pgpriv after the merge, on p-arch's server/pg/schema.js helper (needSchema/ensureSchema/migrate); p8-cookie on the merge id. p-arch must move migrate() too.
- Platform p5-exp landed e82a537 (identity.exp flat integer seconds; dev tokens none). Platform waits on the merge id for p8-cookie, p5-pgpriv, live drawh run.
- p2-swapv t1fn: FAIL (H1 revocation during hello; M1 recheck fails open; M2 exp (now on main e82a537); M3 link/invite expiry; 6 LOW). Rebased p2-land onto main (b18de1d, autostash clean). Fix round 1 to t1fm. Decisions: L3 keep byte-triggered checkpoint and amend § Recovery When; L5 add grants to § Bus; L1 `here` becomes its own job (queued); L4 to p-arch.
- Fix round 1 (t1fm) done in 7 min: all listed fixed; done-when 443/0 plain. Round 2 re-verify sent to t1fn.
- p2-swapv round 2 PASS (R1/R2 MEDIUM at scale, R3-R6 LOW -> p2-tune). Committed 3ca0b05 on p2-land (884/0); merged into main dcbdae6 (884/0 on main). Started p2-tune (t1fw, incl. `here`) and p-arch (t1fx). Platform: p5-pgpriv waits on p-arch's commit id.
- Client t14k: p6-hex started on main (web/**); needs test/arch-scan.js from p-arch: ping t14k with p-arch's commit id (also t187).
- Platform t187: flake v1.test.js token-expiry test (5 s timeout under load). Added to p2-tune R6 (t1fw).
- p-arch (t1fx) reported in 15 min: test green, plants fail; server/pg/schema.js; pg contracts 44/0. Allowlisted s3.js->disk.js (fix: server/blobs/port.js). Open question: restrict adapters to ports + explicit shared list. Verifier t1g0 started.
- Platform S1 (pd-drawh-live): POST /boards 403 on stock single node with dev tokens. Decision: platform builds server/admin bootstrapTenant + CLI (also for the first Google tenant) and adds a dev-only call in main.js (allowed: a few lines in the dev path).
- Platform p8-readme2: (1) main.js:152 stale 'sign-in not wired' log: platform fixes it within its S1 main.js change. (2) GET / 404 after Google sign-in: engine job queued (p-serve: server.js serves web/ statically at /), after p2-tune; asked client t14k for entry file, excluded paths, headers.
- Client t14k gave p-serve requirements (mounts, import-graph allowlist, deny list, CSP/headers). p-serve started (t1g3) now since its files are disjoint; p2-tune told to leave static files alone. Client sends final paths when p6-hex lands.
- p-archv PASS (3 MEDIUM, 8 LOW). Committed p-arch 44dd1aa (arch + store/registry/auth tests 179/0). Sent id to t187 (p5-pgpriv) and t14k (arch-scan). Decision: limit driven adapters to ports + explicit shared list (auth/http.js exempt). Follow-up to t1fx incl. platform's scripts/admin-bootstrap.js composition root.
- p-arch follow-up (t1fx) done: M1-M3, adapter shared-list rule, DRIVING group (auth/http.js, server.js, static.js), admin-bootstrap root, server/blobs/port.js (allowlist empty), LOWs L1(opt-in),L2,L3,L5,L7. bun test 1044/0. Round 2 verify sent to t1g0.
- p-archv round 2 PASS (4 new LOW, chiefly R2-L1: `/*` inside a string/regex earlier on the line hides an import; queue for later). Committed follow-up 3a7520d; told t187. Closed t1fx, t1g0. Started p-audit (t1g5).
- Client t14k: final web/ paths + extended deny list forwarded to p-serve (t1g3). Open: web/core/dev-users.js may move to a dev-only root.
- Platform p5-devadmin: (1) sqliteRegistry 'database is locked' on concurrent first open -> platform fixes (busy_timeout); check engine's store/sqlite.js too. (3) spec note queued: § Registry email:<addr> admins before first sign-in.
- 03:44: herdr-core lost its holder; every agent killed; proxy resumed t18m, t1g8, t1g5, t1fw in place. Watches re-armed. p-serve reported (works; page boot blocked by client's main.js importing denied dev transports; told t14k). Extra flaky v1 checkpoint test sent to p2-tune R6.
- Second restart (after 03:44): team idle, Monitors dead; proxy re-prompted t1g8 (p-servev), t1g5 (p-audit), t1fw (p2-tune), all working again. Watch re-armed (bapeatrdv). Next: p-servev PASS -> commit static serving; p2-tune report -> verifier plenary-p2-tunev; p-audit -> fix jobs, then phase 4.
- p-audit reported (docs/m2/reports/p-audit.md): log safe; fan-out, presence, leases, some ports not ready for the NFRs. Job plan: p4-store-lease (Store lease + epoch fence, started t1gd) -> its verifier -> p4-host (room host uses it) -> p4-wire (main.js wiring); p-fanout (protocol/gateway fan-out, snapshot tail) after p2-tune lands; then p-ports. Sent platform t187 F4 (no grants announce on addLinkUse, main.js:73), F8 (role cache invalidated by grants + batched timed re-check), F9 serving side (HTTP snapshot endpoint). Closed t1g5.
- p2-tune reported (t1fw); verifier p2-tunev started (t1gf). On PASS: commit by path, then p-fanout; then apply p4-store-lease's PROTOCOL.md proposal.
- p-servev FAIL (docs/m2/reports/p-servev.md): H1 scanner bug (comment containing "import" swallows the next import; /ports/storage.js 404, page can't boot). Fix round r2 started (t1gj, resumed builder session). Same grammar bug in test/arch-scan.js importsOf: queued (p-arch lineage, with R2-L1).
- Platform t187: p5-devadmin committed 7a44278 (PASS, LOWs). p5-pgpriv (in verification) fixes the SQLite registry lock with a WAL check + bounded busy retry (onBusyRetry); queued: copy it into server/store/sqlite.js after p4-store-lease (t1gd owns server/store/* now). Answers the queued busy_timeout item.
- Platform t187 re F4/F8/F9: F4+F8 = job p5-load (worker t1gh, ETA ~1.5h with verifier); gateway.js changes (read {board,user} on grants, role-cache invalidation) come as a patch in docs/m2/reports/p5-load.md for engine to apply; proposed batched port rolesFor(boardId, identities) -> Map (+ grantsFor if needed). F9 = job p5-snap (snapshot ticket in welcome, GET /boards/:id/snapshot?seq=&t=<ticket>), starts when p-fanout fixes the snapshot/tail message shape: TELL t187 then. p5-pgpriv commit id follows (verifier t1gg).
- p-serve r2 reported (t1gj): scanner now Bun.Transpiler.scanImports + regex on comment-free transformSync output; allowlist = Bun.build crawl (39 files). Re-verifier p-servev2 started (t1gm). t1g3 (plain shell) and t1g8 (p-servev, FAIL filed) closed and removed. p2-tunev report still a draft FAIL with measurements pending.
- Platform t187: p5-pgpriv committed 740665f (Registry least-privilege start-up; no ALTER/DROP/GRANT). Sent to p4-store-lease (t1gd): no ALTER at Store start-up either, plus 2 LOWs (lock_timeout on the advisory lock, store/postgres.js:80; clear privilege error). t1gd showed "done" but is still on a full Postgres run. Note from t187: test/core-source fails only because ~/repos/herdr-draw has uncommitted core/ edits (not ours).
- p2-tune (t1fw) final: test/server 10/10; full suite plain 1083/1 fail, with PG+NATS 1179/1 fail (both core drift from herdr-draw, not ours); stall 261-278 ms down to 7 ms on 20 grants x 2,000 conns. Code files unchanged since before p2-tunev started (latest tune.test.js 07:29, brief 07:33), so the verifier tests current code. Decision: recheckPass keeps auth.role per user; when p5-load lands, wire the timed pass to invalidate(board) + rolesFor per chunk (grants pass still fails closed). Open: t1fw scratch dir left behind (permission prompt denied its delete; test data only, outside the repo).

- p-servev2 PASS (0 HIGH; 1 MEDIUM: deny list checks the URL, not a symlink's real target; 0 symlinks today; 4 LOW). Committed ea978ac (static serving). Closed t1gj and t1gm. Queued: static.js realpath the target against the deny list, plus the p-servev2 LOWs. Told client t14k (static committed; count-only `here` coming).
- p2-tunev FAIL (t1gf): H1 a never-settling Registry lookup freezes the re-check (revoked editor keeps writing); H2 a few always-failing users close every healthy connection (8 bad closed 300 healthy); M1 retry backoff not reset; M2 `here` resends 50 writers on every viewer-count change (~90 MB/s per gateway at 100k). Fix round r2 sent to t1fw (docs/m2/briefs/p2-tune-r2.md): per-lookup timeout, grants cuts a weaker pass short, per-user errors, count-only `here`.
- p4-store-lease reported (t1gd): lease + epoch fence in both Stores, contract on SQLite too (F12), typedef (F13), no ALTER at PG start-up (needs-migration + LEASE_UPGRADE_SQL), lock_timeout, wrapped 42501; 28 mutations caught. deploy/README.md paragraph proposed for platform. Verifier p4-store-leasev started (t1gp).
- Client t14k: p6-hex committed 06bf267; web/main.js is production-only (dev rooms in web/dev-main.js, unreachable from main.js, so not served). Checked: no dev imports in main.js; test/server/static.test.js 19/19. Queued item "client removes dev imports from main.js" closed. core-source failure is the known herdr-draw drift.
- t1fw heads-up: count-only here = {t:"here", writerCount, viewers}; web/core/collab/presence-model.js:73-75 clears the list when writers is absent. Sent to client t14k to keep the last list.
- t1gf final FAIL message received (same findings as filed; r2 already covers them). Sent platform t187: Registry Postgres has no query timeout (registry/postgres.js:79 vs registry-port.js:11-14), defense in depth. Queued: delete t1gf scratch (path in p2-tunev.md Housekeeping). t1gf kept idle for the round-2 re-verify.
- 2026-11-12 static.js: dropped DENY web/adapters/collab/** for t14k (p7-wire); fake.js still denied; real-tree test reads index.html stylesheets. Committed 050ef13, t14k told.
- 2026-11-12 t1fw: autocompact thrash; my /clear arrived as chat (no effect), t1fw kept state (8% ctx) and resumed r2 under p2-tune-r2b.md rules.
- 2026-11-12 p4-store-leasev (t1gp): PASS, 2 MEDIUM (PG takeover can wait forever; PG tests miss fence-atomicity/clock mutants) + 5 LOW. Fix round p4-store-lease-r2.md sent to t1gd (M1, M2, L2, L3).
- 2026-11-12 t14k asked how to count viewers (2 connections per tab). Decided: hello gets optional `tab`; here.viewers = distinct (user, tab); writer cap = 8 tabs per (user, board) per gateway. Engine builds after p2-tune r2; multiplexing stays M4. Client told to wait for my ping.
- 2026-11-12 t1gp regraded p4-store-leasev to FAIL: the PG test gap is H1 (4 mutants survive); code held. Same fix round; t1gd told.
- 2026-11-12 t187: p5-load committed 1d73436; its gateway.js patch is on hold (2 HIGH merge hazards vs p2-tune r2). Told t187 to re-cut after p2-tune r2 commits; I ping them.
- 2026-11-12: p4-store-lease r2 (t1gd) reported: H1 4/4 mutants caught, M1 timeouts, L3 probe, L2 bump kept (PROTOCOL.md: incarnations never share an epoch). Re-verify sent to t1gp.
- 2026-11-12: p2-tune r2 (t1fw) reported done: all findings fixed, 8 mutations caught, 10x green, PG+NATS green, stall <=9 ms (46 ms one-user revoke-all in Risks). Re-verify sent to t1gf.
- 2026-11-12: p4-store-lease committed 00cf69c after p4-store-leasev round 2 PASS (t1gp). Open LOWs: R2-L1 ttl/2 lock cap untested; R2-L2 idle-cut-off writer gets a raw PG error (for p4-host). t1gd and t1gp closed and removed.
- 2026-11-12: brief docs/m2/briefs/p4-host.md written (room host on acquire/renew/release in both modes, required epoch on every write, holder-only inbox, renew from before the rebuild, host deadline on a real timer, fail without release, release on close; F13 Bus, F14 Room status, F15 flush; R2-L1, R2-L2). Launch held until p2-tune commits, because p4-host changes openEpoch callers in p2-tune's uncommitted tests. Deferred, decided: F11 (per-board gateway subject) to p-fanout because it changes subjects.gateway used by gateway.js; F10 (incremental fold) to its own job; main.js wiring of leaseTtlMs/holder to p4-wire.
- 2026-11-12: p2-tune committed a90cd6b after p2-tunev round 2 PASS (t1gf): test/server 10/10, PG+NATS 1215/0, R1 stall 8.7 ms. Open: MEDIUM a hung Registry makes a grants pass take ~N/8 x 2 s; MEDIUM breather N x 8 ms; LOW the cut has no test. t1gf and t1fw closed and removed (t1gf scratch: p2-tunev.md Housekeeping).
- 2026-11-12: p4-host launched (t1h5, brief docs/m2/briefs/p4-host.md). On report: verifier p4-hostv, then p4-wire.
- 2026-11-12: client p7-audit (ea47b46) engine findings queued: E-1 HIGH no downstream heartbeat (half-open link stays live); E-2 HIGH reconnect herd (first retry 0.5-1 s for every client of a dead gateway, replica.js:318-339); E-4 HIGH every connection gets every presence batch (~105 KB/s per viewer at 50 cursors, gateway.js:527-540; goes into p-fanout); E-3 MEDIUM recordsState rebuild 27 ms/rev; E-5 MEDIUM static under a join wave; E-6 LOW; E-7 core paintScene (herdr-draw side, not ours to edit). Plan: jobs p-heartbeat (E-1) and jitter in Replica (E-2) after p-fanout's spec.
- 2026-11-12: p7-tab decision: engine adds a Replica option `tab` (new Replica({tab})) so connectMessages puts hello.tab; spec first (PROTOCOL.md § hello tab, here.viewers = distinct (user, tab), writer cap 8 tabs per (user, board) per gateway), then gateway + Replica, verifier, then ping t14k. Told t14k.
- 2026-11-12 t187: rolesFor groups by identityKey (user, email, domain; server/auth/tenancy.js:38). p5-load gateway patch re-cut against a90cd6b in t1gh (brief p5-load3): imports identityKey, keeps invalidate(board) before rolesFor in the timed pass (needed for link revokes). Patch path comes after its verifier passes; then I apply it.

- 2026-11-12 p4-host: t1h5 asked to edit 3 test spots outside its list (outbound.test.js:360 seed append without epoch; gateway.test.js:287-297 append wrapper drops the epoch arg) because goal 8 makes the epoch required. Approved: mechanical, those lines only, listed in its report.
- 2026-11-12 p4-host: approved 2 more out-of-list edits: gateway.test.js:335 conflict->fenced (lease fence is the intended result); main.test.js kill -9 restart test retries its hello (only 1013/timeouts allowed, bounded at ttl+3 s, acked ops still asserted) since the new process waits out the dead holder lease. Shorter ttl via main.js left to p4-wire.
- 2026-11-12 platform c2024f3 (t187): every PG Registry call bounded (lock/statement timeouts, in-flight gate, queue deadline; codes surface to clients as unavailable); deploy/README.md has our two Store notes (pl_leases upgrade ALTER, start-up grant probe). Closes queued item "Registry PG query timeout". p2-tune MEDIUM (hung Registry => grants pass ~N/8 x 2 s) stays open: the 3-5 s statement timeout is above our 2 s recheckLookupMs, so the gateway cut still governs; fix is in the gateway (concurrency/whole-pass deadline), not the Registry.
- 2026-11-12 C-16 (t14k p7-archtest): committed 422526c, static.js DENY adds web/dev*.html|js, core/dev-users.js, adapters/storage/memory.js; static.test.js rule cases updated (dropping either new rule fails 1 test). Not exported as one list: test/web/architecture.test.js checks DENY vs DEV_MODULES both ways. t14k asked to delete DENY_GAPS_C16 and unskip; until then their uncommitted shrink-only test fails (expected).
- 2026-11-12 t14k FYI (p7-archtestv): replica.js:31 session id uses Math.random() even with injected random (via web/core/sync.js:53). Judged LOW, queued. Not a one-line swap: ~10 tests inject random: () => 0, so using `random` would give every same-named Replica the same session part and defeat its purpose (no op-id collision on reload). Fix shape: an optional `session` (or `sessionId`) option, default as today; bindEditor passes one from the clock port when seeded. packages/protocol change, so drawh copy + SOURCE.json follow. Goes with the E-2 reconnect-jitter job (same file, same `random`).
- 2026-11-12 p4-host done (t1h5, uncommitted): full bun test with PG+NATS 1363 pass / 1 fail (core-source drift only); test/server 10x clean except one run hit by my C-16 static edit mid-run; 14/14 mutants caught. t1h5 idle, kept for a fix round. Verifier p4-hostv launched: t1hd, brief docs/m2/briefs/p4-hostv.md (CHECKER, goals 1-12 both ways, F5/dead-holder/fenced-append attacks on both adapters, mutants incl. 3 new, approved test edits not loosened, 10x, sdd ensemble, PG+NATS run). After PASS: commit by path, clean up t1h5/t1hd, launch p4-wire.
- 2026-11-12 p5-load gateway patch ready (t187: docs/m2/reports/p5-load.patch, 479cf46 cut on 426757d, verifier p5-load4v PASS). Landing conditions: apply whole; PROTOCOL.md Role-cache sentence lands with main.js roleCache wiring or neither; run bun test test/server after (revocation.test.js has p4-host's uncommitted edits, combination untested). `git apply --check` passes now. HELD until p4-host is committed: the patch touches revocation.test.js and rig.js (p4-host files), and verifier t1hd is running bun test in the shared tree, so applying now would change the tree under it (as C-16 did to t1h5) and tangle the path commits. Order: p4-hostv PASS, commit p4-host, apply p5-load patch, bun test test/server + full, commit.
- 2026-11-12 p4-hostv FAIL (t1hd, docs/m2/reports/p4-hostv.md): HIGH-1 a holder stalled past its ttl (real SIGSTOP/SIGCONT, PG+NATS) serves inbox messages queued during the stall: welcomes the new holder's connections from its dead epoch, then 1013s them. No acked op lost (fence held). MEDIUM: takeover up to ~2 ttl; hello during the new holder's build unanswered; hung renew never retried. 9 LOW. 14/15 mutants caught; gates green but core-source. Fix round sent to live t1h5 (hc send, 28% context): brief docs/m2/briefs/p4-host-r2.md. Decisions: one `expired(slot)` guard on onInbox and every reply, fail() 1013s only welcomed connections; lease() returns Store-judged remainingMs, watcher retries every ttl/3 and on silence/release; new-epoch heartbeat answers held hellos 1013; renew bounded by renewEvery; LOWs L1, L3-L5, L7-L9 fixed, L6 documented. t1hd kept idle for round 2 (tab renamed). p5-load patch still held.
- 2026-11-12 t187 FYI: p5-google2 committed 35d5f5a. LOW for server/main.js: httpRoutes gets the default stdout logger (ignores LOG_LEVEL, 76 noisy lines in bun test); fix = pass log.child({component:"auth"}) to httpRoutes. Queued into p4-wire (owns main.js). t187 also saw room-host-lease.test.js (repro F) and gateway.test.js ('entries subject carries each entry once') failing in the main tree: t1h5's round 2 is mid-work there; the round-2 gates (full bun test, 10x test/server) must cover both before re-verify.
- 2026-11-12 t14k FYI: client job J3 p8-one-link (t1ht) holds web/core/{sync,session}.js: one Replica + one transport per tab feeding board and notes. It mints a tab id but passes no {tab} to Replica until I ping (no packages/ edits). Dependency for my queued "tab counting" job: when packages/protocol Replica accepts {tab} (and the gateway counts tabs), ping t14k. Pair with the replica.js `session` option (E-2 job), same file.
- 2026-11-12 t1h5 r2 question: MEDIUM-2 fix marks the room's first .entries heartbeat `opened: true` (watcher then answers held hellos). Approved gateway.test.js:278 -> toEqual({seq:0, epoch:1, opened:true}), exact; asked for a later-beat-has-no-opened assert, the flag in the § Bus proposal, and confirmation the gateway ignores it. Additive bus field, explicit, simpler than inferring from epoch change.
- 2026-11-12 p4-host r2 done (t1h5): HIGH-1, MEDIUM-1..3, L1-L9 fixed/answered; repros are tests (in-process stall always runs; real SIGSTOP/kill -9 in room-host-proc.test.js); 13/13 r2 mutants; full PG+NATS 1493 pass / core-source only; test/server 10x: 9 clean + 1 file-load failure from a concurrent server/auth edit, reruns clean. Deviation accepted: renew bounded ttl/6, retry ttl/12 (deadline = last good send + 2 intervals, so a whole-interval bound times out exactly at the deadline and never retries; repro F failed that way). Re-verify sent to t1hd (round 2, appends to p4-hostv.md).
- 2026-11-12 Load-test split with t187 (platform): platform writes p8-rig (scripts/cluster-rig.js, deploy/cluster.compose.yml) AND the load client (scripts/load/, consumer of packages/protocol Replica, no packages/ edits); engine keeps the gate numbers and wires main.js (p4-wire). Env contract given to t187 for p4-wire: DATABASE_URL, NATS_URL, PLENARY_NODE_ID ([a-z0-9-], default os.hostname()), PLENARY_ROLES (gateway,host; default both), PLENARY_LEASE_TTL_MS (default 10000, same on every node). Change a name only after telling t187. deploy/README.md uncommitted diff is not engine's.
- 2026-11-12 p4-host committed 5b272ad after p4-hostv round 2 PASS (t1hd). Open LOW R2-L1: slot.welcomed never shrinks (goes into p4-wire). t1h5 and t1hd closed, killed and removed.
- 2026-11-12 p5-load patch applied whole and committed 15210d3 (12 files; tree diff equals the patch line for line except one line). Adaptation: test M7 gated store.openEpoch, which room-host no longer calls since p4-host, so it saw "welcome" instead of "closed 1008"; it now gates store.acquire (passes 3x, fails with the gate off). bun test green except core-source (known herdr-draw drift).
- 2026-11-12 p4-wire launched: builder t1j6 (brief docs/m2/briefs/p4-wire.md; tab renamed). Remote open decided: request plen-hosts.open {tenant,board,gateway,n}, reply on requester-owned plen-hosts.opened.<requester>, first reply wins, reject after leaseTtlMs, one in flight per board, never cached; gateway.js untouched.
- 2026-11-12 p4-wire round 1 done (t1j6, report docs/m2/reports/p4-wire.md, uncommitted): 8/8 mutants; bun test 1436 pass / core-source only; test/server 10x clean; PG+NATS 1580 pass / core-source + one test/load flake (platform's, passed on rerun). Decisions 2-6 accepted. Decision 1 changed (round 2, brief docs/m2/briefs/p4-wire-r2.md): a "held" reply resolves the remote open at once; "watching" resolves after a grace of min(1000, ttl/4) ms, because a cold-board 1013 plus client backoff breaks the 150 ms editor NFR. Round 2 also measures the cold bounce on PG+NATS (20 boards) and closes the redaction gaps (NATS open failure, partial-open close). Then verifier p4-wirev.
- 2026-11-12 Proxy: replace hand-written import scanners with Bun's parser. server/static.js already uses Bun.Transpiler.scanImports (no work). Queued job p-scan: test/arch-scan.js importsOf/packagesOf onto Bun.Transpiler (keep the output shape; keep new URL(lit, import.meta.url) and JSDoc import() "type" edges, which scanImports misses), starts after client's p8-tidy commits (its test/web/architecture.test.js imports arch-scan). Proposed to t14k: globals lexer in test/web/architecture.test.js stays client's unless they hand it over. Asked t187 whether test/auth/architecture.test.js:51 (own copy of the grammar) moves onto arch-scan.js.
- 2026-11-12 Agreed with t14k: engine p-scan = test/arch-scan.js only (starts when t14k reports p8-tidy committed; send t14k p-scan's commit id after); client's next job = parser-based globals check in test/web/architecture.test.js (client-owned helper), starts after p-scan lands.
- 2026-11-12 t14k handed over test/web/architecture.test.js's globals lexer: p-scan scope = test/arch-scan.js + that file's globals check onto Bun's parser (keep every rule/allowlist; delete regex/prefix-postfix rules; p8-tidy round 3-4 evasion cases stay as tests and stay caught; test/web/core-runtime-globals.test.js untouched). Starts when t14k reports p8-tidy committed. Still waiting on t187 about test/auth/architecture.test.js:51.
- 2026-11-12 Final with t14k (supersedes the hand-over line above): p-scan = test/arch-scan.js only; the globals check in test/web/architecture.test.js stays client's, starting after engine sends p-scan's commit id.
- 2026-11-12 t187 agreed: p-scan also points test/auth/architecture.test.js at arch-scan.js's importsOf (delete local importsOf/onComment; keep SCOPE, CLASSES, COMPOSITION_ROOTS, inbound rule, runtime vs type split; gate: green + 2 mutations). Brief written: docs/m2/briefs/p-scan.md. Launch on t14k's p8-tidy-committed note; send the commit id to t14k and t187.
- 2026-11-12 15:24 t187: SysV shm full (32/32, 30 orphans from SIGKILLed postmasters since 14:22). Engine checked: our tests SIGKILL only bun children; t1j6 stops Postgres with pg_ctl stop by PID. Verifier briefs must stop PG with pg_ctl and check ipcs -m. Clearing orphans needs the CEO's OK (platform raises it).
- 2026-11-12 15:44 t14k: p8-tidy committed 9494fd2. p-scan launched: builder t1jc (plenary-p-scan), brief docs/m2/briefs/p-scan.md. Send its commit id to t14k and t187 when it lands.
- 2026-11-12 15:44 t14k, M4 notes from the tidy verifier (engine queue, not client work): (1) server retry-after on gateway admission, protocol first, agreed with client: the real control against a correlated return; (2) jitter window scaled by audience size; (3) M4 counts probe reconnects per return. Client jitter today: editors 0-2 s, viewers/annotators 0-15 s. Folded into the E-2 queue item.
- 2026-11-12 p4-wire round 2 done (t1j6): grace min(1000, ttl/4) on watcher-only replies; cold first-writer bounce on PG+NATS 17/60 before, 0/60 after; NATS-fail and close-what-opened redaction tests; 5/5 new mutations caught. Open: possible room-host watcher race (lost hello, then 1013; ticket for room-host owner); test/deploy/cluster-rig.test.js flakes under contention (platform's). Verifier launched: t1jd (plenary-p4-wirev), brief docs/m2/briefs/p4-wirev.md (stop PG with pg_ctl only, check ipcs -m, never ipcrm).
- 2026-11-12 t187: 71 copies of the repo .env sit in 18 sessions' scratchpads (/private/tmp/claude-501, mode 0700); 8 went into folders handed to codex/grok review tools. Rotation is the CEO's call (platform raised it). Engine rule from now on: every brief says scratch copies exclude .env (git worktree or rsync --exclude .env) and no folder holding .env goes to a review tool. Sent as an addendum to t1jd (p4-wirev).
- 2026-11-12 t187: gate flake ticket (engine queue): test/server/v1.test.js 'Pacing: ... past maxLiveQueuedBytes' timed out at 20 s in a full run (load avg ~5); 12/12 alone. Platform's load client committed 448ca84.
- 2026-11-12 p-scan committed e4b8cea (report docs/m2/reports/p-scan.md): import scanners on Bun's parser; a parse failure is a loud violation. Verified independently: arch tests 53/53, full bun test 1469 pass / 1 fail (core-source drift only), own mutant (parse failure swallowed as 0 imports) caught by 2 tests, in a git worktree without .env. test/architecture.test.js left out (its diff is platform's p8-rig/load composition roots; told t187). Commit id sent to t14k and t187. t1jc closed, killed, removed; its scratch (session 475dbefc scratchpad, no .env per its report) remains: deleting another session's scratchpad was refused by the permission check.
- 2026-11-12 p4-wire committed 7bf171b after p4-wirev PASS (t1jd): 1 MEDIUM (server/bus/nats.js ignores NATS_URL user:pass; fails closed) and 7 LOWs (redact gaps with fake drivers, post-start errors unredacted, R2-L1 sweep path untested, late watching at ttl, stale publish reject by key, dash-only node id, empty URLs = single node) ticketed for a fix round. bun test 1475 pass / 1 fail (core-source drift). Deploy notes relayed to t187. t1j6, t1jd closed (tab, kill, rm); their scratchpads left (rm denied).
- 2026-11-12 CEO decisions (via proxy t1bx): SysV orphan segments cleared (30 removed), Postgres starts again; all 69 scratch .env copies deleted (repo .env kept); no secret rotation. Engine impact: no engine job was blocked on shm (p4-wirev ran PG at 30/32); no engine worker is running, so none needs .env re-created. Briefs keep the rule: scratch copies exclude .env; a worker that needs it reads the repo .env in place. Rotation item closed.
- 2026-11-12 proxy asked for the p4-wire fix round, the per-tab id and E-1 in parallel if files don't collide. Launched p4-wire2 (t1km, brief docs/m2/briefs/p4-wire2.md: NATS_URL userinfo into client options, redact gaps, late-watching timer, inflight-by-key settle, node id edges, empty URL refusal; owns main.js, room-host.js, bus/nats.js and their tests) and p-tab (t1kn, brief docs/m2/briefs/p-tab.md: optional hello.tab /^[A-Za-z0-9_-]{1,32}$/, here.viewers = distinct (user, tab) per board per gateway, writer cap 8 tabs per (user, board) + 2 conns per tab, 1008 limit; owns PROTOCOL.md § hello/§ here, replica.js, envelope.js, gateway.js and their tests). Ownership checked disjoint. E-1 heartbeat held: it edits PROTOCOL.md, gateway.js and replica.js, the same files as p-tab; it starts after p-tab commits (design: gateway sends hb itself per idle conn, encoded once per board; Replica idle deadline ~25 s only while live, via timeLeft on the virtual clock, no timers). Replica ignores unknown t (replica.js:364-388), so hb is safe there; drawh copy and web/core/sync.js to be checked in p-hb. After p-tab commits: ping t14k (p7-tab), tell t187 (drawh protocol copy + SOURCE.json, L6/L7). Monitor b6onzoo3i watches both.
- 2026-11-12 t187 relayed: p8-load3's review saw server/gateway.js with the hello-tab check disabled (if (false)); real check back at :886. Cause: p-tab builder t1kn mutating in the real tree. t1kn told: mutations only in a scratch worktree, and its report must confirm the real tree is clean. Before committing p-tab I diff every owned file for leftover mutations (grep 'if (false)' etc.).

### 2026-11-12: p-tab verified by me; p-tabv and p4-wire2v launched
- **p-tab (t1kn):** my diff check found no leftover mutations; test/server, envelope, replica, architecture and purity
  gave 326 pass, 0 fail. The first verifier launch (t1ky) used wrong `--plugin-dir` paths, so I killed and removed it
  and relaunched it as **t1kz** with the /Users/r/repos/ paths.
- **p4-wire2 (t1km):** done. M1 and L1-L7 are fixed with 12 tests, all named mutations are caught, and test/server
  passed 10×. On PG + NATS with auth: 398 pass, 0 fail. Its full run had 3 timing failures in tab.test.js and
  tune.test.js that pass alone; both verifiers are told to check them.
  The verifier **p4-wire2v** is t1m0.
- **For platform:** deploy/cluster/RIG.md lines 11-15 are stale after L7 and M1. Empty URLs now refuse to start, and
  NATS userinfo now works.

### 2026-11-12: p-tab committed (40cba26)
- **p-tabv (t1kz): PASS**, 0 HIGH, 1 MEDIUM, 3 LOW. Fixed before commit: M1 (PROTOCOL.md writer-cap lines now say
  8 tabs x 2 connections) and L1 (a direct "forwarded without the tab" test in test/server/tab.test.js; mutant V1 killed).
- **My checks:** server/gateway.js diffed at t187's request: both `tooMany()` call sites live, no check disabled.
  `bun test`: 1534 pass, 1 fail = core-source drift only.
- **Deferred:** L2 (the 8-cap message still says "connections"; change with v1.test.js:148) is engine's;
  L3 (per-tab refusal UI text) went to t14k with the p7-tab unblock. A PROTOCOL changelog row for hello.tab is queued.
- **Told:** t14k (p7-tab unblocked, L3); t187 (drawh protocol re-copy + SOURCE.json, gateway diff clean, p4-wire2's
  `bus error` err is now an Error, RIG.md lines 11-15 stale).
- **Cleaned up:** t1kn, t1kz.

### 2026-11-12: p4-wire2 committed (ddc484a)
- **p4-wire2v (t1m0): PASS**, 0 HIGH, 0 MEDIUM, 4 LOW (docs/m2/reports/p4-wire2v.md). All 8 p4-wirev fixes hold;
  PG + NATS with auth 399/0; no password in output.
- **My gate:** `bun test` 1546 pass, 1 fail = core-source drift only. Committed 9 files by path.
- **Deferred LOWs (engine's):** L1 the redacting logger can throw where log.js never does (wrap `scrub` in try/catch);
  L2 the CLI redacting logger (main.js:397) is untested, mutant survives; L3 raw `/ ? # ,` in a NATS password is
  mis-parsed (fails closed); L4 field keys not redacted.
- **From t187:** deploy/README.md lines 10, 87 and 181 are stale against main.js env handling (p8-rig4); not
  platform's file. Engine owns main.js's env contract, so engine takes it (queued with the LOWs); RIG.md is current.
- **Cleaned up:** t1km, t1m0. t1m0's scratchpad was not deleted (its rm was denied); left in place.
