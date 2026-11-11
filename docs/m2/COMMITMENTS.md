# M2 commitments and state (owned by the proxy)

Every promise made to the CEO goes here the same turn. Status: OPEN, RUNNING, VERIFYING, DONE (commit), DROPPED.

## Sessions

| Role / job | Terminal | Tab label | Status |
|---|---|---|---|
| owner | t13s | owner (audits) | idle after starting the proxy |
| proxy | t14h | ★ proxy (talk here) | running |
| manager engine | t14j | manager engine | p1 spec fixed, re-verifying (verifier t151); p3 server scaffold builder t14z running |
| manager platform | t14q | manager platform | running: p5-auth (builder t14s), p8-ci DONE 8f89d4f; p5-auth verifying (t153), p8-ign verifying (t152); drawh proposal (builder t14y) |
| manager client | t14k | manager client | running: phase 6 mock verifying (verifier t14v) + p6-base canvas core (builder t14r) |

## Commitments

| # | What | Status | Evidence |
|---|---|---|---|
| 1 | Phase 1 protocol v1 spec, shown to the CEO (not a gate; phase 2 starts on PASS) | RUNNING (fix round) | manager engine t14j, brief docs/m2/briefs/manager-engine.md |
| 2 | Phase 6 design mock, shown to the CEO (not a gate; phase 6 build starts on PASS) | VERIFYING | manager client t14k, brief docs/m2/briefs/manager-client.md |
| 3 | Ask the CEO for the Google OAuth client (env vars, never chat) when phase 5 starts | OPEN | |
| 4 | drawh change is a proposal only; herdr-draw untouched without the CEO | OPEN | |

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
