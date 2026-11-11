# Report: p1-seam (protocol v1 follow-up)

**Done: all 12 decided items and every round-2 finding are in PROTOCOL.md.** Only PROTOCOL.md changed. `bun test`:
143 pass, 0 fail (no code changed, so this only shows nothing else broke). Not committed.

## Renames and additions (phase-2 builder: read this first)

**No section, message or field was renamed.** These were added:

| What | Where | Why |
|---|---|---|
| `welcome.rv` | § Messages | L9: a client must know the room's rules version before the first entry |
| `name?` on `records` entries; `name` on threads, comments, `resolved` | § Messages, § Records | M8 |
| hello context `{user, name, role, client}` (was `{user, role, client}`); `tableAuth` returns `{user, name, role}` | rule 8, § Auth, § Bus, phase-2 list | M8 |
| checkpoint field `by` (next to `seq`, `id`, `at`) | § Recovery | L8 |
| `here.writerCount`; `here.writers` capped at 50 | § Messages, § Presence | L14 |
| rules 12 (timeouts, backoff) and 13 (pending ops belong to a user) | § Rules | M3, L13. Rules 1–11 keep their numbers |
| new subsection "Pacing (the op rate)" under § Limits | § Limits | item 7 |
| bus subjects `.gw.<gateway>` and `.here`; inbox messages `{…, closed: true}` and `{ gateway, conns }` | § Bus | M3, L14, item 8 (phase 3; not phase 2) |
| the room answers a writer's hello with `welcome` only; the gateway serves catch-up | rules 3 and 8 | M3. **Phase 2's Room still sends welcome + catch-up itself** (stated in the phase-2 section), so world.js needs no gateway |

## Decided items (brief 1–9, manager's 11–12)

| # | What changed | Where |
|---|---|---|
| 1 | `null` = refused (`auth`, closed); a throw = infrastructure error (`unavailable`, client retries with backoff, no new sign-in). Same split for `Registry.board` | § Auth "Auth errors"; error table |
| 2 | Tenants are made by an operator; first sign-in never creates one. Share-link guests sign in with Google; no anonymous guests. `memberRole` rule kept | § Tenancy, first bullets |
| 3, 11 | "Authoritative email" defined (`@gmail.com`, or `email_verified` + `hd` equal to the email's domain) and used for invite matching. Only a tenant admin may grant `owner` after creation; invites, links and `memberRole` never give it | § Tenancy |
| 4 | No first-write exemption (absent = version 0). Seeding = client-side import, version 1, fresh nonce, ids kept, no new message | § The element op |
| 5 | `Replica.local()` normalizes on send (highest known, confirmed or pending, + 1; fresh nonce) | § The element op; phase-2 replica row; test "normalize on send" |
| 6 | A since-0 resync closes and reconnects. `receive()` returns what it applied; `reset()` keeps pending ops overlaid | rule 5; § Op ids (stale); phase-2 replica row; test "resync" |
| 7 | Client paces every send, resends included (20/s, burst 100). Gateway queues over-rate ops per (user, board); past 500 ops or 8 MB per connection it answers `unavailable` and closes. `limit` = content caps only. Resend of an accepted op gets its ack before any limit | § Limits and § Pacing; rule 2; error table; test "pacing" |
| 8 | `unavailable` for any op from a connection not welcomed in this incarnation; close notice per connection; connection list every 5 s; all `n` state of a gateway silent 30 s is dropped | rule 6; § Bus; phase-2 room row; test "unknown connection" |
| 9 | A `records` refusal only leaves the pending overlay. Repeats and dead targets are accepted, logged, acked, and change nothing | rule 5; § Records; error table; test "records" |
| 12 | At least one owner per board; the last-owner check and the change are one atomic step; durable adapters must honour it | § Registry |

**Numbers I picked** (the decisions named none; all reversible constants): gateway queue cap 500 ops / 8 MB;
gateway silence 30 s; connection list every 5 s.

## Round-2 findings (item 10)

| Finding | Fix | Where | Same as the verifier's fix? |
|---|---|---|---|
| M3 lost hello/welcome/catch-up | Client timeouts (10 s to `welcome`; 10 s without catch-up progress), backoff min(30 s, 0.5 s × 2^k) with jitter; reply subject `.gw.<gateway>`; gateway serves writers' catch-up; bus carries nothing bigger than one op | rules 3, 8, 12; § Bus | yes |
| M4 refusals from speculative state | Speculative now includes queued entries; a refusal or `stale` decided against unresolved entries is held, and becomes `unavailable` if one fails | § Recovery; § Op ids table | yes, with a simpler rule: wait for **every** entry unresolved at decision time, not only the ones the answer depends on (no dependency tracking; costs at most one append of delay on a refusal) |
| M6 `sha1` format | 40 lowercase hex for `sha1` and `fileId`, else `bad-op` before signing | § Messages, § Blobs, § The element op | yes (`fileId` only "when set": a placeholder image may have none) |
| M7 heartbeat | Gateway reads the Store after 5 s of silence, and every 5 s while silent; the room heartbeats while it runs (the undefined "while any gateway follows" is gone) | § Bus | yes (the Store-poll option) |
| M8 author names | `name` stored on `records` entries at write time | § Records | yes (store at write time). Reactions keep user ids only: names of 20 emoji × many users on every comment is weight the UI doesn't need. Raised as CEO question 4 |
| L1 | Pure `applyEntry` and checkpoint → snapshot in the phase-2 room row; phase-2 Room answers viewers' hellos | phase-2 section | yes |
| L2 | Lines fixed (60/62/64, 94, 107), `protocol.test.js:14` added, `no-files` sentence and preview-test sentence corrected | "Tests that change" | yes |
| L3 | All 11 banned substrings listed; injected clock required | phase-2 intro | yes |
| L4 | `noteAuthor` in replica row; typedefs replaced; phase-3 sentence lists `here`, `blob`, op queue | phase-2 section | **differs on MemoryLog:** I kept its per-board `(entries, expectSeq)` shape and said phase 3 passes the room a per-board view of the Store. Changing the signature now would move names under the running phase-2 builder for no gain |
| L5 | Lowest counter leaves at W; pairs leave only at eviction ticks; bound H + 1,024 | § Op ids | yes |
| L6 | "Never logged twice" scoped to honest `sentAt` | rule 2 | yes |
| L7 | Prune entries `< S` | § Recovery | yes |
| L8 | Check compares `id`, `by`, `at`; gateways make the same check | § Recovery, rule 8 | **partly:** no content hash. The pure package has no hash function available in every runtime (QuickJS); listed under Known limits as the Store adapter's job |
| L9 | `rv` covers core's merge rules and the appState key set; unknown `rv` = stop | § Recovery | yes |
| L10 | Snapshots hold tombstones | § Messages, § Recovery | yes |
| L11 | Append timeout 5 s | § Recovery | yes |
| L12 | Role before dedupe, stated with its effect | § Limits | yes |
| L13 | Pending ops dropped when `welcome.user` changes | rule 13 | yes |
| L14 | Cursor/select repeat every 10 s, expire after 30 s; `here` built per gateway over `.here`, capped at 50 + `writerCount` | § Presence | yes |
| L15 | Tenant check for id-only admin calls; `POST /boards` tenant source; two-call create; `memberRole: null`; highest-wins | § Tenancy, § Registry | yes, except the stale header comment in registry.js (platform's file, below) |
| L16 | `blob` 10/s per connection; put URLs 30/min per user per board; PUT ends at our server | § Blobs; Known limits | yes |
| L17 | Log growth, per-node durability, big snapshots in Known limits; `ack` row scoped | § Known limits, § Messages | yes |
| Codex: unique key wording | The adapter must also check last `seq` = `expectSeq` in the same transaction | § Store | yes |
| Codex: `tableAuth` | Row now says the v0 typedefs are replaced | phase-2 ports row | yes |
| Codex: forged `sentAt`, lease fence, Postgres failover | Refuted by the verifier; only L6 and L17 wording changed | | |

## For other owners (I did not touch these files)

- **Platform, server/auth/port.js:22, 29:** both `verify` and `role` catch every throw and return `null`, so a
  Registry outage answers `auth`. The spec now says a throw must reach the gateway (`unavailable`).
- **Platform, server/auth/oidc.js:128:** `authoritativeEmail` accepts any `hd` that is set; the decided rule is
  `hd` **equal to the email's domain**.
- **Platform, server/auth/registry.js:** `setGrant` has no last-owner check (item 12); nothing limits who grants
  `owner` (item 11, an admin-API check); the header comment still says "Store has `board(id)`".
- **Phase-2 builder (p2-recovery):** beyond its brief's bullets, the spec now also asks phase 2 for: held
  refusals (M4), append timeout, `welcome.rv`, `name` on records entries, checkpoint `by`, record no-ops logged,
  client timeouts and backoff, drop pending on user change, `fileId` format. See the phase-2 rows and test table.

## Open question added for the CEO

- **Question 4, names saved with comments:** stored at write time, stays in the log, doesn't follow a rename.

## Not verified

- **No v1 code exists**, so every rule here is argued from text. `bun test` runs v0 code.
- **NATS `max_payload`:** the spec asks for 2 MB; I did not check NATS's default or limits.
- **The numbers** (queue cap, 5 s / 30 s liveness, backoff, blob rates, `here` cap) are reasoned, not measured.
- **Excalidraw `fileId` format:** I assumed herdr-draw's ids are SHA-1 hex, as v1 already said. If core mints
  other ids, the 40-hex rule refuses them.
- **No second review:** the advisor tool was rate-limited and Engram recall was unreachable.

## Later edits (manager, after the first report)

- **(a) § Registry, "At least one owner per board":** now says it is `Registry.setGrant` that refuses,
  atomically, to remove or downgrade a board's last owner. **§ Tenancy, `owner` bullet:** "only a tenant admin
  may grant `owner`" is enforced by the admin layer (server/admin), not by the Registry.
- **(b) § Known limits:** a Workspace user on a secondary domain can't claim an invite by email (`hd` must equal
  the email's domain); they still get `memberRole` via `hd` and can use share links.
- Nothing else changed. `bun test` re-run after these edits: 143 pass, 0 fail.

- **(c) Nesting depth (p3-scaffoldv H1):** § Limits has a new row: any frame or op nested deeper than 64 levels
  is refused `bad-op` (the gateway checks the raw frame before decoding; `opProblem` checks it too). Added to the
  phase-2 envelope.js row and to the test table ("nesting depth": a 30,000-deep op is refused). Two details are
  mine, not the manager's: the envelope row says the check must not recurse, and the test row adds "64 levels
  pass". `bun test` after: 143 pass, 0 fail.

## Risks

- **The spec grew** (461 → 630 lines); phase 2's list is longer than its brief.
- **Held refusals (M4)** delay a refusal by up to one append; under a slow Store, refusals feel slow.
- **Per-gateway op rate:** a user on G gateways gets G × the rate (Known limits).
