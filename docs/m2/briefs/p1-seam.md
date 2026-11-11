# Brief: p1-seam (protocol v1 follow-up: decided items and round-2 findings)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (v1, committed 28fa91d),
docs/m2/reports/p1-specv2.md (round-2 verifier: 8 MEDIUM, 17 LOW, codex leads), and the "Queued spec edits" and
"Manager decisions" bullets in docs/m2/reports/manager-engine.md (read-only). For Auth and Registry, read
server/auth/port.js, registry.js, tenancy.js, oidc.js (read-only; platform owns them).

- **Your tab:** `worker p1-seam (engine): protocol v1 follow-up`. Manager: `manager engine`, terminal `t14j`.
- **You own:** PROTOCOL.md only. A phase-2 builder is implementing the spec in packages/protocol at the same
  time: keep section names and message/field names stable unless a decision below changes them, and list every
  rename at the top of your report.
- **Report:** docs/m2/reports/p1-seam.md (each item: what changed, where). Then stop, idle. Don't commit.

## Fold in (decided; write them as rules, don't re-decide)

1. **§ Auth errors:** `verify`/`role` resolving `null` = refused (close reason `auth`); a throw = infrastructure
   error (gateway answers `unavailable`; the client may retry).
2. **§ Tenancy:** tenants are created by an operator in M2 (a first sign-in from a domain never creates one);
   share-link guests sign in with Google (no anonymous guests). A Workspace member's role includes the board's
   `memberRole` (already there; keep).
3. **§ Tenancy, invite matching:** an email is trusted only where Google is authoritative for it: `@gmail.com`,
   or `email_verified` plus an `hd` claim equal to the email's domain.
4. **Seeding from a local file** (drawh): no first-write exemption from the 1,000 version-jump cap (an absent
   element counts as version 0). Seeding is a client-side import: version rewritten to 1, fresh `versionNonce`,
   ids kept. No new message.
5. **Normalize on send:** `Replica.local()` sets each outgoing element's `version` to (highest version the
   replica knows for that id, confirmed or pending) + 1 with a fresh `versionNonce`, so long drags never trip the
   cap. Update the phase-2 list.
6. **Rule 5:** a since-0 resync closes and reconnects (one hello per connection). Phase-2 list: `Replica.receive()`
   returns what it applied; `Replica.reset()` keeps pending ops overlaid.
7. **M1:** the client paces every send, resends included, to the published rate. Over-rate is backpressure, never
   a refusal: the gateway queues; past its queue cap it closes the connection (ops stay pending; reconnect). The
   rate is per user per board. `limit` stays for content caps only. A resend of an accepted op is answered before
   any limit.
8. **M2:** a room answers `unavailable` to any op from a connection it did not welcome in this incarnation; the
   gateway sends the room a close message for each connection; the room drops that connection's `n` state (and
   drops all `n` state for a gateway it hasn't heard from in a stated time).
9. **M5:** a refusal on `records` only removes that op from the pending overlay (no reset, no resync). No-op
   record actions (repeat resolve/react, dead target) are accepted, logged and acked.
10. **The other round-2 findings** (M3, M4, M6, M7, M8, all LOWs, codex leads): fix each in the text using the
    verifier's suggested fix unless it conflicts with 1–9; where you choose differently, say why in the report.
    Anything that is the CEO's call goes in "Open questions for the CEO", not decided.

## Done when

- Every item above is reflected in PROTOCOL.md (including the phase-2 change list and its tests), and each rule says
  what is guaranteed and what may drop.
- `bun test` passes. Report written.

## Process rules

- Never `pkill`/`killall`; port 0 for anything you start. sdd helpers per BRIEF-BASE (optional for a spec job).

## Added while running (sent to the builder by prompt)

11. § Tenancy: the term "authoritative email" for item 3's rule; only tenant admins may grant `owner`.
12. § Registry: at least one owner per board; the last-owner check and the removal/demotion are atomic (one
    transaction or a conditional delete). Durable Registry adapters (phase 3/4) must honour it.
