# p11-protov: verify p11-proto (protocol v1.1 code)

**Verdict: PASS, with two MEDIUM findings (M1, M2).** There is no HIGH finding.
- **What holds:** every goal item is in the code and tested. Under heavy settings traffic with CAS
  (compare-and-set) conflicts, room restarts and `stale` resyncs:
  - no op was logged twice and no acked op was lost;
  - every logged settings op's base was current;
  - held changes always released in normal operation;
  - no refused op was ever logged, and no retry gate opened early;
  - replay was deterministic.
- **M1:** a settings change made during a resync is always refused `stale-setting`, even with no conflict.
- **M2:** after a Store loss, a refused settings op's gate can stick, and with it every later settings change on
  that stream.
- **Lows:** four LOW findings (L1–L4).

The builder's report (p11-proto.md) was not read. I worked from the manager's summary of its "Not verified" and
"Risks" sections.

**Job:** the uncommitted diff in /Users/r/repos/plenary-p2 over cb343b9 (PROTOCOL.md v1.1), in
`packages/protocol/{room,replica,envelope,ports,codec}.js`, `test/v11.test.js` (new) and edits to
`test/{world,envelope,holes,recovery,replica}.test.js`. web/ and test/web/ belong to the client and were ignored.

## Gates

| Check | Result |
|---|---|
| `bun test` in the worktree | **383 pass, 0 fail** (test/web included) |
| Top-level `test/*.test.js` | 116/116; purity passes (it reads every `.js` in packages/protocol) |
| codex (**single harness**), effort high, read-only scratch clone with the diff applied | one lead, which became L1 |

## Goal items, checked

| Item | Code | Tested / my check |
|---|---|---|
| CAS against **speculative** `appSeq`, **after** the op-id table, all-or-nothing, soft `stale-setting` | room.js `op()`: after the dedupe/`stale` rows, every key's base is compared with `this.appSeq[stream]` (speculative); any miss refuses the whole op, held until `this.seq` resolves | v11:203–258 (read). Mine, with a slow store (MemoryLog is synchronous, so the fuzz can't see this): b's conflicting op gets **nothing** until a's append lands, then `stale-setting`; one entry logged. Fuzz: CAS invariant replayed from the log alone over **23,273 logged settings ops**: 0 violations |
| No elements in a settings op; `appBase` shape | envelope.js `opProblem` + `appBaseProblem` (same keys, safe integers ≥ 0; no base without `appState`) | v11:72; holes.test.js now sends a well-formed base, so its appState refusals happen for the right reason (stricter: also asserts nothing logged) |
| A resend of an accepted settings op gets its ack | the op-id table comes first | v11:203 (read). Mine, with a slow store: a resend of an unresolved accepted op waits and gets the same ack (seq 1, twice). Fuzz: **no op answered `stale-setting` ever appears in the log** (900 runs) |
| Replay ignores `appBase` | `applyEntry` → `mergeAppState` (own `APP_KEYS` only) | rebuild equals the original in every fuzz run |
| `welcome.room {board, epoch}`; epoch passed in; `MemoryLog.openEpoch/epoch`; heartbeat `{seq, epoch}` | room.js, ports.js; `fromLog` opens the next epoch when none is given | v11:105–194. **L2**: the default epoch can repeat |
| Replica: `appBase` stamped, mixed changes split (elements first), one in flight per (stream, key), held changes, gate opens only once a confirmed `appSeq` passes the refused base | replica.js `local/setting/basesOf/busy/openGates/release` | v11:276–396; fuzz below. **M1**: the stamp during a resync |
| `keepVersions` seeding skipped by restamp | `push(…, keep)`; `restampAll` treats `keep` like a sent op | v11:397–436 |
| Epoch checks only on writer welcomes; lower → reconnect; higher + `seq` below applied → resync and clear floors/gates | replica.js `welcome()` | v11:139–194. **L1**: a `welcome` with no `room` is accepted unchecked |
| Codec: op frames start `{"t":"op","id":`; `frameOpId` | codec.js | v11:92 + mine: key order shuffled, round-trips, an escaped `"` in the id → null |
| `MAX_OP_BYTES` in UTF-8 | `utf8Bytes` | mine: 40,000 random strings (ASCII, é, 漢, 😀, lone surrogates) all equal `Buffer.byteLength`; the 3-byte boundary is exact |
| Depth 62 | `MAX_OP_DEPTH = 62`; `MAX_FRAME_DEPTH = 64` exported | envelope.test.js: 3 + 59 = 62 passes, 63 is refused |
| Append timeout 4 s | `APPEND_TIMEOUT_MS = 4000` | recovery.test.js: 3,999 ms ok, 4,000 ms fails |

## Old tests edited

Every change traces to v1.1:
- **envelope.test.js:** depth 64 → 62, with the same boundary shape.
- **holes.test.js:** a well-formed `appBase` is now required for the refusal to happen for the right reason, plus
  a stricter "nothing logged" check.
- **recovery.test.js:** 5 s → 4 s.
- **replica.test.js:** `receive()` returns two new keys.
- **world.js:** passes `epoch: log.openEpoch()`, and `rebuild({epoch})`.

**One harness change I checked by running it:** world.js `settle()` now also reconnects a client that still has
held settings. That nudge could hide a held change that never releases on a live connection. I ran my settings
fuzz with the nudge **disabled** (scratch `world3.js`, `NOHELD=1`): 300/300 pass, and settle never had to
reconnect anyone (max recursion depth 0). Held changes release on their own (on ack, drain or gate opening).

## Stress runs (scratch, against the worktree)

| Run | Result |
|---|---|
| Settings fuzz (set.test.js; set3.test.js adds the two checks below), 300 seeds: 5 clients, 35% of edits are settings on hot keys (`grid`, `snap`, both; board or notes; 20% mixed with elements), the app retries 70% of refused settings once their gate opens, random rebuilds (with or without a checkpoint) and a checkpoint | **300/300**. 7,783 settings logged, 3,529 `stale-setting` refusals, **every one** reported `retryReady`. At the end: nothing pending, **nothing held**, every replica equals the room, seqs run 1..n, no `(by, id)` twice, **CAS invariant 0 violations**, rebuild deep-equals the room (replay determinism with `stale-setting`) |
| The same with the world.js held-reconnect nudge disabled | 300/300, the same numbers |
| The same with small op-id rules (W 4, H 40, every 8) to force the `stale` path | **300/300**: **4,885 `stale` answers** mixed with settings and held changes; converges, nothing held. This covers the builder's "stale tested only with a hand-made error" |
| set3.test.js, three configurations × 300 (plain, small rules, nudge off) | all pass. **Refused-but-logged: 0.** **Retry-gate timing:** at each `retryReady` I checked that some key's confirmed `appSeq` passed the refused base. 23–30 per configuration looked early; every one came in a `receive()` that also reset the copy. In the `stale-setting` branch, `openGates()` runs before `afterAnswers()` resets the copy, so the gate opened correctly on the pre-reset state, and my check read the emptied copy after. No gate opened early |
| Earlier gates (phase 2): convergence with restarts ×6,000, recovery with records ×800 | all pass on this diff (the same runs as before; settings ops in them now carry `appBase` through `local()`) |

## Findings

### HIGH: none

### MEDIUM

**M1. A settings change made during a resync is always refused, even with no conflict.**
- **Where:** `replica.js` `basesOf()`: `max(appSeq[stream][k], floor[stream][k])`. `reset()` empties `appSeq`.
- **Failure:** b sets `grid` (the room's `appSeq.grid = 1`; a has applied it). a gets a hard refusal on some other
  op, so it resets and resyncs. During the resync the user changes `grid` to 25. The op is stamped
  `appBase {grid: 0}`, the room refuses it `stale-setting`, and the room keeps grid = 10. No one else wrote. The
  user had seen seq 1, which is what § Settings says the base must be ("the `appSeq` of that key the sender's
  value was based on"). Reproduced through a real refusal (probes11.test.js, "M1 through a real refusal": `local("board", { appState: { bogus: 1 } })` is refused `bad-op`, a resets, a `grid` change is stamped `{grid: 0}` and refused; room grid stays 10). The builder can lift it as a test.
- **Safe but lossy:** nothing overwrites an unseen value, and the app is told (`refusedSettings`, then
  `retryReady` at once). But every settings change made in a resync window is dropped unless the app retries. It
  is the settings twin of p6-sync2v's M3.
- **Fix: a PROTOCOL.md decision first.** § Settings is not consistent here. For held changes after a `stale`, it
  says they go out on "the key's `appSeq` in the resynced confirmed copy", and v11:376 tests that: the held
  `grid: 2` overwrites another writer's `grid: 50` that a never saw. That contradicts the spec's own "Guaranteed:
  no settings op overwrites a key whose latest value its sender hadn't seen". Two options:
  - **(a) The base is what the user saw.** Keep each key's last confirmed `appSeq` across `reset()` (cleared only
    on rule 13 and on the "Store lost entries" path, as the floors are), and use it in `basesOf`. A change made
    mid-resync with no conflict is accepted; one with a conflict is refused. The held-after-`stale` rule would
    change to match. Safe, and the guarantee holds.
  - **(b) The base is the resynced copy**, for mid-resync changes too: never refused for being made mid-resync,
    but it can overwrite an unseen value (it drops the guarantee for resyncs).
  I'd pick (a). Either way, add a test of a change during a resync with no conflicting writer.

**M2. After a Store loss, a gate can stick, and every later settings change on that stream waits.**
- **Where:** `replica.js` `welcome()`, the "Store lost entries" branch: it clears `floor` and `gates`, but a
  pending settings op keeps its pre-loss `appBase`, and a sent op keeps its bytes on resend.
- **Failure (probes11.test.js, hand-fed Replica):**
  1. `appSeq.grid` = 50, and a `grid` op is sent at base 50.
  2. A higher-epoch `welcome` arrives with seq 30 < applied 50: a reset and resync. The rebuilt room's
     `appSeq.grid` is 30.
  3. The resend goes out with base 50, the room answers `stale-setting`, and a gate `{grid: 50}` is created.
  4. The user's next `grid` change is held. Ten entries on other keys: still held. **Another writer sets `grid`
     at seq 41: still held**, because the gate needs a `grid` entry above 50.
  5. With one held patch per stream (L3), **every** later settings change on that stream waits behind it.
- **Scope:** only after a Store loses acked entries (a known limit). Elements and other streams are unaffected,
  and a reload clears it (a new Replica).
- **Fix:** gates and bases from before a loss can't be trusted. In the lost branch, mark pending settings ops; a
  `stale-setting` for a marked op opens no gate (report `retryReady` at once). Or open a gate when the confirmed
  `appSeq` of any of its keys is **different from** its base, not only greater. The room refuses only when they
  differ, so a smaller confirmed value is also a conflict the client has now applied. Add a test.

### LOW

**L1. A `welcome` with no or malformed `room` skips every identity check.** (codex lead, confirmed by reading.)
- **Where:** `replica.js` `welcome()`: `if (room && typeof room === "object")`, and the epoch check also needs
  `Number.isSafeInteger(room.epoch)`.
- **Effect:** a writer `welcome` with no `room`, or a non-integer epoch, is accepted without the board and epoch
  checks.
- **Context:** this is the builder's open choice ("a pre-v1.1 server"). But v1.1 says no old client or server has
  to keep working, and every server here is v1.1, so only a non-conforming server is affected. Codex rated it
  MEDIUM; I rate it LOW.
- **Fix:** treat a writer `welcome` without a valid `room` like one naming another board (a failed attempt), or
  drop the leniency once phase 3 ships.

**L2. Two incarnations can share epoch 1.**
- **Where:** `room.js` constructor `epoch = 1`.
- **Effect:** a host that builds `new Room({log})` without calling `openEpoch`, then later rebuilds with
  `Room.fromLog` (which opens the log's first epoch, 1), runs two rooms with epoch 1. Scratch: `direct()` (which
  doesn't pass an epoch) gives first 1, rebuilt 1. This breaks "two incarnations never share an epoch". world.js
  avoids it by passing `log.openEpoch()`.
- **Fix:** default to `log.openEpoch?.() ?? 1`, or make `epoch` required (a phase-3 host must call `openEpoch`
  anyway).

**L3. One busy key holds the stream's whole held patch.**
- **Where:** `setting()` / `release()`: one held patch per stream, held whole while any key in it is busy or
  gated (the builder's choice).
- **Effect:** after a `stale-setting` on `layers`, a `grid` change waits until `layers`' conflict is applied
  (normally one entry away; the builder said up to ~5 s). M2 is the case where that wait never ends.
- **Status:** within spec ("later changes to the key stay"). It is stricter than needed, not wrong. A per-key
  held map would remove it.

**L4. `refusedSettings` and `retryReady` are new UI surface with no consumer yet.** web/sync.js (the client's)
must act on them, or refused settings vanish silently from the user's view, contrary to the spec's "the app is
told". This is the builder's own risk; it belongs to the client track.

## The builder's open choices, judged

| Choice | Verdict |
|---|---|
| A whole multi-key change is held if any key is busy | allowed; stricter than the spec (L3) |
| `appBase` stamped at `local()` time | right in principle (the base is what the user saw), but wrong inside a resync (M1) |
| Release on ack | consistent with the spec: the next base = max(confirmed `appSeq`, the acked seq) via `floor` |
| Any refusal drops held changes to its keys | matches § Settings ("dropped with it") |
| A `welcome` without `room` accepted unchecked | L1 |
| Room default epoch 1 | L2 |

## Not verified by me

- **Tests run but not read in full:** v11.test.js 1–202 and 397–end (constants, UTF-8, the byte cap, epochs, codec,
  seeding). I read 203–396, which back the settings rows, and checked the rest with my own probes (misc11.test.js).
- **`MAX_OP_CHARS` is gone** (renamed to `MAX_OP_BYTES`). Nothing in the worktree imports it. The shared tree's
  older `packages/protocol/envelope.js` still defines it, and no `server/` file there imports it. Note for the
  merge.
- QuickJS, a real server, sockets, SQLite and Postgres (`openEpoch`/`epoch` exist only on MemoryLog here).
- A Store loss under live clients end to end (M2 was found by hand-feeding one Replica).
- A gateway's use of `frameOpId` / `MAX_FRAME_DEPTH` (phase 3).

## Scratch

All in
/private/tmp/claude-501/-Users-r-repos-plenary/701a095f-84aa-4ad0-8bba-0a81466cfb0e/scratchpad/stress.AL3A:
set.test.js, set2.test.js, set3.test.js, set4.test.js, world3.js, midresync.test.js, probes11.test.js, misc11.test.js. The codex clone is in
/private/tmp/claude-501/-Users-r-repos-plenary/701a095f-84aa-4ad0-8bba-0a81466cfb0e/scratchpad/codex11.ffx4.
I started no servers or browsers.

## Round 2 (uncommitted in the worktree: PROTOCOL.md, replica.js, room.js, tests)

**Verdict: FAIL.**
- **Fixed:** M1, M2 and L2. My repros now pass, and the fuzz runs converge.
- **Still failing:** two MEDIUM findings.
  - **R2-M1 (a new bug):** the round-2 code can send an honest client's settings op with `appBase` keys missing,
    which is refused `bad-op`.
  - **R2-M2 (a contradiction left in the spec):** the ordinary held-release rule still lets a settings op
    overwrite a value its user never saw. This was already in round 1 and I missed it then.

Round 2's delta was isolated by diffing my round-1 snapshot (the codex scratch clone) against the worktree.

| Check | Result |
|---|---|
| M1, through a real refusal (probes11 "M1 through a real refusal"; midresync) | **fixed:** a `grid` change made mid-resync is stamped `{grid: 1}` (what the user saw), accepted; the room's grid = 25 |
| M2, hand-fed Store loss (probes11) | **fixed:** the pre-loss op's `stale-setting` opens no gate, `retryReady` at once; the next `grid` change goes straight out (not held) |
| L2 | **fixed:** `direct()` then `fromLog` gives epochs 1, then 2 (the constructor opens the log's next epoch when none is given) |
| Order inside the Store-lost branch | right: `discard()` → `reset()` first copies `appSeq` into `seen`, then `forgetSettings()` clears it (rule 13 the same) |
| Fuzz (set3: plain, small rules, nudge off; ×300 each) | 900/900 pass: CAS invariant 0 violations, refused-but-logged 0, nothing held at the end |
| Convergence ×4,000 (fixed + random/deterministic restarts), recovery with records ×800 | all pass |
| `bun test` in the worktree | **390 pass, 0 fail** |
| Fuzz anomalies (set5–set7) | 3 honest settings ops refused **`bad-op`**, and 8 `retryReady` with no gate passed: **R2-M1**, **R2-L1** |
| Spec, edited § Settings | the held-after-`stale` rule and the new "What 'based on' means" now agree. **The ordinary held-release rule doesn't: R2-M2** |

### R2-M1 (MEDIUM). A released held change can carry an `appBase` with keys missing, so the room answers `bad-op`

- **Where:** `replica.js` `release()`: `for (const k of this.heldAfterStale[s]) … base[k] = this.heldBase[s][k]`.
  `forgetSettings()` (the Store-lost path, and rule 13) clears `heldBase` but keeps the held patch. A later
  `stale` on that key's in-flight op adds it to `heldAfterStale`, so `base[k] = undefined`. JSON drops it, and the
  op goes out without that key.
- **Repro (badop.test.js, a genuine Store-loss sequence):**
  1. `grid` op sent at base 10, a second `grid` change held behind it.
  2. A writer `welcome` with epoch 2 and seq 6 < applied 10 (a Store loss).
  3. The resend is answered `stale`, then a resync.
  4. Released: `{"appState":{"grid":78},"appBase":{}}`. `appBaseProblem` → "appBase.grid must be an integer ≥ 0".
- **Effect:** a hard refusal: reset, resync, and the user's held change is dropped. Seen 3 times in 900 fuzz runs,
  triggered there by R2-L1.
- **Fix:** in `release()`, override only when `heldBase[s]` has the key (else keep `basesOf`). After
  `forgetSettings` there is no "what the user saw", and § Settings "After a Store loss" already says to retry on
  the resynced copy. Add the badop repro as a test.

### R2-M2 (MEDIUM). Ordinary held release still overwrites a value the user never saw (a contradiction left in the spec)

- **The rule:** § Settings, "One in flight per key": held changes go out "with base = the higher of the confirmed
  `appSeq` and the settled op's seq", and `release()` uses `basesOf()` at **release** time.
- **The contradiction:** the new "What 'based on' means" says a base is what the client had confirmed **when the
  value was made**, and the Guaranteed line says "no settings op overwrites a key whose latest value its sender
  hadn't seen".
- **Repro (heldrace.test.js):**
  1. a's `grid: 1` is logged at seq 1, and a's `grid: 2` is held behind it (a shows 2).
  2. b, having seen seq 1, sets `grid: 3` at seq 2.
  3. a receives entries 1 and 2 in one message (a group commit or catch-up), then the ack. a's overlay still
     shows 2, so b's 3 is never shown.
  4. The release goes out at `appBase {grid: 2}` and is **accepted**: the room's grid becomes 2, silently
     overwriting b's value, which a's user never saw.
  
  If the ack had come before entry 2, the same change would have been refused `stale-setting`, so the outcome
  depends on message timing.
- **Fix (spec, then code):** a held change's base = the higher of **its own base when it was made**
  (`heldBase`, already recorded for every held change) and the settled op's seq (`floor`). Never the confirmed
  `appSeq` at release time. In code, `release()` uses `max(heldBase[k], floor[k])` for every held key, not only
  after a `stale`. Edit § Settings, "One in flight per key", to say so. Add heldrace as a test (expected:
  `stale-setting`).

### R2-L1 (LOW). The Store-loss check also fires when `entries` arrive before their connection's `welcome`

- **Where:** `replica.js` `welcome()`: `lost = room.epoch > this.epochSeen && msg.seq < this.applied`.
- **What I saw:** in the test world (room → client messages shuffled), it fired **274 times in 300 runs** with no
  loss at all. In one case the first-ever `welcome` (epoch 1, seq 1) arrived after the entry at seq 2.
- **Effect:** each false positive discards the copy, resyncs, and forgets the settings knowledge (`seen`, floors,
  `heldBase`), which is what made R2-M1 reachable in the fuzz. A real socket is ordered, so this needs a gateway
  that forwards bus entries before relaying the room's `welcome`. They travel on different subjects (`.entries`
  and `.gw.<gateway>`), so the order is not automatic.
- **Fix:** either the Replica ignores `entries` and `snapshot` until this connection's `welcome` (they are
  re-sent as catch-up anyway), or the spec requires the gateway to hold a writer's live entries until its
  `welcome` is forwarded (phase 3). The first is a one-line guard and makes the check sound.

Scratch for round 2: heldrace.test.js, badop.test.js, set5–set7.test.js, in the same scratch folder.

## Round 3 (uncommitted in the worktree; snapshot of this round: scratch snap-r3.3btM)

**Verdict: FAIL, on one narrow MEDIUM (R3-M1).**
- **Fixed:** R2-M1 and R2-M2, and § Settings now reads as one rule.
- **R3-M1:** the "base fixed when the value is made" rule still lets a *second* change to a held key take a base
  the user never saw. The fix is one line plus one sentence.
- **R2-L1** (the false Store-loss check) is still open, and now has a bigger effect.

| Check | Result |
|---|---|
| R2-M1 (badop.test.js: a Store loss, then `stale` with a change held) | **fixed:** the held change is dropped and reported (`refusedSettings` code `store-lost`, `retryReady` with `id: null`). Nothing malformed is sent. `push()` now throws on a missing base |
| R2-M2 (heldrace.test.js) | **fixed:** the held change goes out on its make-time base `{grid: 1}`; the room answers `stale-setting` and keeps b's 3 |
| M1 / M2 / L2 (probes11, misc11) | still fixed |
| Fuzz with settings (set8 = set7 with my harness taught that `forgetSettings` reports `id: null`), ×300 in each of 3 configurations | **900/900.** CAS invariant 0 violations, no `bad-op`, refused-but-logged 0, nothing held, no gates left |
| Convergence ×4,000, recovery with records ×800 | all pass |
| `bun test` in the worktree | **396 pass, 0 fail** |
| v11:320 (a change made behind a retry gate) | changed on purpose and consistently: it now goes out on its make-time base, is refused, and the app retries on the value it re-read. This matches the new rule |
| § Settings read in full | the held-after-`stale`, "Forgetting" and "After a Store loss" bullets agree with "based on" and the guarantee. **One gap left: R3-M1** |

### R3-M1 (MEDIUM, narrow). A second change to a held key takes a base the user never saw

- **The rule:** § Settings, "One in flight per key": the base is "the key's base when its **latest** held change
  was made (what the client had **confirmed** then)". Code: `setting()` does
  `Object.assign(heldBase, basesOf(...))` on every held change.
- **The gap:** while a key is held, the screen shows the held value, not the confirmed one. A peer's entry for that
  key applied meanwhile is confirmed but never seen. A second change to the key then re-stamps its base from the
  confirmed copy, past that unseen entry.
- **Repro (heldrace4.test.js, real room; this needs a key held behind another key's gate):**
  1. b sets `grid: 3` (seq 1) and c sets `layers` (seq 2).
  2. a's `{snap, layers}` op on base 0 is refused (a gate on snap and layers).
  3. a makes `{snap: false, grid: 5}`, which is held whole because snap is gated.
  4. a applies b's seq 1. Its screen still shows **grid 5**.
  5. a changes grid to 6. c's seq 2 opens the gate.
  6. The release goes out at `{snap: 0, grid: 1}` and is **acked**: the room's grid is 6, and b's 3 is
     overwritten. a's user never saw it.
- **Why narrow:** an own in-flight op can't produce this. The peer's entry would come after the client's own entry,
  in the same drain that releases the change. It needs a key held only because another key in the same patch is
  busy or gated (L3, one held patch per stream).
- **Fix (spec, then code, one line):** a held key's base is fixed by its **first** held change. Later changes to
  it while held keep that base, raised only by the client's own settled op (`floor`). In `setting()`, only set
  `heldBase[s][k]` when the key is not already held. Reword the bullet: "the key's base when it was first held".
  Add heldrace4 as a test (expected: `stale-setting`).

### Still open from round 2

**R2-L1. False "Store lost" when `entries` reach the client before its `welcome`.**
- **Status:** unchanged. It fired about 280 times in 300 fuzz runs with no loss.
- **Bigger effect now:** each false positive also runs `forgetSettings`, which **drops the user's held settings
  changes** (`store-lost`; about 57 per 300 runs in the fuzz). A real socket is ordered, so this needs a gateway
  that forwards bus entries before the room's `welcome` (phase 3).
- **Fix:** ignore `entries` and `snapshot` until this connection's `welcome`, or have the spec bind the gateway to
  that order. It is now worth doing before phase 3.

Scratch for round 3: heldrace2–4.test.js, set8.test.js, in the same scratch folder.

## Round 4 (uncommitted in the worktree; diffed against my round-3 snapshot)

**Verdict: PASS.** R3-M1 and R2-L1 are fixed. Only `replica.js` and PROTOCOL.md changed this round; room, envelope,
ports and codec are identical to round 3.

| Check | Result |
|---|---|
| R3-M1 (heldrace4.test.js, real room) | **fixed:** the release goes out at `{snap: 0, grid: 0}` (grid keeps its first-held base), and the room answers **`stale-setting`**; b's grid 3 stands. Code: `setting()` sets `heldBase[k]` only if the key isn't already held |
| R2-L1 | **fixed:** `entries`/`snapshot` that arrive before this connection's `welcome` are buffered (`early`) and applied right after its checks, or dropped if the `welcome` ends the connection. In the fuzz the false Store-loss check fired **0** times (it was about 280 per 300 runs), and no held change was dropped as `store-lost` |
| Earlier repros (heldrace, badop, probes11 M1/M2, misc11 epochs) | all still fixed |
| Settings fuzz (set8), ×300 in each of 3 configurations | **900/900.** CAS invariant 0 violations, no `bad-op`, refused-but-logged 0, every refusal reported `retryReady`, nothing held, no gates left. The early-gate count is now only the known reset artifact (the gate opened on the pre-reset copy) |
| Convergence ×6,000 (three configurations), recovery with records ×800, resend ×5 | all pass |
| `bun test` in the worktree | **398 pass, 0 fail** |
| § Settings, re-read in full (plus the new "Checked against what came before this connection" bullet in § Recovery, Room identity) | no contradiction left. "Based on", "One in flight per key" (first-held base, own settled op, never the release-time `appSeq`), held-after-`stale`, "Forgetting", "After a Store loss" and the Guaranteed line agree with each other and with the code |

**Nit (not a finding):** the "What 'based on' means" bullet says "its own **acknowledged** settings op". The code
also raises `floor` when the op settles by its entry with no ack (rule 4), and the held-change bullet says
"settles". Saying "settled" in both would match.

Open LOWs from round 1 still stand as written: L1 (a `welcome` with no `room` is unchecked), L3 (one held patch per
stream), L4 (`refusedSettings`/`retryReady` need a consumer in web/).
