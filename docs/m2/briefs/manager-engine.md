# Brief: manager engine

Base: docs/m2/BRIEF-BASE.md applies, except you are a manager: you direct builders and verifiers, you don't
build. Read docs/m2/OFFICE.md, docs/m2/PLAN.md, docs/m2/COMMITMENTS.md, CLAUDE.md and PROTOCOL.md first.

- **Your tab:** `manager engine`. Labels: `herdr.space=sp21a427967d02459948b4c10156ff82ae`, `plenary=manager-engine`.
- **Your parent:** the proxy (terminal id in COMMITMENTS.md). **Never type into the proxy's input** (no
  `herdr_agent prompt`, `hc send` or SendMessage to it; CEO, 2026-11-12: that input is the CEO's). Report by ending
  your turn with one short message (outcome first, path to the report; the proxy's watch delivers it) and in docs/m2/reports/manager-engine.md (append a dated section
  per phase).
- **Track (PLAN.md):** engine. You own PROTOCOL.md, packages/protocol/, server/ (except server/auth,
  server/admin), test/ (except test/web, test/auth). Phases 1, 2, 3, 4 and the load-test half of 8. The engine
  track owns every protocol message, including comments, reactions and presence; the client consumes them.

## Job now: phase 1, protocol v1 spec (PROTOCOL.md)

Goal (CEO's words via PLAN.md): restart recovery (snapshot + log replay; op-id and note-author tables in
snapshots; op-id table bounded per client), presence channel (cursors, selections, laser, emotes; never logged,
may drop), comments (threads anchored to element or point, replies, resolve) and reactions as durable records,
tenancy, ports: Store, Bus, Blobs, async Auth (verified before a room sees hello).

1. Write docs/m2/briefs/p1-spec.md (BRIEF-BASE + the job) and start a builder `worker p1-spec: protocol v1 spec`.
   It owns PROTOCOL.md only (spec, no code in phase 1). It must also say what in packages/protocol phase 2 will
   change, so phase 2 can be briefed from the spec. Keep the M2 decisions in CLAUDE.md (one sequencer per board,
   acked op never lost, presence never saved, token in hello not a header, server never runs layout).
2. When it reports, start a separate verifier `verifier p1-specv: protocol v1 spec` per OFFICE.md (goal,
   done-when, `git diff`, the builder's not-verified list and risks only). It checks the spec for holes
   (ordering, idempotent resend across restart, unbounded tables, cross-tenant leaks, presence never persisted,
   auth before hello reaches a room) and that the existing `bun test` still passes.
3. HIGH findings go back to a builder. When the verifier says PASS: re-run `bun test` yourself, commit PROTOCOL.md
   (and the reports) by path, and report to the proxy. **Stop there:** the CEO reviews the spec before any phase 2
   code. Do not start phase 2 until the proxy tells you.

## Rules

- Start sessions exactly as OFFICE.md "Starting a session" shows; rename each tab right away; record each worker
  in docs/m2/reports/manager-engine.md (terminal id, tab, status). The proxy keeps COMMITMENTS.md, not you.
- Watch your workers (`herdr_agent watch` into Monitor, re-arm on expiry); unstick per OFFICE.md.
- Never push. Never touch files outside your track. Escalate CEO-only decisions to the proxy, never to the CEO.
- Hand off at ~60% context (OFFICE.md, Recycling): docs/m2/handoff/manager-engine.md.
