# Report: p11-proto (protocol v1.1 code in packages/protocol)

**Done.** Every packages/protocol row of p1-v11.md's code list is built against PROTOCOL.md v1.1 (cb343b9) in
/Users/r/repos/plenary-p2 (branch p2-land). Nothing is committed.

- **`bun test test/*.test.js`:** 116 pass, 0 fail. That is 89 existing tests plus 27 new ones in test/v11.test.js.
- **`bun test` (whole worktree):** 375 pass, 0 fail. The client session had added web tests meanwhile; it was 347 earlier. test/web did not go red; nothing in web/ had to change.
- **Many seeds (scratch, not committed):**
  - convergence: 1,000 seeds
  - the new settings invariant: 1,000 seeds
  - the recovery rebuild-equals-original test: 300 seeds × with and without a checkpoint
  - a lone writer is never refused `stale-setting`: 300 seeds
  - nothing is held once the network goes quiet: 600 seeds
  - All pass. Details under "How I checked".

## Changes per file

| File | Change |
|---|---|
| `packages/protocol/envelope.js` | `MAX_OP_CHARS` is replaced by `MAX_OP_BYTES = 1_000_000`, counted by a new hand-written `utf8Bytes(str)` (a surrogate pair counts 4, a lone surrogate 3). `opProblem(msg, bytes)`: the 2nd argument is now **bytes**, no longer chars. `MAX_OP_DEPTH` 64 → **62**; new `MAX_FRAME_DEPTH = 64`. `APPEND_TIMEOUT_MS` 5000 → **4000**. New `MAX_WRITER_CONNS = 8`, `PING_IDLE_MS = 10_000`, `CONN_SILENCE_MS = 30_000`. New `appBaseProblem(appState, appBase)`. `opProblem` now gives `bad-op` for: settings plus elements in one op (even `elements: []`), `appBase` without `appState`, and missing, extra or non-integer base keys. The `appState` value check runs before the base check |
| `packages/protocol/codec.js` | `jsonCodec.encode` writes every op frame as `{"t":"op","id":…` first, whatever order its keys were built in. New pure `frameOpId(text)` reads the op id from a raw frame's head without decoding it (for the gateway) |
| `packages/protocol/ports.js` | `MemoryLog.openEpoch()` (+1 per call, 1 on the first) and `MemoryLog.epoch()` (0 = no room built yet). The Store typedef gains `openEpoch` and `epoch`; the Log typedef gains an optional `openEpoch` |
| `packages/protocol/room.js` | New constructor option `epoch` (default 1). `welcome.room = { board, epoch }`. New `room.heartbeat() → { seq: resolved, epoch }`. `Room.fromLog` calls `log.openEpoch()` when no `epoch` is passed. The temporary room in `checkpoint()` carries the epoch. Settings compare-and-set runs after the op-id table and after the "only owners and editors change settings" check. Each key's base is compared with `!==` against the speculative `appSeq`; any mismatch refuses the whole op `stale-setting`, held until `this.seq` resolves like other refusals. Replay is unchanged (`appBase` is ignored) |
| `packages/protocol/replica.js` | `local(stream, op, { keepVersions })`, mixed-change split, `appBase` stamping, one op in flight per key with held changes, soft `stale-setting` with a retry gate, and the `welcome.room` checks. API below |
| `test/world.js` | The room gets an epoch from `log.openEpoch()`. `rebuild({ epoch })` can force one (otherwise `fromLog` opens the next). `settle()` also waits for held settings |
| `test/envelope.test.js` | Depth test is now 62 (3 + 59 levels pass, 3 + 60 refused) |
| `test/recovery.test.js` | Append timeout test is now 4 s (`t += 3999` doesn't fail, +1 does) |
| `test/replica.test.js` | The exact `did` shape gains `refusedSettings: []` and `retryReady: []` |
| `test/holes.test.js` | The raw bad-settings ops now carry a well-formed `appBase`, so they are refused for their value, not for a missing base. They also assert nothing is logged |
| `test/v11.test.js` (new) | 27 tests (next table) |

## Tests added (test/v11.test.js), per done-when row

| Done-when row | Tests |
|---|---|
| Concurrent settings CAS: one winner, one soft refusal | "concurrent settings: one winner…": nothing logged for the loser; a resend of the accepted op gets its `ack`; the loser on the current base is accepted; all-or-nothing on two keys. Replica side: "two replicas race on layers…": the loser is told, with no reset and no resync |
| Revert vs stale save are told apart | "a deliberate revert (current base) is accepted; a stale save of the same old value is refused" |
| A retry never fires before the conflict is applied | "a refused settings op takes the held changes… retry gate…": no `retryReady` and nothing sent until the winning entry is applied. "a two-key op refused on one key retries once that key moves past its base" |
| Held refusal, then `unavailable` | "the base check runs against speculative state…held, then sent"; "a held stale-setting becomes unavailable when the append fails" (and the rebuilt room then accepts the op) |
| Replay | "replay applies logged settings as they were…" (with and without a checkpoint, `appSeq` included) |
| Epoch rises per rebuild; a lower epoch makes a writer reconnect | "every welcome names the room…" (epochs 1→4 over three rebuilds; heartbeat). "the heartbeat names the resolved seq". "a writer's welcome from a lower epoch closes and reconnects…; a viewer's is only recorded". "another board". "higher epoch + seq regression → resync from 0", plus higher epoch without a regression = a normal rebuild. "no room (pre-v1.1 server) accepted unchecked" |
| Mixed change split | "a change with elements and settings goes out as two ops, elements first" (the caller's `appBase` is ignored) |
| One in flight per key | "back-to-back changes are held, shown, and go out as one op on the acked op's seq": the counter is minted at release. "after `stale`, held changes wait for the resync and go out on the resynced appSeq" |
| Seeding with keepVersions | "versions and nonces go out unchanged and are never re-stamped, not even on a resync" (with the importer's renumber rule run in the test). "an element >1,000 below the file's version": what happens if it is sent anyway |
| Op byte cap with non-ASCII text | "400k CJK chars (1.2 MB) are too-large, 990k ASCII pass" (also through the room). The boundary: exactly 1,000,000 bytes pass; one more byte, or one `é` in place of an `x`, is `too-large`. `utf8Bytes` matches `Buffer.byteLength` |
| Depth 62 | test/envelope.test.js (updated), plus the constants test |
| Codec | "an op frame starts `{"t":"op","id":`…" (including a replica's real op and `frameOpId` on a frame too deep to decode) |
| Settings at scale | "convergence with concurrent multi-key settings…": replays the log and checks every settings entry's `appBase[k]` equals that key's `appSeq` just before it. Nothing is left held or pending, and all copies agree |

## Replica / Room API for drawh and the web client

**`local(stream, op, { keepVersions = false } = {}) → msg`**

- **Mixed change:** an op with both `elements` and `appState` becomes **two ops, elements first**.
- **Return value:**
  - the elements op's message when there is one, else the settings op's;
  - for a held settings change, a stand-in `{ t: "op", id: null, held: true, stream, op: { appState } }`. Never send it.
  - `web/sync.js:217` (reads `msg.op.elements`) keeps working.
- **`appBase`:**
  - The Replica stamps it **when the op is made**: per key, the higher of the confirmed `appSeq` and the seq of my last acknowledged settings op for that key (`floor`).
  - A caller-supplied `appBase` is ignored.
  - Held changes are stamped when they are released.
- **`keepVersions: true`** (imports):
  - elements keep their `version` and `versionNonce`, and `restampAll()` never touches them, even on a resync;
  - `appState` in the same call is still split off and stamped normally;
  - the renumber and hold-back rules are the **importer's**: use `replica.roomVersion(stream, id)` (the confirmed copy) after catch-up.

**One op in flight per (stream, key)**

- **When a key is busy:** a pending settings op for it has no `ack` yet (sent or not), or a retry gate on it is still shut.
- **Holding:** a change touching any busy key is held, and so is anything after it while a held patch exists. There is one held patch per stream; later changes merge into it.
- **Showing:** held changes show at once (`showAppState` overlays pending, then held).
- **Release:** held changes go out as one op once none of their keys is busy and the connection has caught up. They wait while a `stale` resync is pending or before `welcome.seq` is applied.
- `heldSettings() → { board, notes }` (each a patch or null).

**`receive(msg)` result**

- **Two new fields:** `did = { entries, snapshot, reset, settled, dropped, refusedSettings, retryReady }`.
- **`refusedSettings`:** `[{ id, stream, code, appState, appBase, held }]`, one per refused settings op, any code except `stale`. `held` holds the changes to its keys that were dropped with it (null if none).
  - **`stale-setting`:** soft. The op leaves the overlay; no reset, no resync. A retry gate is armed.
  - **Any other refusal:** rule 5 as before (reset and reconnect).
- **`retryReady`:** `[{ id, stream, keys }]`, sent once per refused op when its gate opens. A gate opens when the confirmed `appSeq` of **any** of its keys is **greater than** its refused base (R2-M1 wording).
  - Changes the app makes to those keys before then are held, and go out automatically once the gate opens, on the current base.
  - So the app may simply re-read and call `local()` again.

**Room identity on the client**

- **State:** `replica.epoch` (last seen, any welcome) and `replica.epochSeen` (the highest in a writer's welcome, kept across resets).
- **Checks** (rule 12, § Room identity):
  - `welcome.room.board` ≠ the hello's board → failed attempt and `resync`; not welcomed.
  - A writer's welcome (has `high`) with an epoch below `epochSeen` → the same.
  - A higher epoch with `welcome.seq < applied` → `discard` (`did.reset`, resync from 0; not counted as a failure). It also forgets `floor` and the retry gates, because they may name entries the room lost. Otherwise a base could stay above the room's `appSeq`: always refused, with a gate that never opens.
  - A viewer's welcome is only recorded.
  - A welcome with **no `room`** is accepted unchecked (the pre-v1.1 server).

**Room and codec**

- **`new Room({ …, epoch })`:** the host passes the epoch from `Store.openEpoch` (default 1).
- **`room.heartbeat()`** returns `{ seq, epoch }`.
- **`Room.fromLog`** opens the MemoryLog's next epoch.
- **`jsonCodec.encode`** orders op frames; `frameOpId(text)` reads the id from a raw frame.

## Left for the server half (not mine; p1-v11 rows)

- **server/room-host.js:**
  - `await store.openEpoch(tenant, board)` before building, and pass `epoch` to `Room.rebuild`/`new Room`;
  - publish `room.heartbeat()` every 2 s;
  - stop publishing catch-up and snapshots on `.gw`;
  - split `.entries` under 2 MB.
- **server/gateway.js:**
  - a viewer's `welcome.room = { board, epoch }` from the heartbeat or `store.epoch()` (0 = no room yet);
  - frame depth `MAX_FRAME_DEPTH` (64);
  - `frameOpId` for frame-level refusals and `too-large` with the id;
  - a token bucket per connection;
  - `MAX_WRITER_CONNS` → `limit`, then close;
  - ping after `PING_IDLE_MS`, close after `CONN_SILENCE_MS`.
- **Store adapters (SQLite, Postgres):** `openEpoch`/`epoch` in a lease or epoch record, plus a contract test.
- **Anyone calling `opProblem(msg, n)` with a char count** must pass a UTF-8 byte count now (`utf8Bytes`).
- **The `limit`-on-hello case in the Replica:** an id-less `limit` error is ignored today (no pending op matches). Rule 12 wants "tell the UI, back off": the gateway closes the socket, and `connectionFailed()` already counts that. The "too many open tabs" UI line is the client track's.
- **Client (web/):**
  - show `did.refusedSettings` ("someone changed this; re-read") and use `retryReady`;
  - check the core glue (`files` → blob PUT, `transient` → preview).
  - Nothing in web/ breaks today.
- **drawh:**
  - take this protocol;
  - use `keepVersions` and its own renumber/hold-back rule via `roomVersion`;
  - drop the 10 s window heuristic in favour of `refusedSettings`/`retryReady`;
  - read `welcome.room`.

## Choices the spec left open (manager: overrule any)

| # | Choice | Why |
|---|---|---|
| C1 | **Multi-key change with only some keys busy:** the whole change is held (one held patch per stream) | Keeps the user's change atomic, as the room's all-or-nothing does. Cost: a free key waits behind a busy one, at most one round trip |
| C2 | `appBase` is stamped at `local()` time, not at first send | Stamping at send could base an op on a value its sender never saw, which breaks "no settings op overwrites a key whose latest value its sender hadn't seen". A settings change made mid-resync is based on the empty copy, so it may be refused `stale-setting` (soft) |
| C3 | Release happens on **ack** (base = max(confirmed, floor)), not on the entry being applied | The spec's "settled op's seq" |
| C4 | A refused settings op with a code other than `stale-setting` also drops the held changes to its keys and reports them | Spec: "if that op was refused, the held changes … are dropped". Without this, a `forbidden` would replay every held change into a resync |
| C5 | A welcome with no `room` is accepted unchecked | The server half isn't swapped yet. Once it is, this branch could be tightened |
| C6 | Room default `epoch = 1` when none is passed | web/sync.js:314 builds `new Room` without one. Only the host's real epoch matters |

## How I checked

- **Tests:** `bun test test/*.test.js` gives 115 pass. `bun test` (the whole worktree, test/web too) gives 347 pass.
- **Purity:** test/purity.test.js passes. No `TextEncoder`/`Buffer` in packages/protocol; `utf8Bytes` is by hand.
- **Many seeds:** run in this session's scratchpad (`/private/tmp/claude-501/-Users-r-repos-plenary/a6eaa695-61e3-48cd-81bc-8bd04c6f8615/scratchpad/seeds/`). The files are copies of the worktree tests with the seed loop widened:

  | Run | Seeds | What it covers | Result |
  |---|---|---|---|
  | `conv.test.js` (convergence) | 1,000 | shuffled, duplicated delivery; reconnects; two rebuilds and a checkpoint per run | pass |
  | `settings.test.js` (settings invariant) | 1,000 | concurrent multi-key settings and a rebuild; base = appSeq before each entry; nothing held | pass |
  | `recovery.test.js` (rebuild equals original) | 300 × 2 | with and without a checkpoint | pass |
  | `quiet.test.js`, lone writer | 300 | one editor plus a viewer; settings, mixed changes, drops, two rebuilds. **Zero `stale-setting`** across 37,843 settings entries (with one writer, any refusal would mean a wrong base) | pass |
  | `quiet.test.js`, quiet check | 300 + 300 | lone writer, and three writers (15,653 refusals). Every 50 rounds and at the end the network runs until quiet; before `settle()`'s reconnect loop, no connected client holds settings changes | pass |

  The settings invariant (base = `appSeq` before each entry) holds by the room's own check whatever the Replica
  stamps. The lone-writer run is what checks that the Replica's bases are right.

- **Engram:** searched. One relevant lead: git's `test/*.js` pathspec is recursive, so I used `':(glob)test/*.js'` for my diff.

## Not verified

- **No model run** of the Replica's held changes and gates beyond the seeded world. The world's other writers don't retry; a refusal is handled only by the gate.
- **The `stale` path for settings** is tested with a hand-made `stale` error, not a real eviction.
- **Nothing running in Herdr's QuickJS:** `frameOpId` uses a regex (no `??=` or other ES2021 syntax added).
- **No sdd ensemble:** I'm the builder; that is the verifier's job.

## Risks

- **drawh breaks until it takes v1.1:** its settings ops without `appBase` get `bad-op`, so it resyncs. Sequence it with drawh's round (as p1-v11 said).
- **A held patch can wait on a gate** until the conflicting entry arrives (bus or Store poll; at most about 5 s by § Bus).
  - **Store loss:** after a Store loss the client clears its acked seqs and gates (welcome with a higher epoch and a lower `seq`).
  - **What can still stick:** an op stamped from a lost acked seq, sent before that welcome and refused after it, arms a gate on a base above the room's `appSeq`. That gate opens only once another write to the key passes the base. Until then, changes to that key stay held (shown but unsent) for the session.
  - Only a Store that loses acked entries (a known limit) can cause this, and no test reaches it.
- **`refusedSettings` is new UI surface.** The web client ignores it today, so a refused setting just snaps back on screen with no message.

## Fix round (verifier p11-protov: PASS, M1 and M2; manager's decisions)

**Both MEDIUMs are fixed, and L2 too.** Spec first, then code, then tests.

- **Tests:** `bun test test/*.test.js` gives **120 pass, 0 fail** (116 + 4 new; one rewritten).
- **Whole worktree:** `bun test` gives **390 pass, 0 fail**.

| Finding | Fix | Where | Tests |
|---|---|---|---|
| **M1** a settings change made mid-resync was always refused | **Option (a), "the base is what the user saw":** the Replica keeps each key's last confirmed `appSeq` across `reset()` (`seen`), and `basesOf` = max(confirmed, `seen`, `floor`). `seen` is cleared only on rule 13 and on the Store-lost path (`forgetSettings()`). **Held after `stale`:** each held key records its base when its latest change was made (`heldBase`). If the op it waited on is answered `stale`, those keys go out on that base, never on a value the resync brought in. | PROTOCOL.md § Settings: a new bullet, "What 'based on' means (the client)", and the "One in flight per key" `stale` sentence rewritten. replica.js `reset`, `basesOf`, `setting`, `release`, `error` | "M1: a settings change made during a resync…" (lifted from the verifier's probe): accepted with no conflict (room grid 25, base {grid: 1}), refused with one (grid 30 stands). The old v11:376 test is rewritten: the held `grid: 2` goes out on base 0, is refused, grid 50 stands, and `retryReady` comes at once. New: a `stale` op that never landed, with no other writer, lets the held change through on base 0 |
| **M2** after a Store loss, a refused op's gate could stick | The lost branch marks every pending settings op `lost`. A `stale-setting` for a `lost` op arms **no gate** and reports `retryReady` at once. The branch also forgets `seen`, `floor`, `heldBase` and the gates | PROTOCOL.md § Settings: a new bullet, "After a Store loss". replica.js `welcome`, `error` | "M2: after a Store loss…" (the verifier's probe as a test): `retryReady` at once, no gate, and the next `grid` change goes out at once on base 30 |
| **L2** two incarnations could share epoch 1 | `new Room` with no `epoch` calls `log.openEpoch()` when the log has one, else uses 1 | room.js constructor | "L2: a room built without an epoch opens the log's next one…" |
| L1 (a `welcome` with no `room` is accepted unchecked) | **Not changed.** The server half doesn't send `room` yet. Tighten it in the swap job: treat a writer `welcome` without a valid `room` as a failed attempt | | |
| L3 (one held patch per stream) | **Not changed** (my choice C1). M2 was the case where it never ended; that is fixed | | |
| L4 (`refusedSettings`/`retryReady` have no UI consumer) | The client track's | | |

**Re-checked in scratch** (the same files as before, against the fixed code):

| Run | Result |
|---|---|
| Convergence, 1,000 seeds | pass |
| Settings invariant, 1,000 seeds | pass |
| Recovery rebuild-equals-original, 300 × 2 | pass |
| Lone writer | **0 `stale-setting`** across 37,843 settings entries, 300 seeds |
| Nothing held at quiet | 600 seeds (15,698 refusals among three writers) |

**One thing for the manager to decide (not changed):**
- **The rule:** § Settings' ordinary held rule (base = max(confirmed, settled op's seq) at release) still lets a held change go out on another writer's entry that the Replica applied after the change was made. It never shows on screen, because the held value is overlaid on it.
- **Why it's a question:** that is consistent if "seen" means "applied by the replica", but not if it means "on screen".
- **Possible fix:** the `heldBase` record now exists, so it could become the base for every held change. That would mean more refusals, one round trip each.

## Fix round 2 (verifier p11-protov Round 2: FAIL on R2-M1, R2-M2; manager's decisions)

**Both are fixed, and the two accessors for the client track are added.** Spec first, then code.

- **Tests:** `bun test test/*.test.js` gives **126 pass, 0 fail** (120 + 6 new; one rewritten).
- **Whole worktree:** `bun test` gives **396 pass, 0 fail**.

| Item | Fix | Where | Tests |
|---|---|---|---|
| **R2-M2:** a held change released after a peer's entry it hid was accepted | **A held change's base is fixed when the value is made:** max(the key's base at `local()` time, kept in `heldBase`; the seq of this client's own preceding op on the key once it settles, kept in `floor`). Never the confirmed `appSeq` at release time. `heldAfterStale` is gone: the same rule covers the `stale` case | PROTOCOL.md § Settings, "One in flight per key", rewritten; it now agrees with "What 'based on' means" and the Guaranteed line. replica.js `release()` | "R2-M2: a held change keeps the base it was made on…" (the verifier's heldrace): released at base 1, refused `stale-setting`, b's 3 stands, a is told (`retryReady` at once) |
| **Found while fixing R2-M2:** an op settled by its own **entry** (rule 4, ack lost or late) didn't raise `floor` | `drain()` now raises `floor` too. Without this, the heldrace sequence released at base 0 instead of 1. The outcome was the same here (refused), but it would wrongly refuse a lone writer whose ack comes after its entry | replica.js `drain()` | covered by the heldrace test; the lone-writer scratch check still shows 0 refusals |
| **R2-M1:** after `forgetSettings()` a held patch could go out with `appBase` keys missing (`bad-op`) | `forgetSettings(did, code)` (Store-lost path: `"store-lost"`; rule 13: `"user-changed"`) **drops held patches** and reports each one in `did.refusedSettings` (`id: null`, `appBase: null`) and `did.retryReady` (`id: null`). `push()` **asserts** that every settings op has a full `appBase` (`appBaseProblem`), throwing on a bug instead of sending one | PROTOCOL.md § Settings, new "Forgetting" bullet. replica.js `forgetSettings`, `push`, `welcome` | "R2-M1: a Store loss drops held changes…" (the verifier's badop sequence): nothing is sent with a key missing; the app's retry is based on the resynced copy. "rule 13 … drops held settings changes too". "the op builder refuses to build a settings op without a full base" |
| `gate` test (v11 "a refused settings op takes the held changes…") | Rewritten for the new rule. A change made during a gate was made before the conflict was applied, so at release it is refused once and the app is told at once. The app's retry (re-read) is then accepted at base 1 | test/v11.test.js | (rewritten) |
| **Accessor** `previewEntries(stream)` | `[{ element, user, client, at }]` for others' live previews on that stream; drops expired ones first, as `previewsOf` does (unchanged) | replica.js | "previewEntries(stream)…": per stream, with sender; expires at 5 s |
| **Accessor** `pendingOf(stream)` | `[{ id, op, sent }]`: this client's **unacknowledged** ops on that stream, in send (counter) order. `sent` = written to a socket at least once (`sentAt` set). `op` is a copy. Held settings changes aren't ops yet; see `heldSettings()` | replica.js | "pendingOf(stream)…": order, per stream, `sent` flips after `outgoing()`, copy semantics, empty once acked |

**API changes for drawh and the client** (on top of the round-1 list):

- **Release:** held settings now go out on the base they were made on, so a change made while another writer's entry was still on the way is refused, and the app is told. Retry after re-reading.
- **New `refusedSettings` codes:** `"store-lost"` and `"user-changed"`, each with `id: null`, report dropped held changes.

**Re-checked in scratch** (the same files):

| Run | Result |
|---|---|
| Convergence, 1,000 seeds | pass |
| Settings invariant, 1,000 seeds | pass; the `push()` assertion never fired |
| Recovery, 300 × 2 | pass |
| Lone writer, 300 seeds | **0 `stale-setting`** across 37,843 settings entries |
| Nothing held at quiet, 600 seeds | pass (16,901 refusals among three writers, up from 15,698: held changes no longer ride over unseen entries) |

**Not changed: R2-L1** (the Store-loss check fires when `entries` arrive before their connection's `welcome`).

- **Why it fires:** only an out-of-order transport causes it. The test world shuffles messages; a real socket doesn't, unless the gateway forwards live entries before relaying the room's `welcome`.
- **What a false positive costs:** now only a resync, plus dropped held changes that are reported to the app. It no longer leads to `bad-op`.
- **Two fixes:**
  - the gateway holds a writer's live entries until its `welcome` is forwarded (phase 3, spec);
  - or the Replica buffers `entries`/`snapshot` until `welcome`, which needs care with the world's duplicate and shuffled delivery.
- **Manager's call.**

## Fix round 3 (verifier p11-protov Round 3: FAIL on R3-M1; plus R2-L1; manager's decisions)

**Both are fixed.** Spec first, then code.

- **Tests:** `bun test test/*.test.js` gives **128 pass, 0 fail** (126 + 2 new; one existing test given its missing `welcome`).
- **Whole worktree:** `bun test` gives **398 pass, 0 fail**.

| Item | Fix | Where | Tests |
|---|---|---|---|
| **R3-M1:** a second change to a held key took a base the user never saw | **A held key's base is fixed by its first held change.** Later changes to it while held keep that base, raised only by the client's own settled op (`floor`). `setting()` sets `heldBase[s][k]` only when the key isn't already held | PROTOCOL.md § Settings, "One in flight per key": "fixed when the key is first held", with why. replica.js `setting()` | "R3-M1: a held key's base is fixed by its first held change…" (the verifier's heldrace4): the release goes out at `{snap: 0, grid: 0}`, is refused `stale-setting`, and b's grid 3 stands |
| **R2-L1:** false "Store lost" when `entries` beat their connection's `welcome` | The Replica keeps `entries` and `snapshot` that arrive before this connection's `welcome` (`this.early`) and applies them right after it, only if the `welcome` was accepted (not a failed attempt, not a resync). The Store-loss check therefore compares `welcome.seq` with what was applied **before** this connection | PROTOCOL.md § Recovery, Room identity, new bullet "Checked against what came before this connection". replica.js `receive()` | "R2-L1: entries that reach the client before its welcome…": early entries are applied after the welcome; a lagging welcome from a rebuilt room is a normal rebuild (held changes kept); a real loss is still caught |
| replica.test.js:91 ("receive() returns what it applied…") | It handed a late joiner its snapshot without the `welcome`. It now delivers the `welcome` first. This is a test artifact: a snapshot before `welcome` is now kept until the `welcome` | test/replica.test.js | |

**Re-checked in scratch** (the same files):

| Run | Result |
|---|---|
| Convergence, 1,000 seeds | pass |
| Settings invariant, 1,000 seeds | pass |
| Recovery, 300 × 2 | pass |
| Lone writer | **0 `stale-setting`** across 37,830 settings entries |
| Nothing held at quiet, 600 seeds | pass |
| False Store-loss counter (new in the quiet test): a writer `welcome` that reset with a higher epoch and a lower seq | **0** in the shuffled world, which has no real loss. The verifier counted about 280 per 300 runs before |

**What I did not verify:** that my counter would have fired on the old code. I didn't revert to check; the R2-L1 unit test reproduces the old false positive's sequence.
