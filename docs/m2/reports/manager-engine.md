# Report: manager engine

Manager terminal: `t14j` (tab `manager engine`). Parent: proxy `t14h`.

## Workers

| Job | Terminal | Tab | Status |
|---|---|---|---|
| p1-spec (builder) | t14n | worker p1-spec: protocol v1 spec | reported, idle |
| p1-specv (verifier) | t14p | done p1-specv | FAIL reported, idle |
| p1-spec fix round | t14n | worker p1-spec: protocol v1 spec | reported, idle |
| p1-specv2 (re-verifier) | t151 | verifier p1-specv2: protocol v1 spec, round 2 | RUNNING |
| p3-scaffold (builder) | t14z | done p3-scaffold (engine) | reported (128 tests pass), idle |
| p3-scaffoldv (verifier) | t158 | verifier p3-scaffoldv (engine): server scaffold | RUNNING |

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
