# M2 commitments and state (owned by the proxy)

Every promise made to the CEO goes here the same turn. Status: OPEN, RUNNING, VERIFYING, DONE (commit), DROPPED.

## Sessions

| Role / job | Terminal | Tab label | Status |
|---|---|---|---|
| owner | t13s | owner (audits) | idle after starting the proxy |
| proxy | t14h | ★ proxy (talk here) | running |
| manager engine | t14j | manager engine | verifying: phase 1 spec (builder t14n done, verifier t14p) |
| manager platform | t14q | manager platform | running: p5-auth (builder t14s) and p8-ci (builder t14t) |
| manager client | t14k | manager client | running: phase 6 mock (builder t14m) + p6-base canvas core (builder t14r) |

## Commitments

| # | What | Status | Evidence |
|---|---|---|---|
| 1 | Phase 1 protocol v1 spec, shown to the CEO (not a gate; phase 2 starts on PASS) | VERIFYING | manager engine t14j, brief docs/m2/briefs/manager-engine.md |
| 2 | Phase 6 design mock, shown to the CEO (not a gate; phase 6 build starts on PASS) | RUNNING | manager client t14k, brief docs/m2/briefs/manager-client.md |
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
