# Plenary protocol v0

One board = one **room**, the only sequencer. Clients send ops; the room checks the sender's role, gives each
accepted op the board's next **sequence number** (`seq`), logs it, acknowledges it, and broadcasts it. Every
copy that applies the same log in `seq` order ends in the same state; element ops converge in any order.

Transport-neutral: any ordered, message-framed channel (WebSocket today). Encoding is JSON in v0, behind a
codec (`encode(msg) → string | bytes`, `decode`), so a binary codec (MessagePack/CBOR) can swap in later.

## Streams

A board has two streams, each its own document with herdr-draw's merge rules:

| Stream | Holds | Who may write |
|---|---|---|
| `board` | the drawing (elements, `appState.herdr`: layers, grid, timeline) | owner, editor |
| `notes` | annotations, highlights, comments as elements | owner, editor, annotator, commenter |

Viewers write nothing. Roles come from the server's auth port, never from the client. Annotators and
commenters change only the notes they made, and never a stream's settings; owners and editors may change or
delete anyone's.

## The op (unchanged from herdr-draw)

`{ elements?: Element[], appState?: object }`: whole elements, each carrying Excalidraw's `version` and
`versionNonce`; `appState` is a shallow patch of `appState.herdr`.

- **Elements** need a string `id`, an integer `version` and an integer `versionNonce`. They merge by version: higher `version` wins; a tie goes to the lower `versionNonce` (same on every
  copy). A delete is an element with `isDeleted: true` and a higher version, so a stale copy can't bring it back.
- **A version can't jump** more than 1,000 past the room's copy of that element in one op, so no one can lock
  an element with a huge version.
- **`appState` keys are a fixed set**, each checked: `layers` (1–100 of `{id, name, visible, locked, opacity 0–100}`),
  `grid` (0–1000), `snap` (boolean), `timeline` (`{duration}` up to an hour). Unknown keys, including prototype names (`__proto__`, `constructor`), are refused.
- **`appState` keys have no version.** They merge by `seq`: a key takes the value from the highest-`seq` op that
  set it. Clients overlay their own unacknowledged patches on top until acknowledged.
- **Pictures** never travel in ops. An image element refers to `fileId` (SHA-1 of the bytes); the bytes go
  through the blob port (HTTP upload in M2) with a size cap. A room rejects an op that carries `files`.

## Messages

Client → room

| `t` | Fields | |
|---|---|---|
| `hello` | `token`, `board`, `since` (last `seq` this client applied, 0 if none), `client` | first message; the token travels here, never in a header (Herdr refuses credential headers). `client` = a name plus a per-session part (`laptop.k3x9`), no colon |
| `op` | `id` (`client:counter`), `stream`, `op`, `transient?` | the id must start with this connection's `client:` |

Room → client

| `t` | Fields | |
|---|---|---|
| `welcome` | `seq` (room's latest), `role`, `user` | answer to `hello` |
| `snapshot` | `seq`, `streams: { board: scene, notes: scene }`, `appSeq` | when `since` is older than the log kept |
| `entries` | `entries: [{ seq, board, tenant, stream, op, by, id }]` | catch-up and live batches, ascending `seq` |
| `ack` | `id`, `seq` | the op is logged; it will never be lost |
| `transient` | `stream`, `op`, `by` | drag previews and cursors: broadcast, never logged, never applied by the room |
| `error` | `id?`, `code`, `message` | `forbidden`, `bad-op`, `no-files`, `auth`, `too-large` |

## Rules

1. **Ack after log.** An `ack` means the entry is in the durable log (the storage port). It survives a crash.
2. **Idempotent resend.** A client resends every unacknowledged op after reconnecting, with the same `id`.
   The room keeps the `seq` of each (user, op id) it accepted and answers a repeat with the same `ack`, without
   logging or broadcasting it again. Version merging alone doesn't make resends safe for `appState`. Dedupe is
   per user, and ids carry the sender's own client id, so no one can suppress another person's op.
3. **Catch-up.** After `welcome`, the room sends either `entries` with every `seq > since`, or a `snapshot`
   (when the log no longer reaches back that far) followed by the entries after it.
4. **Order.** Clients apply `entries` in `seq` order, buffering gaps and skipping `seq` they already applied;
   duplicates and reordering in transit change nothing.
5. **Transient ops** (`transient: true`) are relayed to the room's other clients and dropped. The final,
   non-transient op ends the gesture.
6. **Tenant** is resolved by the server from the board, never sent by the client. A `hello` for another board,
   or a token from another tenant, is refused. Every logged entry carries its board and tenant.
7. **A refused op is undone.** The sender already showed it, so on an `error` naming one of its ops it drops
   that op, discards its copy, and reconnects with `since: 0`; its other unacknowledged ops are resent.

## Known limits of v0

- `layers` is one key: two editors adding layers at once converge, but one of the two layers is lost.
- The op-id table grows without bound; M2 bounds it per client.
- Recovery after a room restart (replaying the log) and lost messages on a live connection are M2's tests.
- Not yet run inside Herdr's QuickJS runtime.

## Not in v0

Presence and cursors beyond `transient`, batching intervals (the transport decides), binary codec, blob
upload, compaction policy, gateways and the bus (M4), regions (M7).
