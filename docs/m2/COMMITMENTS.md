# M2 commitments and state (owned by the proxy)

Every promise made to the CEO goes here the same turn. Status: OPEN, RUNNING, VERIFYING, DONE (commit), DROPPED.

## Sessions

| Role / job | Terminal | Tab label | Status |
|---|---|---|---|
| owner | t13s | owner (audits) | idle after starting the proxy |
| proxy | t14h | ★ proxy (talk here) | running |
| manager engine | t18m | manager engine | running (successor of t14j; handoff docs/m2/handoff/manager-engine.md, 94b1ae9): scaffold final gate t18c, v1.1 code verify t171 |
| manager platform | t187 | manager platform | running (successor of t14q; handoff docs/m2/handoff/manager-platform.md, 9266173): drawh round 3 (t185, verifier t155) |
| manager client | t14k | manager client | running: phase 6 mock verifying (verifier t14v) + p6-base canvas core (builder t14r) |

## Commitments

| # | What | Status | Evidence |
|---|---|---|---|
| 1 | Phase 1 protocol v1 spec, shown to the CEO (not a gate; phase 2 starts on PASS) | DONE 28fa91d (audited by proxy, pushed 32cc915; shown to the CEO with 3 open questions) | manager engine t14j, brief docs/m2/briefs/manager-engine.md |
| 2 | Phase 6 design mock, shown to the CEO (not a gate; phase 6 build starts on PASS) | DONE 7536d50 (round 2 PASS; shown to the CEO) | manager client t14k, brief docs/m2/briefs/manager-client.md |
| 3 | Ask the CEO for the Google OAuth client (env vars, never chat) when phase 5 starts | DONE 2026-11-11 | Web client "canvas-dev-local" in Omniping project gen-lang-client-0027800234 (consent screen already External/Testing); redirect http://localhost:8080/auth/callback; keys in .env (gitignored, 0600) via the downloaded JSON, never shown in chat |
| 5 | Hexagonal architecture enforced (boundary test) and the systems design skill used on every design-bearing job; architecture audit per track | RUNNING | OFFICE.md "Architecture"; managers told |
| 4 | drawh change is a proposal only; herdr-draw untouched without the CEO | RUNNING (fix round, 2 HIGH) | patch built (applies to herdr-draw 5dfe352, its tests 269 pass), verifier t155; goes to the CEO after PASS; needs a refresh after phase 2 |

## Decisions (reversible; the CEO may overturn)

- 2026-11-11 owner: three tracks (engine, client, platform) with disjoint ownership; platform starts after phase 3.
- 2026-11-11 proxy: managers report to the proxy by `herdr_agent prompt` to t14h plus docs/m2/reports/manager-<track>.md; managers keep their own worker rosters there, the proxy keeps this file.
- 2026-11-11 proxy: Engram was unreachable at start (name resolver error); proceeding without recall.
- 2026-11-11 proxy: highlighter, notes-as-tool and image aren't core tool ids (manager client). The mock labels them "new in web/" or "needs protocol v1"; the engine's v1 spec must say how each one travels (sent to t14j).
- 2026-11-11 proxy: an automatic security review flagged medium DOM XSS in docs/m2/design/phone.html (URL text inserted as HTML). Engine routed it to manager client (t14k); it must be fixed before the mock passes verification.
- 2026-11-11 CEO via owner (0fe5159): the CEO is never a gate; next phase starts on verifier PASS. Manager platform started now on server-independent work. Both managers told.
- 2026-11-11 proxy: Auth port shape (draft v1: async verify(token) and role(identity, board), awaited at the gateway before hello) relayed from engine to platform. If verification changes it, the proxy re-relays it.
- 2026-11-11 platform (reversible): a Workspace member's default role on a board = per-board memberRole set at POST /boards, default viewer. Store needs a create call; invites/links/grants live in a registry port (server/auth/registry.js) until engine backs it. Sent to engine for the v1 spec.
- 2026-11-11 engine: Registry becomes a named port in PROTOCOL.md (boards, tenants, invites, share links, grants; createBoard; Store.board moves to Registry.board; Store keeps log + checkpoints), shaped after platform's server/auth/registry.js. Platform keeps those method names stable. Relayed.
- 2026-11-11 proxy: platform owns the root .dockerignore and .gitignore (whole file; other tracks ask via the proxy). Reason: COPY . . was sending .git into the image, and .env* wasn't ignored.
- 2026-11-11 proxy: phase 2 waits for the spec's PASS (it implements the exact parts being fixed); the engine runs a phase-3 server scaffold in parallel so the track isn't idle.
- 2026-11-11 proxy: CI gets a read-only clone of herdr-draw (public repo) at the SOURCE.json commit as ../herdr-draw, so test/core-source.test.js compares on CI too instead of skipping. Proxy re-ran bun test after 8f89d4f: 80 pass, 0 fail (working tree, incl. other builders' uncommitted tests; manager saw 65).
- 2026-11-11 CEO via owner: reports to the CEO are actions only (credentials, spending, public, a link to look at); no status, no FYIs. In OFFICE.md.
- 2026-11-11 CEO via owner: parents close and kill finished sessions (committed job or committed hand-off) and any servers/scratch terminals they started; no done/retired tabs kept. In OFFICE.md.
- 2026-11-11 CEO via owner: sdd harnesses as helpers (verifier ensemble reviews, builder sub-tasks in worktrees, mock images, quota check first). In OFFICE.md and BRIEF-BASE.md.
- 2026-11-11 proxy: t14r (p6-base) is blocked on a pkill -f "chrome-prof" prompt (would kill by pattern). Managers and the proxy are refused, by the auto-mode classifier, from pressing keys in another session's dialog, so the CEO has to press 2 there. Then manager client steers it to kill by PID.
- 2026-11-11 proxy: Auth verify/role return null = refused (close reason: auth), throw = infrastructure error (close reason: unavailable, retryable). Platform (reversible): tenants are created by an operator in M2; share-link guests sign in with Google, no anonymous guests. Sent to engine for the spec.
- 2026-11-11 owner: every session gets plenary.reports-to=<parent id>; worker/verifier tabs name their track, e.g. `worker p2-recovery (engine): room recovery`. Running sessions relabelled and renamed by the proxy.
- 2026-11-11 proxy: no pkill/killall; kill by recorded PID; no hard-coded ports (t14r and t14v both used Chrome on 9333). In OFFICE.md. t14r and t14v are both blocked on pkill prompts; the CEO has to press 2 in both.
- 2026-11-11 proxy: sdd check_adapter: only codex works (agy quota exhausted ~70h; grok, kimi, mistral not signed in; qwen not installed). Ensembles are single-harness until the CEO signs some in (optional ask).
- 2026-11-11 proxy: MAX_VERSION_JUMP vs drawh seeding an old board (first-write exemption or an import path) sent to engine to decide in the v1 spec.
- 2026-11-11 engine: no first-write exemption from MAX_VERSION_JUMP; seeding = client-side import (version 1, fresh versionNonce, same ids). Relayed to platform for the drawh patch.
- 2026-11-11 owner refused the t14r/t14v pkill prompts and steered both to kill by PID; rule also in BRIEF-BASE.md (d2e6e5f). Manager watches checked: engine 3, client 2, platform 4 monitors armed. Client caught both blocks; what stalled was who may answer a prompt (classifier refuses send_keys for managers and proxy).
- 2026-11-11 platform: p5-auth back for a fix round (an invite could be claimed by a consumer account with a stale verified third-party email). Rule: trust an email only where Google is authoritative (@gmail.com, or email_verified + hd). Sent to engine for § Tenancy.
- 2026-11-11 client: mock verifier FAIL (HIGH: viewer view showed durable writes; MEDIUM: read-only write controls live, note authors tagged v0, phone docks missing buttons). Fix round 1 in t14m; t14v re-checks.
- 2026-11-11 client: p6-base built (gate passes: refused op + resync leaves Editor == Replica; bun test 143/143); verifier t15h. Seam: Editor.livePut bumps the version per pointer move, so a long drag passes MAX_VERSION_JUMP. Sent to engine to decide (client normalize / jump rule / core change, the last needing the CEO).
- 2026-11-11 engine: version seam = Option A (Replica.local() normalizes to highest known + 1, fresh nonce; drag previews are presence; core untouched). Client Replica asks in phase 2. A since-0 resync = close and reconnect. Relayed to client.
- 2026-11-11 proxy: phase 1 audit: re-verifier PASS (docs/m2/reports/p1-specv2.md), bun test 143/0; pushed main to origin (32cc915). Phase 2 (t15q) and p1-seam (t15r) running. p5-auth DONE 91fb274. README uses a neutral placeholder name (CLAUDE.md: name stays in CLAUDE.md and package.json until settled).
- 2026-11-11 proxy: first GitHub Actions run green (run 43119353172, commit 32cc915).
- 2026-11-11 owner (2f29f47): sessions start via zsh -lic so Engram env loads; managers told.
- 2026-11-11 proxy: start command pins --model opus --permission-mode auto (t15y came up as Fable 5.2 in manual mode under zsh -lic); OFFICE.md b8bce5b.
- 2026-11-11 engine: p1-seam written, verifier t165. Three p5-auth code gaps (null-vs-throw in port.js, hd must equal email domain, setGrant last-owner/owner-grant) sent to platform as job p5-fix.
- 2026-11-11 platform (reversible): authoritative email = hd equal to the email domain or @gmail.com; secondary-domain Workspace users claim access via the hd member role or share links, not email invites. Last-owner check moves into the Registry contract (atomic in SQL).
- 2026-11-11 engine: p3-scaffold FAIL on 1 HIGH (deeply nested valid ops stall the process ~2 s per join); fix = gateway depth limit 64 + spec § Limits + opProblem in phase 2. Proxy: engine owns the durable SQLite/Postgres Registry adapter (server/), against platform's contract and a shared contract test; platform sets HOST=0.0.0.0 in deploy/.
- 2026-11-11 platform (reversible, proxy agrees): the CLAUDE.md name rule covers prose and branding, not code identifiers (PLENARY_DATA_DIR, PLENARY_DEV_TOKENS, PROTOCOL.md title). README prose keeps PROJECT_NAME. If the name changes, renaming env vars is mechanical. Shared registry contract test: test/auth/registry-contract.js (registryContract(name, makeRegistry)).
- 2026-11-11 client: p6-base FAIL, 3 HIGH in web/sync.js (edit during resync dead at v1; Escape mid-drag leaves the Editor ahead of the Replica; the gate ignored tombstones and versions). Fix round in t14r; phase 2 told to cover both in the Replica. Core livePut/cancel is the root cause of H2: worked around, no herdr-draw change asked.
- 2026-11-11 engine: p1-seam DONE 7e834d2 (verifier PASS); spec carries every relayed item. Pushed.
- 2026-11-11 platform: p8-deploy DONE 2225ff1 (HOST=0.0.0.0, real entry/health, restart policy; verifier PASS; bun test 245/0; never built in Docker). drawh proposal in fix round (2 HIGH). README parked until server/ and web/ are committed.
- 2026-11-11 platform: p5-fix DONE 4e16752 (verifier PASS vs spec 7e834d2; bun test 254/0). Small follow-up on 2 older MEDIUMs (createBoard ownerless-board report, gmail email_verified wording).
- 2026-11-11 engine: SQLite Registry DONE f2eb88b (verifier PASS; bun test 254/0). Scaffold fix round done; t14z wiring the Registry into main.js with a restart test, then re-verify.
- 2026-11-11 client: drag previews through the server pause (gateway refuses v0 transient ops) until p6-sync2 moves them to v1 presence after phase 2; engine pings client directly when it lands.
- 2026-11-11 proxy: phase 2 lands as one green commit from branch p2-land (worktree ../plenary-p2) with engine seam swaps and client p6-sync2 (web/sync.js); p6-base commits on main first. Engine merges; proxy audits before push.
- 2026-11-11 client: p6-base DONE f1886d5 (round 2 PASS; bun test 263/263). p6-ui built, verifier t172. p6-sync2 waits for engine's rebased p2-land worktree.
- 2026-11-11 platform: p8-cluster-env built (verifier t174). Proposed cluster env names sent to engine to confirm, plus a role switch (PLAN phase 4 separates gateways and room hosts). Dev blob store is pgsty/minio (pinned community fork, AGPL-3.0), referenced by image only and swappable (service name blobs).
- 2026-11-11 engine: phase 2 verifier PASS on p2-land (docs/m2/reports/p2-recoveryv.md; 6,000 convergence runs with restarts, no HIGH/MEDIUM); lands with the seam swaps and p6-sync2. Scaffold commit held until the flaky seed-2 convergence test is root-caused.
- 2026-11-11 platform: p8-cluster-env DONE 33b4cd8 (cluster compose: Postgres, NATS 2 MB, blobs, 3 nodes with PLENARY_ROLES, Caddy to the gateways; CI Postgres + NATS services; verifier PASS; bun test 263). Never run in Docker. Engine told the env is ready for phase 4.
- 2026-11-11 proxy: CI run 43126348872 green on GitHub, including the new test-cluster-services job (Postgres + NATS services start).
- 2026-11-11 client: p6-ui DONE 3c32a5f (p6-uiv PASS; no forbidden writes from any role; 5 tabs converge; MEDIUM: draft lost if the connection drops mid-edit). Next: p6-land in the p2-land worktree (sync wiring, p6-ui fixes, the MEDIUM), sequential on purpose; phase 7 brief drafted for the p2-land merge.
- 2026-11-11 engine: scaffold re-verify FAIL, 1 HIGH (catch-up sent as one frame; ~280 legal 1 MB note rewrites make a board unjoinable; non-reading viewers pin memory). Fix in t14z: streamed bounded catch-up with backpressure, buffer budget, per-user connection cap. Flaky test = rig.js timing, fixed with a 50x stability run.
- 2026-11-11 engine: phase-4 adapters started in parallel: p4-pg t17d (Postgres Store + Registry, atomic last-owner) and p4-natss3 t17f (NATS Bus + S3 Blobs; adds one NATS client dependency, pinned in bun.lock). Engine allowed brew install postgresql@17 nats-server on this Mac for local tests (servers run by PID, no brew services).
- 2026-11-11 platform (reversible): drawh seeding renumbers only elements the room would refuse (absent and version > 1,000), not all of them, to avoid silent overwrites from open Herdr panes. Sent to engine to confirm. drawh lost saves 0/4,541. p5-http PASS, MEDIUM in a fix round.
- 2026-11-11 platform: p5-http DONE 4fad32a (httpRoutes; verifier PASS; bun test 315/0). Engine wires it into main.js in p2-swap. Client told about #token= in the post-login URL.
- 2026-11-11 client: p6-sync2 FAIL when merged with p6-ui (a SharedWorker tab stuck "Connecting…" after a resync; a waiting edit lost on reload). Decision (reversible): one transport contract (reopen() required and drops the old connection; close() = finished; a resync never calls close()). p6-land t17s fixes it, plus previewsOf/connectionFailed, drafts across drops, #token=. Engine fixing restamp() (round 4). Landing blocked until p6-land passes.
- 2026-11-11 platform: p8-deps DONE 723f6c6 (after engine lockfile 0d40b86); image installs bun.lock frozen; CI S3 store with throwaway values.
- 2026-11-11 engine: scaffold round 3 FAIL, 2 HIGH (a since-0 catch-up over the 64 MiB per-user budget is always refused; a kill -9 test flake at a count boundary). Fix round 3 in t14z. The scaffold is the single blocker: phase 2 (verified on p2-land), Postgres and NATS/S3 adapters (verified) all wait on it.
- 2026-11-11 platform: p5-flake DONE c0ff386 (the replay-guard test counts pruner visits; 100/100 under load).
- 2026-11-11 platform: drawh re-check 2 FAIL (settings have no version, so a stale save and a revert are indistinguishable); round 3 (the last) with a fresh builder; t14y retired. Sent to engine: settings version/base, and a room identity in welcome. README PASS stale; refresh after p2-swap. Platform manager handing off at 52%.
- 2026-11-11 proxy: platform manager t14q handed off to t187 (9266173); t14q closed and removed. Engine scheduled the drawh asks as p1-v11 (t186): settings compare-and-set on a per-key base appSeq with a soft refusal; welcome carries room {board, epoch}.
- 2026-11-11 engine: protocol v1.1 spec verified and committed on p2-land cb343b9 (settings CAS appBase, welcome room {board, epoch}, plus queued items). v1.1 code and drawh appBase land together after the phase 2 merge. Scaffold round 4 in progress (one timing-dependent test failed 2 of 20 runs).
- 2026-11-11 engine: scaffold round 4 FAIL (two timing-dependent tests, 8/20 full runs; a snapshot over Bun backpressureLimit is dropped silently). t14z retired (handoff 346ccd9); fresh builder p3-fix4 t18c, bar 20/20 full runs. p11-proto t18b writing the v1.1 code on p2-land. Platform told about its 5 s timeout under load.
- 2026-11-11 platform: p5-slow DONE 061ef4c (replay-guard test sized down, 30 s timeout; 150/150 under load). Caveat: one heavy-load full run had 2 uncaptured failures.
- 2026-11-11 engine: p-arch (test/architecture.test.js, a static boundary check; current violations go in a shrink-only allowlist, each one a fix job) starts after t18c's gate; the architecture audit of server/ and packages/protocol runs after phase 2 lands.
- 2026-11-11 client: hexagonal plan: p6-hex (web/core, web/ports with contract tests, web/adapters, web/main.js as the only root; no behaviour change), then p7-wire on that shape, then a web/ audit. Boundary-test ownership being settled with engine.
- 2026-11-11 platform: auth/admin audit found 1 real violation (the SQLite/Postgres Registry adapters import mint from the in-memory adapter), plus type-only Identity imports from oidc.js and an unwritten IdP port. p5-hex (t18k) fixes them; engine agreed to platform editing the 3 import lines in its adapter files (a named seam exception).
- 2026-11-11 platform: drawh re-check 3 FAIL, 1 narrow HIGH (rapid toggles drop the third); round 3b with a hard stop (another HIGH ships the scope cut). Proxy agreed.
- 2026-11-11 proxy: engine manager t14j handed off to t18m (94b1ae9); t14j closed and removed; engine workers relabelled reports-to=t18m.
- 2026-11-11 engine: protocol v1.1 code committed on p2-land 5d55112 (p11-protov PASS round 4; bun test 398/0); lands with the phase-2 merge.
- 2026-11-11 platform: p5-google t18p builds a live check up to Google's sign-in page (skipped by default) and ends with human-login steps for the CEO. Note: Bun auto-loads .env, so engine tests must pass explicit env.
