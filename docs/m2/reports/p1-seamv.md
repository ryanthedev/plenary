# Verifier report: p1-seamv (protocol v1 follow-up)

**Verdict: PASS.** No HIGH finding. All 12 decided items are in PROTOCOL.md, correct and consistent. Every round-2
finding (M1–M8, L1–L17 in p1-specv2.md) is closed in the text, not just mentioned. There are **2 MEDIUM** and
**7 LOW** findings, all text fixes. Neither MEDIUM breaks a hard guarantee; both are liveness gaps that phase 3
would otherwise have to guess at.

- **Done-when, not fully met:** "each rule says what is guaranteed and what may drop" falls short in three places.
  The failure path for an op too big for the bus is unstated (M1). § Pacing's "May happen" line is wrong for
  honest multi-tab users (M2). A refusal with no `id` has no stated end (L1). The manager can overrule knowingly,
  as with round 2.
- **Op-id model, done for one of three rules:** the brief asked to re-run it against pacing, held refusals and
  `unavailable` on an unknown connection. The full op-id model covers only the third. Pacing has a separate
  liveness simulation (M2), which doesn't track op ids. Held refusals are argued from the text only.

- **Checked:** `git diff -- PROTOCOL.md` against base 28fa91d (636 lines now; the diff's sha1 at sign-off is
  `39238b3afacfab3c43dfe123274b6321ae0177d2`). This includes the three late edits the manager announced (see
  "Late edits").
- **Not read:** docs/m2/reports/p1-seam.md (the builder's claims), as the brief says.
- **`bun test`:** 143 pass, 0 fail, 14 files at the start. At sign-off: 205 pass, 0 fail, 17 files (other tracks
  added test files meanwhile).
- **Severity scale (same as round 2):** HIGH means a spec-conformant sequence breaks a hard guarantee (an op
  logged twice, an acked op lost, a cross-tenant read, presence saved, an auth bypass). A missing rule that a
  later phase must guess, or an honest client stuck, is MEDIUM.

## How I checked

- **Read the whole spec**, then each item and each round-2 finding against the text (tables below).
- **Re-ran the round-2 op-id model** (`opid-model.js`, copied into this session's scratchpad
  `/private/tmp/claude-501/-Users-r-repos-plenary/64586db7-0766-4d75-b4e1-0e3caa22a7fe/scratchpad/opid-model.js`;
  `bun opid-model.js 150 4000`, about 40 s).
  - **What it models:** the op-id table, resolved vs speculative state, the per-connection `n` check, rebuilds,
    and late-landing appends, with lost messages, reconnects and reloads injected.
  - **Result:** no (user, id) logged twice, no `seq` gap or reuse, every ack names a durable entry, and nothing
    welcomed or checkpointed above the durable prefix. The model throws on any of these; none threw.
  - **The adopted rule holds:** with "a room answers `unavailable` to a connection it didn't welcome" (now rule
    6), 0 real unacked ops were lost (`staleUnloggedBelowHigh: 0`). With the rejected "accept" reading, 271 were
    lost. Every other `stale` was the documented forgotten-client cost.
  - **Not modelled:** pacing, the gateway queue, held refusals, records, limits. For those, the argument is from
    the text. **Pacing** only delays sends: every channel stays FIFO and resends follow `welcome`. So the first
    arrival of counter c always comes after counters below c on the same channel, and `high` cannot jump an
    unlogged op. **A held refusal** is still decided against speculative state, but it is only sent once that
    state has resolved, or it becomes `unavailable`.
- **Code-facing claims:**
  - The phase-2 list's test line numbers and names match the current files: `protocol.test.js:9`, `:14`, `:49`,
    `:60/62/64`, `holes.test.js:94/107`, `convergence.test.js:35` (`compact()`).
  - The list's code names match v0: `STREAMS`, `tableAuth`, `transient`, `compact`, `auth.check`, `local()`,
    `reset()`.
  - `server/auth/registry.js:5,105` already makes `setGrant` refuse the last owner (code `last-owner`), matching
    § Registry.
- **sdd ensemble: single harness.** Codex was the only harness available (agy was out of quota and the others
  weren't signed in, per the brief), so nothing is a HIGH candidate by agreement.
  - Codex ran at `effort: high` on a copy of the files outside the repo, so it couldn't edit the tree.
  - It received PROTOCOL.md, the 28fa91d version, the diff, the brief, p1-specv2.md and packages/.
  - Its leads are confirmed or refuted under "Codex leads".
  - Codex quota before the run: 34% of the 5-hour window used.
  - **Codex reviewed the file before the three late edits** (nesting depth, `setGrant` wording, secondary
    domains). I checked those alone. A `diff` of codex's copy against the final file shows only those three edits
    changed.
- **Engram:** searched; nothing relevant to this spec.

## The 12 decided items

| # | Item | Status | Where |
|---|---|---|---|
| 1 | `null` = refused (`auth`); a throw = `unavailable`, retry | Yes, and `Registry.board` follows the same split | § Auth l. 432–436 |
| 2 | Operator-created tenants; share-link guests sign in with Google; members get `memberRole`, default viewer | Yes | § Tenancy l. 398–406 |
| 3 | Authoritative email = `@gmail.com`, or `email_verified` + `hd` = the email's domain | Yes (see L6 on case) | l. 408–411; known limit l. 551–553 |
| 4 | Seeding: no first-write exemption; version 1, fresh nonce, ids kept | Yes | l. 62–71 |
| 5 | `local()` normalizes on send: highest known (confirmed or pending) + 1, fresh nonce | Yes | l. 65–68; phase-2 replica row |
| 6 | A since-0 resync closes and reconnects; `receive()` returns what it applied; `reset()` keeps pending overlaid | Yes | rule 5 l. 170–172; phase-2 replica row; tests |
| 7 | Client paces every send; over-rate is backpressure; rate per user per board; `limit` for content only; a resend of an accepted op is answered before any limit | Yes (see M2 on the timeout) | § Limits l. 82–100; § Pacing l. 102–112 |
| 8 | `unavailable` for an unwelcomed connection; close notices; `n` state dropped (30 s for a silent gateway) | Yes | rule 6 l. 180–187; § Bus l. 506–509 |
| 9 | A `records` refusal only leaves the overlay; no-op record actions logged and acked | Yes | rule 5 l. 173–174; § Records l. 373–379 |
| 10 | Round-2 findings closed | Yes, all 25 (table below) | |
| 11 | Only tenant admins grant `owner` | Yes, enforced in the admin layer (`server/admin` exists) | § Tenancy l. 412–414 |
| 12 | At least one owner; last-owner check and change are atomic | Yes, in `Registry.setGrant`; matches registry.js | § Registry l. 456–461 (see L5) |

## Round-2 findings: closed in the text

| Round 2 | Closed by |
|---|---|
| M1 rate vs resend | § Pacing: the client paces, the gateway queues, nothing is refused for rate, rate per (user, board) |
| M2 unknown connection, `n` state forever | rule 6 "Unknown connections" and "Closed connections"; § Bus close notice and list (confirmed by the model) |
| M3 lost hello, `welcome` or catch-up; reply route; bus size | rule 12 timeouts and backoff; `.gw.<gateway>`; gateways serve writers' catch-up (rules 3, 8) |
| M4 refusals from speculative state; queued entries | "A refusal or `stale` waits too"; speculative includes queued entries; the op-id row says "or queued behind it" |
| M5 comment races force resync | records refusal = overlay only; no-ops logged and acked; dead targets are no-ops |
| M6 blob `sha1` format | 40 lowercase hex, `bad-op` before signing (§ Blobs); `fileId` the same (l. 72) |
| M7 heartbeat stops with the room | Store poll every 5 s of silence, needs no room (§ Bus) |
| M8 author names | `name` on `records` entries, from Auth, kept on comments |
| L1 pure code for gateways; viewer hello in phase 2 | phase-2 list l. 565–567; exported `applyEntry` and checkpoint → snapshot |
| L2 tests-that-change | line numbers now right; `:14` added; `no-files` stays; presence test reworded |
| L3 purity substrings | all 11 listed; injected clock |
| L4 phase-2 rows | `noteAuthor`, typedefs, MemoryLog as an adapter, phase-3 sentence |
| L5 `recent` wording, bound | lowest counter goes; eviction only at ticks; H + 1,024 |
| L6 honest `sentAt` | rule 2 states the guarantee for honest clients |
| L7 prune `< S` | yes |
| L8 checkpoint check | `id`, `by`, `at`; gateways check the same; body hash is a known limit |
| L9 what `rv` covers | merge rules, appState keys; unknown `rv` stops the client |
| L10 tombstones in snapshots | yes |
| L11 append timeout | 5 s (see L2 below: the claim it rests on is off) |
| L12 role before dedupe | stated, l. 99–100 |
| L13 pending ops belong to a user | rule 13 |
| L14 presence expiry; `here` | 30 s expiry; `here` built by gateways, ≤ 50 writers |
| L15 Registry and roles | tenant check on id-only calls; two-call `POST /boards`; tenant from identity; `memberRole: null`; highest wins |
| L16 blob gaps | request and put rates; PUT ends at our server; quota known limit |
| L17 known limits | log grows; per-node durability (the `ack` row is now scoped); big boards join slowly |

## Late edits (announced by the manager mid-check)

| Edit | Verdict |
|---|---|
| `Registry.setGrant` refuses the last owner; "only tenant admins grant `owner`" is the admin layer's rule | Correct and consistent with registry.js:5,105. See L5 for the two-call window |
| Known limit: secondary-domain Workspace users can't claim invites by email | Accurate: `hd` is the primary domain, so such an address is never authoritative; `memberRole` and links still work |
| Nesting depth 64 (§ Limits, envelope row, test row) | Present in all three places; adequate for real ops (elements are about 6 levels deep). See L1 and L3 |

## MEDIUM

### M1. A valid op can be too big for the bus, and the failure path is unstated (phase 3)
- **Where:** § Limits l. 87 (one op ≤ 1,000,000 JSON chars) vs § Bus l. 510–511 (the bus must carry 2 MB).
- **Scenario:** a text element with about 1M CJK characters is within the cap. Measured with bun:
  999,978 chars encode to **2,999,778 UTF-8 bytes**, plus the inbox envelope.
  - The gateway can't publish it on a 2 MB bus.
  - The spec doesn't say what happens next. If the op just goes unanswered, the client's 10 s op timeout fires,
    and the client reconnects and resends it, forever.
  - Rule 6 keeps every later op of that client behind it, so the client is stuck.
- **Fix:** state the op cap in encoded bytes (for example, ≤ 1 MB after encoding), or require the bus to carry
  ≥ 4 MB. Either way, say a gateway that can't forward an op answers `too-large` with the op's `id`.
- **Source:** codex lead, confirmed by measurement. NATS itself allows `max_payload` up to 64 MB (codex cites the
  NATS config docs; I did not check them), so 2 MB is fine for NATS. The mismatch is inside the spec.

### M2. Gateway queueing can outlast the client's 10 s op timeout for an honest user (phase 3)
- **Where:** § Pacing l. 104–111, rule 2 l. 156–158, known limit l. 544–545.
- **The mismatch:** the client paces **per client** (20/s), but the gateway's bucket is **per (user, board)**
  across its connections (also 20/s).
- **Scenario:** one user has two tabs, or a laptop and a phone, on the same board through one gateway. Both are
  honest and paced.
  - Once both are past their burst, the gateway receives 40/s and drains 20/s, so the i-th op waits about
    i/40 s in its queue.
  - Rule 2 starts the 10 s op timeout when the op leaves the client's pacer, so the queue time counts. Past
    about 400 combined ops after the bursts, the timeout fires, the client closes and reconnects, and it
    resends its whole backlog.
- **Simulated** (`pacing-model.js` in this session's scratchpad: client pacer, per-user gateway bucket, FIFO
  queue per connection, 10 s op timeout, backoff, resend on reconnect; the room acks instantly):

  | Case | Peak queue wait | Closes | Lost |
  |---|---|---|---|
  | 1 client, 400 pending | 0 s | 0 | 0 |
  | 2 tabs, 150 pending each | 7.5 s | 0 | 0 |
  | 2 tabs, 300 pending each | hits 10 s | 1 + 1 | 0 |
  | 3 tabs, 200 pending each | hits 10 s | 0 + 2 + 1 | 0 |
  | 2 tabs, 200 pending each, then editing 12 ops/s each for 2 min | hits 10 s | 10 + 7 | 0 |

- **Impact:** safety holds. Ops stay pending, each channel is FIFO, and dedupe answers repeats. But:
  - The spec's "May happen: … a closed connection for a client that ignores the pace" is wrong: honest clients
    get closed too.
  - The churn repeats under sustained multi-tab editing.
- **Fix (pick one):**
  - The gateway bucket allows the sum of its connections' rates, with a cap on connections per (user, board).
    This also bounds the G × rate known limit.
  - Or the client's op timeout counts only time not spent in a gateway queue. That needs a "queued" signal and
    is more complex.
  - Or size the timeout above the worst-case queue time (500 ops / 20 per s = 25 s) and accept slower failure
    detection.

## LOW

- **L1. Frame-level refusals carry no `id`, so a poison op loops** (§ Limits l. 88, error table l. 149–150).
  - The depth check runs on the raw frame before decoding, so its `bad-op` has no `id`.
  - An error with no `id` drops nothing pending, so the client keeps the op. It gets no answer, times out,
    reconnects and resends, forever.
  - Honest clients never send such an op, so this is LOW. The same path applies to M1 if a gateway answers
    without an `id`.
  - **Fix:** say the gateway closes the connection with reason `bad-op`. A client that gets the same frame refused
    twice drops the head pending op and resyncs.
- **L2. "Append timeout 5 s is shorter than the client's 10 s" doesn't hold end to end** (l. 227–228).
  - An op accepted while an append is in flight goes into the *next* append, so its ack, and any held refusal or
    dedupe wait, can take up to 5 s + 5 s. Gateway queueing (M2) adds to that.
  - So clients can still time out together under a slow Store.
  - The builder's risk note "held refusals delay a refusal by up to one append" is an undercount: it is up to two.
  - **Fix:** append timeout ≤ 4 s, or state the bound as two appends and size the client timeout against it.
- **L3. Where depth is counted is ambiguous** (l. 88, test row l. 593). "Any frame or op deeper than 64" counts
  from two roots: an op 64 deep sits 65 or more deep in its frame, so the gateway refuses what `opProblem`
  accepts, and the test "64 levels pass" can be read either way.
  - **Fix:** one rule, for example "the frame's depth ≤ 64" with ops checked as frame depth minus the envelope's.
- **L4. Core emits shapes v1 refuses; the client glue is unspecified** (phase 6).
  - `packages/core/editor.js:108` sends `{elements, files}` for an image insert. The room refuses that
    `no-files`. This was already true in v0.
  - `editor.js:425` sends `transient: true` previews, which v1 removes.
  - Seeding (l. 69–71) says nothing about a file's embedded images. They must go through blob PUT, and the PUT
    succeeds only if `fileId` = SHA-1 of the bytes.
  - drawh mints it that way (`herdr-draw/mods/herdr-draw/drawh:735`). Core never mints ids (codex lead, below).
  - **Fix:** one paragraph saying the web client's `onOp` hook splits `files` into blob PUTs and turns
    `transient` into `preview` presence, and what an import does with a non-SHA-1 `fileId`.
- **L5. `POST /boards` leaves a window with no owner** (l. 462–464 vs "a board always keeps at least one owner",
  l. 414). A crash between `createBoard` and `setGrant(…, "owner")` leaves an ownerless board, and nothing
  retries it.
  - **Fix:** say a tenant admin can repair it (they can grant `owner`), or make `createBoard` take the creator
    and do both in one transaction.
- **L6. Email and domain comparison isn't normalized** (§ Tenancy l. 408–411). Say emails and `hd` compare
  case-insensitively (lowercased), and whether `@googlemail.com` counts as `@gmail.com`.
  - Without that, an invite to `Ann@Example.com` may fail to match the email Google returns.
- **L7. Who may call `POST /boards` is unstated.** CLAUDE.md calls it "an admin endpoint". The spec gives its
  tenant source but not the caller's required role, nor the answer for a caller with no tenant (a gmail.com
  user). This is probably settled in `server/admin`, which I didn't read.

## Codex leads (single harness)

| Lead | Verdict | Why |
|---|---|---|
| Op cap in chars vs 2 MB bus (MEDIUM) | **Confirmed**, M1 | Measured: 999,978 chars → 2,999,778 bytes |
| Core doesn't mint `fileId` as SHA-1 (MEDIUM) | **Refuted as a spec defect**, kept as L4 | Core takes the caller's id; the callers mint SHA-1 of the bytes (drawh:735), and `server/blobs/disk.js:32–37` refuses anything else. The real gap is the glue, L4 |
| Test files missing from the checkout (LOW) | **Refuted** | An artefact of my scratch copy (I didn't give codex test/). I checked every referenced line myself |
| All 12 items correct; M1–M8 and L1–L17 closed; no op logged twice or acked op lost | Agrees with my reading | |

## The builder's not-verified list and risks

| Risk | Finding |
|---|---|
| No v1 code; all from text | Still true. The model covers op ids, group commit, rebuild and the unknown-connection rule |
| NATS `max_payload` 2 MB | Within NATS's limits (codex: max 64 MB; not checked by me). The real problem is the op cap in chars (M1) |
| Numbers reasoned, not measured | Agreed; none measured. The 5 s / 10 s pairing is off by one append (L2); the queue cap vs the timeout is M2 |
| `fileId` assumed SHA-1 | Core doesn't mint ids; its callers (drawh) use SHA-1 of the bytes. Import of foreign files is L4 |
| Held refusals delay by up to one append | Up to two (L2). Safe: nothing is dropped early |
| A user on G gateways gets G × the rate | Stated as a known limit. M2's first fix also bounds it |

## Regressions hunted (what 28fa91d guaranteed)

| Question | Answer |
|---|---|
| Op logged twice | No (model; the pacing argument under "How I checked") |
| Acked op lost | No (model; the `ack` row is now scoped to the Store's media) |
| Ack, welcome or checkpoint from speculative state | No; held refusals now also wait |
| Cross-tenant reads | No new path; blob requests are scoped by the connection's board |
| Presence saved | No; rule 10 unchanged; presence never reaches the room |
| A room seeing an unauthenticated hello | No; § Auth: verify, role and `Registry.board` are awaited before forwarding, and a throw is `unavailable` |
| New contradictions | M2 (pacing vs the timeout) and L2/L3 only |

## What I did NOT verify

- **Anything running:** v1 has no code yet. Gateways, records and limits are argued from the text.
- **The op-id model against pacing and held refusals:** not done. The pacing simulation checks liveness only
  (timeouts, closes, nothing left pending), not op-id safety.
- **NATS limits and Google's `hd` behaviour for secondary domains:** codex's citation, and general knowledge.
- **`server/admin`:** not read (L7).
- **A real ensemble:** codex only.

**For the manager:** PASS. M1 and M2 should be fixed in PROTOCOL.md before phase 3 builds the gateway queue and
bus. The LOWs can ride along with the next spec edit.
