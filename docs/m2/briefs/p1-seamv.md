# Brief: p1-seamv (verify the protocol v1 follow-up)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, then `git diff -- PROTOCOL.md` (the job; base is commit 28fa91d, which passed verification). **Do not
read docs/m2/reports/p1-seam.md** (the builder's claims).

- **Your tab:** `verifier p1-seamv (engine): protocol v1 follow-up`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p1-seamv.md only. Everything else is read-only.
- **Scratch** outside the repo (`mktemp -d`). Never `pkill`/`killall`; port 0 for anything you start.
- **sdd ensemble:** load `sdd:subagent-driven-development`, check usage, run codex over the diff. Today codex is the
  only harness (agy out of quota, others not signed in): label it "single harness"; its findings are leads to
  confirm or refute.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings (where, failure scenario, fix). Then stop, idle.

## The job: fold these decided items into PROTOCOL.md (check each is there, correct, and consistent)

1. § Auth: `verify`/`role` resolving `null` = refused (`auth`); a throw = infrastructure error (`unavailable`, retry).
2. § Tenancy: tenants created by an operator in M2 (no auto-create on first sign-in); share-link guests sign in
   with Google (no anonymous guests); a Workspace member's role includes the board's `memberRole`, default viewer.
3. § Tenancy: "authoritative email" = `@gmail.com`, or `email_verified` plus `hd` equal to the email's domain.
4. Seeding from a local file: no first-write exemption from the 1,000 version-jump cap; client-side import rewrites
   version to 1, fresh `versionNonce`, ids kept.
5. `Replica.local()` normalizes on send: version = (highest known for that id, confirmed or pending) + 1, fresh nonce.
6. Rule 5: a since-0 resync closes and reconnects. Phase-2 list: `receive()` returns what it applied; `reset()`
   keeps pending ops overlaid.
7. Pacing: the client paces every send (resends too); over-rate is backpressure (gateway queues; past the cap it
   closes, ops stay pending), never a refusal; rate per user per board; `limit` for content caps only; a resend
   of an accepted op is answered before any limit.
8. A room answers `unavailable` to ops from a connection it didn't welcome in this incarnation; gateway sends close
   notices; the room drops `n` state (and all of a silent gateway's after a stated time).
9. A refusal on `records` only drops that op from the pending overlay (no reset); no-op record actions are
   accepted, logged and acked.
10. The round-2 verifier's findings in docs/m2/reports/p1-specv2.md (M1–M8, L1–L17, codex leads): check each is
    closed in the text, not just mentioned.
11. Only tenant admins may grant `owner`.
12. § Registry: at least one owner per board; last-owner check and change atomic (transaction / conditional delete).

## Hunt for

- Regressions of what 28fa91d guaranteed: an op logged twice, an acked op lost, an ack/welcome/checkpoint from
  speculative state, cross-tenant reads, presence saved, a room seeing an unauthenticated hello. Re-run the round-2
  verifier's op-id model idea against the new pacing, held-refusal and `unavailable`-on-unknown-connection rules.
- New contradictions between sections (the spec grew from 461 to 630 lines).
- Is the "What phase 2 changes" list still accurate against packages/protocol/*.js, and buildable?
- Done when: every item above is reflected, each rule says what is guaranteed and what may drop, `bun test` passes.

## The builder's not-verified list and risks (check these)

- No v1 code exists; all argued from text. NATS `max_payload` 2 MB asked for, not checked against NATS limits.
- Numbers (queue cap, 5 s / 30 s liveness, backoff, blob rates, `here` cap) reasoned, not measured.
- `fileId` assumed SHA-1 hex (40-hex rule); if core mints other ids, they'd be refused (check packages/core).
- Held refusals delay a refusal by up to one append. A user on G gateways gets G × the op rate.
