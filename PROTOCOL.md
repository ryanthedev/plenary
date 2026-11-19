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
| Gateway rate | one bucket per (user, board) | one bucket per connection, the same as the client's pacer; ≤ 8 writer tabs and ≤ 2 writer connections per tab per (user, board) per gateway (§ Messages, `hello.tab`) |
| Append timeout | 5 s | **4 s**, so two appends (an op queued behind the one in flight) finish inside the client's 10 s (§ Recovery) |
| Bus | "nothing bigger than one op" | catch-up and snapshots never travel on the bus; `.entries` batches are split under 2 MB (§ Bus) |
| Postgres | (unstated) | a server starts as a role that doesn't own the schema; DDL is a separate migrate step (§ Store) |
| `POST /boards` | owner gap unstated | (v1.1) caller must be a tenant admin; a crash between the two calls is repaired by a tenant admin (§ Registry). Since #48: `board.create` at the target Space, or the caller's personal space (§ Spaces and Groups) |
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
| writer tabs per (user, board) | ≤ 8 per gateway, ≤ 2 connections per tab; a ninth tab or a third connection of one tab gets `limit` (no `id`) and is closed (§ Messages, `hello.tab`) |
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
- **Connections per user:** a gateway holds at most **8** writer tabs per (user, board), and at most **2** writer
  connections per tab (§ Messages, `hello.tab`). A writer `hello` for a ninth tab, or a third connection of one
  tab, gets `error` `limit` with no `id` and is closed. The client keeps its pending ops, tells the UI ("too many
  open tabs on this board"), and retries with backoff (rule 12; it counts as a failed attempt). So one user writes
  at most 16 × 20 ops/s through one gateway. A connection counts until the gateway sees it close.
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
| `hello` | `v: 1`, `token`, `board`, `since`, `client`, `tab?` | first message; the token travels here, never in a header (Herdr refuses credential headers). `client` = name + per-session part, no colon, ≤ 128 chars. `tab` = the browser tab this connection belongs to (§ Messages, `hello.tab`). Unknown `v` → `version`, closed |
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
| `here` | `writers: [{ user, name, role }]` (≤ 50), `writerCount`, `viewers` (count) | who's on the board (§ Presence); sent on change, at most 1/s (every 5 s on big boards); without `writers` when only a count changed |
| `emotes` | `counts: { emoji: n }` | viewers' emotes summed per 500 ms |
| `blob` | `sha1`, `url` | a signed URL, 5 minutes, one blob, one verb |
| `error` | `id?`, `sha1?`, `code`, `message` | codes below; `sha1` only on a refused `blob` request (§ Blobs) |

Error codes, and what the client does:

| Code | Meaning | Client |
|---|---|---|
| `forbidden`, `bad-op`, `no-files`, `too-large`, `limit` | refusal of that op (`limit` = a content cap, never the rate) | rule 5: drop it; on an element stream, resync; on `records`, nothing more |
| `stale-setting` | a settings op whose `appBase` isn't current (§ The element op, Settings); nothing logged | drop it from the pending overlay only: no reset, no resync; tell the app, which may retry on the current base |
| `stale` | not logged now; maybe logged earlier (§ Op ids) | drop it from pending; resync once after resends |
| `unavailable` | room moving or stopped, a gap on the way in, a connection this room never welcomed, a full gateway queue, or sign-in could not be checked right now | keep every pending op; reconnect with backoff (rule 12) |
| `auth` | bad token, unknown board, no role, or no hello yet; the connection is closed | keep pending ops; sign in again, then reconnect |
| `version` | unknown protocol `v` | stop; the app must update |

An `error` with no `id` is not about an op (a `blob` request, which also carries its `sha1`: `bad-op`, `forbidden`, `limit`, `unavailable`; a ninth writer
tab or a third connection of one tab: `limit`, then closed; an op frame with no readable id: `bad-op`; or a connection-wide `unavailable`,
`auth`, `version`): nothing pending is dropped for it. Each ends: a `blob` refusal ends with that request (ask
again later); a connection-level one ends the connection, and the client reconnects with backoff (or signs in
again, or stops, per the table).

### `hello.tab`

A client may name the browser tab a connection belongs to, so the gateway counts tabs, not connections. A tab
outlives its connections: a reconnect, or a resync (always a new connection, rule 5), opens a new one while the old
one may still be closing.

- **Format.** `tab` is optional; when present it is a string matching `/^[A-Za-z0-9_-]{1,32}$/` (`TAB_RE` in
  envelope.js). Anything else (empty, too long, another character, not a string) is a bad hello: `error` `bad-op`,
  closed, as for a bad `client`. The web client mints 16 base-36 characters per tab and reuses them for the tab's
  life. The gateway never forwards `tab` to the room: it is a gateway-only count.
- **No `tab` = its own tab.** A hello without `tab` (Herdr, drawh, older clients) counts as a tab of its own, one
  per connection, which is how every connection counted before.
- **What a tab is.** The pair (user, tab) on one board, on one gateway. Two users can't share a tab: the same `tab`
  string from two users is two tabs.
- **Writer cap: tabs.** A gateway admits at most **8 distinct writer tabs per (user, board)**. A writer hello that
  would open a ninth tab gets `error` `limit` with no `id` and is closed (the client's handling is in § Pacing). A
  further connection of one of the 8 tabs is not a ninth tab and passes this cap. This replaces the count of 8
  writer **connections** in § Limits and § Pacing.
- **Writer cap: connections per tab.** At most **2** writer connections per (user, board, tab) on a gateway; a
  third gets the same `limit`, no `id`, and is closed. **Why both caps:** `tab` is chosen by the client, so with
  the tab cap alone one tab could hold any number of connections and each would get its own op bucket (§ Pacing),
  undoing the per-user bound. Two connections cover the honest overlap (the new connection opens before the
  gateway has seen the old one close). Together: one user holds at most 8 × 2 = 16 writer connections per board
  per gateway, so writes at most 16 × 20 ops/s through one gateway.
- **Viewers** are not capped per tab (they write nothing and their connections reach no room); they are counted by
  tab in `here` (§ Presence).
- **When a tab stops counting.** When its last connection on that gateway closes (§ Pacing says when the gateway
  sees a dead one close: within 30 s). Counts are kept per gateway; nothing about tabs travels on the bus beyond
  the `viewers` number.
- **Guaranteed:** an honest client (one tab id per tab, at most one reconnect in flight) with ≤ 8 tabs on a board
  is never refused for tabs or connections per tab, beyond § Pacing's 30 s for a dead socket. A reconnect of an
  existing tab is never refused for the 8-tab cap. **May happen:** a tab that reconnects twice while its first
  socket is still half-open (not yet closed by § Pacing's 30 s rule) is refused `limit` on its third connection and
  gets in on a later retry; the same tab connected through two gateways during a reconnect counts as two tabs, one
  on each.

### Joining

What a join costs, and how it is kept small. A join (rule 8) sends, in order: `welcome`, then catch-up, then `here`.
Catch-up is **the latest checkpoint's `snapshot` when the client's `since` is older than it, then the `entries`
after it** (a client already past the checkpoint gets entries only). Two things bound its size:

1. **The tail is short.** The room folds a checkpoint by bytes as well as entries (§ Recovery, "When"), and a gateway
   re-bases its cached tail on it as soon as the heartbeat names it (§ Bus, `cp`). So a join is the snapshot, plus a
   tail of at most the larger of 64 KiB and about a third of the snapshot (the fold waits for a quarter of the *current* state, which includes the tail; test/server/join-size.test.js checks the bound), plus a few more entries until the next heartbeat.
   `entries` frames hold at most 1 MiB each, so a long tail is several frames.
2. **Compressed catch-up (optional, per connection).** A client that can inflate zlib connects to `/ws?z=deflate`.
   The gateway then sends each **shared** catch-up text (the snapshot, and every `entries` frame holding at least 4 KiB
   that is not a client-specific cut) as one **binary** WebSocket frame holding a **zlib (RFC 1950) stream** of exactly
   the bytes the text frame would have had: the client inflates it, reads the result as UTF-8 JSON, and handles it as it
   would that text frame. Everything else (`welcome`, `here`, live `entries`, `ack`, presence, a small or incompressible
   text, a client's own cut of a chunk, a text with no settled compressed form when the join is sent) stays a text frame.
   That is: a text the compressor declined, failed on, or found too small; and a snapshot or chunk whose compression had
   not settled because a checkpoint re-based the feed during the join's own wait (the join then sends the new base's texts
   plain, once, until a join compresses them). The gateway compresses a
   text **once** and every joiner of that checkpoint shares the result, on a thread-pool thread, never the event loop.
   **Frames stay in order:** a client delivers a text frame that arrives behind a binary one only after the binary one
   is inflated and handled.

   **The open last chunk** (the tail's newest `entries` frame, which grows with every entry) is never compressed
   as it stands: a new entry would make the text stale before it could be sent. Its compressed form is a **prefix**: the
   chunk's entries up to the seq the deflate started at, made once and shared. A join sends that binary frame, then the
   entries after it, up to the feed's seq when the join is sent, as one small plain `entries` text frame cut for that join. Entries landing while the deflate runs, or after it, only lengthen the plain
   cut; no retry and no stale text. The prefix is made again only after 16 KiB (`zSlack`) of newer entries, so a busy
   board costs one deflate per 16 KiB of ops (never one per entry or per join), and a chunk that closes meanwhile is
   sent as its prefix plus the plain rest until the next join compresses it whole. The plain cut is therefore at most
   `zSlack` plus the entries that landed while the join waited (its snapshot deflate and the feed's queue); a chunk that
   closed meanwhile with no settled prefix sends its rest plain, up to `chunkBytes`. The newest *settled* prefix of each
   chunk is kept (per chunk start), so a newer deflate still in flight never hides it from a join that waited for it.

   - **Negotiation is the query, nothing else.** `z=deflate` is a capability, not a credential (the token still goes
     only in `hello`). No `z`, or any other value, means every frame is text: Herdr's mods (QuickJS has no zlib), drawh
     and older clients are untouched. A gateway with no compressor sends text to everyone. A server never sends a
     binary frame to a connection that did not ask.
   - **A frame that fails to inflate** is a bad frame to the client: it drops the socket and reconnects (a new
     connection), as for any frame it cannot decode.
   - **Why not `permessage-deflate`.** It is the standard transparent way, and Bun's server has it, but it compresses
     per message per socket: measured on a 0.94 MB snapshot, 3.0 ms of server CPU per join (dedicated) or 2.8 ms (shared
     compressor) against 0.36 ms for sending a text compressed once; at 100k joins in 2 minutes (833 per second)
     that is about 2.5 cores of deflate per second against 0.3, and it would also compress every live frame per
     socket (100k × a small deflate per broadcast entry) unless each send opts in. Sharing one compressed frame
     needs the compression to happen above the WebSocket layer, hence this frame. A deployment may still put a
     proxy that does `permessage-deflate` in front: the frames then are just bigger text frames.
   - **Cost to the client.** One `DecompressionStream("deflate")` per binary frame (browsers: Chrome 80, Safari 16.4,
     Firefox 113). The web client enables it when the runtime has one.
   - **Measured** (M2 join test, boards built as a user builds them: 100 shapes per op, then single-shape moves; shapes
     of about 430 bytes of JSON, identical but for position and seed; plain text, then compressed): 2,000 shapes in 20 ops,
     0.86 MB → 0.03 MB; 2,000 shapes and 2,000 moves, 1.1 MB → 0.04 MB; 10,000 shapes, 4.3 MB → 0.14 MB. Those are the
     best case (near-identical elements). **A varied board** (random 2-decimal coordinates, ids and seeds, colours, words,
     arrows with bend points; `variedShapes` in test/server/join-measure.js, 2,000 elements): without freehand, 1.1 MB →
     0.15 MB (**7×**); with 30% freehand strokes (40 to 160 points each), 2.2 MB → 0.6 MB (**3.7×**). Expect **about 4× to 7×**
     on real boards, and hundreds of KB (not tens) for 2,000 elements; strokes' coordinates and pressures barely compress.
     `JOIN_REPORT=1 bun test test/server/join-size.test.js` prints the table. A plain join (no `z`) is the same size as
     before for an insert-only board, since a checkpoint can't be smaller than the shapes it holds; folding more often
     only bounds the replay of ops that rewrite what the state already holds.

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
7. **Boards exist only by `POST /boards`** (Registry `createBoard`; who may call it: § Spaces and Groups). A `hello` for an unknown board is refused with
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
- **When.** A join is the latest checkpoint's snapshot plus the log after it (§ Joining), so the room folds when
  that tail is long, in entries or in bytes: after **1,000 entries** (`CHECKPOINT_EVERY`), or once the ops logged
  since the last checkpoint reach **64 KiB** (`CHECKPOINT_BYTES`; the host's `tailFoldBytes`), whichever comes first;
  and **not before those bytes reach a quarter of the state's size** (`CHECKPOINT_STATE_RATIO` = 4; the state is the
  snapshot plus what the tail changed, so for an insert-only board the tail reaches a third of the previous snapshot,
  `tail >= (snapshot + tail) / 4`). The last bound is
  what a rewrite costs: a checkpoint is about the size of the state, so a fold per quarter-state of log writes at
  most about **4×** the log's bytes in checkpoints (measured about 2× to 3× on boards built by many ops; the join test asserts under 5×),
  however often the board changes; and a small board (state under 256 KiB) is rewritten at most once per 64 KiB of
  log, never per op. The consequence for the tail: it is about the larger of 64 KiB and a third of the snapshot
  (in op bytes; the entries' envelopes add about a quarter), plus what was logged while the fold was being written and
  announced. (The entry count only brings a fold forward once the byte gate is met, so it does not bound the tail by itself.) (An insert-only board folds to
  about its own size, so its join is about the log's size either way; the folds pay off when ops rewrite what the
  state already holds: moves, resizes, deletes. Compression, § Joining, is what shrinks the rest.) Also when the
  room is stopped cleanly. The checkpoint is of the **resolved** state at one `seq` S (with entries still unresolved
  too: only resolved ones are in it), taken in small steps ("Incremental fold", below); the write is asynchronous.
- **Incremental fold** (decided 2026-11-19, TECH-DEBT row 39; `packages/protocol/fold.js`). A checkpoint of a big board
  must not hold the event loop (every board on the host waits), so the fold is a job of steps, each bounded.
  - **Shadow room.** For one job the room builds a second, log-less room (the *shadow*) from its current checkpoint, and
    drops it when the job ends or is abandoned (nothing resident between folds: a resident shadow held a third copy of
    the op-id table and the comment threads, 57.9 MB at 4,000 clients x 256 pairs). The shadow applies only **resolved**
    entries, through the same `applyEntry`. A job picks S = the room's resolved seq, catches the shadow up to
    S from the kept tail (`tail[0]` is `base.seq + 1`), then copies the shadow's state into the checkpoint. The job never
    reads the live state, so ops that land mid-job (accepted, appended, acked, broadcast) change nothing it copies, and
    unresolved entries merged into the live state are never in it. The checkpoint is exactly the state at S by
    construction, not by locking.
  - **Cost.** Element objects are never mutated once stored (`Doc.apply` replaces by id), so the checkpoint shares them
    with the shadow: the copy is of references, not of the board. The checkpoint also takes the shadow's op-id arrays
    (the shadow dies with the job). Work is counted in units: an element reference or a client's op-id pair = 1; an entry
    applied = 16 + its op's chars / 16 (applying stringifies and clones what the entry carries, so **bytes** are the cost,
    not element counts; calibrated on point-array strokes, which cost 2 to 3 times more per char than text); a thread = 1 +
    its comments. A step stops after `FOLD_STEP_UNITS` (8192; the host's `foldUnits`), so about 128 KB of op text per
    step. **One entry is indivisible**, so an entry over that is a step of its own: the ceiling of a step is the cost of
    the largest entry in the tail (an op is at most about 1 MB). Measured by `scripts/fold-bench.js` at load ~10 to 30:
    the longest step is 0.5 to 1.7 ms at 10, 27 and 50 MB; 1.0 ms for a tail of 1,500 strokes of 8 KB (120 steps); 0.9 ms
    with 4,000 clients x 256 pairs (254 steps); and 5.4 ms (about 8 ms per MB of op) when the tail holds 660 KB point-array
    strokes, each its own step (before byte-counting a 20-entry 600 KB-stroke tail made one 78 ms step). Heap kept after a fold with 4,000 clients: 0.2 MB (the
    old whole-state fold: 10.4 MB, as the bench measures it). The shadow's own size bookkeeping is off (`measure: false`).
  - **Scheduling is a port.** The package has no timers and runs in QuickJS: the room takes `schedule(fn)`, which runs `fn`
    on a later turn of the host's loop. The host passes `setImmediate` (its `schedule` option; tests pass a queue). With no
    `schedule` an automatic checkpoint runs whole, in one call, as `checkpoint()` does (a clean stop, tests).
  - **Failure.** One job at a time, and none starts while the previous checkpoint's write is unsettled (a slow Store sees
    at most one write in flight). The host fails a write unanswered for `checkpointTimeoutMs` (30 s) and reports it, so
    `writing` always settles and later folds resume (Postgres also bounds the fence's lock wait with `lock_timeout`).
    `status()` shows `folding` and `writing`. `base` and the tail change only when a job completes, so catch-up and joins are served
    from the old base until then. A room that stops (`fail`: lease lost, a fenced write, a failed append) or a host slot
    that dies abandons its job: no step runs, nothing is written. A `checkpoint()` call that takes a running job over
    invalidates the steps already scheduled for it (a turn token), so one chain steps a job. A takeover while a job runs is the same fence as before:
    the write at the end carries the old epoch and is refused `fenced` in the Store's own transaction (§ Store). A job
    that throws is reported (`checkpoint-failed`), dropped with its shadow, and the next job rebuilds the shadow from `base`.
  - **Encoding.** The adapters encode a checkpoint in slices too (`server/encode/sliced.js`, the same text as
    `JSON.stringify`, the loop handed back every ~256 KiB; a thread's comments are pieces of their own): 21 ms at 50 MB became under 3 ms. The Store port is unchanged.
  - **Options weighed.** (a) *Persistent / copy-on-write Doc*: O(1) snapshot, but `Doc` lives in `packages/core`, which is
    never edited here, and a wrapper would leak into every reader of `byId`. (b) *Copy a slice per tick against an overlay of
    later changes*: needs the pre-image of every change since S, including the unresolved entries already merged into the
    live state (elements, appState, records, op-id table, note authors, eviction): an undo log across five structures,
    easy to get subtly wrong. (c) *Encode in a Worker from a structured clone*: the clone is the O(n) block, QuickJS has no
    Worker, and a port for it would still need (a) or (b) underneath. (d) *Shadow replica* (chosen): reuses `applyEntry`
    (already the proven replay path), hides the whole mechanism behind `checkpoint()` / `startCheckpoint()` and the
    `schedule` port, and costs memory about equal to what the old fold held (live state plus the base).
  - **Order of a checkpoint's elements** is now the shadow's insertion order, not paint order. Readers still sort by layer
    and z (`Doc.live()`), but it breaks z ties by array position, so for equal z the paint order of a client loaded
    from a snapshot follows this insertion order (it did follow paint order before).
- **Checkpoint parts** (decided 2026-11-19, TECH-DEBT row 40; `server/encode/cp-parts.js`, the two Store adapters). The fold and
  the encoding are bounded, so the Store's own write must be too: `bun:sqlite` inserts a row in one synchronous call, about
  4 ms per MB (mostly the fsync under `synchronous=FULL`), which held the loop 87 ms at 10 MB, 138 ms at 27 MB and 226 ms at 50 MB (`scripts/fold-bench.js`, `sqlitePutMaxStallMs`, load ~16). With parts the longest stall is
  13.5 to 16 ms at 10, 27 and 50 MB, 15.8 to 19.6 at the worst of two runs, measured at load ~43 (one part's fsync plus the WAL's automatic checkpoint every few parts; `wal_autocheckpoint` 64 to 1000 made no clear difference). The Store
  port is unchanged; the adapters store a checkpoint whose JSON text is longer than one part (`PART_CHARS` = 1 Mi chars,
  option `partChars`) as parts. A checkpoint that fits one part is still one row of plain JSON, as before.
  - **Format.** Part rows in their own table (SQLite `checkpoint_parts`, Postgres `pl_checkpoint_parts`): `(tenant, board, seq,
    wid, n, data)`, `wid` a random id of one write attempt (two writers of one `seq` never share rows), `n` from 0. The
    checkpoint **exists only when its header row** is in the checkpoints table under its `seq`: the text
    `\u0001cp-parts 1 <wid> <parts> <chars>`. No JSON text can start with `\u0001`, and a one-row checkpoint starts with `{`, so a
    reader tells them apart with no migration. Old databases read as before; only the new table is created (SQLite at open,
    Postgres by `migrate`, deploy/README.md). A binary from before parts cannot read a header (its `getCheckpoint` throws on it and the board won't open), so a rollback past this change first deletes the header rows (SQLite: `DELETE FROM checkpoints WHERE data LIKE char(1) || 'cp-parts%'`; Postgres: the same with `E'\x01cp-parts%'`); the log has everything, so the boards rebuild from older one-row checkpoints or from 0.
  - **Write.** Encode in slices (above), cut into parts (never between the halves of a surrogate pair), then one transaction per
    part, **each fenced** (SQLite: the lease epoch read in the write transaction; Postgres: `FOR SHARE` on the lease row), the
    loop handed back between parts; then **the header's transaction**: fenced again, it checks that all `<parts>` rows of
    `(seq, wid)` exist (else `unavailable`: a sweep took one), inserts the header (the first write of a `seq` is kept, as before), and prunes
    to the newest `keepCheckpoints`. So a fenced holder stops at its next part and can never make a checkpoint visible after a
    takeover; a crash or abort before the header leaves the previous checkpoint the newest, readable, untouched; a timed-out write
    that still runs only ever adds a checkpoint at its own `seq`, so it can't hide a newer one (the highest `seq` wins).
  - **Orphans.** Parts no header names are swept: by the writer after its header (the loser of a same-`seq` race, and the
    parts of checkpoints pruned just now), by a writer that aborts or is fenced (its own parts, no fence needed to delete them), and by the
    next checkpoint's sweep for a crash's (the sweep is `orphanGroups`: unnamed groups not newer than the newest header; a newer
    group may be a write in flight). A write overtaken by a newer checkpoint may find its parts swept and fail `unavailable`: it was
    stale anyway. **A delete never races a header:** every delete is conditional in its own statement on no header naming the write (SQLite: `NOT EXISTS` on the header row, one statement is atomic; Postgres: the same, run in a transaction that holds a per-board advisory lock, which the header's transaction takes too, so a header that commits while a sweep is yielding keeps its parts and a sweep that wins first makes the header's part count refuse; the sweep's transaction is bounded like every write, `lock_timeout` `leaseLockTimeoutMs` and the idle cut, and gives up quietly: the next write sweeps again; the header's own wait past it is `unavailable`, "the checkpoint lock is held"). SQLite deletes a part per statement with the loop handed back between.
  - **Read.** The header names the parts; they are read one by one and joined (SQLite hands the loop back between parts), the
    total length checked against the header (`corrupt` if not). A part a concurrent prune removed makes the read look again (up to 3 times); a header whose parts stay missing is a bad checkpoint and is skipped, so the caller gets the next one below it (rebuild and the feed step back the same way). The adapters report each skip through their `onSkip` option (`{ tenant, board, seq }`); `server/main.js` logs it as an error, "checkpoint unreadable: parts missing; stepped back".
    Decoding the JSON itself is still one call (rebuild and gateway feeds only; § Known limits).
  - **Why SQLite's parts table has a rowid.** Counting a write's parts on a `WITHOUT ROWID` table walks every row's text (15 ms for 50 x 1 MB);
    with a rowid the key lives in a narrow index and the count is free.
  - **Options weighed.** (a) *Incremental blob I/O on one row* (`sqlite3_blob_write`): one atomic row, but `bun:sqlite` has no blob handle and one
    commit would still fsync the whole file. (b) *Smaller `synchronous` for checkpoints*: breaks "an acknowledged op is never lost" for their data and
    the one-row visibility guarantee. (c) *Write the checkpoint to a file and store its name*: a second durability domain, no atomicity with the lease fence, and
    it doesn't exist for Postgres. (d) *Parts + header row* (chosen): per-part fence, atomic visibility, one format for both adapters, old rows still readable.
    Postgres's own stall (the driver turns the whole text into bytes in one call: 11 ms at 27 MB, 20.5 at 50 MB, measured) fell to 5.5 and 7.7 ms with parts.
- **A checkpoint may lag the live `seq`.** Between a fold and the gateways learning of it (the write's
  acknowledgement, then the next heartbeat's `cp`, ≤ 2 s) a join is served from the older checkpoint with a longer
  tail: slower, never wrong. A checkpoint that can't be read, or doesn't match the log (see Rebuild), is skipped for
  the one before it, and for the empty board last: the log has everything (M2 never prunes), so the join is longer,
  never short of an entry.
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
  Not the checkpoint, because checkpoints are written asynchronously, only now and then (§ Recovery, "When"), and the
  highest `seq` wins. A rebuild that wrote no checkpoint, or fell back past a bad one, would repeat an epoch.
- **How gateways learn it.** A writer's `welcome` comes from the room, which knows its epoch. For a viewer's
  `welcome` the gateway uses the latest epoch it knows. The room puts `epoch` in its `.entries` heartbeat
  (`{ seq, epoch, cp }`, § Bus), and a gateway with no heartbeat for the board yet reads the lease record from the
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

**Stuck host (#65): a host that is alive but not progressing is replaced through the lease, never by a second arbiter.**
The Store lease stays the only authority. The room host (`server/room-host.js`) stops *renewing* a board it cannot
serve; the lease then lapses by its own ttl and a waiting host takes it by the ordinary `acquire` (§ Bus, "The heartbeat,
exactly"). Defaults: `leaseTtlMs` 10,000, `appendTimeoutMs` 4,000, `storeTimeoutMs` 10,000, `stuckMs` 8,000 (2 x
`appendTimeoutMs`), `heartbeatMs` 2,000, renew every ttl/3 (3,333 ms).

| # | What is stuck | Before #65 | Now | Room stopped within | A waiting host holds the lease within |
|---|---|---|---|---|---|
| a | the whole process (event loop blocked, SIGSTOP) | renews and timers cannot run; the lease lapses by its ttl; on waking the host sees `expired` at its first timer or inbox message and stops without answering | unchanged. A block of about `stuckMs` (6 s or more, with ops waiting) can also trip the watchdog on waking, before the deadline check: the writers then hear `unavailable` (1013) and reconnect, the same outcome | on waking (the lease is already gone) | last renew + ttl + margin (about 10.2 s); a waiter also tries at its own silence (2 heartbeats = 4 s) but is refused until the lapse |
| b1 | one board's `append` never answers | `withTimeout` 4 s failed the room | unchanged | `appendTimeoutMs` (4 s) | the stop + at most 10 s (renewing stops with the room; the lease lapses ttl after the last renew, which was before the stop) |
| b2 | a Store call of the **build** (`getCheckpoint`, a `read` page) or of `acquire`/`lease` never answers | **unbounded**: renew kept succeeding, the lease was held forever by a room that never opened, `open` never settled | each call is bounded by `storeTimeoutMs`; a build that times out stops renewing and **releases** (a failed build, not a lost lease) and then publishes `{ seq: 0, epoch, cp: 0, released: true }` on `.entries`, so a host already watching the board tries the lease at once (no wait for its next poll) | `storeTimeoutMs` (10 s) per call | the stop + one Store round trip (release, then the `released` message); if the release fails: + ttl |
| c | sequencing stalled: ops are waiting (`inflight` + `queued` + `held` > 0) and the resolved `seq` has not moved | only the append and checkpoint timeouts, which a skewed wall clock or a Store call that never reaches the room could defeat | **progress watchdog**: each heartbeat tick compares the resolved `seq`; no movement for `stuckMs` while work waits stops the room (`lost`: never `release`, an append may be in flight) | `stuckMs` + `heartbeatMs` = 10 s at most | + ttl |

- **The progress watchdog** runs on the host's `monotonic` clock and `timers` (never the rooms' `now`), on the heartbeat
  tick (`heartbeatMs`). It records `{ seq, at }` per room; the record resets whenever nothing waits or `seq` moved. An idle
  room is never stuck: it cannot trip the watchdog. A slow Store is not stuck either: any append that lands moves `seq`.
  `stuckMs` should exceed `appendTimeoutMs`; if it does not, a slow but live Store is cut early (safe, only noisy). It defaults to 2 x `appendTimeoutMs`, so raising `appendTimeoutMs` raises it too; the host logs the effective `stuckMs`, `appendTimeoutMs`, `storeTimeoutMs` and `leaseTtlMs` once at start (`room host: stuck-host bounds`).
- **What stopping does.** `lost`: the room fails, every connection it welcomed hears `unavailable` (close 1013) and
  reconnects, renewing and the deadline timer stop, and nothing is released (a release could hang with the Store, and the
  lapse is enough).
- **Cooldown: a stuck host never retakes its own board at once.** `acquire` grants a lease to the holder that already
  holds it, and gateways call `open` on every writer hello, so without a rule the stuck host would re-acquire its own
  still-live lease (epoch + 1), hang again, and the waiting host would never get the board. After a **stuck stop** (the
  progress watchdog, an append timeout, a build timeout) the host puts the board in a **cooldown of `leaseTtlMs` + margin**
  (margin = max(20, ttl / 50) ms) on its monotonic clock, counted from the stop. During it `open` does not claim: it reads
  the lease (bounded by `storeTimeoutMs`), watches the board and resolves "watching", and a waiting host's own attempt also
  does not claim; the hello is answered `unavailable` once the heartbeat is silent. The stop came after the last renew, so
  the lease has lapsed when the cooldown ends. Another host that holds the board is untouched by it; if none does, this host
  takes the board when the cooldown ends. A lost lease for any other reason (renew refused, fenced, host deadline) has no
  cooldown: the board is already someone else's or free. Cost: a single node (no other host) is also unavailable for the cooldown (10,200 ms at the defaults) after a stuck stop. The first `open` after it starts the retake at once (an `open` that finds the watch calls the attempt; the watch's own poll, every ttl/3, is only the fallback), and the writer's next reconnect is served: 10,200 ms + two reconnect intervals. Its writers get `unavailable` and reconnect meanwhile.
- **No acknowledged op is lost.** An op is acked only after its append resolved *and* the lease was still within its host
  deadline (§ Recovery, append). A stuck host that wakes has two defences: its own deadline check (`expired`) and the
  Store's epoch fence. Every write the host makes carries the lease epoch and is checked **in the write's own transaction**:
  `append`, `putCheckpoint` (small, each part, and the header; SQLite reads the lease epoch in the write transaction,
  Postgres takes `FOR SHARE` on the lease row), so after a takeover (`acquire` raises the epoch) the old host's write is
  `fenced` and writes nothing. `renew` and `release` are conditional on holder **and** epoch and are no-ops against a
  newer holder. The host has no other Store write. An entry the old host made durable but never acked stays in the log;
  the client resends it unacked and the new holder deduplicates it by op id (§ Op ids).
- **What clients see.** A stuck room's writers get `unavailable` and reconnect (rule 12); their pending ops are resent
  and deduplicated. Viewers lose nothing: gateways repair from the Store (§ Bus). A `hello` while no host serves the board
  is answered `unavailable` by a waiting host once the heartbeat is silent for 2 heartbeats.
- **A timed-out `acquire`.** The Store may still have applied it: the lease then sits held by this host with no renew and
  lapses by its ttl; the next `acquire` by the same holder raises the epoch again. The host never trusts an answer that
  arrived after its timeout.

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
  - **What is counted.** A writer is a user with an owner, editor, annotator or commenter connection; `writerCount`
    counts users (a user's tabs count once). `viewers` counts viewer **tabs**: distinct (user, tab) pairs with a
    viewer connection on the board, per gateway (§ Messages, `hello.tab`), summed over gateways. Two connections of
    one tab (a reconnect overlapping its old connection) count once; two tabs count twice; a hello without `tab`
    counts as its own tab, so such connections count one each. Each gateway de-duplicates only its own: a gateway
    can't de-duplicate 100k viewers across gateways without lists, and the bus message must stay small. **May
    happen:** the same tab on two gateways during a reconnect counts twice, until the old gateway sees its
    connection close.
  - **Merging.** Each gateway keeps the latest `.here` message per gateway id (its own included) for 15 s. Users in
    the merged lists appear once (their highest role and latest `active`); `writerCount` = those listed users plus,
    for each gateway, its writers it couldn't list (its `writerCount` minus its list). Exact while every gateway's
    list is complete (≤ 50 writers each); past that, a user connected through two gateways may count twice.
  - **Pacing.** A gateway publishes on `.here` when its own numbers change, at most once a second, and at least
    every 5 s. It sends `here` to its clients when the merged answer changes, at most once a second, and to a
    joiner right after its catch-up. **Big boards:** where this gateway holds more than 1,000 connections on the
    board, it sends `here` at most every 5 s (a 50-writer `here` is ~4 KB; 1/s to 100k viewers would be 400 MB/s).
    Sending to many connections yields to the event loop as it goes; one send at a time per board.
  - **Count-only `here`.** When only `writerCount` or `viewers` changed, `here` leaves out `writers`; a client keeps
    its last list and names (an explicit list, even `[]`, replaces them). A joiner's first `here` always carries the
    list. (At 100k connections a 50-writer list every second would be ~400 MB/s; counts alone are tens of bytes.)

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
- **Roles** (computed by Auth from the Registry; § Organization, after this list, widens the sources to Spaces, Groups, Teams and the
  Unit, and is the rule today): the highest of an explicit grant on that board (the creator gets
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
  (server/admin), not by the Registry. A board always keeps at least one owner (§ Registry). The design also lets a
  Space or Group owner grant `owner` inside it (the `transfer` permission, § Organization); that is enforced when the
  routes for it exist, and until then only a tenant admin may.
- **`POST /boards`** takes its tenant from the caller's verified identity (their Workspace domain's tenant),
  never from the request body, and the caller needs **`board.create`** at the target Space or uses their personal space
  (§ Spaces and Groups; it was tenant-admin-only before #48). A caller with no tenant (a gmail user, a guest) gets `forbidden`. Admin calls that name only an id
  (`invite(id)`, `revokeInvite`, `revokeLink`, `setGrant`, …) must first check that the id's board belongs to the caller's tenant.
- Every log entry, checkpoint, blob and bus subject is keyed by the board's tenant: Store keys
  `(tenant, board, seq)`, blobs `(tenant, sha1)`, subjects `plen.<tenant>.<board>.*` (prefixed on the wire by the cluster id, § Bus).
- Nothing a client sends can reach another tenant: `hello` names a board (the server finds its tenant), record
  anchors and element ids are board-local, and a blob URL is minted only for a board the requester has a role on,
  in that board's tenant.

### Organization (Units, Groups, Spaces, Teams)

Boards are organized as **Unit > Group > Space > Board**. Design: design/orgs/JOURNEY.md (§ 1, 2). The Registry stores it
(§ Registry, "Organization"); the resolver below turns it into access. The routes and pages are § Home, § Spaces and Groups and § Teams and access.

- **Unit** = today's tenant, plus a `kind` label (`company` | `enterprise`) and **one or more Workspace domains**
  (`tenant.domains`; `tenant.domain` stays the first). A domain belongs to at most one tenant. Units don't nest, so the
  tenant wall (store keys, blob keys, bus subjects) is unchanged. A Unit **member** is an identity whose `hd` is one of
  its domains.
- **Group**: a named shelf of Spaces (one level: Groups don't nest). **Space**: holds boards; it sits in one Group or at
  the Unit root. Both carry **general access**: `generalRole`, the role "everyone in the Unit" gets (members only, never
  `owner`; null = only people added). A board keeps its own general access in `memberRole` (§ Tenancy above): the same
  meaning, widened. A board lives in at most one Space (`board.space`; null = *unfiled*, which is every board made before
  Spaces existed).
- **Personal space**: a Space with an `owner` (one per member per Unit, made by `ensurePersonalSpace`), private
  (`generalRole` null), the member its owner. **Team**: a named set of Unit members.
- **A Team's membership is a grant.** Adding someone to a Team gives them each role the Team holds, so changing membership (and deleting the Team) needs the caller to be able to grant
  or revoke each of those roles at each of those scopes, unless they are a Unit admin (§ Teams and access). No `team.manage` holder can reach a role through a Team they could not grant directly.
- **Scoped grants**: a role for a user or a Team on a Unit, Group, Space or board (`setScopedGrant`). A user's own grant on
  a board stays in `grants` (`setGrant`), so the room's path and the last-owner rule are unchanged. A Group or Space keeps
  at least one `owner` grant (a user's or a Team's), atomically, like a board (the Unit's admins are the backstop and aren't counted).
- **Roles are named sets of permissions; the server checks permissions, never role names.** Built-in, fixed: the ladder
  `viewer < commenter < annotator < editor < owner` at Group, Space and board scope, and at the Unit **admin** and
  **member** (member is editable). A **custom role** (per Unit) carries exactly **one board-content ladder role**
  (viewer..editor) plus management permissions; it is made by duplicating a built-in role and can be granted at any
  scope. Only the ladder role reaches a room: **a connection gets one ladder role**, as before.

**Permissions** (`server/auth/permissions.js`): `board.view`, `board.comment`, `board.annotate`, `board.edit` (board content:
cumulative up the ladder) and the management permissions `board.create`, `space.create`, `group.create`, `members.manage`, `move`, `delete`,
`transfer`, `roles.manage`, `team.manage`. A role held at a scope gives its permissions *within that scope* (a role on a container
covers everything inside it), clipped to what exists there: `roles.manage`, `team.manage` and `group.create` only at the Unit; `space.create` at the Unit
and Groups; `board.create` at the Unit, Groups and Spaces; a board has only the ladder plus `members.manage`, `move`, `delete`
and `transfer`. Built-ins: `owner` = the four content permissions plus `board.create`, `space.create`, `members.manage`,
`move`, `delete`, `transfer`; `editor` = content plus `board.create`, `space.create`; `annotator`, `commenter`, `viewer` =
content only; Unit `admin` = every management permission, `team.manage` included (and board content only where the deployment sets
`adminBoardContent`, below); Unit `member` = `space.create` until an admin edits it.

**Resolution** (`server/auth/resolver.js`, pure). An identity's access to a board (or to a Space, Group or the Unit) is
the **union** of what every source grants; for the ladder that is the highest. There are **no deny rules**, so a board
is never more private than its Space. Sources, each reported with where it came from, in this order (the order only orders
the report: a union has no precedence). The code is the truth; this list is read from it:

1. **direct** and 2. **team**, scope by scope from the target outward (board, then its Space, then its Group): the user's
   own grant on that scope, then a grant to a Team the user is in (the source names the Team). A user's own grant on a
   board is the `grants` table; every other scope's are scoped grants.
3. **general**: "everyone in the Unit" on the board (`memberRole`), the Space and the Group, for Unit members only.
4. **invite**: a live invite to the user's authoritative email (board scope; role capped below `owner`).
5. **link**: a live share link the user redeemed (board scope; within viewer, annotator, editor).
6. **unit**: Unit admin (the tenant's `admins`), then grants on the Unit (the user's, then their Teams'), then the Unit
   member role for members.

**Who is on a Space, Group, the Unit or a Team.** A **member** is an identity whose `hd` is one of the Unit's domains; only
members get general access and the Unit member role. **Inside** = a member, or a Unit admin named by user id (the
operator vouches for them; it is what lets a Unit with no domain, such as a dev tenant, have a Space owner). Only the
inside hold Space, Group and Unit grants and Team grants: for anyone else the resolver skips every one of them, so **a guest
holds only board-scope sources**: a direct grant on the board, an invite or a link, whatever rows the Registry holds. The
Registry cannot tell a guest (membership comes from `hd` at sign-in and is not stored), so this read-time rule is the
enforcement, and a scoped grant or Team membership written for a guest is inert, not an error. `admin` and `member` are not
grantable: a scoped grant of either is ignored (admin comes only from `admins` and its guards, member only from membership).

**Permissions are clipped where they are asked.** A role held at a scope covers what is inside it, but a permission means
something only at some targets, so every source's permissions are cut to the target asked about: a Unit admin asked
about a board has no `roles.manage`, and a plain member asked about a Group or Space has no `space.create`. The Unit member
role's management permissions apply only when the target is the Unit itself; creating a Space in a Group needs a role on
that Group (JOURNEY J4).

The answer is `{ ladder, permissions, sources, until }`: `ladder` is the one role the room gets (null = none = `auth`),
`permissions` the union, each `source` is `{ kind, scope: { type, id }, role, team?, permissions, ladder }` (the UI's
"Viewer via Infra team on Space Platform"), `until` the soonest invite or link expiry (the answer can change then
without a message). Stored roles are never trusted: an unknown role, a role not valid at its scope, an `owner` through
general access, invite or link counts for nothing or is capped. **Unit admin and rooms:** today an admin manages every
board of the Unit but enters a room only through a role. The resolver keeps that (admin's board-content permissions and
ladder `owner` are off unless the deployment sets `adminBoardContent`: `PLENARY_ADMIN_BOARD_CONTENT=1`, read by
server/main.js and given to `tenancy` and `roleCache`), so no one's access changes by upgrading.

**Defaults.** A personal space is private (`generalRole` null) and its owner owns it. A new Space gives `viewer` (its
creator may pick none). A new board in a Space has `memberRole` null, so it **inherits** the Space; a board made without
a Space keeps today's `memberRole` default (`viewer`).

**Migration.** Adding the organization changes no one's access. The Registry only *adds* tables (§ Registry,
"Organization"); existing tenants read as `company` with their one domain, existing boards stay unfiled with their
`memberRole`, grants, invites and links untouched, and no Space, Group, Team, scoped grant or role exists until someone
creates it. So the resolver's answer for every identity on every pre-existing board is the old rule's. Re-running
start-up is a no-op. test/auth/legacy-migration.js proves it on SQLite and Postgres. Unfiled boards are a state, not a
rule: a later backfill may file them into one per-Unit legacy Space (`generalRole` null, no grants), which adds no source,
so access stays the same (test/auth/org-access.test.js checks that equivalence).

**Freshness.** The resolver reads live; `.grants` (§ Bus) is per board. A change to anything the resolver reads above a
board (a scoped grant on a Space, Group or the Unit; a Team's grants or membership; a Space's or Group's general access or
its Group; a custom or member role; a Unit's domains or admins) therefore reaches live connections only if it is announced
for **every board it reaches**, or else on the next timed re-check (≤ 60 s; a cached hello role within the cache's 30 s).
The Registry lists what is needed, in bounded pages, so no route has to guess:

- `boardsIn(scope)`: the board ids in a Space, a Group (its Spaces') or a Unit, by id, `{ ids, next }` per page (default
  500, at most 1000).
- `scopesOf(subject)`: the scopes (with the role) a user or Team holds a grant on, paged the same way.
- A cursor (`after`) must be a previous page's `next` (a board id; or `<type>\n<id>`). A **malformed cursor is refused**
  (the call rejects with "registry: bad cursor"), never read as "start over", so a caller looping on `next` can't spin
  forever; an unknown but well-formed one is just a position.

How the routes of #47 and later announce: after the write succeeds, a change **on a scope** pages `boardsIn(scope)` (a
board scope is that one board) and publishes `{ board }` on each board's `.grants` subject; a **Team membership change**
(`setTeamMember`) pages `scopesOf({ type: "team", id })` and announces each scope's boards the same way; a **role edit** announces `boardsIn` of the Unit (which scopes use a role is not indexed); a change to the **Unit**
(domain, admin, Unit grant, member role) does the same. Each announcement is a plain `.grants` message, so the gateway's existing one-pass-at-a-time rule bounds the work;
announcing is best-effort like every bus message, and the timed pass repairs a lost one. The gateway's role cache holds a
board's chain (its Space, Group and tenant records) for at most its `ttlMs` and drops it on `.grants`.

### Home (the read API behind the Home screen, #47)

Design: design/orgs/JOURNEY.md (J1, J5, §4 [home], §5). Code: `server/auth/home.js` (core), routes in `server/auth/http.js`,
Registry calls below. All routes authenticate like every other route in http.js: `Authorization: Bearer <session or dev token>`, no cookie.

- `GET /home` → `{ guest, user, unit, recent, starred, owned, shared, tree, limits, can: { createGroup, manageAccess, manageRoles } }`. A Unit member's first `/home` makes their personal space (`ensurePersonalSpace`, idempotent), so it is always in the tree; `can.createGroup` = the caller holds `group.create` at the Unit root (false for a guest); `can.manageAccess` = the caller holds `members.manage` at the Unit (the page then links the Unit's access page; false for a guest).
  - `guest`: true when the caller has no Unit (`tenantOf` null: a gmail user, a domain with no Unit, and every dev-token user without a
    domain, so the README "Try it" users are guests). A guest gets **Recent, Your boards (`owned`) and Shared with me (`shared`)**
    (JOURNEY J1): `starred` is `[]` (no Starred: a guest's star is refused, 403), `tree` is null, `unit` null, and the page offers no "New board".
  - `recent`: the last 12 boards the person opened (newest first). `starred`: up to 50, newest star first (members only). Each is a list of
    **cards**: `{ id, title, role, path, starred, at? }`. `role` = the ladder role the person holds now. `at` = when it was opened (recent) or
    starred (starred).
  - `owned` ("Your boards", guests only; `[]` for a member): up to 50 boards the guest holds a direct **owner** grant on, by title, with an empty `path`. A member's
    owned boards are already in their Spaces and the tree. `shared` ("Shared with me"): up to 50, by title. **Shared means** boards the person
    reaches through a source on the board itself (a direct grant, a grant to a Team they are in, a live invite to their email, a link they redeemed;
    `Registry.sharedBoards`) and, for a member, whose place the tree doesn't already show: boards in a Space they can open, and boards in
    no Space in their own Unit (listed under "Other boards"), are not repeated in Shared. An owned board in a Space the member can't open does show in Shared. All of it is
    filtered by what the resolver says they can open now, so an expired invite or revoked link vanishes.
  - **Names are access.** `path` names only what the person can open: `[{ type: "group", id, name }, { type: "space", id, name }]` for a Space (and
    Group) they can open boards in; any Space or Group above a board they reach another way is replaced by the neutral
    `{ type: "shared", name: "Shared with you" }` (a Group they can't open is dropped when the Space is open); a board in no Space is
    `{ type: "other", name: "Other boards" }` for a member of its Unit, else "Shared with you". A guest never sees another Unit's Group or Space names.
    The check is the resolver's own answer for the Space / Group (`accessMany`, below), not a stored flag.
  - `tree` (members): `{ groups: [{ id, name, spaces: [{ id, name, personal }] }], spaces: [...Spaces in no Group, or in a Group they can't open], other: { boards: [{ id, title }], more }, more }`.
    Only Spaces and Groups the person can open boards in appear. `other`: the unfiled boards they can open (up to 20; `more` true if more exist or the scan stopped).
    `tree.more`: true when the page of Space candidates (100), the Group candidates (50; one more is asked for to tell), or the grant checks (40 Spaces, 20 Groups) left something out. "Other boards" is a pseudo-group for the boards made before
    Spaces existed: one constant (`OTHER` in home.js), so a later migration into a legacy Space removes it in one place.
  - `limits`: the caps in force, so the page needs no copy of them.
- `GET /home/search?q=<text>` → `{ q, results, more }`. `q` trimmed, 1-100 chars (else 400). Members: boards of the person's Unit whose **title** contains `q`,
  or whose Space name contains `q` **and the person can open that Space** (an unopenable Space's name is no search key), plus matching titles among `owned` and `shared`.
  Matching is **ASCII case-folding only** (`A-Z`; other letters compare as written; `%`, `_` and `\` literal) on every adapter. At most 20 results. Work is bounded: up to 2
  windows, each examining the next 1000 boards of the Unit (`searchBoards`' `scan`) and returning EVERY match in it (checked 200 at a time). **`more` is true only when a 21st
  openable match exists or the window ended before the Unit did**: never because of how many matches the person can't open, so a hidden Space's name (or a pile of hidden boards)
  gives the same answer as a query that matches nothing. `searchBoards`' `next` likewise depends only on the window, never on the match count.
  A board the person cannot open is never returned, whatever it is called. Guests: matching titles among `owned` and `shared`.
- `GET /home/search?space=<id>` → `{ space, results, more }`: one Space's boards the person can open (by id, up to 50), for the tree's click. `space` is `{ id, name }` only when the
  person can open the Space itself, else null (a board reached another way still lists, under "Shared with you"). It reads at most 3 pages of 200 boards. `more` is true on a 51st openable card, or, for a Space they can open, when
  the pages ran out; for a Space they can't open it is only the card overflow, so a hidden Space (any size) answers exactly like an unknown id or another Unit's Space: `{ space: null, results: [], more: false }`. `space` with `q` is 400.
- `PUT /home/stars/:board` / `DELETE /home/stars/:board` → 204. Starring needs a Unit and a role on the board (a guest, a board with no role and an unknown board all get the same 403 `forbidden`);
  unstarring is always allowed and idempotent.
- **Recent is written by the server**, not the page: when a gateway welcomes a connection it calls `markOpened(user, board)` (debounced per user and board for 60 s per gateway, best
  effort). Under a join storm the write is **bounded**: at most 16 writes in flight per gateway; a welcome that finds 16 running is dropped (counted, one log line per minute), never queued. One
  row per (user, board); only the newest 50 per user are kept, **atomically** (Postgres serialises one member's writes with a transaction advisory lock).

**"Boards I can open", efficiently.** The listing never asks the resolver once per board in the Unit. Every list is built from a *candidate* query that is bounded in SQL (recents ≤ 30
rows, starred ≤ 60, shared ≤ 60, a search window of ≤ 1000 examined boards, ≤ 2 windows) and the candidates then go through ONE batch, `tenancy.accessMany(identity, ids)`:
`Registry.boardRows(ids, { user, email })` (SQLite 7 statements, Postgres 6, for the whole batch, however many boards: boards, the user's grants, Team grants on the boards, the user's Teams among
them, invites to their email, link uses, the links) plus **one `accessContext` per distinct Space (or Unit, for unfiled boards)** among the candidates, then the pure `resolveAccess` per board, and
once per distinct Space and Group from the context already in hand (no more reads) for `spaceOpen` / `groupOpen`, which the path rule above needs. So a page of N candidates costs 6-7 batch statements plus one per distinct
Space, never N × 4. The answer is the resolver's, board for board (test/auth/access-equivalence.js checks it against `tenancy.effective`: ladder, permissions, sources and `until`, on memory,
SQLite and Postgres, several seeds, with custom roles, Group, Space and Unit grants, `adminBoardContent` on and off, and a second Unit in one batch).

**The tree is bounded too.** It does not read the Unit's Spaces and Groups: `Registry.spaceCandidates(tenant, { user, all, limit })` pages Spaces in SQL (by id, 100 per page, one page) that the
person COULD open: general access set, their personal space, a grant to them or one of their Teams on the Space or its Group, a Group with general access, or any Space if they hold a Unit-level role
(`all`). A superset the resolver then settles: Spaces whose general access already opens them are resolved from the rows in hand (no read); only Spaces that need their grants are checked with
`effective`, at most 40 (8 at a time), and Groups (`groupCandidates` ≤ 50, `effective` for at most 20) the same. What is left out sets `tree.more`.

**Where Recent and Starred live.** Two Registry tables, `reg_recents (member, board, opened_at)` and `reg_stars (member, board, at)`, keyed `(member, board)` and indexed `(member, time DESC, board DESC)`.
Not a separate port: they are per-user rows over the Registry's own board ids with the same durability, and they must be read with the access check. They hold no board data, so an unreadable
board's row is inert (the access filter drops it). Additive tables like the Organization ones, with these indexes added for Home's reads: `reg_invites (email)`, `reg_link_uses (member, board)`,
`reg_scope_grants (subject_type, subject, scope_type)`, `reg_team_members (member)`, `reg_grants (member)`, `reg_boards (tenant, id)`.

Pending maintainer decisions kept as-is: a Unit admin gets no board content by being admin (a board they cannot open is not listed); unfiled boards appear under "Other boards" (above), not in a legacy Space.

## Spaces and Groups (pages, pickers, create and rename, #48)

Design: design/orgs/JOURNEY.md (J2, J4, §4 [space] [group] [new-board] [new-space], §5). Code: `server/auth/spaces.js` (core: every decision
below), routes in `server/auth/http.js` (they only translate), Registry calls `rename`, `updateScope`, `spacesIn`, `accessContexts` (§ Registry). Every route
authenticates like Home (`Authorization: Bearer`), and **checks permissions, never role names**: the permission is read from the resolver's
answer (`tenancy.effective`) at the scope the request names.

**One refusal, whatever the reason.** A route that names a Space, Group or board the caller may not use answers the same for an id that does
not exist, one in another Unit, and one that exists but is hidden: a read is `404 not-found`, a write is `403 forbidden`, same body, same
status, and **the same Registry work** (every route reads the scope row and calls `tenancy.effective` for any id, fine or not, and a board id goes through `accessOn(..., { uniform: true })`; a test counts Registry calls per case, one case at a time). The work is the same down to the statements: SQLite's `accessContext` runs the same statements with no-match parameters when the row is missing (a test counts them), and Postgres answers in one statement either way. So no page, picker or error names or confirms a Space or Group the person cannot open. **Open** = the resolver's ladder
role for the person is not null (the Home rule); a Unit admin does not open a private Space while `adminBoardContent` is off (pending
maintainer decision, kept as-is), so a page or picker does not list one for them. A *write* checks the permission only: an admin who knows a
Space's id may still `board.create` in it, **except in another member's personal space** (private until its owner shares from it): 403, the ordinary refusal.

| Route | Needs | Answers |
|---|---|---|
| `POST /boards` `{ title?, space?, memberRole? }` | a Unit (members only: a guest, or a user with no Unit, gets 403). `space` omitted or null = the caller's **personal space** (made on first use; always allowed). `space: "<id>"` needs `board.create` at that Space | 201 `{ board }` (the board record). The caller becomes its `owner`. `memberRole` absent = null: the board inherits its Space (a personal space is private); else a role below `owner` (400 otherwise). Replaces the admin-only rule |
| `GET /spaces?can=board.create` | a Unit | `{ spaces: [{ id, name, personal, general, group: { id, name } \| null }], more }`: the Spaces the caller can open **and** holds `board.create` in (`general` = the Space's general-access role or null), their personal space first. A Group's name appears only when the caller can open the Group. The picker and `POST /boards` use one function, so what is listed is what is accepted. `more` = the bounded candidate scan left something out |
| `POST /groups` `{ name, general? }` | `group.create` at the Unit root (a permission, not a role name; the built-in Unit `admin` holds it, `owner`/`editor`/`member` do not, a custom Unit role can). `name` trimmed, 1-200; `general` as for spaces, default `null` | 201 `{ group: { id, name, general } }`; the caller becomes its `owner` |
| `GET /groups?can=space.create` | a Unit | `{ root, groups: [{ id, name }], more }`: `root` = the caller holds `space.create` at the Unit root; `groups` = the Groups they can open and hold `space.create` in |
| `POST /spaces` `{ name, group?, general? }` | `space.create` at the Unit root (`group` omitted or null) or at the Group. `name` trimmed, 1-200. `general`: `"viewer"` (default), `"commenter"`, `"annotator"`, `"editor"` or `null` (only people added) | 201 `{ space }` (`{ id, name, personal: false, general, group }`); the caller becomes its `owner`. An unknown, other-Unit or hidden `group`: 403 |
| `GET /spaces/:id` | open the Space | `{ space, can: { createBoard, rename, general }, boards, more }`. `boards` = Home cards (§ Home) of the boards the caller can open, by title, at most 50 (Home's bounded window: up to 3 pages), each with `can: { rename }`. `can.*` are permissions: `board.create`; `members.manage` (not for a personal space) |
| `GET /groups/:id` | open the Group | `{ group: { id, name, general }, can: { createSpace, rename, general }, spaces: [{ id, name, general }], next }`: its Spaces, by id, 100 a page (`?after=<next>`). Every Space of a Group the caller opens is open to them (a role on a container covers what is inside), so none is filtered. Someone who can open one Space but not the Group gets 404 here (the Space shows in their Home tree) |
| `PATCH /spaces/:id` `{ name?, general? }` | `members.manage` at the Space. A personal space: the ordinary 403 (its name and privacy are the person's own; the refusal must not say which Space is personal) | 200 `{ space }`. At least one field, else 400. Name and general access change in **one** Registry call (`updateScope`: one transaction, no half-applied change). If the caller manages the Space but cannot open it (a Unit admin, content access off), the answer is only `{ id }` plus the fields they sent: no stored name |
| `PATCH /groups/:id` `{ name?, general? }` | `members.manage` at the Group | 200 `{ group }` (the same only-what-you-sent rule when the caller cannot open it) |
| `PATCH /boards/:board` `{ title }` | `board.edit` or `members.manage` on the board (a title is board content; an owner and an admin hold the second). `title` trimmed, 0-200 | 200 `{ board }` |

Unknown body fields are 400 `unknown-field`, as everywhere. The 4xx/5xx codes are the existing ones (400 `bad-request`, 401, 403 `forbidden`, 404
`not-found`, 503 `unavailable`); #48 adds none.

**Why `members.manage` renames a Space.** The permission list has no rename; a name is the container's management, which `members.manage` is (Space
and Group owners hold it, editors do not). A custom role can hold it. A board's title is content, so `board.edit` also renames it.

**Freshness (§ Organization).** Per route: `POST /boards` and `POST /spaces` add an owner grant on a thing that did not exist, so no live connection
is affected and nothing is announced (the board's own `setGrant` announces as before). A rename is not access: nothing is announced. A
**general-access change** (`PATCH` with `general`) changes what every board inside gets, so after the write it pages `boardsIn(scope)` (a Space's
boards, or a Group's Spaces' boards) and publishes `{ board }` on each board's `.grants` subject, at most 20 pages of 500, **after the response** (off the request path; shutdown waits up to 2 s for it, and anything lost falls back to the timed re-check); a larger scope's
rest waits for the timed re-check (≤ 60 s) and one log line says so. A failed announcement is logged, never fails the request.
**Scheduling** (`server/auth/spaces.js`): one pass per scope at a time; a change during a pass marks the scope dirty and earns exactly one more pass (the check and the
release of the scope happen in one synchronous step, so no change is lost); a scope yields its slot after 3 passes in a row (back of the queue). At most 8 scopes run at
once and 4 of one Unit; scopes over the cap wait in a queue deduped by scope; only past 10,000 queued scopes is an ordinary change dropped (logged, left to the gateways' timed re-check, 60 s at most). A change that **reduces access** (general set to null or to a lower
role) waits in its own queue, drained before the ordinary one and first-in first-out (an old revocation is never starved by newer ones), and has its own budget (16 slots overall, 8 per Unit), so a revoked viewer loses live access promptly and one Unit's flood of revocations can't starve another's. It is never dropped, shutdown (`close()`, after a 2 s wait for running passes) forgets whatever is still queued, and its priority lasts for the pass that follows the change only (an ordinary change after it queues normally).

**Bounds.** `GET /spaces?can=`: one page of at most 100 candidate Spaces (`spaceCandidates`, SQL), general access settled from the rows in hand, then ONE batched `effectiveMany` (one `accessContexts` call: one statement on Postgres) for the candidates still undecided; the rest set `more`. `GET /groups?can=`: at most 50 Group candidates, one batched read.
`GET /spaces/:id`: the Space's one `effective`, then Home's window (≤ 3 pages of 200 ids, one `accessMany` each: 6-7 statements and one context read
per page). `GET /groups/:id`: one `effective`, one `spacesIn` page. Nothing loops the boards, Spaces or Groups of a Unit.

## HTTP request deadline (#73, TECH-DEBT row 16)

Every route `httpRoutes` (server/auth/http.js) serves answers within a **request deadline**, default **8000 ms** (`config.requestDeadlineMs`; main.js reads
`PLENARY_REQUEST_DEADLINE_MS`), or answers `503 {error:"unavailable"}` (the same body and code as any Registry or verifier outage). One wrapper in the
dispatcher covers the whole route table, the body read, the bearer check and the handler, so a route added later is covered with no per-route code
(`test/auth/http-deadline.test.js` enumerates the table and fails on a route it does not know). The deadline sits under the idle cut in front of the server
(Bun's own default is 10 s without a byte; `server.js` sets 30 s, `idleTimeoutSec`) and under any proxy's, so the client sees a status, never a dropped
connection. `GET /auth/dev` keeps its own tighter 3 s wait. Blob PUT/GET (`blob-http.js`) has its own body deadline and is not under this one.

**Inner limits stay under the deadline.** A call that runs past the deadline still works on after the 503, so every single-call limit below it is kept
shorter: main.js starts the Postgres Registry with `statementTimeoutMs` and `lockTimeoutMs` of **5000** (a single node's SQLite busy timeout is 5000 too) and
Google's `timeoutMs` of **3500**, and **refuses to start** (a loud error naming the setting) when one of them is not below the deadline. For Postgres the
check uses the adapter's longest call as `gate()` reports it: its wait for a connection plus the limit plus a 1 s backstop (7050 ms by default). Several calls in a row (scope reads, then the create) can still add up
past it; that case is the next paragraph's.

**What a 503 means on a write.** The work is not cancelled (the Registry port has no cancel; a statement already sent to the database runs to its own
limit). So a 503 from a write route says **"may or may not have applied"**, and after the 503 is sent the late result is **discarded**: the response is
built once, and the late handler's return value or rejection is dropped (handled, never an unhandled rejection) and counted (`stats().late`) and logged
(at most one line per 10 s, with the route and whether it applied or failed).
- **Safe to retry as is:** grants, stars, revokes, renames and `updateScope` set a value; repeating them changes nothing. So do the Teams routes that are not creates (`PATCH /teams/:id`, `DELETE /teams/:id`, `PUT` / `DELETE /teams/:id/members/:user`) and the access routes (`PUT` / `DELETE /access/:type/:id/grants/:subjectType/:subject`).
- **Retry with the same `Idempotency-Key`:** a create (`POST /boards`, `/spaces`, `/groups`, `/teams`, `/roles`, `/boards/:board/invites`, `/boards/:board/links`) makes a new
  object on every call, so without the key a retry can leave the first, committed object next to the second (and no route deletes a board, Space or
  Group). Send the header and a retry returns the first call's object, exactly once, whether or not the first committed. See the next section.

## Idempotent creates (`Idempotency-Key`, #73, exactly-once #86)

`POST /boards`, `POST /spaces`, `POST /groups`, `POST /teams`, `POST /roles`, `POST /boards/:board/invites` and `POST /boards/:board/links` accept an `Idempotency-Key` header: 8-64 of
`[A-Za-z0-9_-]` (anything else is 400 `bad-idempotency-key`); a client makes one per submit (a random UUID is fine) and **reuses it for every retry of that
submit**. Without the header a create behaves as before. 

**The key is written in the create's own transaction.** The Registry call that creates the object also inserts the key's row `(user, key) → fingerprint, id`
in the **same atomic step** (one SQLite transaction, one Postgres transaction, one synchronous memory step). So the object and its key commit together or
not at all: there is no state in which the object exists and the key does not, or the reverse. Nothing is "claimed" before the work and nothing is
"finished" after it, so a client timeout, a dropped connection, a deadline 503 or a crash at any point leaves exactly one of two states, and a retry with
the same key is correct in both.

| Same key, per signed-in user | Answer |
|---|---|
| first use | runs the create; the object and the key commit together; **201** |
| again, after the first committed (whatever happened to the first call's response) | **the first object, rebuilt** for the caller as they are now (rule below): **201** with it read fresh, plus the header `Idempotent-Replayed: true`. Nothing is created |
| again, while the first is still running (a call cut by the deadline keeps running) | the retry's create waits on the same row until the first commits or rolls back, then replays (201) or runs fresh. The wait is bounded by the adapter's lock limit (Postgres `lock_timeout`, 5000 ms; SQLite busy timeout, 5000 ms): past it the answer is `503 unavailable` (the transaction rolled back, nothing written) and the client retries with the same key. **There is no `in-progress` answer** (and no 409) |
| again, after the first failed before committing (a refusal, a rolled-back transaction) | the key left no trace: the retry runs as a first use |
| again, with a different route, path parameter or body | `422 {error:"idempotency-key-reused"}`; nothing runs |

- **A board is created with its owner in one step.** `createBoard` takes the `owner` (like `createSpace` and `createGroup` always did): the board, its owner
  grant and the key are one transaction. There is no board without its owner and no `owner-grant-failed` outcome.
- **The deadline does not lose the answer.** A create cut off by the deadline keeps running and either commits (object + key) or rolls back (neither). A
  retry gets the board id in the first case and a fresh run in the second.
- **A replay is authorized again (security).** What is stored under a key is the object's **id**, **never a response body** (a link's `url`, an
  invite's address and the object's other fields are not in it). A repeat re-runs the create's own authorization for the caller as they are now,
  then reads the object fresh: `POST /boards` needs `board.create` at the board's Space (and a personal Space is its owner's alone), `POST /spaces`
  `space.create` at its Group or the Unit, `POST /groups` `group.create`, `POST /teams` `team.manage`, `POST /roles` `roles.manage` and no escalation (§ Roles; a replay of a role since deleted is `404 not-found`), invites and links the board-manager check of the invites and links routes
  (`readInvite`, `readLink`). A caller who lost that access since gets the route's ordinary `403 forbidden`, never the stored answer and no token. A link's `id` is itself its capability; it is the same id `reg_links` holds in the
  same store, and it is returned only after the manager check.
- **A replay of a revoked or expired invite or link** answers `404 not-found`, not a 201 with its url.
- **Scope and retention.** A key belongs to its user (ids are globally unique, so the Unit adds nothing): another user's request under the same key is a separate key and never sees or collides with this user's answer. A key row is kept **24 h** (`IDEM.ttlMs`); a row older than that counts as absent, and the next create under the key replaces it. The store is bounded by age: expired rows are deleted in small batches (`IDEM.prune`) as keyed creates arrive.
  The request body is stored only as a SHA-256 fingerprint.
- **Port** (§ Registry): each keyed create takes an optional `idem: { user, key, fp }` and writes the row inside its own atomic step. When a live row exists it
  rejects, changing nothing, with `code: "idem-replay"` (and `ref`: the stored id) for the same fingerprint or `code: "idem-mismatch"` for another. `idemGet({ user, key, fp })`
  is the read-only form of the same check, which http.js asks first so a replay skips the create's work. Memory, SQLite (`reg_idempotency`) and Postgres
  (`reg_idempotency`, the row inserted before the object, a unique conflict waits for the first writer) implement it, and `registry-contract.js` pins the three.
  Adding the header to another create is: take `idem` in its Registry call, call the adapter's one in-transaction step, and wrap the route in `keyed` with a rebuild that re-authorizes and reads the object.

## Teams and access (#49)

Design: design/orgs/JOURNEY.md (J4, J9, J10, §4 [space-settings] [access] [unit-members, teams]). Code: `server/auth/access.js` (core: every decision below),
routes in `server/auth/http.js` (they only translate), Registry calls `renameTeam`, `deleteTeam`, `teamsPage`, `teamsAmong`, `teamMembersPage`, `scopedGrantsPage`,
`touchMember`, `membersAmong`, `findMembers` (§ Registry). Every route authenticates like Home (`Authorization: Bearer`) and **checks permissions, never role names**.
Names are access, exactly as in § Spaces and Groups: an id the caller may not use (unknown, in another Unit, or hidden) gets one answer (a read `404 not-found`, a write
`403 forbidden`, same body) and the same Registry work; a caller with no Unit (a guest) gets 403 everywhere.

**The member directory.** A Unit's membership comes from `hd` at sign-in and is not stored, so a person can be added to a Team, Space, Group or the Unit only after the
server has seen them: `GET /home` and the sign-in code exchange (best effort) record the caller in `reg_members (tenant, member, name, email)` (the exchange write is bounded: at most 16 directory writes in flight per process and one per user at a time, a slot frees only when its write settles, which the Registry's own bounds guarantee (SQLite `busy_timeout`, Postgres `lock_timeout`/`statement_timeout`); after 5 s (`config.touchTimeoutMs`, clamped like `devSignIn.waitMs`) the write is only logged as slow; the excess is dropped (the person's next Home records them); a failure, slow write or drop logs one rate-limited warning that identifies no one) (`touchMember`: one read, a write only when the row is new or the name
or email changed). A person who has never signed in is not in the directory and cannot be added to a Team, Group, Space or the Unit (400 `unknown-person`, the same answer for an id that is a guest, in
another Unit or never seen). A change to a grant that already exists needs no directory row. A NEW person grant on a board (this surface and `PUT /boards/:board/grants/:user`, one rule, `knownOnBoard` in server/admin/boards.js) is accepted only for a person in the board's Unit's directory (or an admin of it named by id), one who already holds a grant on that board, or a guest who redeemed a link of that board; never an `email:` entry, another Unit's member or an id nobody has seen (400 `unknown-person`). A Unit admin named by user id (`tenant.admins`, an `email:` entry excluded) counts as in the directory. Searching is `findMembers`: ASCII-folded substring of name, email or
user id, at most 50 results, by name then id; it scans one Unit's rows, never another's. A row with no directory entry (a grant older than the directory) is shown with
the name derived from its id (the part after `google:` / `dev:`).

**Teams.** A Team is a named set of Unit members. **Who manages a Team: the `team.manage` permission at the Unit root** (a new management permission; Unit scope only:
clipped away at Group, Space and board; the built-in Unit `admin` holds it, the Unit `member` role does not by default, and a custom role may carry it). A Team has no owner of
its own and so no last-owner rule of its own; what protects a Group or Space is that it keeps one counted `owner` (below), and a Team that is such an owner cannot be deleted
or emptied while it is the only one. Any Unit member may read the Team list and a Team's members (the Unit's directory, like a GitHub organisation's teams).

| Route | Needs | Answers |
|---|---|---|
| `GET /teams?after=&q=` | a Unit | `{ teams: [{ id, name, size }], next, can: { create } }`: by id, 50 a page (`next` is the cursor); `q` = ASCII-folded name substring (1-100 chars); `size` counts to 1001 (1001 = more than 1000); `can.create` = `team.manage` at the Unit |
| `POST /teams` `{ name }` (optional `Idempotency-Key`, § Idempotent creates) | `team.manage` | 201 `{ team: { id, name, size: 0 } }`; name trimmed, 1-200 |
| `GET /teams/:id?after=` | a Unit; the Team in the caller's Unit | `{ team: { id, name, size }, can: { manage }, members: [{ user, name, email }], next }`: members by user id, 50 a page |
| `PATCH /teams/:id` `{ name }` | `team.manage` | 200 `{ team }` |
| `DELETE /teams/:id` | `team.manage` | 204. Removes the Team, its members and every grant it holds in one atomic step. **409 `last-owner`** (nothing changes) if it is the only counted owner of a Group or Space. **409 `too-large`** if it holds grants on more than 5000 scopes (remove some first) |
| `PUT /teams/:id/members/:user` | `team.manage`; `:user` in the directory | 204, idempotent. A guest or unknown person: 400 `unknown-person` |
| `DELETE /teams/:id/members/:user` | `team.manage` | 204, idempotent. **409 `last-owner`** if it would empty the only counted owner of a Group or Space |

**A Team's grants are the caller's to give.** Adding a person to a Team gives them every grant the Team holds, and removing one (or deleting the Team) takes those away, so `team.manage`
alone is not enough: unless the caller is a Unit admin, they must be able to do each of those as a direct grant, that is `members.manage` at each scope the Team holds a grant on and
the role grantable by them there (the rule of § Access at a scope below, `owner` on a board only for a Unit admin). The check runs at write time over `scopesOf({ type: "team" })`, at most 50
scopes (51 are read to tell); a Team holding more, or any scope the caller falls short on, is the ordinary 403 `forbidden`, the same body whatever the reason (it names no scope). A role stored on a
Team that means nothing at its scope is ignored. Granting a Team a role (`PUT /access/.../grants/team/...`) is checked exactly as for a person.

A Team's members are Unit members only; a Team membership or grant written for a guest is inert (§ Organization), which is why the write is refused rather than stored.

**Access at a scope.** One surface for every scope: `unit` (id = the Unit's id), `group`, `space` and `board`.

| Route | Needs | Answers |
|---|---|---|
| `GET /access/:type/:id?after=` | open the scope, or `members.manage` at it | `{ scope: { type, id, name? }, can: { manage }, general, admins, rows, next, inherited, roles }` |
| `PUT /access/:type/:id/grants/:subjectType/:subject` `{ role }` | `members.manage` at the scope; the role grantable by the caller (below) | 200 `{ row }`: adds the person (`subjectType` `user`; `:subject` the URL-encoded user id) or Team (`team`) with `role`, or changes their role; idempotent |
| `DELETE /access/:type/:id/grants/:subjectType/:subject` | `members.manage`; the existing role manageable by the caller | 204, idempotent |
| `GET /directory?q=` | a Unit | `{ people: [{ user, name, email }], teams: [{ id, name, size }] }`: the picker's search, at most 8 of each; `q` 0-100 chars (empty = the first ones) |

- `rows`: the grants set AT this scope, by subject type then id, 50 a page: `{ subject: { type: "user"|"team", id, name, email?, size? }, role, roleName, via: "direct"|"team", can: { change, remove } }`.
  `via` is `direct` for a person, `team` for a Team. At a board the first page also carries the board's direct person grants (`grants`, up to 200). `can.*` is per row (below).
- `general`: the general-access row of this scope and of the containers above it: `[{ scope: { type, id, name? }, role }]` (a Space's `generalRole`, its Group's, a board's `memberRole`; null roles are left out). A scope's own change is `PATCH` (§ Spaces and Groups).
- `inherited`: grants on the containers above (a board: its Space then its Group; a Space: its Group), the first 20 of each: `{ scope: { type, id, name }, subject, role, roleName, via: "inherited" }`; only for a container the caller can open (names are access); read-only.
- `admins` (`unit` scope only): the Unit's admins by id, up to 100, `{ user, name, email }`; admin is not a grantable role, so these rows are read-only.
- `roles`: the picker: **the roles valid at this scope that the caller may grant**, `{ id, name, custom, summary, ladder, people }`. Built-in ladder roles `viewer` .. `owner` at Group, Space and board; at the Unit only custom roles (a Unit role is `admin` and `member`, neither grantable); custom roles filtered by `ALLOWED_AT` (a role is listed where `roleDef` gives it any meaning). `people: false` marks a role that cannot be given to a person (at a board, a custom role: a person's board grant is the ladder's own `grants` table) so the UI offers it for Teams only.
- **Who may grant or change what.** The caller needs `members.manage` at the scope, and may only hand out or alter a role whose **management permissions are a subset of their own at that scope** (no escalation: `owner` needs `transfer`; a custom role with `delete` needs `delete`). Content permissions are not compared, so a Unit admin, who manages without content access, can still grant `editor`. At a **board**, today's rule stays (server/admin/boards.js): a person's grant goes through `setGrant`, so a board owner sets roles up to `editor`, may change an owner's grant only their own, and only a Unit admin sets `owner`; a Team's board grant follows the same limits. A role not valid at the scope (a Unit role, `admin`, `member`, unknown) is 400 `bad-role`. `can.change` / `can.remove` of a row is whether the same rule would allow it.
- **Personal space.** Its access is its owner's own: `members.manage` there is not offered (`can.manage` false, writes 403), as for rename.
- **Last owner.** A Space and a Group keep at least one counted `owner` (a person, or a Team with a member), atomically on memory, SQLite and Postgres (§ Registry). The access routes surface it as **409 `last-owner`**; the same holds for removing a Team's last member and deleting a Team. A board keeps its owner through `setGrant`'s own rule (unchanged). The Unit's admins are the backstop and are not counted.
- **Idempotency.** `PUT` with the role already held and `DELETE` of nothing are successes that change nothing and announce nothing.

**Freshness (§ Organization).** Every change here announces through the one bounded, fair scheduler of § Spaces and Groups (`announceChange`): a change to a grant on a Unit, Group,
Space or board announces that scope's boards (a board scope: that board); a **Team member add or remove** pages `scopesOf({ type: "team", id })` (500 a page) and announces each scope;
a **Team delete** collects those scopes first (refusing past 5000, 409 `too-large`), deletes, then announces each; a **rename** is not access and announces nothing. A change that reduces access (a
removal, a lower role, a Team member removed, a Team deleted) is a revocation: it goes through the revocation queue and **is never dropped**. The walk over a Team's scopes waits (never drops) while the scheduler's backlog is above 2000, so a Team with many grants cannot grow it without bound. An add (`revoke: false`) beyond 20 pages of a Team's scopes is left to the timed re-check (≤ 60 s) with one log line.

**Bounds.** `GET /teams`: one statement (size counted to 1001 per Team). `GET /teams/:id`: the Team row, one `effective` at the Unit, one member page, one `membersAmong`. `GET /access/..`: the scope row and its one `effective`
(both whatever the id), then one grants page, one `membersAmong` and one `teamsAmong` over that page, the Unit's roles, and, for a Space or board, the container rows and their `effective`; for a manager, also the pending requests (one `accessRequests` page of at most 50, then `tenancy.effectiveAmong` over those requesters: ONE `accessContext` for a Space or Group, up to 50 sequential `accessOn` for a board; no Registry write). `GET /directory`:
one `findMembers` and one `teamsPage`. Nothing loops a Unit's members, boards or Spaces.

## Roles (#50)

Design: design/orgs/JOURNEY.md (J9, §4 [roles]). Code: `server/auth/roles.js` (every decision below), routes in `server/auth/http.js` (they only translate), Registry calls `createRole`
(with `max`), `updateRole`, `deleteRole`, `roleUsage`, `memberCount` (§ Registry), the one definition of what a role grants in `server/auth/permissions.js` (`roleDef`, `roleProblem`, `ALLOWED_AT`).
Every route authenticates like Home (`Authorization: Bearer`) and **checks the permission `roles.manage` at the Unit root** (Unit scope only: clipped away below; the built-in Unit `admin` holds
it; a custom role may carry it), never a role name. The Roles screen is `?roles=1`; Home links to it when `can.manageRoles` (= `roles.manage` at the Unit) is true.

**What is a role.** One **board-content ladder step** (`viewer`, `commenter`, `annotator` or `editor`; never `owner`, so a role edit can never create a path to owner or board owner) plus a set of
**management permissions** (`board.create`, `space.create`, `group.create`, `members.manage`, `move`, `delete`, `transfer`, `roles.manage`, `team.manage`). The model is ONE set, not a set per scope: where a
permission means something is derived (`ALLOWED_AT`), so the screen cannot offer an impossible permission-at-scope pair. Built-in roles are read-only (ladder `viewer`..`owner`, Unit `admin`); the
Unit **member** role is editable in its **management permissions only** (its name and its board content, none, are fixed: no edit can hand every member board content). Custom roles are per Unit,
**at most 50** (409 `too-large`; the cap is checked atomically in the Registry write, so concurrent creates cannot pass it).

| Route | Needs | Answers |
|---|---|---|
| `GET /roles` | `roles.manage` at the Unit (else the one 404 `not-found`; a guest or a caller with no Unit too) | `{ roles: RoleView[], matrix, can: { admin }, limits }` |
| `POST /roles` `{ name, boardRole, permissions, base? }` | `roles.manage`; no escalation (below); accepts `Idempotency-Key` (§ Idempotent creates) | 201 `{ role }`; `base` = the id of the role this one was duplicated from (a built-in, `member` or a custom id; display only, `like Editor`) |
| `PATCH /roles/:id` `{ name?, boardRole?, permissions?, confirm? }` | `roles.manage`; no escalation; a custom role, or `member` (which also needs the Unit-wide admin capability, below) | 200 `{ role }`. 409 `confirm-required` (below) |
| `DELETE /roles/:id` | `roles.manage`; no escalation; a custom role | 204. **409 `in-use`** `{ places }` while any grant holds it |

- `RoleView`: `{ id, name, kind: "builtin"|"member"|"custom", editable, summary, base?, ladder, permissions, scopes: { unit|group|space|board: string[] }, used: { places, capped } | null }`. `editable` is per caller: true only when a PATCH of that role by THIS caller can pass the checks below (the `member` role: a Unit admin; a custom role: its Unit permissions within the caller's own, or the caller is a Unit admin); always false for a built-in. The screen offers no edit where it is false and says why (member: "Only a Unit admin can change what every member gets"; custom: it gives more than the caller holds). `permissions` are the
  management permissions it was given; `scopes[type]` is what `roleDef(role, type)` gives there (content permissions included), so the screen's matrix is the server's. `used` is `null` for a built-in (not counted); `member` carries `{ members, capped }` (the directory's size shown as at most 50; `capped: true` = more than 50) instead of `places`.
  `summary` is one line (a custom role's reads "Editor board access, plus 2 management permissions"). `places` = the grants (a person's or a Team's, on any scope) that hold the role, **counted to 100** (`capped: true` = 100 or more; the cost is one statement of at most 101 index rows per role).
- `matrix`: `{ scopes: ["unit","group","space","board"], permissions: [{ id, group: "content"|"management", scopes }], content, ladders, tickable }` where `scopes` is where the permission means anything (from
  `ALLOWED_AT`; content at all four), `content` maps each board step to the content permissions it includes (the screen shows them as read-only cells next to the step), `tickable` the management permissions the caller may tick, `ladders` the ladder steps the CALLER may give (`viewer`..up to what they hold themselves; all four for a Unit admin). `can.admin` is the caller's Unit-admin flag.
  The permissions the caller may tick are those they hold themselves (the same rule the server enforces), listed as `matrix.tickable` (a Unit admin: every management permission).
- **The Unit member role is Unit-wide.** Editing it changes what every member may do, so it needs the Unit-wide admin capability (today: the caller is a Unit admin, the check that guards other Unit-wide admin changes; `unitWide` in `roles.js` is the one place tiered admin levels, #88, map to), on top of `roles.manage` and no escalation. A `roles.manage` holder who is not a Unit admin gets the ordinary 403 `forbidden` on `PATCH /roles/member`, whatever the body, with the same Registry reads as any refused write.
- **No escalation.** Unless the caller is a Unit admin, a write needs the role's definition **at the Unit** (`roleDef(role, "unit")`: ladder content permissions plus management permissions, ladder step
  included) to be a **subset of the caller's own permissions at the Unit** (what the resolver gives them there, member role's included), both for the role as it is now (so a role cannot be edited, or
  deleted, by someone who could not hold it) and as it would become. A permission the caller lacks cannot be put in a role, and a role above the caller cannot be touched. Every custom role carries a board step, whose content permissions are part of the measure, so a non-admin who holds no board content of their own (only the Unit `member` role's management permissions, say) can edit no role: delegating role editing means giving the delegate a role with a board step. A Unit admin is not held to it (they manage without content). The `team.manage`
  back door (§ Teams and access) still holds with no change: a Team's grants are re-read live, so a role edit that adds a permission to a role a Team holds is checked at the next Team change against
  the caller's own rights there.
- **Validation** (`roleProblem`, then names): name trimmed 1-200, no NUL; `boardRole` one of the four steps for a custom role; `permissions` distinct management permissions; `member` takes
  `permissions` only (a `name` or `boardRole` in the patch is 400). Body fields outside the list are refused.
- **The many-people warning.** An edit that changes `permissions` or `boardRole` of a role is **many** when it is used in **more than 10 places** or by **more than 50 people** (the DISTINCT people with a direct grant (one person in twelve places is one) plus the
  sizes of the Teams that hold it, read for up to 50 Teams, each size counted to 1001, an over-estimate; the Unit `member` role: the directory's member count, shown as at most 50 with `capped: true` when there are more, and 50+ is many). A many edit
  without `confirm: true` changes **nothing** and answers `409 { error: "confirm-required", impact: { places, people, capped } }` (counts only, capped at 100 / 1001 / 50; no name). The screen shows the
  count and asks; **Save anyway** sends the same patch with `confirm: true`. A rename never needs it.
- **Delete is refused while the role is in use** (decision: refuse, never reassign: reassigning would silently change what people can do). The check and the delete are ONE atomic Registry step
  (`deleteRole`: only grants of the same Unit count, so another Unit can never block a delete). The write side closes the other half on every adapter: `setScopedGrant` of a role shaped like a custom role id (`r-…`) checks, inside the write that stores it, that the role exists in the scope's Unit, else rejects code `no-role` (a role id of another Unit, or one deleted a moment ago); the access routes answer that 400 `bad-role`. On Postgres that check takes `FOR KEY SHARE` on the role row, which conflicts with `deleteRole`'s `FOR UPDATE`, so a grant and a delete of the same role are serialised: the delete either waits and then sees the grant (409 `in-use`) or has committed first (the grant is refused). So a grant never lands on a deleted role (a role grant that predates this rule is inert: the resolver ignores an unknown role, and any manager may clear it).
  The `member` role is never deleted (400); a built-in id is "not a role" and answers like an unknown one (403).
- **Leaks.** An id that is unknown, belongs to another Unit, or is not a role (`admin`, a ladder name) gets the SAME answer and the same Registry work as a hidden one: a write is 403 `forbidden`,
  identical to a caller without `roles.manage`; `GET /roles` is 404 `not-found`. No error names a scope or a person; the usage count is a number only. A role deleted between the check and the write is the
  same 403, never a 503.
- **Freshness.** Role definitions are read live by every access answer. An edit that changes `permissions` or `boardRole` announces `{ type: "unit" }` through the one bounded, fair scheduler
  (`announceChange`, § Spaces and Groups): as a **revocation** (priority queue, never dropped) unless it is a pure widening (the new role holds everything the old did and no lower ladder step);
  a rename announces nothing; an edit of a role no grant holds (`used.places` 0, read in the same request) announces nothing (nothing to re-check; the timed pass covers a grant that races in).
  So a removed permission or a lowered ladder step reaches an open board's sockets within one pass (the next `.grants` handling, else the timed re-check ≤ 60 s), and the next HTTP call.
  Create and delete of an unused role announce nothing.
- **Bounds.** `GET /roles`: one `effective` at the Unit, one `roles(tenant)` (≤ 51 rows), one `roleUsage` over those ids (ONE statement per id, so ≤ 51 statements, each reading ≤ 101 index rows for the places count, ≤ 101 for the distinct users and ≤ 50 for the Team ids), one `memberCount` (≤ 51 rows read).
  `PATCH`: the same reads plus, only for a many-check on a Team-held role, one `teamsAmong` over ≤ 50 ids. Nothing loops grants, members or boards.

## Access explanation and requests (#51)

Design: design/orgs/JOURNEY.md (J10, §4 [space-viewer] [access], §5). Code: `server/auth/explain.js` (the one explanation, pure helpers plus `explainService`), used by `server/auth/access.js`
(the Access page and the requests) and `server/auth/spaces.js` (the Space page); routes in `server/auth/http.js` (they only translate); Registry calls `requestAccess`, `accessRequest`,
`accessRequests`, `closeAccessRequest`, `grantHolders` (§ Registry). Every route authenticates like Home (`Authorization: Bearer`).

**One source of truth.** The explanation is built from the `Access` that `tenancy.effective` returned for this very request, the object the same handler used for `can.*`: its `sources`
(resolver.js) are the reasons, its `permissions` the answer. No second resolver, no client-side rule. "What would be needed" (`needs`) is derived with `roleDef` from the same permission tables
(`permissions.js`), never a hard-coded role name. A test pins that `mine.role` equals the room's hello role (`tenancy.role`) for every source kind.

**`mine`** (the caller's own access to the scope): `{ role: { id, name } | null, sources: [{ kind, scope: { type, id, name? }, role, roleName, ladder, team?: { id, name }, strongest }] }`.
- `role` is the highest ladder role over all sources (the union's board-content step; `null` = no board content), `sources` are the resolver's, in its order: `kind` is `direct`, `team`, `general`, `invite`, `link` or `unit`
  (Unit admin, a role on the Unit, the Unit `member` role).
- **Strongest.** `strongest: true` marks every source whose `ladder` equals `role.id` (ties are all marked; nothing is marked when `role` is null). The caller gets everything every source grants; the mark only says which source reaches the top.
- Names: a source's `scope.name` and `team.name` are filled for a container or Team the caller holds a source through (they hold a role there, so it is theirs to know); the Unit has no name.

**`needs`**: for the scope's key permission, the lowest built-in ladder role that holds it there: `{ "board.create": { role, roleName, held } | null }` on a Space, `space.create` on a Group,
`board.edit` on a board (none on the Unit). `null` = no built-in role has it (a custom role may). It is computed **against the caller's own `Access`**: `held` is true when the caller's ladder role is already at or above `role` yet `access.permissions` lacks the key
permission (their role, such as the Unit `member` role set to board role editor, or a custom role with no management permissions, gives board content but not this). The sentence then says so ("your Editor access comes from a role that does not include it") instead of asking for a role the caller seems to have.

**`owners`**: who to ask: up to 10 people or Teams (`{ type, id, name }`, names only) that hold `members.manage` here, found through the container chain (the scope, then its Space, then its Group) by role
(`owner`, and custom roles that carry `members.manage` at that scope: `grantHolders`). Empty when only the Unit's admins can grant (they hold it everywhere: the page then says so).

**`ask`**: `{ can, roles: [{ id, name }], pending: { role, roleName, at } | null, retryAfterMs: number | null }`.
- `can` only for a Unit member who can open a Space, Group or board that is not a personal space and who does not already manage it. `roles` = the built-in roles above the caller's own up to `editor` (never `owner`), **plus** the `needs` role when the caller lacks the key permission even though their ladder role is at or above it (one function, `askRolesFor(access, type, roles)`, used by the explanation and by the route's check, so they cannot differ). `guest: true` (no Unit of the scope's) is also sent, so copy can tell a guest from a member with nobody to ask.
- `pending` = their open request here. `retryAfterMs` = how long until they may ask again (counted from the dismissal), else null. A granted request is not shown.

**Where it appears.** `GET /spaces/:id` carries it as `why` **only when `can.createBoard` is false** (the same predicate, same `Access`): `{ mine, needs, owners, ask }`. `GET /access/:type/:id` always carries `mine`, `needs`, `owners`, `ask` and, for `members.manage` holders, `requests`.
`GET /boards/:board/explain` (the canvas's read-only pill) answers `{ mine, needs, owners, ask }` for anyone who can open the board, **a guest included** (a guest's sources are board-scope only, so nothing else is named, `owners` is `[]`, `ask.can` false). It calls `tenancy.effective(identity, board, { uniform: true })`, which is the same `accessOn` + `resolveAccess` a hello reaches through `tenancy.resolve` (the hello does not pass `uniform`; that flag only makes an unknown board cost the same reads as a hidden one), so the role it reports is the hello's role.

**Who sees "Who has access" (decision).** Anyone who can open the scope **and** is inside its Unit (a member, or a Unit admin named by id) sees everyone who can open it and why (`rows`, `inherited`, `general`, `organization`): that is JOURNEY's "visible to all members", and "member" here never means a guest. A guest (no Unit, or another Unit's member opening a linked board) gets the ordinary 404 from `/access/..` and sees **only their own sources** (`/boards/:board/explain`); a person who cannot open the scope gets the same 404 as for an id that does not exist (same body, same Registry work), so no member list, no other Space and no Team leaks. A requester's identity (`requests`) is visible only to a current `members.manage` holder (a Unit admin included); `owners` names only who may grant.

`GET /access/:type/:id` additionally answers where access comes from above the scope, so a person with access only through the Unit is accounted for:
- `organization: { admins: [{ user, name }], more, memberRole: role | null }` (not on the Unit page, which has `admins`): the Unit's admins (they manage every board; no board content unless granted), up to 20 (`more` = there are more), and the Unit `member` role's board role when it carries board content.
- `inherited` also holds the Unit's scoped grants whose role gives board content at this scope (`scope: { type: "unit", id }`, no name), the first 50 read (`organization.more` is true when the Unit holds more).

**Ask for access.** There is no email or push infrastructure, so asking **stores a request the owners see** (Registry, below): it appears as a list on the scope's Access page, for every `members.manage` holder at the scope (owners, custom roles that carry it, and the Unit's admins), who answer by granting the role from the same page (which closes the request) or dismissing it. A request whose person **already reaches the role asked for** by another route (a Team they are in, a grant at a containing Group) is hidden from the list and closed as granted on read: `requestsOf` resolves up to 50 requesters in one batch (`tenancy.effectiveAmong`: one `accessContext` for a Space or Group, one per person on a board; every directory row is a Unit member) and keeps a request only while the person's `Access.permissions` lack some permission of the asked role.

| Route | Needs | Answers |
|---|---|---|
| `POST /access/:type/:id/requests` `{ role }` (`Idempotency-Key`, § Idempotent creates) | `ask.can` here; `role` in `ask.roles`. `:type` is `space`, `group` or `board`. No free text. | 201 `{ request: { role, roleName, at, state: "pending" } }` (the caller's own request; the same one again while it is pending: a second ask changes nothing and sends nothing new) |
| `DELETE /access/:type/:id/requests/:user` | `members.manage` at the scope (the rule of the grant routes) | 204, idempotent: the request stays as `dismissed` (it holds the cooldown); asking again is refused until the cooldown has passed |

Any other caller (a guest, no Unit, an id that is unknown, in another Unit or hidden, a personal space, someone who already manages the scope) gets the one ordinary answer: `403 forbidden`, with the same Registry work as a success up to the point of refusal. A role not in `ask.roles` is 400 `bad-role`.

- **Rate limit** (decision), enforced inside the Registry's atomic step so every gateway agrees and a retry cannot slip past: one request per (scope, person); a dismissed request blocks a new one for `ASK.cooldownMs` (24 h) **from the dismissal** (`closedAt`, stored with the row); at most `ASK.perUser` (20) requests a person may make in `ASK.windowMs` (24 h) across all scopes (every row counts for its `at`, including granted and dismissed ones, so a grant does not return quota); at most `ASK.scopePending` (200) pending per scope. On Postgres the step takes a per-scope advisory lock first and a per-person one second (always in that order), so concurrent asks by different people cannot pass the scope limit. `requestAccess` takes an optional `limits: { perUser?, scopePending? }` that can only LOWER the limits (tests). Refusal: **`429 rate-limited`** `{ error, retryAfter }` (seconds, rounded up; null when no wait helps) with a `Retry-After` header when known.
- **Idempotency.** The create's key row is written in the same transaction as the request (`idem`, the mechanism of § Idempotent creates). A replay whose key's request is no longer the open one (superseded, or re-asked) answers `409 superseded`, never the newer request; a replay with no row left is the ordinary `403`. The key is checked **first**, so a retried success replays (`201`, `Idempotent-Replayed: true`) even when the limit has since been reached; a key reused for another body is 422. A repeat re-authorizes the caller as they are now.
- **Freshness.** Nothing is announced (a request is not access). A request is closed (state `granted`, kept so the per-person count stays true; asking again is allowed) when the grant for that person lands at the same scope (`PUT /access/.../grants/user/:user`, `PUT /boards/:board/grants/:user`). **A read never writes:** the Access page hides a pending request whose person already reaches the role (a Team, a grant at a containing Group), and the row stays `pending` until the grant route closes it, a new ask supersedes it, or the ttl prunes it; hidden rows still count toward `scopePending` until then. A new ask for a different role than a pending one replaces it (`supersede: true` from the service; every write of a request, a supersede or a re-ask after a dismissal, mints a NEW id) only when the asker's access already reaches the pending role; otherwise the pending request is returned as it is. Requests older than `ASK.ttlMs` (30 days, counted from the dismissal for a dismissed one) are ignored and pruned.
- **Bounds.** The Space page adds, only for a caller who cannot create boards, one `membersAmong`, one `teamsAmong`, one `grantHolders` per container, one `accessRequest`. The Access page adds the same plus one `accessRequests` page (50) for managers and, for those requests, `tenancy.effectiveAmong` (at most 50 requesters: for a Space or Group ONE `accessContext` plus one `resolveAccess` per requester in memory; for a board up to 50 sequential `accessOn` calls). It performs no Registry write. Nothing loops members.

## Sign-in code exchange

No long-lived token ever appears in a URL. After Google sign-in the server hands the page a single-use code, and the
page trades it for a session token.

1. **Callback.** `GET /auth/callback` answers 302 to the post-login URL with `#code=<code>` (for a share link, the
   board URL with `#code=<code>`, plus `&link=invalid` or `&link=unavailable` where that applies). It also sets
   `__Host-plen_xchg`, an HttpOnly, Secure, SameSite=Strict, host-only cookie that lives 60 s and carries the signed
   identity.
2. **Client.** Read `#code`, drop the fragment at once (`history.replaceState`), then `POST /auth/exchange` from the
   same origin with `credentials: "same-origin"`, `Content-Type: application/json` and body `{"code":"<code>"}`.
   The server accepts only the post-login URL's origin, so the auth routes and the page share one origin.
3. **Answers** (JSON, always `Cache-Control: no-store`):
   - `200 {token, user, name, email, domain, exp}`; the exchange cookie is cleared.
   - `400 {error:"invalid-code"}`: unknown, expired (> 60 s), already used, or not this browser's. One answer for all,
     so there is no oracle.
   - `403 {error:"bad-origin"}`: the `Origin` header is not the post-login origin.
   - `503 {error:"unavailable"}`: the server can't issue a session right now; the code is not spent, so one jittered
     retry is reasonable. Sign-in not configured at all answers `503 {error:"sign-in-unavailable"}`.
   - A body that is not JSON (by content type) is refused with 415, an oversized one with 413, and a JSON content type
     with a body that can't be read, isn't an object, or has a field other than `code` with `400 {error:"bad-request"}`
     (`"unknown-field"` for the extra field), and with a body that doesn't parse as JSON with `400 {error:"bad-json"}`.
   - `{error:"network"}` is client-only: no answer at all. The server never sends it.
4. The token then goes in `hello` (kept in memory and sessionStorage, never localStorage or a URL).

Field types of the 200 body:

- `user`: a non-empty string (`google:<sub>`, or `dev:<name>` for dev tokens).
- `name`: a string, or null (Google sent none; an empty name becomes null).
- `email`: a string, or null whenever Google isn't authoritative for it (a consumer account not at `@gmail.com`, or a
  Workspace user on a secondary domain). Show it only if present.
- `domain`: a string, or null: the Workspace `hd` domain, null for any non-Workspace account. It says who the user
  is, not how they got access (an invite or share-link user from a Workspace keeps their own domain).
- `exp`: an integer, seconds since the epoch.

The client side of this contract is `web/ports/auth.js`; `test/web/contracts/auth-contract.js` runs it against every
adapter.

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
- **Re-checking live connections.** A gateway computes the role of its live connections on a board again (1) on
  every `.grants` message for that board (§ Bus) and (2) on a timer, every **60 s**, because time passing changes
  roles without any message (a share link or invite past its `expiresAt`, § Tenancy). So an expiring link or invite
  takes effect within about 60 s; a `grants` change within one pass. A connection that lost its role is answered
  `auth` and closed; one whose role changed is answered `unavailable` and closed (it reconnects with the new role).
  - **One pass at a time per board.** A `grants` message during a pass runs one more pass after it, however many
    arrive: never a pass per message. A timer tick during a pass is skipped. A `grants` message during a timed or
    retry pass also cuts that pass short at its next batch (the users it didn't reach keep their role until the
    grants pass, which checks everyone).
  - **Per user, not per connection.** A user's connections on a board share one `role` answer per pass (grouped
    by user, email and domain: what `role` reads). Users with
    a writer connection are checked first (they are the ones who could write). The pass yields between users, so it
    never holds a gateway's event loop.
  - **Errors (`role` throws, or hasn't answered in 2 s).** After a `grants` message, **fail closed**: that user's connections are answered
    `unavailable` and closed, and their hellos do the check again (a Registry that can't answer can't vouch for a
    role that was just changed). On the timed pass, **keep and retry**: the connection stays open and is checked
    again after 2 s, 4 s, 8 s (counted per connection; a good answer resets the count); after 3 failed retries
    (about 14 s of outage) that connection alone is answered `unavailable` and closed. A timed pass whose whole
    first batch of lookups fails stops (the Registry looks down); the users it didn't reach are unchanged until the
    next pass. So a short Registry blip closes nobody, one failing user closes only their own connections, and an
    expired link outlives its `expiresAt` by at most about 60 s + 14 s while the Registry answers.
  - **Role cache.** A gateway may answer a hello's role from a per-gateway cache. If a `grants` message is lost, a
    NEW connection may therefore be admitted with the old role until the gateway's next timed re-check, which reads
    the Registry fresh and treats the connection like any other live one, or until the cache entry's life ends (at
    most 30 s), whichever is first. The cache never hides a revoke past the next timed pass.

### Registry

Tenants, boards, grants, invites and share links. Platform owns its implementation (server/auth/registry.js); the
method names are stable. Ids are server-minted over `[a-z0-9-]`.

| Area | Calls |
|---|---|
| tenants | `createTenant({ domain, domains, kind, admins })` (`kind` default `company`), `tenant(id) → { id, domain, domains, kind, admins, createdAt }`, `tenantByDomain(domain)` (any of the Unit's domains → tenant), `addTenantAdmin(tenant, user)`, `addTenantDomain(tenant, domain)` |
| boards | `createBoard({ tenant, title, memberRole, space, owner?, idem? }) → { id, tenant, title, memberRole, space, createdAt }`, `board(id) → { tenant, title, memberRole, space, … } \| null` (`space` null = unfiled) |
| grants | `setGrant(board, user, role \| null)`, `grant(board, user) → role \| null`, `grants(board)` |
| invites | `createInvite({ board, email, role, expiresAt, by, idem? })`, `invite(id)`, `invites(board)`, `invitesFor(board, email)`, `revokeInvite(id)` |
| share links | `createLink({ board, role, expiresAt, by, idem? })` (role per link), `link(id)`, `links(board)`, `revokeLink(id)`, `addLinkUse(link, user)`, `linkUses(board, user)` |
| idempotency | the optional `idem: { user, key, fp }` of `createBoard`, `createGroup`, `createSpace`, `createTeam`, `createInvite`, `createLink` (the key row is written in the create's own atomic step; a live one rejects with `code` `idem-replay` + `ref`, or `idem-mismatch`), and `idemGet({ user, key, fp }) → { state: "none" \| "done" \| "mismatch", ref? }` (§ Idempotent creates) |
| home | `markOpened(user, board)`, `recents(user, { limit })`, `setStarred(user, board, on)`, `starred(user, { limit })`, `starredAmong(user, boards)`, `sharedBoards(user, email, { limit })`, `searchBoards(tenant, { q, unfiled, after, scan })`, `spaceCandidates(tenant, { user, all, after, limit })`, `groupCandidates(tenant, { user, all, limit })`, `boardRows(boards, { user, email })` (§ Home) |
| access requests (#51) | `requestAccess({ tenant, scope, user, role, idem?, limits?, supersede? }) → AccessRequest` (one atomic step: key, existing row, cooldown, per-user and per-scope limits, write; rejects code `rate-limited` with `retryAfterMs`), `accessRequest(scope, user) → AccessRequest \| null`, `accessRequests(scope, { limit }) → AccessRequest[]` (pending, newest first, default 50, at most 200), `closeAccessRequest(scope, user, "dismissed" \| "granted") → boolean` (both keep the row with `closedAt`: `dismissed` holds the cooldown, `granted` only the per-person count; a closed pending row is never reopened by a read), `grantHolders(scope, roles, { limit }) → ScopedGrant[]` (scoped grants at the scope whose role is in `roles`, by subject, at most 20); table `reg_access_requests` (tenant, scope, member, role, state `pending`|`dismissed`|`granted`, at, closed_at; unique per scope and member) |
| organization | `createGroup`, `group`, `groups`; `createSpace`, `space`, `spaces`, `ensurePersonalSpace(tenant, user)`; `createTeam`, `team`, `teams`, `setTeamMember`, `teamMembers`; `setScopedGrant({ scope, subject, role \| null })` (a role shaped `r-…` must be a custom role of the scope's Unit, checked in the write: code `no-role`), `scopedGrants(scope)`; `createRole({ tenant, name, base, boardRole, permissions, max? })` (`max`: rejects code `limit` when the Unit already has `max` custom roles, atomically), `updateRole`, `role`, `roles`; Roles (§ Roles): `deleteRole(tenant, id)` (ONE atomic step: rejects code `in-use` while any scoped grant holds the role, `member` is never deleted, an unknown id rejects `registry: no such role`), `roleUsage(tenant, ids, { cap })` (per id, **this Unit's grants only**: a scoped grant has no tenant column, so its scope's row says whose it is and another Unit's grant of the same role string never counts, nor does a Team id of another Unit appear; `member` is refused: `{ places, users, teams }` = grant rows holding it counted to `cap + 1`, DISTINCT user subjects counted to `cap + 1`, and up to 50 Team ids, in one statement per id; index on `reg_scope_grants (role)`), `memberCount(tenant, { cap })` (directory rows, counted to `cap + 1`); `accessContext(scope, { users, chain })`; `boardsIn(scope, { after, limit })`, `scopesOf(subject, { after, limit })`; `accessContexts(scopes, { users })` (the batch of `accessContext`, one statement on Postgres), `rename({ type: "board"\|"space"\|"group", id }, name)`, `updateScope({ type: "space"\|"group", id }, { name?, generalRole? })` (atomic; returns the row), `spacesIn(group, { after, limit })` (§ Spaces and Groups); Teams and access (§ Teams and access): `renameTeam`, `deleteTeam` (atomic, `last-owner`), `teamsPage(tenant, { after, limit, q })`, `teamsAmong(tenant, ids)`, `teamMembersPage(team, { after, limit })`, `scopedGrant(scope, subject)`, `scopedGrantsPage(scope, { after, limit })`, and the member directory `touchMember(tenant, { user, name, email })`, `membersAmong(tenant, users)`, `findMembers(tenant, { q, limit })` (table `reg_members`) |

Single node: SQLite; cluster: Postgres. The room never calls it; gateways and Auth do. On Postgres the server
runs as a role that doesn't own the schema (§ Store, Least privilege).

- **At least one owner per board, atomically.** It is **`Registry.setGrant`** itself that refuses to remove or
  downgrade a board's last owner. Removing or demoting an owner (`setGrant` to a lower role or
  `null`) must leave at least one `owner` grant on that board, and the last-owner check and the change must be
  **one atomic step** (one transaction, or a conditional delete/update), so two concurrent removals can't both
  pass. The call that would remove the last owner fails and changes nothing. Every durable adapter (phase 3/4)
  must honour this.
- **`createBoard` takes the creator as `owner`**, so `POST /boards` is one call: the board, its `owner` grant and (with a key) the idempotency row are one atomic
  step. There is no state with an ownerless created board. (`setGrant(board, user, "owner")` remains the admin's repair for a board made without `owner`, e.g. by a script.)
- **Organization** (§ Tenancy, "Organization"). `accessContext({ type: "board"|"space"|"group"|"unit", id }, { users, chain })`
  is the resolver's one read: the tenant, the scope's board / Space / Group, the grants on each scope of the chain, the
  Unit's roles, and the members of every Team named in those grants, as one consistent answer (null for an unknown
  scope). `users` limits the Team members returned to those users (a hello passes its user, a re-check pass its users),
  so a Team of 100k costs nothing; `chain` hands back the stable records a cache already holds, and the adapter then
  reads only the volatile rows. Its cost is **one statement on Postgres** (a single snapshot) and a fixed number in a
  SQLite transaction, however many grants, Teams or members exist, and it never takes a list of boards: the resolver makes
  no per-row follow-up queries and builds one user→Teams index per pass. Who owns what: the Registry owns every row; the
  resolver owns no state (a function of what it is handed); `tenancy` owns none beyond `roleCache`'s bounded entries
  and chains. Adapters validate shape (names, scope and subject types, same tenant) and store role strings as given; whether
  a role is valid where it is held is `server/auth/permissions.js`'s rule, applied by the admin layer on write and by the
  resolver on read.
- **Last owner for Groups and Spaces.** `setScopedGrant` refuses to remove or demote the last *counted* `owner` of a Group
  or Space, atomically. A user owner always counts; a Team owner counts only while the Team has at least one member (an
  empty Team guards nothing). `setTeamMember` refuses to remove the last member of a Team that is the only counted owner
  of a Group or Space. Both are `last-owner`. Postgres lock order, in both calls: the tenant's owners lock (a
  transaction advisory lock, `plenary-owners:<schema>:<tenant>`, taken by every write that can lower a Group's or Space's
  counted owners: a Group or Space grant change and a Team member's removal, all rare admin writes) first, then the
  container's row (Group or Space), then the Team's member rows, never the Team row. The tenant lock is what keeps the count
  honest when two Teams lose their last members at once. A demotion that counts a Team owner share-locks the Team's member rows
  before counting; a member's removal locks them all, deletes its own, and, if the Team is now empty, re-reads the
  containers the Team owns (grants made while it waited are visible) and refuses if any has no counted owner.
- **Postgres tables** (all created only if missing, like the first seven; nothing is ever altered): `reg_tenant_meta` (kind),
  `reg_tenant_domains` (a Unit's domains after its first, which stays in `reg_tenants.domain`; a domain is unique across both,
  serialised by an advisory lock), `reg_groups`, `reg_spaces` (unique `(tenant, owner_user)`: one personal space per member),
  `reg_board_spaces` (a board's Space; no row = unfiled), `reg_teams`, `reg_team_members`, `reg_scope_grants` (scope, subject,
  role), `reg_roles` (custom roles and the Unit's `member` override). SQLite has the same tables with the same names.
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
- **Cluster id (isolation on a shared bus).** Two clusters may share one NATS server, so every subject on the wire
  starts with the cluster id: `<cluster>.<subject>`, e.g. `c-k3j9x0a1b2c3d4e5.plen.<tenant>.<board>.entries` and
  `c-….plen-hosts.open`. Every subject named below is written without it; the Bus adapters take the id as their
  `cluster` option (`natsBus`, `memoryBus`; both apply `scopeBus` from server/bus/port.js), which adds it on publish
  and subscribe and strips it from what handlers see, so no gateway, room host or feed knows about it, and only the
  adapters build wire subjects. An adapter refuses a malformed id (anything but `c-` + 16 of `[a-z0-9]`) before it
  connects; the composition root (server/main.js) reads the id from the Store and passes it in. A node never publishes or subscribes outside its own cluster's prefix.
  - **Where the id comes from: the Store.** The id is `c-` + 16 of `[a-z0-9]`, minted once by the first node that asks
    and kept in the Postgres Store (table `pl_cluster`, at most one row), so **two nodes on one Postgres database
    are one cluster by definition and two clusters never share an id**, with nothing for an operator to configure or
    mistype. `store.clusterId()` returns it (Postgres adapter only; a single node uses the in-memory bus, which no
    other process can reach, and has no id). The id is durable before it is returned. A node whose Store has no id, returns a
    malformed one or fails to read it **refuses to start** (fail closed: it never joins the bus unscoped; the adapters
    it opened are closed and the entry point logs `start refused`).
  - **Why this isolates.** The lease and the log live in the Store, so a board's sequencer is unique per Store. A
    host answering a remote open (or reading a board's `.inbox`) from another cluster is what splits the brain: it
    would lease and ack the board into its own Store, and the gateway's client would hold an ack the board's real
    Store never saw. With the id in the subject a foreign host cannot see the request, the board's inbox or its
    heartbeats, so a gateway whose cluster has no host answers `unavailable` rather than being served by a stranger.
  - **Not a security boundary.** The prefix keeps honest clusters apart; any client that can connect to the NATS
    server can still subscribe to another cluster's subjects. For real separation give each cluster its own NATS
    account or user, limited to publish and subscribe on `<id>.>` (and the inbox prefix it uses).
  - **Finding the id.** It is on the `cluster adapters open` log line (`cluster`) and in
    `SELECT id FROM pl_cluster`; it is minted at the first node's first start and never changes.
  - **A restored or cloned database keeps its id.** A copy of a production database (staging, a restore test) that
    shares a NATS server with the original is, by this rule, the same cluster. Give the copy its own id before it
    joins a shared bus: with every node of the copy stopped, `DELETE FROM pl_cluster;` (the next start mints a new one).
  - **Rolling upgrade.** The id changes the wire subjects, so a node from before this rule (unscoped `plen.…`
    subjects) and a node with it never exchange a message: an old gateway's remote open does not reach a new host,
    and an old and a new gateway do not see each other's presence or entries. They also cannot split-brain, because
    leases are in the Store. The Store's conditional, epoch-fenced append stays the last line of defence inside one cluster: a host that lost its lease can't write (§ Store). Upgrade a cluster as a whole: stop the old nodes and start the new ones (hosts first),
    or expect writers on a not-yet-upgraded gateway to get `unavailable` until its host side is upgraded. The other
    direction fails the same way: a writer on an upgraded gateway gets `unavailable` while an old host still holds the
    board's lease, until that host stops (its lease lapses or is released) and an upgraded host takes the board. Readers on
    a gateway whose board feed lost the bus keep working from the Store poll (≤ 5 s behind, see below). The schema
    gains table `pl_cluster`: a node running as a role that may not create tables starts only after the owner has
    migrated (`deploy/README.md`).
- Subjects per board: `plen.<tenant>.<board>.entries` (the room, after an append resolves), `.presence`, `.emotes`
  and `.here` (gateways), `.inbox` (gateway → room, numbered per connection: rule 6), `.gw.<gateway>` (room →
  that one gateway: `welcome`, `ack`, `error`, each addressed to a `conn`), and `.grants` (whoever changes the
  board's grants, invites or links → gateways: `{ board }`; each gateway computes its connections' roles again and
  closes the ones that lost access or changed role; § Auth, Re-checking live connections, also says when they
re-check without one). `.grants` is at-most-once like all bus traffic: a lost one is repaired by the next timed
  pass (≤ 60 s). Gateway ids are server-minted like the others.
- **`.here` messages** (gateway → gateways, never saved): `{ gateway, writers: [{ user, name, role, active }]
  (≤ 50), writerCount, viewers }` = that gateway's own writer users on the board (the 50 it would show first, with
  `active` = the time of their last op or presence, ms), its number of writer users, and its number of viewer
  tabs (§ Presence, `here`). Small by construction (≤ 50 entries) whatever the board's size.
- **At-most-once.** Entries carry `seq`, so a gateway that sees a gap reads the missing range from the Store and
  delivers in order; duplicates are dropped by `seq`. Presence has no repair.
- **A lost last entry is repaired two ways.** While it runs, the room publishes a `{ seq, epoch, cp }` **heartbeat**
  (resolved seq, the room's epoch, its latest durable checkpoint: below) on `.entries` every 2 s. And a gateway that has heard neither an entry nor a heartbeat for
  **5 s** on a board it serves reads the Store from its last delivered `seq` + 1 (checked every 2.5 s, so 5 to 7.5 s
  after the last live message), and again 5 to 7.5 s later while the silence lasts. The poll needs no room, so it also works after the room stopped or its host died (viewers never
  restart a room). Guaranteed: every connected client gets every resolved entry, in order, within 7.5 s of
  the bus going quiet. Delivery to clients is effectively at-least-once, eventually consistent.
- **The heartbeat, exactly.** Publisher: the room host (`server/room-host.js`), one message per board it holds a live
  room for, on `.entries`, every `heartbeatMs` (2,000 ms) from one timer of the host (all boards beat on the same tick:
  a burst of N publishes, no jitter). Payload `{ seq, epoch, cp }`: `seq` = the resolved seq (never the speculative
  one), `epoch` = the room's epoch (the lease's, § Recovery, Room identity), `cp` = newest durable checkpoint (below).
  Two variants share the shape: `{ seq, epoch, cp, opened: true }` once at room build, before the inbox is served, and
  `{ seq, epoch, cp, released: true }` after a clean stop, and `{ seq: 0, epoch, cp: 0, released: true }` after it
  released the lease of a build that failed (a timed-out Store call, § Recovery "Stuck host"). A host whose lease renew
  deadline has passed, or whose progress watchdog fired (ops waiting, resolved `seq` unmoved for `stuckMs`), publishes
  nothing and stops the room instead; it keeps no lease and no cooldown-time claim (§ Recovery). Consumers and what each does with it:
  (1) **gateway feed** (`server/feed.js`): a heartbeat or an entries batch whose `epoch` is at least the feed's (a
  missing or non-integer `epoch` counts as lower) resets its silence timer; one from a lower epoch (a dead incarnation's,
  delayed on the bus) does not, so stale traffic cannot hold off the Store poll. A `released` message is a host leaving: it neither resets the silence timer nor raises the feed's epoch (a failed build's release carries the epoch of a room that never served), though its `cp` is still read. It reads the Store when `seq` is above its own
  (a lost last entry); raises its epoch (never lowers: a late or duplicate beat with a lower `epoch`, `seq` or `cp` changes
  nothing); records `cp` (max) to decide a re-base. (2) **waiting host** (a host that found another host's live lease,
  `watchEntries`): a message (heartbeat or entries batch) with an integer `epoch` at least the highest it knows (seeded
  from the lease it read) counts as "the holder is alive" and re-arms its silence timer (2 x `heartbeatMs`); one with
  a lower or missing `epoch` is a late one from a dead incarnation and counts for nothing, `released` included. A late
  message of the **same** epoch is indistinguishable from a live holder's and does count; it delays the takeover by
  at most 2 beats after the last such message. Hellos held while waiting are never dropped without an answer: a
  later message from the holder drops only those held longer than 2 beats (a live holder had its chance to answer);
  younger ones stay, and the silence, a new holder or the `unavailable` answer resolves them. `opened`, or an epoch above
  the last one heard, answers the held hellos `unavailable`; `released` (current epoch) makes it try the lease at once.
  **A heartbeat never grants or moves the lease**: it only decides *when* a waiting host asks. The Store's
  `acquire` is the sole arbiter (live lease: refused; otherwise a new, higher epoch, and the old holder is fenced on its
  next write or renew). So a missed, late, duplicate or forged heartbeat can cause an early *attempt* (one Store read,
  refused while the lease is live, then the next try at the lease's remaining time + a margin, at least every ttl/3)
  and never a wrong takeover. Missing beats: a gateway polls the Store once its silence reaches 5 s, checked every 2.5 s, so a lost
  last entry is repaired 5 to 7.5 s after the last live message (then again 5 to 7.5 s later while the silence lasts); a waiting host attempts after 2 beats of silence. Cost: 1 message per hosted board per 2 s (30 per
  minute, 26 bytes each as JSON with small numbers, 780 B per board per minute, payload bytes only (no subject or
  NATS framing); test/server/heartbeat.test.js counts them on virtual time: 1, 100 and 1,000 boards give exactly 30,
  3,000 and 30,000 messages a minute. Indicative CPU, publisher side only, in-memory bus (consumers not measured):
  a whole beat tick about 0.01, 0.14 and 0.35 ms); the beat loop does no Store work. Batching across boards is not done: subjects are per board and a gateway subscribes per board, so a batch
  would have to be fanned out again on every gateway.
- **`cp`, the latest durable checkpoint.** The heartbeat's `cp` is the `seq` of the newest checkpoint the room
  knows is in the Store: the one it was rebuilt from, or a later one whose write the Store has acknowledged (0 =
  none). A checkpoint is announced only after its write succeeds, never when it is taken, so `cp` never names a
  checkpoint a reader can't find. A gateway keeps its cached tail short by re-basing it on a newer checkpoint (§
  Recovery, Rebuild; for a gateway whose host announces no `cp`, once the tail passes 1,000 entries or 4 MB): it reads one from the Store only when the
  largest `cp` it has heard is above both its base and the `cp` of its last completed look, so a gateway reads each
  checkpoint at most once, and an idle board, or a room that hasn't folded, costs no reads. A look that fails (a
  Store error) is not completed and is tried again (on the backoff below). A gateway whose last heartbeat for the
  board had no `cp` (its host predates `cp`), or that has had none since it began serving the board (the Store poll
  below delivers), looks when its tail is due, and after a look that finds nothing newer, again on at most 3 later
  heartbeats or polls, then not until the tail is due again. Mixed versions are safe both ways: an older gateway
  ignores `cp`. A host that stops cleanly checkpoints, releases the lease and then publishes
  `{ seq, epoch, cp, released: true }` on `.entries` (so a waiting host takes the board at once): it carries `cp`
  like a heartbeat, which announces the stop checkpoint. A look that fails (a Store error) is tried again on a
  jittered backoff of heartbeats: after the n-th failure in a row, with b = min(31, 2^(n-1) - 1), the next k
  heartbeats or polls are skipped, k drawn from [⌈b/2⌉, b] (so gateways don't look in lockstep). While skipping, no
  look is made at all, also not one a due tail would trigger (a host without `cp`), so a persistent failure costs at
  most one look per 17 heartbeats or polls once the backoff is at its cap, plus one per newly announced checkpoint. A heartbeat naming a `cp` above the one
  the failing look was for ends the skip (a checkpoint was just written: look now). A successful look resets n.
- A gateway subscribes to the board's subjects **before** it forwards a hello or serves any catch-up, so
  nothing between catch-up and live is missed.
- Gateway → room messages on `.inbox`: a hello or op as `{ n, conn, gateway, user, name, role, client, msg }`; a
  close notice as `{ n, conn, gateway, closed: true }`; and, every 5 s, `{ gateway, conns: [conn…] }` listing that
  gateway's open writer connections on the board (rule 6). A lost close notice is repaired by the next list; a
  lost reply by rule 2's or rule 12's timeout.
- **Remote open** (a gateway-only node; no tenant or board in the subject, and, like every subject, the cluster id in front of it: only this cluster's hosts hear it): `plen-hosts.open` carries
  `{ tenant, board, gateway, n }` to every room host, which opens the board itself (takes the lease or watches the
  holder) and only then answers `{ n, board, state: "held" | "watching" }` on `plen-hosts.opened.<requester>`. The
  gateway forwards the writer's hello on the first `held`; a `watching` answer starts a grace of
  min(1000 ms, ttl / 4), after which it forwards anyway. No answer within the lease ttl: the hello is answered
  `unavailable`. Nothing is cached: every writer hello asks again. So a cluster with a gateway-only node needs at least
  one host node.
- **Message size: 2 MB cap.** A deployment's bus must carry 2 MB messages (NATS: raise `max_payload`; headers
  count toward it). What travels:
  - **Never on the bus:** catch-up and snapshots. The gateway reads them from the Store (or its cached tail) and
    sends them straight to the client (rules 3, 8). A room never publishes catch-up frames on `.gw.<gateway>`.
  - **`.inbox`:** one hello or op plus its envelope. An op is ≤ 1 MB (§ Limits), so it always fits. A gateway
    that still can't publish one answers `too-large` with the op's `id`.
  - **`.entries`:** a group commit's entries are published as one or more messages `{ from, to, items, epoch }`
    (`epoch` = the room's, as in the heartbeat), each under 2 MB, in `seq` order. A single entry always fits (one op plus its fields). Gateways deliver by `seq`, so a split batch is
    the same as several appends.
  - **`.gw.<gateway>`:** `welcome`, `ack`, `error` only (small).
  - Guaranteed: no message the protocol needs is over the cap. A publish refused anyway (misconfigured bus) is
    repaired like a lost message: Store poll for entries, the client's timeouts for replies.
- Single node: an in-memory bus with the same contract. Cluster: NATS core.

### Blobs

- `put(tenant, sha1, bytes) → boolean` (true: stored now; false: the tenant already had it), `get(tenant, sha1) → bytes | null`,
  `usage(tenant) → bytes` (the total the tenant's blobs take; the quota's starting point).
- **No token on HTTP.** A client asks over its socket (on the connection that has been welcomed, never a second one):
  `{ t: "blob", sha1, put?: true }`; the gateway checks the role and answers `{ t: "blob", sha1, url }`, a signed URL
  scoped to (tenant, board, sha1, GET or PUT), valid 5 minutes. The tenant and board are the connection's, never the
  message's. Works for `<img>`, browsers and Herdr alike, and keeps the token out of headers and URLs.
- **`sha1` is exactly 40 lowercase hex characters, and `put` is `true` or absent.** Anything else is answered
  `bad-op` before the server signs anything or calls Blobs, so no adapter ever sees a key like `../other-tenant/x`.
- **Refusals** are an `error` with no `id` and the request's `sha1` (echoed as given when it is a string of at most 64 characters, even a malformed one), so the client matches it
  to its request; nothing else is dropped for it. `bad-op` (shape), `forbidden` (role), `limit` (rate), `unavailable`
  (this node has no blob store, or signing is down: ask again later), `auth` (before `welcome`; the connection stays).
  Checks run in this order: rate, shape, role, put rate.
- **Rates:** `blob` requests 10/s per connection (every request counts, refused ones too); put URLs 30 per minute per
  user per board per gateway. Over -> `error` `limit` (ask again later).
- **The URL is `<PUBLIC_URL>/blobs/<token>`** when `PUBLIC_URL` is set, else the path `/blobs/<token>`, which the client
  resolves against the origin it connected to (the `ws` URL with `http`). `token = base64url(payload) "." base64url(HMAC-SHA256(key, "b1." payload))`,
  `payload` the JSON `{ tenant, board, sha1, verb: "GET" | "PUT", user?, exp }` (`exp` in epoch ms). `key` is derived from the
  deployment's shared `COOKIE_KEY`, so every gateway verifies every other gateway's URLs; a single node without one
  signs with a random key per process, so a URL does not survive a restart (the client asks again). A bad, forged,
  tampered or expired token is `401 { "error": "bad-token" }`, a verb other than the token's is `405`. The role is
  checked when the URL is asked for, not when it is used: a URL is a 5-minute bearer capability.
- **A cluster must name its storage.** `main.js` refuses a cluster node (`DATABASE_URL`/`NATS_URL`) without `S3_ENDPOINT`:
  a picture put through one node would be unreadable through another. `PLENARY_BLOBS=local-disk` opts a cluster with a
  single gateway into disk (the start warns).
- **A signed PUT URL ends at our server**, never directly at S3: the server must hash and type-check the bytes
  before they are stored.
- **`PUT /blobs/<token>`** (a put URL): the body is the bytes, with a `Content-Length` (chunked bodies are refused).
  The server refuses before reading more than 10 MB, hashes the bytes and refuses a mismatch, checks they are a
  PNG, JPEG, GIF or WebP (SVG refused), then reserves quota and stores. The first bytes for a hash are kept: a put
  of a stored blob succeeds without storing. `201` stored now, `200` already stored, `400 bad-length` (no or
  zero length), `413 too-large`, `415 not-image`, `422 hash-mismatch`, `507 quota`, `503 unavailable`
  (the store failed or took too long; safe to retry), `503 busy` (a node reads at most 8 PUT bodies at once and one account (per tenant, across its boards) at most 2; retry), `409 in-flight` (a second PUT on a token already being read), `408 timeout` (the whole body must arrive within 120 s however slowly it drips; retryable), `401`.
  The body is read as it arrives (memory follows the bytes sent, not the `Content-Length` claimed). Bodies are JSON `{ "error": code }`.
- **`GET /blobs/<token>`** (a get URL): `200` with the bytes, `Content-Type` of the sniffed kind, `X-Content-Type-Options:
  nosniff`, `Cache-Control: no-store`, and a `Content-Security-Policy: default-src 'none'; sandbox`; `404 not-found`
  (nothing stored under that hash yet: an element's op can arrive before its upload finishes, so a client retries);
  `503 unavailable`; `401`.
- Upload needs write on `board` or `notes` (not `records`: commenters can't place images); reading needs any role
  on the board, a viewer included. Cap **10 MB**.
- **Quota** (default 10 GB per tenant, `PLENARY_BLOB_QUOTA_BYTES`): a node reads `usage(tenant)` once (its first put
  for that tenant), then adds what it stores. A put reserves its bytes before storing and gives them back when it
  fails or the blob was already there, so concurrent puts on one node never go over. Several nodes each count their own
  puts after the first read: the real overshoot is at most the sum of what the other nodes store before this one
  restarts (Known limits).
- **Client rules** (web client, `wsNet`): an upload is `blob` ask then PUT; a download is `blob` ask then GET. Only
  well-formed ids (40 lowercase hex) are asked for. A failure that can pass (no welcome yet, a dropped connection,
  `unavailable`, 408, 429, 5xx, a network error, a timeout) is asked again with backoff on a fresh URL, up to 6 tries;
  a GET `404` the same way (not yet). A `limit` is not a failed try: it backs off (2 s doubling to 30 s, up to 20
  times) and the user is told once. A PUT answered `503 busy` or `409 in-flight` was reachable, not failed: the client waits
  the `Retry-After` and sends the same URL again while it is fresh (4 minutes), without a new ask or a counted try, and says
  "the server is busy" once. At most 2 PUTs (the server's per-account cap) and 4 GETs run at once; a PUT may take up to
  150 s (the server's body deadline is 120 s). After the tries, a download rests 30 s, doubling each round up to 10 min (asked again by the next `want` after the rest, at once when a
  document change touching that picture arrives, and after a reconnect), an upload
  wakes itself after 30 s and tries again, so a picture someone placed always goes up once the server takes it. `quota`,
  `too-large`, `not-image`, `hash-mismatch`, `forbidden` and `bad-op` are final and shown to the user. Requests wait
  for `welcome` and are asked again after every reconnect.
- Bytes never travel in ops. A blob is stored once per tenant, shared by that tenant's boards.

## Known limits of v1.1

- **`layers` is one key.** Two editors changing layers at once no longer lose one silently: the second gets
  `stale-setting` and its app re-applies the change on the current list. Still per key, not per layer: editing
  two different layers at once conflicts, and a change the app doesn't retry is lost (the user is told).
- **Seeding's silent band.** After an import renumbers an element (over 1,000 and new to the board) to version 1,
  a pane that still holds the file's old copy can write it back. A copy at 1,001 or just above (within 1,000 of
  the room's version) is accepted and undoes later edits to it without a word; anything higher is held back with
  a warning. drawh warns at import time.
- **Blobs are tenant-wide, by decision.** Within a tenant, anyone with a role on one board can read another board's blob
  if they know its SHA-1. Hashes are not guessable, and a `200` against a `404` only tells you whether the tenant holds
  an image whose bytes you already have. Per-board blobs would cost storage and cross-board dedupe; not done.
- **`/blobs/*` sends no CORS headers**, so the page must be same-origin with it: `PUBLIC_URL` must be the origin the
  page is served from (unset, the URL is a path and always is).
- **SHA-1 keys, first put wins:** a tenant writer able to make a chosen-prefix collision could plant bytes another
  user's image later resolves to. Small in practice; the fix (key by SHA-256, keep `fileId` as a lookup) is open.
- Blobs are never garbage-collected; only the quota bounds them.
- Tombstones are never compacted; the stream caps count them.
- **The log grows forever in M2** (never pruned).
- **Durability is per Store node** (§ Store): losing that node's disk, or failing over to a replica that lags,
  can lose acked entries. Replicated durability is M7.
- **Big boards join slowly:** the caps allow a snapshot over 100 MB, which doesn't fit 100k joins in 2 minutes.
  Compressed catch-up (§ Joining) takes a varied 2,000-element board from 1.1 to 2.2 MB down to 0.15 to 0.6 MB (4× to 7×;
  near-identical shapes reach 30×), but a board near the caps is still tens of MB after it. M4's load test sets the
  real cap.
- **A big checkpoint's write is in parts** (§ Recovery, "Checkpoint parts"; `scripts/fold-bench.js` prints `sqlitePutMaxStallMs`
  and, with `DATABASE_URL`, `pgPutMaxStallMs`). What still holds the loop in one call: one part's insert (about 3 to 15 ms at 1 MiB,
  fsync-bound, plus a WAL checkpoint every few parts), `JSON.parse` of a whole checkpoint when a room rebuilds or a gateway feeds one,
  and `Buffer.from(text)` before the catch-up deflate (about 10 to 20 ms per 18 MB text, once per text). The independent review measured about 20 ms worst case at 50 MB and judged it acceptable: it is fsync-bound (plus the WAL's automatic checkpoint), so smaller parts do not help.
- **Compressed catch-up is for clients that can inflate.** A runtime with no zlib (Herdr's QuickJS) joins as before:
  plain text, the full size.
- **The op rate is per gateway:** a user connected through G gateways can write up to G × 8 connections × 20
  ops/s. The connection cap (8 per user per board) is per gateway too.
- **Blob quota:** any writer, guests included, can fill the tenant's quota at the put rate (300 MB a minute).
  Per-user quotas are M6. The count is per node after its first read of `usage` (§ Blobs): with N nodes a tenant can
  overshoot by what the other N-1 store until a node restarts. A tab closed before its upload finishes leaves an
  element whose bytes only that tab ever had (the placeholder, for everyone else).
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

The v1.1 changes (§ What changed in v1.1) land after phase 2, as their own code job; its file-by-file list is in the
commit that landed it.

Tests (phase 2 done-when, plus what this spec adds):

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

## Open questions

1. **Durable reactions by viewers?** v1 says no: viewers send emotes (live, summed, not saved); comments and
   reactions need commenter or above, keeping 100k viewers off the sequencer. Yes would need a per-board cap.
2. **Commenter = records only?** v1 narrows `commenter` to comments and reactions (v0 also let it write notes).
3. **Blob reads within a tenant:** is "anyone with a role on some board of the tenant who knows the hash" acceptable,
   or must blobs be per board (more storage, no cross-board dedupe)?
4. **Names saved with comments:** v1 stores the author's display name on each comment when it is written, so it
   still shows after they leave. It stays in the log and doesn't follow a later rename. OK, or should names be
   looked up live (needs a directory of past users)?
