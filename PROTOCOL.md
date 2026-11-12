# Plenary protocol v1.1

One board = one **room**, the only sequencer. Clients send ops; the room checks the sender's role, gives each
accepted op the board's next **sequence number** (`seq`), logs it durably, acknowledges it, and broadcasts it.
Every copy that applies the same log in `seq` order ends in the same state; element ops converge in any order.

Transport-neutral: any ordered, message-framed channel (WebSocket today). Encoding is JSON, behind a codec
(`encode(msg) → string | bytes`, `decode`), so a binary codec can swap in later. The server never runs layout:
clients do (as herdr-draw does).

## What changed in v1.1

v1.1 keeps the wire's `v: 1` and `rv: 1`: nothing is deployed yet, so no old client has to keep working, and
replay is unchanged (a settings base is checked when an op is accepted, never on replay). The code that follows
this spec changes the constants and checks named below.

| Area | v1 | v1.1 |
|---|---|---|
| Settings (`appState`) | a key took the value of the highest `seq` that set it, stale or not | each key an op sets names the `appSeq` it was based on (`appBase`); the room applies the op only if every base is current, else refuses it `stale-setting`, a **soft** refusal (§ The element op, Settings) |
| `welcome` | no room identity | `room: { board, epoch }`; `epoch` rises on every room build, kept with the board's lease record in the Store (§ Recovery, Room identity) |
| Seeding (drawh) | every element renumbered to version 1 | only elements the room would refuse as new (absent and version > 1,000) go to version 1; an element the room has at more than 1,000 below the file's version is held back with a warning; everything else is sent unchanged (§ The element op) |
| Authoritative email | `@gmail.com`, or `email_verified` + `hd` | `email_verified` true **and** (`@gmail.com` or `hd` = the email's domain), compared lower-cased (§ Tenancy) |
| Op size | ≤ 1,000,000 JSON **chars** | ≤ 1,000,000 **bytes** of UTF-8 JSON, so an op always fits the 2 MB bus; a gateway that can't forward an op answers `too-large` with its `id` (§ Limits) |
| Nesting depth | "any frame or op" > 64 | a frame ≤ 64 levels (gateway), an op ≤ 62 (`opProblem`), so an op fits both a frame and a bus message (§ Limits) |
| Frame refusals | could come with no `id` | an op frame starts `{"t":"op","id":…`, and the gateway names that `id` in a frame-level refusal (§ Limits) |
| Gateway rate | one bucket per (user, board) | one bucket per connection, the same as the client's pacer; ≤ 8 writer connections per (user, board) per gateway (§ Pacing) |
| Append timeout | 5 s | **4 s**, so two appends (an op queued behind the one in flight) finish inside the client's 10 s (§ Recovery) |
| Bus | "nothing bigger than one op" | catch-up and snapshots never travel on the bus; `.entries` batches are split under 2 MB (§ Bus) |
| Postgres | (unstated) | a server starts as a role that doesn't own the schema; DDL is a separate migrate step (§ Store) |
| `POST /boards` | owner gap unstated | caller must be a tenant admin; a crash between the two calls is repaired by a tenant admin (§ Registry) |
| Store | log and checkpoints | also each board's epoch: `openEpoch`, `epoch` (§ Store) |
| Core glue | unstated | the client's op hook turns `files` into blob PUTs and `transient` into `preview` presence (§ The element op) |
| Spec gaps | emote set unnamed; `records.js` missing from the phase-2 list | emote set named (§ Presence); `records.js` row added |

## What changed from v0

| Area | v0 | v1 |
|---|---|---|
| Restart | the room lived in memory | a room rebuilds from its latest **checkpoint** + the log after it (§ Recovery) |
| Op-id table | grew forever | bounded per client and in total, checked by the room (§ Op ids) |
| Previews, cursors | `op` with `transient: true` | removed; a separate **presence** channel (§ Presence) |
| Comments | elements in `notes` | durable **records** in a third stream, `records` (§ Records) |
| Roles | `commenter` = `annotator` | `commenter` writes records only, not notes (§ Streams) |
| Tenancy | "a token from another tenant is refused" | the role comes from the board; an invited guest from another domain is fine (§ Tenancy) |
| Ports | sync `Auth.check`, `Log.append` | async Auth, Registry, Store, Bus, Blobs; the room never sees a token (§ Ports) |
| Viewers | joined through the room | served by gateways; never reach the room (rule 8) |
| Blob access | HTTP upload (unspecified) | signed URLs asked for over the socket; no token in any header (§ Blobs) |
| Entries | `{seq, board, tenant, stream, op, by, id}` | adds `at` (room clock, ms) and `rv` (rules version) |
| Op ids | any string starting `client:` | `client:counter`, counter a positive integer rising per client; `op` carries `sentAt` |

## Streams

A board has three streams, all sequenced by the same `seq`. `board` and `notes` are **element streams** (one
element document each); `records` is not.

| Stream | Holds | Merge | Who may write |
|---|---|---|---|
| `board` | the drawing (elements, `appState.herdr`: layers, grid, snap, timeline) | herdr-draw's: version, then `seq` for appState | owner, editor |
| `notes` | annotations: sticky notes, highlighter strokes, pins, pictures | same | owner, editor, annotator |
| `records` | comment threads, replies, reactions | applied in `seq` order by the room (§ Records) | owner, editor, annotator, commenter |

Viewers write nothing durable; they may send emotes (§ Presence). Roles come from the auth port, never the client.
Annotators change only the notes they made, and never a stream's settings; owners and editors change or delete
anyone's.

### How each tool travels

| Tool | Travels as | Durable? |
|---|---|---|
| shapes, arrows, text, frames, pen (`freedraw`) | elements in `board` | yes |
| **notes** (sticky note: shape + bound text) | elements in `notes` | yes |
| **highlighter** | a `freedraw` element with highlighter style (wide, translucent) in `notes` (editors may put it in `board`); while drawing, a `preview` presence | yes, the finished stroke |
| **laser** | `laser` presence only; fades on every client | no |
| **image** | an `image` element whose `fileId` = SHA-1 of the bytes; the bytes go through the Blobs port (§ Blobs) | the element, yes; bytes in Blobs |
| drag/resize previews | `preview` presence | no; the final op is |
| comments, reactions | ops in `records` | yes |
| emotes | `emote` presence | no |

## The element op

`{ elements?: Element[], appState?: object, appBase?: object }` on `board` and `notes`: whole elements with
Excalidraw's `version` and `versionNonce`; `appState` is a shallow patch of `appState.herdr`; `appBase` goes with
`appState` (Settings, below).

- **Elements** need a string `id` (≤ 64 chars), an integer `version` and an integer `versionNonce`. Higher
  `version` wins; a tie goes to the lower `versionNonce`. A delete is `isDeleted: true` at a higher version.
- **A version can't jump** more than 1,000 past the room's copy in one op. An element the room doesn't have counts
  as version 0: there is **no first-write exemption** (an exempt first write could claim a version near 2^53 and
  lock the element for everyone).
- **Normalize on send.** `Replica.local()` sets each outgoing element's `version` to (the highest version the
  replica knows for that id, confirmed or pending; 0 if none) + 1 and draws a fresh `versionNonce`. An editor's
  per-pointer-move version bumps never reach the wire. Guaranteed: an honest client never trips the jump cap,
  however long a drag ran between sends. A client that skips this may be refused (`bad-op`); nothing else breaks.
- **Seeding from a local file** (drawh) is a client-side import, not a message. It is the one sender that does
  **not** normalize: it sends the file's elements as ordinary ops with ids, versions and nonces kept, through a
  version-keeping send of the Replica (`local(stream, op, { keepVersions: true })`, never re-stamped on a
  resync), except:
  - **decided against the confirmed copy after catch-up** (rule 2: the import waits for `welcome.seq`). Another
    writer may create the same id between that and the send; only another copy of the same file can do that
    (element ids are random), and v1 had the same race.
  - **renumbered:** an element the room doesn't have (as the replica's confirmed copy shows it) whose `version` is
    over 1,000, which the room would refuse (an absent element counts as version 0). It goes out at **version 1**
    with a fresh `versionNonce`, and the importer warns that a pane still holding the old numbers can undo later
    edits to it (§ Known limits).
  - **held back:** an element the room has at a version more than 1,000 below the file's (the room would refuse it
    too). It isn't sent; the importer warns, and the room's copy stands.
  - Guaranteed: an import never trips the jump cap. An element at or below 1,000, or one the room already has,
    keeps its number, so an older copy loses to a newer one by the ordinary merge instead of overwriting it.
- **Core's own output needs glue** (the web client and drawh). Core's editor emits two shapes v1 refuses: an image
  insert as `{ elements, files }` and drag previews as `transient: true` ops. The client's op hook splits `files`
  off into blob PUTs (§ Blobs) and sends the elements alone; it turns a `transient` op into a `preview` presence
  message. An import whose image element has a `fileId` that isn't the SHA-1 of its bytes re-hashes the bytes
  and rewrites `fileId`; one whose bytes are missing is sent with `fileId: null` and a warning.
- **An image element's `fileId`**, when set, is exactly 40 lowercase hex characters (a SHA-1); anything else is
  `bad-op`.
- **`appState` keys are a fixed set**, each checked: `layers` (1–100 of `{id, name, visible, locked, opacity 0–100}`),
  `grid` (0–1000), `snap` (boolean), `timeline` (`{duration}` up to an hour). Unknown and prototype keys are refused.
  Only owners and editors set them, on either stream.
- **`appState` keys merge by `seq`**: a key takes the value of the highest-`seq` op that set it. `appSeq[stream][key]`
  is that `seq` (0 for a key never set). The room only logs a settings op whose bases are current (below), so the
  highest `seq` is also the latest value its writer had seen.
- **Pictures** never travel in ops: an op with `files` is refused (`no-files`).

### Settings (compare-and-set)

- **Shape.** An op with `appState` also carries `appBase`: the same keys, each an integer ≥ 0, the `appSeq` of that
  key the sender's value was based on. Missing, extra or non-integer `appBase` keys, `appBase` without `appState`,
  or an op with both `appState` and `elements` → `bad-op`. (A settings op stands alone, so refusing it never takes
  elements with it.) `Replica.local()` splits a mixed local change into two ops, elements first, then settings, so
  an honest client never sends a mixed one.
- **What "based on" means (the client).** A key's base is the newest `appSeq` of that key the client had
  confirmed when the value was made, or the `seq` of its own acknowledged settings op for the key, whichever is
  higher. A resync doesn't lower it: the client keeps each key's last confirmed `appSeq` across a reset, so a
  change made while its copy is being rebuilt is based on what the user saw, and is accepted unless someone
  else changed the key meanwhile. It is forgotten only when another user signs in (rule 13) or when the Store
  lost acknowledged entries (§ Recovery, Room identity), because then the room may no longer have it.
- **The check.** After the op-id table (§ Limits, order of checks), the room compares each key's base with that
  key's `appSeq` in its **speculative** state. All equal: the op is logged, and its `seq` becomes every key's new
  `appSeq`. Any differs: the whole op is refused `stale-setting` and nothing is logged. Like every refusal decided
  against unresolved entries, it is held until they resolve, or becomes `unavailable` (§ Recovery).
- **A resend of an accepted settings op** meets the op-id table first, so it gets its `ack`, never a
  `stale-setting` against its own `seq`.
- **`stale-setting` is soft.** The client drops that op from its pending overlay. There's no reset and no resync,
  as for `records` refusals: the client's confirmed copy is already right. The app re-reads the key and may
  retry. It retries only once its confirmed `appSeq` of **any** key in the refused op has **passed** (is greater
  than) that key's refused base, so a retry can't spin against an entry it hasn't applied yet. (Any stale key refuses the whole op
  and the `error` names no key, so "any key passed its base" is exactly what the room's check implies. The refused key's
  entry is durable before the held refusal is sent, so the client always receives it, by the bus or the Store poll.)
- **One in flight per key.** A client sends at most one settings op per (stream, key) until that op is settled.
  Later local changes to the key stay in the overlay and go out as one op when it settles. **A held change's base
  is fixed when the key is first held:** per key, the higher of the key's base when it was first held (what
  the client had confirmed then, as above; later changes to a held key keep that base, because while it is held
  the screen shows the held value, so a peer's entry confirmed meanwhile was never seen) and, once it settles, the `seq` of this client's own preceding
  op on that key. Never the confirmed `appSeq` at release time: an entry applied after the change was made, which
  the held value hid on screen, was never seen, so a held change that would overwrite it is refused
  `stale-setting` and the app is told. If the preceding op was refused, the held changes to the key are dropped
  with it (they were built on the refused value), and the app is told. If it was answered `stale` (§ Op ids: it
  may or may not have landed), the held changes wait for the resync that follows and then go out on the same
  fixed base; if the `stale` op had landed, or anyone else changed the key, that op is refused `stale-setting`
  (its retry gate opens at once: the conflict is already applied).
- **Forgetting.** When the client forgets what it saw (another user signs in, rule 13, or the Store lost
  acknowledged entries), held changes lose their base: they are dropped, and the app is told (it may retry on
  the resynced copy). A settings op always carries a base for every key it sets.
- **After a Store loss** (a writer's `welcome` from a higher epoch whose `seq` is below what the client applied),
  a settings op the client stamped before the loss may name a base the room no longer has. A `stale-setting` for
  such an op arms no retry gate: the app is told it may retry at once, on the resynced copy.
- **Imports carry bases too.** A drawh import that sends the file's settings sends them as an ordinary settings op
  with `appBase` from its confirmed copy after catch-up; on `stale-setting` the board's settings win (as when
  joining a board that already has them).
- **A deliberate revert** (a key set back to an older value) is a fresh op on the current base, so it is accepted.
  A stale save carrying the same old value names an old base and is refused. The two are told apart by base,
  never by value or by time.
- **Replay** applies a logged settings entry unconditionally (`appBase` is ignored): an entry is in the log only
  if its bases were current when it was accepted. So `rv` doesn't change.
- **Guaranteed:** no settings op overwrites a key whose latest value its sender hadn't seen; an acknowledged
  setting is never lost. **May drop:** a stale settings op (the client is told and may retry).
- **Cost: a lost `stale-setting` becomes a resync.** If the refusal is lost, or was held and turned `unavailable`
  because an append failed, and a later op of the same client was then accepted, the resend is below `high` and
  not in `recent`, so it gets `stale` and the client resyncs (§ Op ids). Safe (nothing is logged twice; the resync
  shows the truth), but it costs the resync the soft refusal avoids. `records` refusals have the same cost.

## Limits

Durable writes are bounded so one writer can't flood the sequencer or bloat every snapshot. Over a **content cap**
→ `limit` (a refusal: rule 5). The op **rate** is different: over-rate is backpressure, never a refusal (§ Pacing).

| What | Limit |
|---|---|
| one op | ≤ 1,000,000 **bytes** of its UTF-8 JSON (`too-large`). Bytes, not chars: 1M CJK chars are 3 MB, which no 2 MB bus carries. Counted without `TextEncoder` (the pure package can't use it) |
| nesting depth | the outermost object or array is level 1 (the op object itself, for an op). A **client → server frame** deeper than **64** is refused `bad-op` by the gateway, on the raw text before decoding. An **op** deeper than **62** is refused `bad-op` by `opProblem` (so replay and other transports are covered). So an accepted op fits in its frame (op + 1) and in the gateway's bus message (op + 2). Server → client frames aren't capped (an `entries` frame holds an op at op + 3) |
| writer connections per (user, board) | ≤ 8 per gateway; a ninth writer `hello` gets `limit` (no `id`) and is closed (§ Pacing) |
| durable ops per connection | 20/s sustained, bursts of 100 (§ Pacing; never answered with `limit`) |
| `board` stream | ≤ 100,000 element ids, ≤ 50 MB of JSON (tombstones count) |
| `notes` stream | ≤ 200,000 element ids, ≤ 50 MB of JSON (tombstones count) |
| `records` | ≤ 20 MB of JSON; plus the per-record caps in § Records |
| blobs | 10 MB each; per-tenant quota (default 10 GB, set per deployment); request rates in § Blobs |

Order of checks on an `op`: shape (`bad-op`, `no-files`, `too-large`), id (`bad-op`), role (`forbidden`), op-id
table (§ Op ids), then settings bases (`stale-setting`), then content and limits. So a bad id never hides a shape
error, and a resend of an accepted op is answered with its `ack` before any base or limit check, including limits
that changed since.

- **Frame-level refusals name the op.** The client's codec writes every op frame starting `{"t":"op","id":"…"`, so
  a gateway that refuses a frame before decoding it (too deep, too big to forward) reads the `id` from the frame's
  head and puts it in the `error`. The client then drops that op (rule 5), so a poison op can't loop through
  reconnects. A frame with no readable id at its head gets an `error` with no `id`. Only a broken or hostile
  client sends one, and the gateway may close its connection after repeated bad frames.
- **Too big for the bus.** A gateway that can't publish an op to the room (over the bus's message cap) answers
  `too-large` with the op's `id`. It never leaves the op unanswered.

- **Role comes before the op-id table.** A resend after the sender's role was lowered gets `forbidden`, not its
  old `ack`. The client drops it; the resync (element streams) or catch-up (`records`) shows whether it had landed.

### Pacing (the op rate)

- **The client paces every send, resends included,** with a token bucket of 20 ops/s and a burst of 100 (clock
  injected). Ops waiting for a token stay pending and stay visible (the pending overlay).
- **The gateway runs the same bucket per connection** (20/s, burst 100), so an honest client's ops never wait
  there beyond network jitter, however many tabs its user has open. An over-rate op is **queued** in arrival
  order, never refused and never reordered (rule 6).
- **Connections per user:** a gateway holds at most **8** writer connections per (user, board). A ninth writer
  `hello` gets `error` `limit` with no `id` and is closed. The client keeps its pending ops, tells the UI ("too
  many open tabs on this board"), and retries with backoff (rule 12; it counts as a failed attempt). So one user
  writes at most 8 × 20 ops/s through one gateway. A connection counts until the gateway sees it close.
- **Dead connections stop counting within 30 s.** The gateway sends a WebSocket ping on every connection that has
  sent nothing for **10 s**, and closes any connection it has heard nothing from (no frame, no pong) for **30 s**.
  So a half-open socket left by a flapping network frees its slot within 30 s, and a client refused `limit` for
  it gets in on a later retry. Guaranteed: an honest user with ≤ 8 live tabs is never kept out longer than about
  30 s plus backoff. (WebSocket pongs are answered by the client's WebSocket stack, not by app code. Whether
  Herdr's WebSocket answers pings is untested; if it doesn't, an idle Herdr client is closed after 30 s and
  reconnects, which costs time only.)
- **Queue cap:** 500 ops or 8 MB per connection, whichever comes first. Past it the gateway answers `unavailable`
  and closes the connection. The ops stay pending on the client, which reconnects (rule 12) and resends (rule 2).
- **Guaranteed:** no op is refused or dropped for rate; a resend of an accepted op still gets its `ack` (the queue
  only delays it); an honest client's ops don't wait in a gateway queue, so the queue never trips its 10 s op
  timeout. **May happen:** delay and a closed connection only for a client that ignores the pace; a ninth tab
  waits until another closes.
- The rate is not coordinated between gateways in M2 (§ Known limits).

## Messages

Client → server

| `t` | Fields | |
|---|---|---|
| `hello` | `v: 1`, `token`, `board`, `since`, `client` | first message; the token travels here, never in a header (Herdr refuses credential headers). `client` = name + per-session part, no colon, ≤ 128 chars. Unknown `v` → `version`, closed |
| `op` | `id` (`client:counter`), `sentAt`, `stream`, `op` | durable change; `counter` is a positive safe integer, larger than every earlier counter of this client; `sentAt` = the `seq` the client had applied when it first sent this op. Encoded with `t` then `id` first (§ Limits) |
| `presence` | `k`, kind fields (§ Presence) | never logged, may drop |
| `blob` | `sha1` (40 lowercase hex), `put?` | asks for a signed blob URL (§ Blobs) |

Server → client

| `t` | Fields | |
|---|---|---|
| `welcome` | `seq`, `role`, `user`, `high`, `horizon`, `rv`, `room` | `seq` = resolved seq; `high` = this (user, client)'s highest accepted counter (0 if none; omitted for viewers); `horizon` (§ Op ids); `rv` = the room's rules version (§ Recovery); `room` = `{ board, epoch }` (§ Recovery, Room identity) |
| `snapshot` | `seq`, `streams: { board, notes }`, `appSeq`, `records`, `noteAuthor` | the client-facing board state at a resolved `seq`, tombstones included; never holds the op-id table |
| `entries` | `entries: [{ seq, board, tenant, stream, op, by, id, at, rv, name? }]` | catch-up and live, ascending `seq`; `name` only on `records` entries (§ Records) |
| `ack` | `id`, `seq` | the entry is durable (§ Store says against what); it is never lost short of losing the Store's own media |
| `presence` | `batch: [{ user, client, k, … }]` | coalesced others' presence |
| `here` | `writers: [{ user, name, role }]` (≤ 50), `writerCount`, `viewers` (count) | who's on the board (§ Presence); sent on change, at most 1/s |
| `emotes` | `counts: { emoji: n }` | viewers' emotes summed per 500 ms |
| `blob` | `sha1`, `url` | a signed URL, 5 minutes, one blob, one verb |
| `error` | `id?`, `code`, `message` | codes below |

Error codes, and what the client does:

| Code | Meaning | Client |
|---|---|---|
| `forbidden`, `bad-op`, `no-files`, `too-large`, `limit` | refusal of that op (`limit` = a content cap, never the rate) | rule 5: drop it; on an element stream, resync; on `records`, nothing more |
| `stale-setting` | a settings op whose `appBase` isn't current (§ The element op, Settings); nothing logged | drop it from the pending overlay only: no reset, no resync; tell the app, which may retry on the current base |
| `stale` | not logged now; maybe logged earlier (§ Op ids) | drop it from pending; resync once after resends |
| `unavailable` | room moving or stopped, a gap on the way in, a connection this room never welcomed, a full gateway queue, or sign-in could not be checked right now | keep every pending op; reconnect with backoff (rule 12) |
| `auth` | bad token, unknown board, no role, or no hello yet; the connection is closed | keep pending ops; sign in again, then reconnect |
| `version` | unknown protocol `v` | stop; the app must update |

An `error` with no `id` is not about an op (a `blob` request: `bad-op`, `forbidden`, `limit`; a ninth writer
connection: `limit`, then closed; an op frame with no readable id: `bad-op`; or a connection-wide `unavailable`,
`auth`, `version`): nothing pending is dropped for it. Each ends: a `blob` refusal ends with that request (ask
again later); a connection-level one ends the connection, and the client reconnects with backoff (or signs in
again, or stops, per the table).

## Rules

1. **Ack after durable log.** An `ack` means the entry is in the Store (§ Store). It survives a crash of any process.
2. **Idempotent resend, only right after `welcome`.** After each `welcome`, a client resends every unacknowledged op
   it has, oldest first, same `id` and `sentAt`, paced like any send (§ Pacing). It never resends on a live
   connection: an op with no `ack` or `error` within **10 s** of being written to the socket (not of being queued
   by the pacer) means the connection is suspect, so the client closes it and reconnects. The room
   answers an op it already accepted with the same `ack` (same `seq`), without logging or broadcasting it again
   (§ Op ids). Dedupe is per user, and ids carry the sender's own client id. An op the client has never sent waits
   until the client has applied every entry up to `welcome.seq`. Guaranteed: an op from a client that reports
   `sentAt` honestly is never logged twice. A client that forges `sentAt` can log only its own op again (§ Op ids).
3. **Catch-up.** After `welcome`, the server sends `entries` with every `seq > since`, or a `snapshot` (when the
   kept log no longer reaches back that far) followed by the entries after it. The **gateway** serves it, to
   writers as to viewers (rule 8), up to at least `welcome.seq`; it never travels over the bus.
4. **Order.** Clients apply `entries` in `seq` order, buffer gaps, skip `seq` they already applied. An applied
   entry whose `id` is one of this client's pending ops **and whose `by` is this user** settles that op, ack or
   not. (`by` matters: another user may reuse the same client string; dedupe and settling are per user.)
5. **A refused op is undone.** On a refusal (table above) naming one of its ops, the client drops that op.
   - **Element streams** (any refusal but `stale-setting`): it then discards its copy, **closes the connection and reconnects** with `since: 0` (a
     resync is always a new connection: one hello per connection, rule 11). Its other unacknowledged ops stay
     pending, stay overlaid on what it shows during the resync, and are resent after the new `welcome`.
   - **`records`:** the op only leaves the pending overlay. No reset, no resync: records apply in `seq` order, so
     the client's confirmed copy is already right.
   - **`stale-setting`:** the same: the op only leaves the overlay (with any held changes to its keys), and the app
     may retry on the current base (§ The element op, Settings).
   - `unavailable` and `auth` are not refusals: pending ops are kept.
6. **Per-connection order, checked.** A client's ops reach the room in the order it sent them. The client sends
   in counter order; the gateway numbers each connection's messages to the room (`n` = 1, 2, …, the hello is 1);
   the room processes them in `n` order and, on a gap, answers `unavailable` and drops that connection. § Op ids
   depends on this. A lost `ack` or `error` on the way back is caught by rule 2's timeout.
   - **Unknown connections.** A room answers `unavailable` to any op from a connection it did not welcome **in
     this incarnation** (after a rebuild or takeover it knows none, whatever `n` says). It never accepts it. The
     gateway closes that client connection; the client reconnects and is welcomed afresh.
   - **Closed connections.** The gateway sends the room a close notice for each writer connection that ends, and
     every 5 s the list of its open writer connections on that board (§ Bus). The room drops the `n` state of a
     closed or unlisted connection, and all `n` state of a gateway it has not heard from for **30 s**.
   - **Guaranteed:** no op is accepted out of order, across restarts too; `n` state is bounded by open
     connections. **May drop:** a connection (never a pending op: the client resends after reconnecting).
7. **Boards exist only by `POST /boards`** (Registry `createBoard`). A `hello` for an unknown board is refused with
   `auth`, the same error as a board the token has no role on, so existence doesn't leak. A hello never creates one.
8. **Auth before the room; viewers never reach it.** The gateway awaits Auth and the Registry (§ Auth) before
   anything is forwarded; the room never sees a token. A writer's hello goes on as `{user, name, role, client}`,
   and the room answers with `welcome` only (`seq`, `high`, `horizon`, `rv`, `room`; small enough for any bus). The gateway
   then serves catch-up itself: from its cached tail, the Store, or a snapshot built from the latest checkpoint
   (checked as in § Recovery, Rebuild). A **viewer's** hello never leaves the gateway: `welcome` (no `high`; `room`
   from the gateway's latest known epoch, § Recovery, Room identity) and the same catch-up. Viewers send no ops, so 100k joins never touch the sequencer.
9. **One sequencer per board**, fenced at the Store (§ Store): two hosts can never both log a `seq`.
10. **Presence is never saved:** not in the log, not in checkpoints, not in snapshots. It may drop at any hop.
11. **Before `welcome`** a connection's presence is dropped and its ops get `auth`. One board per connection: a
    second `hello` gets `bad-op` and the connection is closed.
12. **Timeouts and backoff (client; clock injected).** The client closes the connection and reconnects when: no
    `welcome` arrives within **10 s** of its hello; or the `welcome` names another board; or a **writer's**
    `welcome` (one with `high`) names an epoch lower than one it has seen in a writer's `welcome` (§ Recovery, Room
    identity; a viewer's `welcome` is never checked for epoch); or it is behind `welcome.seq` and no `snapshot` or `entries`
    message arrives for **10 s**; or rule 2's op timeout fires. Before each reconnect (also after `unavailable`)
    it waits min(30 s, 0.5 s × 2^k) × a random factor in [0.5, 1), k = failed attempts in a row. A failed attempt
    is a connection that ended by one of these timeouts, by `unavailable`, or by the socket closing without the
    client asking; each connection counts once. k resets to 0 only after a connection has **proven itself**: it
    applied `welcome.seq` and then stayed connected for **10 s** more (the silent 10 s before a timeout don't
    count). Being welcomed, or caught up, is not enough:
    a server that welcomes and then drops still meets growing waits. The reset is applied when the next wait is
    worked out (so a proven connection that then fails counts as the first failure). Guaranteed: a lost hello,
    `welcome`, catch-up message, `ack` or `error` never strands a client, and pending ops are kept throughout.
    May drop: time only.
13. **Pending ops belong to a user.** If `welcome.user` differs from the user who made the client's pending ops
    (someone else signed in), the client drops them before resending anything and tells the UI how many.

## Recovery

A room's state is a pure function of the log: the same entries in `seq` order, under the rules version each was
accepted with, give the same state.

**Resolved vs speculative.** The room keeps two states:

- **Resolved:** every entry whose append has resolved (durable). `welcome.seq`, `high`, catch-up, snapshots,
  checkpoints and broadcasts come only from this.
- **Speculative:** resolved + every accepted entry whose append hasn't resolved yet: those in the append in
  flight (a group commit) and those queued behind it. New ops are checked against it, so op k+1 sees op k's
  record id, note author and op id.
- **A dedupe hit on an unresolved entry waits** for its append and then acks with its `seq`. It never acks early.
- **A refusal or `stale` waits too.** If any entry was unresolved when the room decided it, the answer is held
  until every such entry has resolved, then sent. If one of them fails, the answer becomes `unavailable` (the
  op stays pending; the rebuilt room decides again, unless a later op of the same client has landed meanwhile:
  then the resend is answered `stale` and the client resyncs, § Op ids). Guaranteed: no client drops an op because of an entry that
  never became durable.
- When an append resolves, its entries move to resolved, are acked, and are broadcast, in `seq` order.
- **Append timeout: 4 s.** An op accepted while an append is in flight goes into the next one, so its `ack` (or a
  held refusal, or a dedupe wait) can take two appends: 8 s, still inside the client's 10 s. So under a slow Store
  clients hear `unavailable` and back off instead of all timing out at once. (Network time and gateway jitter eat
  the last 2 s; an op that misses it is resent safely, rule 2.)
- On `conflict`, failure or timeout of an append: drop the speculative state, stop sequencing (answer
  `unavailable` to everything held or new), and rebuild from the Store, which settles whether the entry landed.
  Unacked ops are resent by their clients after reconnecting; rule 2 makes that safe. A room never reuses a `seq`
  it may have written.

**Checkpoint** (the room's, kept in the Store; never sent to clients):

| Field | Holds |
|---|---|
| `seq`, `id`, `by`, `at` | the last entry it covers, and that entry's `id`, `by` and `at` |
| `rv` | rules version the checkpoint was made under |
| `streams` | `board` and `notes` scenes, tombstones included |
| `appSeq` | per stream, per appState key, the `seq` that set it |
| `records` | every thread, comment, reaction (§ Records), tombstones included |
| `clients` | the op-id table (§ Op ids): per (user, client) `{ high, last, recent: [[counter, seq]…] }`, and `horizon` |
| `noteAuthor` | notes element id → user who first wrote it |

**Snapshot** (sent to clients) = `seq`, `streams`, `appSeq`, `records`, `noteAuthor`. It never holds `clients`
(size, and other people's op ids). `noteAuthor` is in it so a client knows which notes an annotator may change.
Its `streams` and `records` **include tombstones**, as the checkpoint's do: without them a later entry carrying an
older version of a deleted element would bring it back on that client only.

- **One step.** Live ops and replay go through the same `applyEntry(entry)`: merge into the stream (or records),
  record the op id under `(entry.by, client of entry.id)`, record note authors, run eviction (§ Op ids). Role and
  limit checks run before logging, never on replay: a logged entry was already accepted.
- **Rules version.** Every entry and checkpoint carries `rv` (1 now). W, H, the eviction period and the meaning of
  each record action are fixed per `rv`; a later version replays old entries under the rules they were accepted
  with. `rv` also covers everything else replay depends on: the element merge rules (a re-copy of packages/core
  that changes a merge result bumps `rv`) and the `appState` key set. A client that meets a `welcome` or an entry
  with an `rv` it doesn't know stops, as on `version`: the app must update.
- **When.** Every 1,000 entries, or later: not until the bytes logged since the last checkpoint reach half that
  checkpoint's size (so rewriting a big checkpoint costs at most about 2× the log). Also, at any entry count, once
  those bytes reach the host's byte trigger (`tailFoldBytes`, default 8 MB) and that same half-size bound, whichever
  comes first: a few huge ops make catch-up bounded without waiting for 1,000 entries. Also when the room is stopped
  cleanly. The copy is of the **resolved** state at `seq` S, taken synchronously; the write is asynchronous.
- **Order of durability.** A checkpoint at S holds only resolved entries, so entries ≤ S are durable. Log entries
  **< S** may be pruned only after checkpoint S is durable (entry S itself stays: the rebuild check needs it); M2
  never prunes the log.
- **Rebuild.** Read the latest checkpoint. Check it against log entry S: same `id`, `by` and `at`, and S ≤ the
  log's end. If not (a checkpoint from a fenced-off host, or corruption), log an error and use the one before it
  (M2 keeps the whole log, so starting empty at 0 always works). Then read the log from S + 1 to its end and apply
  each entry in order. A gap or a repeated `seq` in the log is corruption: the room refuses to start and logs an
  error. The kept tail for catch-up = entries after the checkpoint. A gateway building a viewer's or writer's
  snapshot from a checkpoint (rule 8) makes the same check. The check catches a checkpoint from the wrong
  history, not a damaged body (§ Known limits).
- **Guarantees after a rebuild:** state, `appSeq`, records, op-id table and note authors equal the original's
  resolved state; a resend of an acked op gets the same `ack`/`seq`; an annotator still can't change another's
  note; the next entry is the log's end + 1 (no gap, no reuse).

**Room identity.** Every `welcome` carries `room: { board, epoch }`, so a client knows when the room it talks to was
rebuilt without guessing from the last entry.

- **What `epoch` is.** A positive integer per board (0 only in a gateway-built `welcome` for a board whose room
  was never built: "no room yet") that rises by at least 1 every time a room is **built** for it:
  first start, a rebuild after a failed append, a restart, a takeover by another host. One room incarnation has one
  epoch.
- **Where it lives: the board's lease record in the Store, not the checkpoint.** A room build first calls
  `Store.openEpoch(tenant, board) → epoch` (§ Store), a durable atomic increment, and welcomes nobody before it
  resolves. In a cluster this is the same row and the same step as taking the board's lease (phase 4), so a
  takeover's lease and its epoch can't diverge. Single node has the same record (its one host holds every lease).
  Not the checkpoint, because checkpoints are written asynchronously, only every 1,000 entries or later, and the
  highest `seq` wins. A rebuild that wrote no checkpoint, or fell back past a bad one, would repeat an epoch.
- **How gateways learn it.** A writer's `welcome` comes from the room, which knows its epoch. For a viewer's
  `welcome` the gateway uses the latest epoch it knows. The room puts `epoch` in its `.entries` heartbeat
  (`{ seq, epoch }`, § Bus), and a gateway with no heartbeat for the board yet reads the lease record from the
  Store, as it reads catch-up.
- **What the client does.** `room.board` must equal its hello's board. If not, it closes and reconnects (a failed
  attempt, rule 12). The epoch checks below apply only to a **room-built** `welcome` (a writer's: it carries
  `high`), because a gateway-built one (a viewer's) may lag. A viewer only records the epoch. A writer remembers the
  highest epoch seen for the board:
  - **Lower than seen:** a stale host or gateway. Close and reconnect (a failed attempt). In a cluster this can
    last until the stale host's lease lapses or its next append conflicts: the epoch numbers incarnations but
    doesn't fence them (the conditional append does). Phase 4 may add the fence (`append(…, expectSeq, epoch)`,
    checked against the lease record) to end it at once.
  - **Higher than seen, and `welcome.seq` below the `seq` it has applied:** the Store lost acked entries (§ Known
    limits, per-node durability). Resync with `since: 0`.
  - **Higher than seen otherwise:** a normal rebuild. Nothing more to do (rules 2 and 6 already cover resends).
  - **Checked against what came before this connection.** Live entries and the room's `welcome` travel on
    different bus subjects, so a gateway may deliver an entry before the `welcome`. The client keeps any
    `entries` or `snapshot` that arrive before this connection's `welcome` and applies them right after it, so
    "the `seq` it has applied" never includes them and a reordering never looks like a Store loss.
- **Guaranteed:** two room incarnations of a board never share an epoch, and a later one has a higher epoch.
  **May drop:** a viewer's `welcome` built while a rebuild is under way may carry the previous epoch. A connection
  that stays up through a rebuild gets no new `welcome`. A writer meets the rebuild on its next op (`unavailable`,
  rule 6), a viewer only on its next reconnect. Nothing durable depends on the epoch: it is information for the
  client, and the fence is still the conditional append (§ Store).

## Op ids

Op ids are `client:counter`. The room keeps, per (user, client): `high` (highest accepted counter), `last`
(`seq` of its latest accepted op) and `recent` (its accepted `[counter, seq]` pairs, at most **W = 256**: adding
a 257th removes the pair with the lowest counter; old pairs leave at eviction, below), plus one board-wide
`horizon` (below).

An op with counter n and `sentAt` from (user, client):

| Case | Answer | Logged? |
|---|---|---|
| no record for (user, client) and `sentAt` < `horizon` | `error` `stale` | no |
| n in `recent` (resolved) | `ack` with the stored `seq` | no (already) |
| n unresolved (speculative: in the append in flight or queued behind it) | wait for its append, then `ack` with its `seq` | no (already) |
| n ≤ `high`, not in `recent` | `error` `stale` | no |
| n > `high` | normal checks, then logged | once |

**Why refuse, not ack, below the window:** the room no longer knows that op's `seq`, nor whether it was accepted
or refused (rule 6 says it arrived before). An ack must name a durable `seq`; a guess could lie. So it is never
logged twice, and the client finds out the truth by resync.

- **Client on `stale`:** drops the op from pending (not a rule-5 refusal on its own); once its resends are
  answered, if any were `stale`, it resyncs once with `since: 0` (closing and reconnecting, as in rule 5). Needs
  > 256 accepted-but-unacked ops from one client, or an op older than H entries.
- **Whole clients are forgotten.** Each page load mints a new client, so records are evicted: every 1,024th `seq`
  (an eviction tick, and only then), any client with `last` < `seq` − **H** (H = 100,000 entries) is dropped and
  `horizon` = max(`horizon`, its `last`); pairs with `seq` < tick `seq` − H leave `recent` at the same tick. This
  depends only on `seq`, so replay evicts alike. Bound: client records ≤ H + 1,024, pairs ≤ H + 1,024 (each needs
  an accepted op within H of the last tick, one op per `seq`).
- **A forgotten client coming back is caught by the room** (first row above): an op logged at L has L > `sentAt`,
  and a forgotten client's L ≤ `horizon`, so `sentAt` < `horizon` covers every op that might have been logged and
  forgotten, even if the eviction happens between `welcome` and the resend. A client that lies about `sentAt`
  can only duplicate or lose its own op, which it could do anyway with a new id.
- **The client checks early too (optimisation):** if `welcome.high` = 0, it drops pending ops with `sentAt` <
  `horizon` before resending, resets, and reconnects with `since: 0`.
- **Cost:** new ops wait for catch-up (rule 2), so `sentAt` ≥ the `seq` at send time ≥ `horizon` at that time;
  `horizon` can only pass it after the board moves on more than H entries. So only an op that was sent, never
  acked, and stayed out for more than H entries is dropped. Never logged twice. The UI says so after the resync:
  "n changes could not be confirmed" (the resync shows whether they landed).

**Note authors** are not bounded separately: one entry per notes element id ever made, so they are bounded by the
notes cap (200,000). An author outlives its note's tombstone, so no one can revive and claim another's note.

## Presence

Cursors, selections, laser, previews and emotes. Not sequenced, never logged, never in a checkpoint or snapshot,
may drop at any hop. It doesn't touch the room: gateways relay it over the bus (§ Bus). Replaces v0's
`transient` ops, which consumed op counters and went through the sequencer.

| `k` | Fields | Who sends | Rate per connection | Delivery |
|---|---|---|---|---|
| `cursor` | `x`, `y` | owner, editor, annotator, commenter | 20/s | latest per client wins |
| `select` | `stream`, `ids` (≤ 500) | same | 5/s | latest wins |
| `laser` | `pts: [[x, y, t]]` (≤ 64) | owner, editor | 30/s | every batch; fades on clients |
| `preview` | `stream`, `elements` (≤ 50, ≤ 64 KB) | writers of that stream | 20/s | latest per element wins; display only |
| `emote` | `e`, one of the fixed set 👍 ❤️ 😂 🎉 👏 😮 🙏 🔥 (`EMOTES` in presence.js; changing it changes the protocol) | everyone, viewers too | 4/s | writers' as presence; viewers' only as `emotes` counts |
| `leave` | — | sent by the gateway on disconnect | — | best effort |

- Over the rate or size → dropped silently, no error.
- No role checks beyond the "who sends" column: a `preview` isn't checked for note ownership. It is display only;
  the final op is checked.
- Gateways send `presence` batches every 50 ms, coalesced. Under load they may thin: owner and editor presence
  first; annotator and commenter cursors are capped at the 50 most recently active per board.
- **Emote counts:** each gateway publishes its viewers' counts for each 500 ms window on the board's `.emotes`
  subject; every gateway sums all gateways' counts for that window and sends the total to its clients.
- A `preview` is shown over the board, never merged into it (it may tie the final op on version). The final op's
  entry clears that element's preview; previews also expire 5 s after their last update.
- **Everything expires.** A sender repeats its `cursor` and `select` at least every 10 s while connected. A
  receiver drops all presence of a (user, client) on `leave`, or when it has heard nothing from it for **30 s**.
  A laser fades on its own. So a lost `leave` clears itself within 30 s.
- **`here`:** each gateway publishes its own writers and viewer count for the board on `.here` (§ Bus) when they
  change and at least every 5 s; every gateway merges what it heard in the last 15 s and sends `here` to its
  clients on change, at most 1/s. `writers` lists at most 50 (owners and editors first, then the most recently
  active); `writerCount` is the full number. Best effort, like all presence: counts may lag or be briefly wrong.

## Records

Comments and reactions are durable: ops in the `records` stream, sequenced, logged, acked, idempotent on resend
(rule 2), in checkpoints and snapshots. Records don't merge by version; the room applies them in `seq` order and
refuses an invalid one before logging (checked against the speculative state), so replay never meets an invalid
record.

`op` on `records` is one action:

| `do` | Fields | Who may | Effect |
|---|---|---|---|
| `thread` | `id`, `anchor`, `text` | owner, editor, annotator, commenter | a new thread; its first comment has id `id` |
| `reply` | `id`, `thread`, `text` | same | a new comment in an open or resolved thread |
| `edit` | `id`, `text` | the comment's author only | replaces text; sets `edited: at` |
| `delete` | `id` | author, owner, editor | tombstones a comment (text cleared); deleting a thread's first comment hides the thread |
| `resolve` / `reopen` | `id` (thread) | owner, editor, annotator, commenter | sets `resolved: { by, name, at }` / clears it; repeating is a no-op |
| `move` | `id` (thread), `anchor` | thread author, owner, editor | re-anchors |
| `react` | `id` (comment), `emoji`, `on` (bool) | owner, editor, annotator, commenter | sets or unsets (comment, user, emoji); repeating is a no-op |

- **Anchor:** `{ point: {x, y} }` or `{ stream: "board" | "notes", element, x, y }`. An element anchor follows the
  element; if it's deleted, clients show the thread at `x, y` marked detached. The room doesn't check the element
  exists (it may not yet).
- **No-ops are accepted, logged and acked.** A repeated `resolve`, `reopen` or `react`, a `delete` of something
  already deleted, and any `reply`, `edit`, `react`, `resolve`, `reopen` or `move` on a **dead target** (a deleted
  comment or a hidden thread) get a `seq` and an `ack` like any op and change nothing (a no-op `reply` doesn't
  even reserve its `id`). These are ordinary races (a moderator deletes while 200 people react), so nobody is
  refused or resynced for them. `applyEntry` decides "no-op" from the state alone, so replay agrees.
- **Still refused:** a target id that never existed (`bad-op`), a reused id (`bad-op`), no right to do it
  (`forbidden`; rights are checked before the no-op test, and a tombstone still knows its author), a cap (`limit`). The client only drops that op from its pending overlay (rule 5).
- **Authors come from the entry's `by`**, never from the payload. `id`s are client-made strings (≤ 64), unique per
  board: reusing one is `bad-op`.
- **Author names.** Every `records` entry carries `name`: the sender's verified display name when the room
  accepted the op (from Auth's identity, ≤ 200 chars, may be null), never from the payload. Comments, threads and
  `resolved` keep it, so a comment shows its author after they leave. It is the name at write time: a later
  rename doesn't change old comments. Reactions keep user ids only.
- **Reactions set, never flip.** The UI toggles; the wire says `on: true|false`, keyed by (comment, user, emoji),
  so resend and replay land the same. Reactions are on comments only.
- **Caps:** text 1–10,000 chars; ≤ 10,000 threads per board; ≤ 500 comments per thread; ≤ 20 distinct emoji per
  comment; emoji ≤ 32 chars; and the 20 MB `records` cap (§ Limits). Over → `limit`.
- **Shape in snapshots:** `records: { threads: [{ id, anchor, by, name, at, resolved?, comments: [{ id, by, name,
  at, text, edited?, deleted?, reactions: { emoji: [user…] } }] }] }`.

## Tenancy

- A board belongs to exactly one tenant, set by `POST /boards`. Board ids are server-minted and **globally
  unique** (`b-` + 16 of `[a-z0-9]`), so the server resolves the tenant from the board id alone; no client message
  names a tenant.
- **Tenants are created by an operator** in M2 (`createTenant`). A first sign-in from a Workspace domain never
  creates one; a user whose domain has no tenant is a guest everywhere.
- **Everyone signs in with Google.** A share-link guest signs in first, then redeems the link: there are no
  anonymous guests, so every connection has a verified `user`.
- **Roles** (computed by Auth from the Registry): the highest of an explicit grant on that board (the creator gets
  `owner`), a live invite to the user's **authoritative email**, a live share link the user redeemed, and — for a
  member of the tenant's Workspace domain (the `hd` claim, never the email) — the board's **`memberRole`**, set at
  `POST /boards`, default `viewer` (a reversible choice; `null` = members get nothing by membership). A user from
  another domain gets a role only by grant, invite or link on that very board. No role → `auth`.
- **Highest wins:** a grant below `memberRole` doesn't lower one member. To lower a member, lower `memberRole`.
- **Authoritative email** = an email Google is authoritative for: the ID token has `email_verified` true **and**
  either the email ends in `@gmail.com` or the token has an `hd` claim equal to the email's domain. A gmail
  address does not skip `email_verified`. Only an authoritative email matches an invite. Any other email (a
  consumer account's verified third-party address, with no `hd`) may have changed hands since Google checked it,
  so it claims nothing; that user needs a grant or a share link.
- **Compared lower-cased.** Emails, `hd` and invite addresses are trimmed and lower-cased before any comparison,
  so an invite to `Ann@Example.com` matches `ann@example.com`. `@googlemail.com` is not treated as gmail: such an
  address is never authoritative (it has no `hd`), so that user needs a grant or a share link.
- **`owner`:** the board's creator gets it at `POST /boards`. After that, **only a tenant admin may grant
  `owner`**; invites, share links and `memberRole` never give it. This is enforced by the admin layer
  (server/admin), not by the Registry. A board always keeps at least one owner (§ Registry).
- **`POST /boards`** takes its tenant from the caller's verified identity (their Workspace domain's tenant),
  never from the request body, and the caller must be an **admin of that tenant** (server/admin checks it again).
  A caller with no tenant (a gmail user, a guest) gets `forbidden`. Admin calls that name only an id
  (`invite(id)`, `revokeInvite`, `revokeLink`, `setGrant`, …) must first check that the id's board belongs to the caller's tenant.
- Every log entry, checkpoint, blob and bus subject is keyed by the board's tenant: Store keys
  `(tenant, board, seq)`, blobs `(tenant, sha1)`, subjects `plen.<tenant>.<board>.*`.
- Nothing a client sends can reach another tenant: `hello` names a board (the server finds its tenant), record
  anchors and element ids are board-local, and a blob URL is minted only for a board the requester has a role on,
  in that board's tenant.

## Ports

All ports are async (Promises; QuickJS has them). The room imports none of them directly; the server passes them in.

### Auth

- `verify(token) → { user, name, email, domain } | null`, then `role(identity, board) → role | null` (computed
  from the Registry, § Tenancy).
- **Auth errors.** Resolving `null` = **refused**: the gateway answers `auth` and closes (close reason `auth`).
  A **throw** = an infrastructure error (the Registry or session store is down): the gateway answers
  `unavailable` and closes; the client keeps its pending ops and retries with backoff (rule 12), without signing
  in again. `Registry.board` follows the same split: `null` = `auth` (rule 7), a throw = `unavailable`. So an
  outage never looks like a lost permission, and a refusal is never retried blindly.
- The gateway awaits both, plus `Registry.board(board)`, **before** it forwards the hello: a room sees only verified
  `{user, name, role, client}`.
- The role holds for the connection's life; revoking it closes the user's connections (M6 detail).

### Registry

Tenants, boards, grants, invites and share links. Platform owns its implementation (server/auth/registry.js); the
method names are stable. Ids are server-minted over `[a-z0-9-]`.

| Area | Calls |
|---|---|
| tenants | `createTenant({ domain, admins })`, `tenant(id)`, `tenantByDomain(domain)` (Workspace domain → tenant), `addTenantAdmin(tenant, user)` |
| boards | `createBoard({ tenant, title, memberRole }) → { id, tenant, title, memberRole, createdAt }`, `board(id) → { tenant, title, memberRole, … } \| null` |
| grants | `setGrant(board, user, role \| null)`, `grant(board, user) → role \| null`, `grants(board)` |
| invites | `createInvite({ board, email, role, expiresAt, by })`, `invite(id)`, `invites(board)`, `invitesFor(board, email)`, `revokeInvite(id)` |
| share links | `createLink({ board, role, expiresAt, by })` (role per link), `link(id)`, `links(board)`, `revokeLink(id)`, `addLinkUse(link, user)`, `linkUses(board, user)` |

Single node: SQLite; cluster: Postgres. The room never calls it; gateways and Auth do. On Postgres the server
runs as a role that doesn't own the schema (§ Store, Least privilege).

- **At least one owner per board, atomically.** It is **`Registry.setGrant`** itself that refuses to remove or
  downgrade a board's last owner. Removing or demoting an owner (`setGrant` to a lower role or
  `null`) must leave at least one `owner` grant on that board, and the last-owner check and the change must be
  **one atomic step** (one transaction, or a conditional delete/update), so two concurrent removals can't both
  pass. The call that would remove the last owner fails and changes nothing. Every durable adapter (phase 3/4)
  must honour this.
- **`createBoard` takes no creator**, so `POST /boards` is `createBoard` then `setGrant(board, creator, "owner")`:
  two calls. If the second fails, the endpoint must retry it or report the failure with the board id; it must not
  report success for a board with no owner.
- **A crash between the two calls** leaves a board with no owner, and nothing retries it. That board is still
  safe and usable: roles come from `memberRole`, invites and links as usual, and only a tenant admin could grant
  `owner` anyway. A tenant admin repairs it with `setGrant(board, user, "owner")` (they manage every board of
  their tenant). Guaranteed: no ownerless board is reported as created. May happen: an ownerless board until an
  admin repairs it.
- `memberRole` may be `null` (§ Tenancy). Calls keyed by an id alone carry no tenant: the admin API checks it
  (§ Tenancy).

### Store

The log, checkpoints and each board's epoch (boards live in the Registry).

| Call | Contract |
|---|---|
| `append(tenant, board, entries, expectSeq)` | atomic: writes every entry or none, only if the board's last `seq` is `expectSeq`; else throws `conflict` |
| `read(tenant, board, fromSeq, limit) → entries` | ascending `seq` |
| `putCheckpoint(tenant, board, cp)`, `getCheckpoint(tenant, board, beforeSeq?) → cp \| null` | the highest `seq` wins, never the last write; `beforeSeq` finds the one before a bad checkpoint |
| `openEpoch(tenant, board) → epoch` | durable atomic increment of the board's epoch in its lease record (1 on first call); every room build calls it before its first `welcome` (§ Recovery, Room identity). Phase 4's lease acquire does the same increment in the same step |
| `epoch(tenant, board) → epoch \| 0` | reads it (gateways, for a viewer's `welcome`); 0 = no room was ever built, sent as `room.epoch: 0` |

- **Durable** = resolves only once the write survives a process crash and power loss on its node (SQLite
  `synchronous=FULL`; Postgres commit with `synchronous_commit=on`).
- **One sequencer, fenced at storage:** `append` is conditional on `expectSeq`. A unique `(tenant, board, seq)` key
  stops a `seq` being reused, but not a gap: the adapter must also check, in the same transaction, that the
  board's last `seq` equals `expectSeq`. A host that lost its lease, or is behind, gets `conflict` on its next append, stops, and answers
  `unavailable`; it never acks. Leases decide who *should* sequence (phase 4); the conditional append makes sure
  only one *can*. A checkpoint a fenced-off host wrote is caught at rebuild (§ Recovery).
- A room may batch several entries in one append (group commit; § Recovery, resolved vs speculative). It has one
  append in flight at a time, acks and broadcasts only after it resolves.
- **Least privilege (Postgres; the Registry too).** A server must be able to start as a role that can read and
  write the tables but does **not own the schema**. DDL is a separate **migrate** step run by an owner role
  (`plenary migrate`, or the operator's own migrations), or is skipped when the schema already exists: start-up
  looks each table and index up (`to_regclass`) and creates only what's missing, so a role without DDL rights starts
  against a migrated schema (Postgres checks the privilege before `IF NOT EXISTS`, so a blanket `CREATE … IF NOT
  EXISTS` would fail). A role that owns the schema (dev, CI, compose) may still create everything on first start. A
  single-node SQLite store creates its own file and tables, as today.

### Bus

- Tenant and board ids are server-minted (`[a-z0-9-]`, no `.`, `*`, `>`), never a domain name, so subjects can't
  collide or wildcard across tenants.
- Subjects per board: `plen.<tenant>.<board>.entries` (the room, after an append resolves), `.presence`, `.emotes`
  and `.here` (gateways), `.inbox` (gateway → room, numbered per connection: rule 6), `.gw.<gateway>` (room →
  that one gateway: `welcome`, `ack`, `error`, each addressed to a `conn`), and `.grants` (whoever changes the
  board's grants, invites or links → gateways: `{ board }`; each gateway computes its connections' roles again and
  closes the ones that lost access or changed role). Gateway ids are server-minted like the others.
- **At-most-once.** Entries carry `seq`, so a gateway that sees a gap reads the missing range from the Store and
  delivers in order; duplicates are dropped by `seq`. Presence has no repair.
- **A lost last entry is repaired two ways.** While it runs, the room publishes a `{ seq, epoch }` **heartbeat**
  (resolved seq, the room's epoch) on `.entries` every 2 s. And a gateway that has heard neither an entry nor a heartbeat for
  **5 s** on a board it serves reads the Store from its last delivered `seq` + 1, and again every 5 s while the
  silence lasts. The poll needs no room, so it also works after the room stopped or its host died (viewers never
  restart a room). Guaranteed: every connected client gets every resolved entry, in order, within about 5 s of
  the bus going quiet. Delivery to clients is effectively at-least-once, eventually consistent.
- A gateway subscribes to the board's subjects **before** it forwards a hello or serves any catch-up, so
  nothing between catch-up and live is missed.
- Gateway → room messages on `.inbox`: a hello or op as `{ n, conn, gateway, user, name, role, client, msg }`; a
  close notice as `{ n, conn, gateway, closed: true }`; and, every 5 s, `{ gateway, conns: [conn…] }` listing that
  gateway's open writer connections on the board (rule 6). A lost close notice is repaired by the next list; a
  lost reply by rule 2's or rule 12's timeout.
- **Message size: 2 MB cap.** A deployment's bus must carry 2 MB messages (NATS: raise `max_payload`; headers
  count toward it). What travels:
  - **Never on the bus:** catch-up and snapshots. The gateway reads them from the Store (or its cached tail) and
    sends them straight to the client (rules 3, 8). A room never publishes catch-up frames on `.gw.<gateway>`.
  - **`.inbox`:** one hello or op plus its envelope. An op is ≤ 1 MB (§ Limits), so it always fits. A gateway
    that still can't publish one answers `too-large` with the op's `id`.
  - **`.entries`:** a group commit's entries are published as one or more messages, each under 2 MB, in `seq`
    order. A single entry always fits (one op plus its fields). Gateways deliver by `seq`, so a split batch is
    the same as several appends.
  - **`.gw.<gateway>`:** `welcome`, `ack`, `error` only (small).
  - Guaranteed: no message the protocol needs is over the cap. A publish refused anyway (misconfigured bus) is
    repaired like a lost message: Store poll for entries, the client's timeouts for replies.
- Single node: an in-memory bus with the same contract. Cluster: NATS core.

### Blobs

- `put(tenant, sha1, bytes)`, `get(tenant, sha1) → bytes | null`.
- **No token on HTTP.** A client asks over its socket: `{ t: "blob", sha1, put?: true }`; the server checks the role
  and answers `{ t: "blob", sha1, url }`, a signed URL scoped to (tenant, board, sha1, GET or PUT), valid 5 minutes.
  Works for `<img>`, browsers and Herdr alike, and keeps the token out of headers and URLs.
- **`sha1` is exactly 40 lowercase hex characters.** Anything else is answered `bad-op` (an `error` with no `id`)
  before the server signs anything or calls Blobs, so no adapter ever sees a key like `../other-tenant/x`.
- **Rates:** `blob` requests 10/s per connection; put URLs 30 per minute per user per board. Over → `error`
  `limit` with no `id` (nothing is dropped; ask again later).
- **A signed PUT URL ends at our server**, never directly at S3: the server must hash and type-check the bytes
  before they are stored.
- Upload needs write on `board` or `notes` (not `records`: commenters can't place images); reading needs any role
  on the board. The server hashes the bytes and refuses a mismatch; cap **10 MB**; per-tenant quota (§ Limits);
  images only (PNG, JPEG, GIF, WebP; SVG refused). Put is idempotent: the first bytes for a hash are kept.
- Bytes never travel in ops. A blob is stored once per tenant, shared by that tenant's boards.

## Known limits of v1.1

- **`layers` is one key.** Two editors changing layers at once no longer lose one silently: the second gets
  `stale-setting` and its app re-applies the change on the current list. Still per key, not per layer: editing
  two different layers at once conflicts, and a change the app doesn't retry is lost (the user is told).
- **Seeding's silent band.** After an import renumbers an element (over 1,000 and new to the board) to version 1,
  a pane that still holds the file's old copy can write it back. A copy at 1,001 or just above (within 1,000 of
  the room's version) is accepted and undoes later edits to it without a word; anything higher is held back with
  a warning. drawh warns at import time.
- Within a tenant, a guest with a role on one board can read another board's blob if they know its SHA-1.
- **SHA-1 keys, first put wins:** a tenant writer able to make a chosen-prefix collision could plant bytes another
  user's image later resolves to. Small in practice; the fix (key by SHA-256, keep `fileId` as a lookup) is open.
- Blobs are never garbage-collected; only the quota bounds them.
- Tombstones are never compacted; the stream caps count them.
- **The log grows forever in M2** (never pruned).
- **Durability is per Store node** (§ Store): losing that node's disk, or failing over to a replica that lags,
  can lose acked entries. Replicated durability is M7.
- **Big boards join slowly:** the caps allow a snapshot over 100 MB, which doesn't fit 100k joins in 2 minutes.
  Unmeasured; M4's load test sets the real cap.
- **The op rate is per gateway:** a user connected through G gateways can write up to G × 8 connections × 20
  ops/s. The connection cap (8 per user per board) is per gateway too.
- **Blob quota:** any writer, guests included, can fill the tenant's quota at the put rate (300 MB a minute).
  Per-user quotas are M6.
- **Checkpoint bodies aren't checksummed** by the protocol (the pure package has no hash in every runtime); a
  damaged body is the Store adapter's to detect. The whole log is kept, so a rebuild from 0 always works.
- **Author names on comments are the name at write time** and stay in the log.
- **Secondary Workspace domains can't claim invites by email:** `hd` must equal the email's domain (§ Tenancy), so
  a Workspace user whose address is on a secondary domain has no authoritative email. They still get `memberRole`
  through `hd` and can use share links.
- Signed blob URLs from inside Herdr's runtime are untested (does a mod get plain HTTP GET/PUT?).
- Not yet run inside Herdr's QuickJS runtime.

## What phase 2 changes in packages/protocol

This list is phase 2's (v1) as built. Where v1.1 differs (append timeout 4 s, op depth 62, op cap in bytes,
settings bases, `welcome.room`), the v1.1 code job changes it after phase 2 lands.

Phase 2 stays pure (no Store, Bus or socket code). `test/purity.test.js` rejects these substrings anywhere in
code (comments excepted): `TextDecoder`, `TextEncoder`, `Buffer`, `process`, `require(`, `window`, `document`,
`setTimeout`, `setInterval`, `fetch(`, `structuredClone`. So names like `windowSize`, `processAppend` or
`ringBuffer` fail it (use `W`, `recentMax`, `applyEntry`), and nothing may start a timer: every timeout and the
pacer take an **injected clock** (`tick(now)` or a `now` argument).

- **Phase 2's Room still answers every hello itself**, viewers included, with `welcome` and catch-up from its own
  resolved state: it plays room and gateway in one, so tests need no gateway (`protocol.test.js:9` relies on a
  viewer's hello). The catch-up is built by exported pure functions that phase 3's gateways call.
- **Phase 3:** async ports, gateways (catch-up for viewers and writers, the per-user op queue, `here`, `blob`,
  emote sums, heartbeat and Store-poll repair, close notices and connection lists), the Registry and real stores.

| File | Change |
|---|---|
| `envelope.js` | split `ELEMENT_STREAMS` (`board`, `notes`) from `STREAMS` (adds `records`); element checks only for element streams; new writer table (`notes` without `commenter`, `records` with it); `recordProblem(op)`; op id format (`client:counter`, positive safe integer) and `sentAt` (integer ≥ 0); `PROTOCOL_VERSION = 1`, `RULES_VERSION = 1`; constants W, H, eviction period, caps, rates (op rate 20/s, burst 100), timeouts (10 s, append 5 s, backoff); an absent element counts as version 0 for the jump cap (no first-write exemption); `fileId` and `sha1` format (40 lowercase hex); `opProblem` refuses an op nested deeper than 64 levels (`bad-op`; checked without recursion, so a deep op can't overflow the stack) |
| `room.js` | Doc loops over `ELEMENT_STREAMS` only, records kept apart; `applyEntry(entry)` shared by live ops and replay; op-id table per § Op ids (`high`, `last`, `recent`, eviction every 1,024 `seq`, `horizon`, both `stale` rows); resolved vs speculative state with a pluggable append (sync MemoryLog in phase 2, but the code path awaits so phase 3 is a drop-in); dedupe on in-flight waits; records state and checks; stream caps; `checkpoint()` replaces `compact()` (folds resolved state, trims the kept tail) and `Room.rebuild({ checkpoint, entries, … })` with the entry-S check; welcome adds `high`, `horizon`; entries add `at` (injected clock) and `rv`; snapshot adds `records`, `noteAuthor`; remove `transient`; checks `v` on hello; takes `{user, name, role}` from the hello context instead of calling `auth.check`; per-connection `n` check; `unavailable` for an op from a connection not welcomed in this incarnation (a rebuilt room knows none); a close notice and a gateway's connection list drop `n` state (the 30 s gateway silence rule takes an injected clock); refusals and `stale` decided against unresolved entries are held until those resolve, and become `unavailable` if one fails; append timeout 5 s (injected clock); checkpoint check compares `id`, `by`, `at`; `welcome.rv`; `name` on `records` entries; record no-ops (repeats, dead targets) are logged and acked with no state change; exported pure `applyEntry` (no sequencing) and checkpoint → snapshot (drops `clients`, keeps tombstones) for gateways |
| `replica.js` | Doc loops over `ELEMENT_STREAMS`; sends `v: 1`; wait for `welcome`, then resend once; never resend on a live connection; 10 s timeout sets `resync`; `sentAt` per op; new ops wait for catch-up to `welcome.seq`; settle by entry `id` + `by`; error table (refusal vs `stale` vs `unavailable`/`auth`); forgotten-client early drop with a count of unconfirmed ops; records state with pending overlay; `local()` no longer takes `transient` (previews become `presence` messages, no counter used); **`local()` normalizes on send** (each element's `version` = highest known for that id, confirmed or pending, + 1; fresh `versionNonce`); **`receive()` returns what it applied** (so the UI can patch instead of redrawing); **`reset()` keeps pending ops overlaid** (no flicker during a resync); a since-0 resync is "close and reconnect", signalled to the caller, never a second hello; a refusal on `records` only removes that op from the overlay (no reset); **pacer** for every send, resends included (token bucket, injected clock; the 10 s op timeout starts when the op leaves the pacer); hello → `welcome` and catch-up timeouts, backoff with jitter (rule 12; the random source is injected too); drops pending ops when `welcome.user` changes; stops on an unknown `rv`; tracks `noteAuthor` |
| `ports.js` | `MemoryLog` grows `read(fromSeq)`, conditional `append(entries, expectSeq)` (throws `conflict`), checkpoint put/get with `beforeSeq`; the v0 `Auth` and `Log` typedefs are replaced by the v1 port typedefs; `tableAuth` stays for tests, returning `{user, name, role}` per board. `MemoryLog` is one board's log (no `tenant, board` arguments): phase 3 hands the room a per-board view of the Store with this same shape, so it is an adapter, not the Store port itself |
| `codec.js` | unchanged |
| `presence.js` (new) | `presenceProblem`, rate limiter and coalescer (pure, clock injected); unit-tested in phase 2, relayed by gateways in phase 3 (the room never sees presence). Ships the emote set `EMOTES` = 👍 ❤️ 😂 🎉 👏 😮 🙏 🔥 |
| `records.js` (new) | the `records` state (`Records`): threads, comments, reactions, tombstones; `check` against the speculative state before logging, `apply` on live entries and replay alike (no-ops for dead targets), snapshot shape `toJSON()`; pure, shared by the room and the replica |

The v1.1 changes (§ What changed in v1.1) land after phase 2, as their own code job; its file-by-file list is in
docs/m2/reports/p1-v11.md.

Tests (PLAN.md phase 2 done-when, plus what this spec adds):

| Test | Proves |
|---|---|
| rebuild equals original | a room rebuilt from MemoryLog (with and without a checkpoint) deep-equals the original: streams, `appSeq`, records, op-id table, note authors, `seq` |
| resend after restart | an acked op resent to the rebuilt room gets the same `ack`/`seq`, nothing logged |
| note ownership after restart | an annotator is still refused on another's note |
| no gap, no reuse | the next entry after a rebuild is log end + 1; a conditional append with a stale `expectSeq` throws `conflict` |
| bad checkpoint | a checkpoint whose entry S doesn't match the log (or is past its end) is skipped; rebuild still equals the original |
| convergence with a restart mid-run | the existing convergence test, with the room rebuilt from the log mid-run |
| op-id bound | > 256 resends → `stale`, never logged twice; eviction after H; **eviction between welcome and resend → room answers `stale`** (H1); forgotten client drops and resyncs |
| group commit | with a deferred append: a resend of an in-flight op waits and gets the same `seq`; welcome/snapshot/checkpoint show only resolved state; a failed append drops speculative state and nothing is acked (H2); a refusal that depends on an unresolved entry is held, and becomes `unavailable` when that append fails |
| connection gap | a missing `n` → `unavailable`, connection dropped, nothing logged out of order |
| nesting depth | a 30,000-deep op is refused `bad-op` (no crash, nothing logged); 64 levels pass |
| unknown connection | after a rebuild, an op from a connection welcomed by the old room → `unavailable`, nothing logged, and its later resend of an earlier op is not `stale`; a close notice or a connection list without it drops that connection's `n` state |
| normalize on send | a 5,000-move drag then one send is accepted (version = known + 1); seeding an element with version 9,999 sends version 1; a raw first write above 1,000 is refused |
| pacing | 250 pending ops resent after `welcome` leave at the rate (100, then 20/s by the injected clock), none refused, all acked; the op timeout counts from the send |
| resync | a refusal on an element stream signals close-and-reconnect with `since: 0`; `reset()` keeps pending ops visible; `receive()` returns what it applied |
| timeouts | no `welcome`, or no catch-up progress, for 10 s → reconnect with growing, jittered waits (injected clock and random) |
| user change | pending ops are dropped when `welcome.user` differs |
| records | threads, replies, edit/delete by role, resolve, set/unset reactions idempotent on resend and replay; repeats and dead targets are logged no-ops, acked, identical on replay; a refused record op leaves the overlay with no reset; author `name` kept; caps |
| presence (unit) | shapes checked, over-rate dropped, coalescing keeps the latest; a presence message sent to a room is refused and never logged. The relay test is phase 3 |
| version | `v: 2` → `version` error |

Tests that change:

- `protocol.test.js:14` "roles…" sends ids `client:x-board`: under v1 the id is checked before the role, so it
  would get `bad-op` where the test expects `forbidden`. Give it integer counters.
- `protocol.test.js` "previews are relayed…" becomes "a presence message sent to a room is refused and never
  logged" (the room no longer relays anything; the relay test is phase 3).
- `protocol.test.js` "catch-up…" (line 49) calls `compact()`: becomes `checkpoint()`.
- `protocol.test.js` "pictures travel by id…" (lines 60, 62, 64) sends ids `c0:f`, `c0:e`, `c0:s`: non-integer
  counters. Shape is checked before the id (§ Limits), so `:60` still gets `no-files` and `:64` still fails on
  shape, but give all three real `client:counter` ids so each passes for the reason it names.
- `protocol.test.js` "no hello, no ops; a refused token gets nothing" (the room no longer checks tokens: the gateway
  stand-in in world.js does).
- `holes.test.js:94` uses ids `${client}:${JSON.stringify(appState)}` and `holes.test.js:107` uses
  `${client}:${raw}`: give both integer counters, or they pass for the wrong reason (`bad-op` for the id, not the
  appState).
- `holes.test.js` "no one can lock an element with a huge version" keeps sending its bad op raw (as it does
  today): through `Replica.local()` the version would be normalized and the test would prove nothing.
- `holes.test.js` "hello for another board, or a token from another tenant…" (tenant now comes from the board's
  role, not the token's tenant).
- `test/world.js`: wait for `welcome` before resending, `sentAt`, new room construction, a rebuild helper, `n` per
  connection.
- `convergence.test.js` calls `compact()`: becomes `checkpoint()`.

## Open questions for the CEO

1. **Durable reactions by viewers?** v1 says no: viewers send emotes (live, summed, not saved); comments and
   reactions need commenter or above, keeping 100k viewers off the sequencer. Yes would need a per-board cap.
2. **Commenter = records only?** v1 narrows `commenter` to comments and reactions (v0 also let it write notes).
3. **Blob reads within a tenant:** is "anyone with a role on some board of the tenant who knows the hash" acceptable,
   or must blobs be per board (more storage, no cross-board dedupe)?
4. **Names saved with comments:** v1 stores the author's display name on each comment when it is written, so it
   still shows after they leave. It stays in the log and doesn't follow a later rename. OK, or should names be
   looked up live (needs a directory of past users)?
