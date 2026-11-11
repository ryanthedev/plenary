# Report: p1-spec (protocol v1 spec)

2026-11-11. Outcome: PROTOCOL.md rewritten as v1 (362 lines), covering brief items 1–9 plus the manager's three
additions. `bun test`: 29 pass, 0 fail (no code touched). Not committed.

## What changed

- **File:** PROTOCOL.md only. (docs/m2/COMMITMENTS.md shows as modified in the tree; not by me.)
- **Sections:** what changed from v0 (table), streams + how each tool travels, element op, messages, rules 1–10,
  Recovery, Op ids, Presence, Records, Tenancy, Ports (Auth, Store, Bus, Blobs), known limits, phase 2 change
  list (per file + tests), open questions.

| Brief item | Where | Key decision |
|---|---|---|
| 1 Restart recovery | § Recovery | Room state is a pure function of the log; one `applyEntry` for live and replay; **checkpoint** (Store, has op-id + note-author tables) vs **snapshot** (wire, doesn't); checkpoint every 1,000 entries; append failure/timeout → stop, rebuild from Store, never reuse a seq |
| 2 Bounded op-id table | § Op ids | Per (user, client): `high`, `last`, `recent` ≤ 256 pairs. Below the window → `stale` refusal, never ack (seq unknown; an ack can't guess). Whole clients evicted when idle > H = 100,000 entries, decided by seq only (replay-deterministic); `welcome` carries `high` + `horizon` so a forgotten client drops ops it already sent. Note authors bounded by a 200,000 notes-element cap and outlive tombstones |
| 3 Presence | § Presence | Replaces v0 `transient` (it burned op counters and went through the sequencer). cursor, select, laser, preview, emote, leave; rates; thinning; relayed by gateways over the bus, never touches the room |
| 4 Comments, reactions | § Records | Third stream `records`, same seq/log/ack/dedupe; actions thread/reply/edit/delete/resolve/reopen/move/react; reactions are set/unset (`on: bool`), keyed by (comment, user, emoji); viewers write nothing durable |
| 5 Tenancy | § Tenancy | Tenant from the board; role per board (so invited guests from other domains work — v0 rule 6 "token from another tenant refused" is replaced) |
| 6 Ports | § Ports | All async; Store `append(…, expectSeq)` conditional = storage-level fencing; Bus at-most-once with seq gap repair from Store; Blobs (tenant, sha1), 10 MB, hash-verified, no SVG; Auth awaited by the gateway before the room sees anything |
| 7 M2 decisions | rules 1, 8, 9, 10, intro | kept |
| 8 Phase 2 list | § What phase 2 changes | per file + tests, incl. the two existing tests that change |
| 9 Open questions | end | three, below |

### Manager additions (from t14j, folded in)

- **Unknown board:** rule 7 — refused with `auth`, same error as no role (no existence leak); only `POST /boards` creates.
- **Sequencer fencing at storage:** § Store — conditional append on `expectSeq` (unique `(tenant, board, seq)`);
  leases (phase 4) decide who should sequence, the conditional append ensures only one can.
- **Tools:** § "How each tool travels" — highlighter = durable `freedraw` element in `notes` (preview while drawing);
  laser = presence only; notes = `notes` stream elements; image = element with `fileId` → Blobs.

## How I checked it

- Read v0 PROTOCOL.md, packages/protocol/*.js, test/world.js and the tests; checked the op-id rule against
  world.js (client → room is ordered, which rule 6 now states as a requirement) and Replica.settle / rule-7 path.
- Took an advisor review before writing and addressed its points (determinism of eviction, unbounded client count,
  transient counters, checkpoint vs snapshot, append timeout, same error for unknown board).
- A second advisor review after the first draft found five holes, all fixed in PROTOCOL.md:
  - **Settling by entry id alone** let another user reusing my client string settle my op; rule 4 now also needs `by` = me.
  - **Forgotten-client rule** could double-log (entry arrived inside a snapshot, no ids) or drop never-logged ops of
    a new client; now each pending op keeps `sentAt`, new ops wait for catch-up to `welcome.seq`, and the drop test
    is `high = 0 and sentAt < horizon`.
  - **Bus subjects** could collide (domains have dots); tenant/board ids are now server-minted `[a-z0-9-]`.
  - **Blobs over `Authorization: Bearer`** broke "token never in a header"; replaced by signed URLs asked for over
    the socket (`blob` message).
  - **Phase-2 list** gaps: presence relay moved to phase 3 (unit tests only in phase 2), `compact()` → `checkpoint()`,
    `protocol.test.js` "no hello…" and `test/world.js` listed as changing.
  - Also added: checkpoints keep the highest seq; dead comment targets refused; previews not ownership-checked.
- `bun test` before and after: 29 pass.

## What I did NOT verify

- No code or test exercises v1; every rule is on paper until phase 2.
- The op-id argument (n ≤ high ⇒ the op arrived earlier) rests on rule 6 per-client ordering end to end,
  including the gateway → room hop in cluster mode. Not tested anywhere yet.
- Numbers (W = 256, H = 100,000, rates, caps, 50 ms batches, checkpoint every 1,000) are reasoned, not measured.
- Engram (memory service) was unreachable (`name resolver error`), so no past-session recall; nothing written to it.

## Risks

- **Forgotten-client rule drops sent-but-unacked ops** on a client out for > H entries; logged-or-not is shown by
  resync, but an unlogged one is lost. Rare, and never a double log.
- **Replica must wait for `welcome` before resending** (one extra round trip on reconnect).
- **Commenter narrowed** to records only; nothing tests commenter today, but the client track may assume v0.
- **Blob reads tenant-wide by hash** (known limit). Signed blob URLs from Herdr's runtime are untested.
- **New ops wait for catch-up** to `welcome.seq` (rule 2): on a big board a reconnecting editor's fresh edits
  queue until catch-up lands. Measured nowhere yet.
- Records apply in seq order with room-side validation; replay assumes the validator never changes meaning
  between versions (a future check that refuses old valid entries would break replay — keep checks out of
  `applyEntry`).

## Open questions (CEO)

1. Durable reactions by viewers? Spec says no (emotes only).
2. Commenter = comments/reactions only (not notes)?
3. Blob reads: tenant-wide by hash OK, or per board?

## Fix round (2026-11-11, after verifier FAIL in docs/m2/reports/p1-specv.md)

PROTOCOL.md rewritten in one pass (now 461 lines). `bun test`: 65 pass, 0 fail (29 → 65 because other tracks added test files, e.g. test/auth; none mine). Still only PROTOCOL.md and this
report touched; not committed.

| Finding | Fix in PROTOCOL.md |
|---|---|
| **H1** forgotten-client double log (eviction between welcome and resend; retry on a live connection) | `op` carries `sentAt`; the **room** answers `stale` when it has no record for (user, client) and `sentAt` < `horizon` (§ Op ids, first row). Rule 2: resend only right after `welcome`, never on a live connection; no answer in 10 s → close and reconnect. Client-side drop kept as an optimisation |
| **H2** group commit: in-flight entries leaking into acks, welcome, checkpoints | § Recovery "Resolved vs speculative": checks run on speculative state; a dedupe hit on an in-flight entry waits for that append; `welcome.seq`, `high`, catch-up, snapshots, checkpoints, broadcasts from resolved only; on conflict/failure/timeout drop speculative and rebuild. Checkpoints store entry S's `id` + `at`; rebuild checks them against log entry S (and S ≤ log end), else uses the previous checkpoint (`getCheckpoint(…, beforeSeq)`) |
| M1 rule 6 over a lossy hop | gateway numbers each connection's messages (`n`); room answers `unavailable` and drops the connection on a gap; lost replies caught by rule 2's timeout |
| M2 rule 5 dropped ops on `unavailable` | error table: refusals = `forbidden`, `bad-op`, `no-files`, `too-large`, `limit`; `unavailable`/`auth` keep pending ops and reconnect |
| M3 lost last entry on a quiet board | room heartbeat `{seq}` on `.entries` every 2 s; gateway subscribes before forwarding a hello or serving catch-up |
| M4 no bound on durable writes | new § Limits: 20 ops/s per connection (burst 100), element and byte caps per stream, 20 MB records, blob quota per tenant; uploads only for `board`/`notes` writers; checkpoint cadence tied to checkpoint size |
| M5 `records` in `STREAMS` breaks Doc loops | `ELEMENT_STREAMS` split from `STREAMS` in § Streams and every phase-2 row |
| M6 viewers' catch-up on the sequencer | rule 8: viewers' hellos are served by gateways (welcome without `high`, catch-up from tail/Store/checkpoint snapshot), never reach the room |
| M7 silent drop of unconfirmed ops | UI shows "n changes could not be confirmed" after the resync |
| L1 tests-that-change list incomplete | added `protocol.test.js` compact() / raw ids `c0:f…`, `holes.test.js:85`, `convergence.test.js` compact(); order of checks stated (shape before id) |
| L2 version handling | unknown `v` → new `version` error, closed; `PROTOCOL_VERSION` in envelope.js; replica sends `v: 1`; version test |
| L3 purity test substrings | phase-2 section warns about `window`/`process`/`document` in identifiers |
| L4 snapshot lacks note authors | snapshot now carries `noteAuthor` |
| L5 inbox subject, global board ids | `.inbox` named; board ids globally unique (`b-` + 16) |
| L6 before welcome, second hello | rule 11: presence dropped, ops get `auth`; second hello → `bad-op`, closed |
| L7 emote sums across gateways | each gateway publishes per-window counts on `.emotes`; every gateway sums all |
| L8 tableAuth in wrong row | moved to `ports.js` |
| L9 replay assumes fixed rules | `rv` (rules version) on every entry and checkpoint |
| L10 SHA-1 first put wins | Known limits, with the SHA-256 option |

Seam additions (from platform via the manager):

- **Registry port** named in § Ports, method names matched to server/auth/registry.js (`createTenant`,
  `tenantByDomain`, `createBoard`, `board`, `setGrant`/`grant`/`grants`, invites, links, `addLinkUse`/`linkUses`).
  `Store.board` removed; Store keeps the log and checkpoints only.
- **memberRole rule** in § Tenancy: a Workspace member's role on a board includes that board's `memberRole`, set at
  `POST /boards`, default `viewer`; the highest of grant, invite, redeemed link and memberRole wins (matches
  server/auth/tenancy.js).

### Not verified in the fix round

- Still paper only: no code exercises resolved/speculative state, the room-side `sentAt` check, or `n` gaps.
- I did not re-run the verifier's scratch model against the new rules.
- New numbers (20 ops/s, byte caps, 2 s heartbeat, 10 s timeout, half-size checkpoint cadence) are reasoned, not measured.
- **New risk:** the 10 s no-answer timeout forces a reconnect; a long group commit or a slow Store under load could
  cause reconnect storms. Phase 3 should measure append latency against it.
