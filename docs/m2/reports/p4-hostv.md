# Report: p4-hostv (verify p4-host: the room host holds a Store lease; every write fenced)

Verifier t1hd (engine), manager t18m. Final.

**Verdict: FAIL, on one HIGH.** The lease, the fence and the takeover are sound: no acked op was lost in any attack,
including a real kill -9 and a SIGSTOP of a child process holding a Postgres lease. But a holder woken from a stall
past its ttl serves the inbox messages queued meanwhile. It welcomes the new holder's live connections from its dead
epoch, then closes them with 1013 (HIGH-1). Three MEDIUMs follow:
- **MEDIUM-1:** takeover takes up to ~2 ttl.
- **MEDIUM-2:** a hello sent while the holder is still building is never answered (the writer waits the gateway's 10 s timeout).
- **MEDIUM-3:** a hung renew is never retried.

Plus 9 LOWs. Every gate is green (except the known core-source drift). 14 of 15 mutants are caught; the survivor
needs one more test (L1).

## Files verified (sha256, first 12, as read 2026-11-12)

```
9b01410f1df1 server/room-host.js            9f0f0a7d3823 test/server/store-contract.js
563a72538590 server/server.js               578a080c85f2 test/server/store.test.js
9a8bf0181f50 server/store/sqlite.js         03cc2fd8a841 test/server/pg-store.test.js
cb2ede3120bd server/store/postgres.js       58430d063955 test/server/room-host-lease.test.js
3f3d8d4a086c server/bus/port.js             0784dbf70231 test/server/gateway.test.js
d7c3006468da server/bus/memory.js           724d04c8924e test/server/outbound.test.js
1905ebd62103 server/bus/nats.js             bd6f15426dab test/server/revocation.test.js
5d8cd482cde2 packages/protocol/ports.js     43fd7dad74ae test/server/main.test.js
377779da0d6c packages/protocol/room.js      69393599dc56 test/server/rig.js
```

How I worked: a scratch copy of the tree (rsync, no .git, no .env; its job files hash-checked against the table above); attack tests in it
(`test/server/hostv-attack.test.js`, `hostv-proc.test.js` + `hostv-child.js`, quoted below); Postgres 17 (PID 15350)
and nats-server (PID 14562, `max_payload: 2MB`) on free ports, for the real-process tests.

## Findings

### HIGH-1: a stale holder woken after a stall welcomes, then closes, the new holder's live connections

**Where:** server/room-host.js `onInbox` (≈ :406) and `fail` (≈ :372). Nothing checks the host deadline before
handling an inbox message, so messages queued during a stall are served by a room whose lease is gone.

**Repro (real processes, Postgres + NATS):** `hostv-proc.test.js` "SIGSTOP".
1. Child process A holds the board (ttl 2 s, epoch 1) and acks 5 ops. Host B (parent) watches it.
2. `SIGSTOP` A. B takes over at about 2.1 s (epoch 2) and welcomes the client's reconnect (`c19`, seq 5).
3. While A is frozen, a new writer `x1` says hello and gets an op acked on B; `c19` gets an op acked on B.
4. `SIGCONT` A. Its NATS socket delivers the queued inbox messages **before** its deadline timer runs.
5. A's epoch-1 room welcomes `x1` and `c19` again (seq 5, epoch 1). Then the deadline fires (A's log: "room stopped:
   lease lost … no lease renew succeeded by the host deadline"), and A's `fail()` sends `unavailable` + close 1013 to
   both.

What reached the gateway subject (the test's fake gateway records `.gw.g-1`; messages to `x1` and `c19`, in order):
`welcome(B), welcome(B), ack x:1 seq 6, ack a:6 seq 7, welcome(A, seq 5), welcome(A, seq 5), unavailable 1013, unavailable 1013`.
B's room still had both connections. The log afterwards (run twice, same result) was seqs 1-7 each once,
`a:1..a:5, x:1, a:6`, with nothing written by the woken epoch-1 holder; the lease was B's (`h-b`, epoch 2).
**By reading, not run:** the real gateway would forward A's second welcome to the already-welcomed socket as plain
data (gateway.js:377-389: `c.welcomed` is true, so it falls through to `push`), and the 1013 would close a healthy
socket (gateway.js:382-386). The room-host side alone already breaks "one welcome per hello".

**Why HIGH:** it breaks the F5 done-when ("one welcome per hello, one sequencer") in exactly the case the brief
asks about (an event-loop stall past the deadline). A client is sent a welcome from a dead incarnation (older
epoch, older seq), and the live holder's writers are disconnected. No acked op was lost (each op acked once, the
log read back as above), because the fence held.

**Fix (suggested):** in `onInbox` (and before any reply from a slot), check the deadline synchronously:
`if (perf() >= slot.okAt + leaseTtlMs - renewEvery) return lost(slot, …)`, and have `fail()` of a lost lease not
send 1013 for connections it never welcomed (with the check above it never welcomes any). A test: the SIGSTOP case
above, or in-process with a bus that queues inbox messages while a busy loop runs past the deadline.

### MEDIUM-1: takeover takes up to ~2 ttl after a holder dies, not "just after expiresAt" (goal 5)

**Where:** `arm()` / `attempt()`: attempts run every `ttl + 5%` from when the watch began; a live lease re-arms a
whole ttl.

**Repro:** `hostv-attack.test.js` "C" (SQLite, ttl 2 s): the dying holder's last renew makes its lease expire just
after the watcher's attempt. Output: `holder death to B's room: 4058 ms = 2.03 ttl`. With the default ttl (10 s),
writers on a board whose holder dies wait up to ~20.5 s, half of it after the lease has already lapsed.

**Fix (suggested):** when the watcher hears the holder go silent (2 heartbeats), attempt at once and then every
ttl/3 (still asking the Store each time), or have `lease()` return the Store's remaining ms so the attempt is armed
for just after expiry without comparing clocks.

### MEDIUM-2: a hello forwarded while the holder is still building is never answered (gateway's 10 s timeout)

**Where:** `watchInbox` holds the hello; the holder's first heartbeat (published in `build`, before it subscribes the
inbox) makes the watcher drop it; the holder never saw it.

**Repro:** `hostv-attack.test.js` "A": A opens with a 1.5 s rebuild; B's gateway opens (watch) and forwards a hello
mid-build. Output: `answer to a hello sent mid-build, 4 s after A opened: NONE`. The writer waits for the gateway's
own `helloTimeoutMs` (10 s, gateway.js:1044-1048) and is then refused `unavailable`. The window is the holder's build time (forced to
1.5 s here; normally the checkpoint + log read). It hits the cold start of a cluster: the first writers of a board
land on two gateways at once.

**Fix (suggested):** when the watcher hears a heartbeat with an epoch it hasn't heard before (a new holder just
built), answer the hellos it holds with `unavailable` (the client retries and reaches the new holder) instead of
dropping them.

### MEDIUM-3: a renew that never settles is never retried; the room stops at the deadline (goal 7)

**Where:** `renewTick`: `slot.renewing` stays true while a renew hangs, so later ticks return at once. Goal 7: "A
renew error (timeout, PG down) is retried at the next tick until the deadline." There is no renew timeout.

**Repro:** `hostv-attack.test.js` "F" (ttl 900): one renew hangs, the Store is fine after. Output: `renew calls since
= 1, room alive = false`. One hung request (a dead pooled connection, a black-holed packet) restarts the room, and
its writers reconnect.
**Scope:** only a renew that *hangs*. A renew that rejects is retried every tick until the deadline ("K": rejected,
retried, stopped at the deadline, lease not released). Postgres actually stopped under a live holder refuses at
once ("PGDOWN": `ERR_POSTGRES_CONNECTION_REFUSED` in 2 ms, room stopped 1,800 ms later, ttl 3 s), so this needs a
black-holed connection, not a down database.

**Fix (suggested):** bound each renew (e.g. renewEvery) and clear `renewing` on that timeout, so the next tick sends
a fresh one.

### LOW findings

| # | Finding | Evidence |
|---|---|---|
| L1 | **Test gap: the renew deadline's send-time rule is untested.** Mutant "okAt = the renew's *receive* time" passes the builder's whole lease suite (renews there answer at once). | Mutation table below; my test "G" (renews take 250 ms, then hang) kills it: `stopped 851 ms after the last good renew's send` vs 600 allowed. Add it (or similar) to room-host-lease.test.js. |
| L2 | **A cluster rolling deploy waits up to ~1 ttl.** A watcher that already exists never re-asks the Store when the holder releases; `open()` returns early on a watch. Goal 9's "takes the board at once" holds only for a fresh host (the builder's test). | "B": A closes cleanly (released), B already watching: `B welcomed a writer after 2684 ms (ttl 3000)`. Fix: on hearing the holder go silent, or on `open()` while silent, attempt at once (same fix as MEDIUM-1). |
| L3 | **A renew that lands after the host deadline revives the room** (codex's HIGH, downgraded). After an event-loop stall past the deadline, an overdue renew tick can run before the overdue deadline timer, and its success re-arms the deadline. | "H": blocked 700 ms and 1,500 ms (deadline 600, ttl 900): `room alive = true, lease … epoch 1 live true holder h-a`. **Safe:** a renew succeeds only for the same holder at the same epoch (nobody took the board), so the lease is really held again. It deviates from goal 7's letter only; refuted as HIGH. |
| L4 | **`close()` doesn't wait for an append in flight** (codex MEDIUM, downgraded). `slot.writes` holds only checkpoints, so close can release while an append is pending. | Code: `logOf().append` never adds to `slot.writes` (room-host.js ≈ :135). **Safe:** the release keeps the epoch, and the next acquire bumps it, so a late append either lands before that acquire (in the log, unacked, rebuilt by the next host) or is `fenced`. Goal 9 says "settles slot.writes"; settle the append too, or say why not. |
| L5 | **A failed build keeps the lease without renewing it** (codex MEDIUM, downgraded). `start()`'s catch stops the lease but neither releases it nor retries. | Code: room-host.js ≈ :250. The board waits up to 1 ttl for another host, or for the next local `open()` (which re-acquires as the same holder). Bounded; releasing on a non-lease build error would help other hosts take it sooner. |
| L6 | **A watcher whose `.entries` messages are lost can answer a live holder's hello** (codex MEDIUM; the builder lists it as a risk). The same happens when hosts run different `heartbeatMs`: the watcher's silence is judged on its own `heartbeatMs`. | By reading; the brief's own rule permits it. The client reconnects once; no data at risk. Note in PROTOCOL.md that every host must run the same `heartbeatMs`. |
| L7 | **Hellos past 1,000 held per watched board get no answer** (codex LOW). | `watchInbox` drops the 1,001st onward silently; those writers wait for the gateway's 10 s timeout. Answer them `unavailable` instead of dropping. |
| L8 | **main.test.js's retry is used for the first connect too** (round 0, before any kill). A fresh boot that answers `unavailable` first would pass. | test/server/main.test.js, `welcomedAfterRestart` on round 0. Assertions kept otherwise: every non-welcome must be 1013 + `unavailable`, bounded at ttl + 3 s; every acked-op assertion is unchanged. Use a plain welcome for round 0. |
| L9 | **The PROTOCOL.md proposal is incomplete.** It replaces the § Recovery sentence, but PROTOCOL.md also says a stale host "gets `conflict` on its next append" (:714, now `fenced`), lists `openEpoch` as the build step (:20, :31, :707, :428-431), and says the stale window lasts "until … its next append conflicts" (:443-445). The proposal also doesn't state the takeover timing or the shared `heartbeatMs` assumption. | `grep -n "openEpoch\|conflict" PROTOCOL.md`. |

## sdd ensemble (codex + grok)

`check_adapter`: codex ok, grok ok; agy failed (quota, resets in ~52 h), kimi failed (no model configured), mistral
failed (no API key), qwen missing. Each harness ran in its own scratch copy on `git diff -- server/room-host.js
server/store server/bus packages/protocol/ports.js packages/protocol/room.js` plus the new test.

| Harness | Said | My verdict |
|---|---|---|
| codex (high effort) | HIGH: a late renew revives a room after its deadline | **Refuted as HIGH**, confirmed as L3: reproduced, but safe (same holder, same epoch). |
| codex | MEDIUM: close releases with an append in flight | Confirmed by reading, **downgraded to L4** (the fence keeps it safe). |
| codex | MEDIUM: a failed build leaves the lease unrenewed and unreleased | Confirmed by reading, **downgraded to L5** (bounded by 1 ttl). |
| codex | MEDIUM: lost `.entries` lets a watcher answer a live holder's hello | Confirmed by reading, **L6** (the brief's rule allows it; the builder lists it). |
| codex | LOW: hellos past the 1,000 cap get no answer | Confirmed, **L7**. |
| grok | No findings | Missed HIGH-1 and MEDIUM-1..3, all reproduced above. |

No finding had two harnesses agreeing. HIGH-1 and MEDIUM-1..3 are mine; codex didn't raise them.

## Mutation checks

Each mutant in its own scratch copy (`mutate.py`, each applied pattern checked to match exactly once, the diff
read); run against test/server/room-host-lease.test.js (SQLite), or store.test.js for the store mutant.

| Mutant | Builder's tests | Caught by |
|---|---|---|
| room host drops the epoch on `append` (brief) | caught (5 fail) | two-host probe, takeover, clean restart, dead-holder, losing the lease |
| drops the epoch on `putCheckpoint` (brief) | caught (2) | clean restart, losing the lease |
| ignore a null renew (brief) | caught (1) | losing the lease |
| subscribe the inbox without the lease: build when held live (brief) | caught (4) | two-host probe, takeover, dead-holder, live remote holder |
| `release` in `fail()` (brief) | caught (1), for the right reason (lease no longer `h-a`) | losing the lease |
| host deadline judged by the injected `now` (brief) | caught (1), right reason (never told unavailable) | the host deadline |
| **renew deadline from the receive time** (new) | **survives** | only my test G (L1) |
| answer `unavailable` for a board whose holder heartbeats (brief) | caught (2) | two-host probe, live remote holder |
| renew starts only after the rebuild (brief) | caught (1) | renew starts before the rebuild |
| SQLite fence accepts no epoch (old SEAM) | caught (1) | store contract "fence: …" |
| no `release` on close | caught (1) | clean restart |
| the watcher never answers a silent holder's hello | caught (1) | the dead-holder window |
| Postgres fence accepts no epoch (old SEAM), on Postgres 17 | caught (1) | pg-store contract "fence: …" |
| Postgres ttl/2 cap removed from the lease lock wait (R2-L1) | caught (1) | pg-store "R2-L1: …" |
| Postgres 25P03 left raw (R2-L2) | caught (1) | pg-store "M1: a holder paused mid-write…" |

15 mutants: all 14 of the builder's, re-run (the brief's "answer a live holder's board" and "skip the renew before
the rebuild" are two of them), plus one new: the renew deadline from the receive time. **14 of 15 caught** by the
builder's tests; the survivor is L1.

## Attacks that held (both adapters where it applies)

| Attack | Result |
|---|---|
| **Real kill -9 of a child process holding a Postgres lease** (NATS bus, ttl 2 s; `hostv-proc.test.js`) | First hello in the window answered `unavailable` 1013 in 401 ms; the retry was welcomed after 2,126 ms at seq 5 with epoch 2 > 1; log `a:1..a:5`, each once. |
| SIGSTOP of the holder | Takeover and acked ops as above. The woken holder's behaviour is HIGH-1. |
| Two hosts with different `leaseTtlMs` (holder 3 s, watcher 600 ms; "I") | 20 hellos over 4 s: 20 welcomes, 0 errors, lease stays the holder's. Holder dies: taken over after 3,436 ms. |
| Renews that reject, the Store down ("K", in-process) | Retried each tick, room stopped at the deadline (692 ms after the first reject, ttl 1.5 s), lease still `h-a` (not released). |
| Postgres stopped (`pg_ctl stop -m immediate`) under a live holder ("PGDOWN") | Renew refused in 2 ms (`ERR_POSTGRES_CONNECTION_REFUSED`), retried; room stopped 1,800 ms later (ttl 3 s). |
| `close()` after a takeover it didn't notice | **By reading only:** both adapters' `release` change the row only `WHERE holder = $holder AND epoch = $epoch`, so a stale holder's release can't free the new holder's lease. Not attacked. |
| Takeover racing the watcher's own `close()`, mid-acquire and mid-build ("J") | Lease ends released (holder null, not live); no room, no watch left. |
| Renew deadline by send time ("G") | Stops 600 ms after the last good renew's send (ttl 900): correct. |
| Builder's done-when tests (two-host probe, takeover sqlite + postgres, clean restart, dead-holder window) | Green on every run below. |

## Approved test edits outside the builder's list (check 5)

| Edit | Verdict |
|---|---|
| gateway.test.js:72 and revocation.test.js:17-21 (`openEpoch` wrappers → `acquire`) | Same probe at the new build step; the order and the gate still test what they tested. |
| gateway.test.js:287-297 (`...rest` passes the epoch through the append wrapper) | Needed now (no epoch is refused). "conflicts" still makes a real `conflict`: the usurper writes at the same epoch with a stale `expectSeq`. Not loosened. |
| gateway.test.js:335 (late append: `conflict` → `fenced`) | Stricter: after the failed room is rebuilt (same holder, epoch bumped) the fence refuses it before `expectSeq` is looked at. The "op once" log assertion is kept. Not loosened. |
| outbound.test.js:360 (seed acquires a lease, passes its epoch) | Needed; tests the same read-by-size behaviour. Not loosened. |
| main.test.js kill -9 restart | Retries only on 1013 + `unavailable` or a timeout, bounded at `LEASE_TTL_MS + 3 s`; every acked-op assertion kept. One looseness: **L8** (round 0 tolerates it too). |
| rig.js | Unchanged (`git diff` empty). |

## Spec conformance (goals 1-12)

| Goal | Verdict |
|---|---|
| 1 One path, no `openEpoch` in server/ | Met: `grep -rn openEpoch server/` finds only the Store adapters. |
| 2 Holder id | Met, with the builder's documented deviation (`-`, not `:`, because the Store's ids are `[a-z0-9-]`); `hostname` defaults to `$HOSTNAME` (p4-wire should pass `os.hostname()`). |
| 3 ttl 10 s, renew ttl/3, unref'd interval | Met. |
| 4 Renew before the rebuild | Met (mutant caught). |
| 5 Held elsewhere: no room, no inbox, one armed attempt asking the Store | Met, except the timing: **MEDIUM-1** (≈ 2 ttl, not "just after expiresAt"). |
| 6 Dead-holder window | Met for a dead holder (≤ ttl + 3 s, real kill -9). Gaps: **MEDIUM-2** (holder still building), **L7**. |
| 7 Losing the lease stops the room, no release; deadline by `performance.now()` from send time | Met in the main paths. Gaps: **HIGH-1** (inbox served past the deadline after a stall), **MEDIUM-3** (hung renew not retried), **L3**. |
| 8 Every write fenced; no epoch → `bad-entry`; typedef; MemoryLog unchanged | Met, both adapters (contract; SEAM mutant caught). |
| 9 Clean stop: checkpoint, settle, release | Met for checkpoints. **L4** (appends not settled), **L2** (an existing watcher waits up to 1 ttl). |
| 10 R2-L2 25P03 → `unavailable`; R2-L1 cap test | Met (pg-store tests green on Postgres 17). |
| 11 F14 `Room.status()` only | Met: room-host calls only Room methods (`status`, `checkpoint`, `heartbeat`, `connect`, `disconnect`, `receive`, `listed`, `sweep`, `fail`); `stopped` is one extra field. |
| 12 F15/F13 `flush` on the port, no `?.`; typedef `flush` + `maxBytes` | Met (room-host.js:456, :459). |
| PROTOCOL.md proposal vs code | The code does what it says; the proposal leaves stale text elsewhere (**L9**). |

## Systems design (distributed-systems-design, CHECKER mode)

- **CAP:** CP, stated by the builder and true: no Store, no sequencer. The fence makes the Store the single judge,
  so clock skew between hosts doesn't matter (hosts measure only their own elapsed time).
- **Failure scenarios, per component:**

  | Failure | Holds? |
  |---|---|
  | Holder dies (kill -9) | Yes; takeover in 1.05-2.05 ttl (MEDIUM-1). |
  | Holder stalls past the ttl (GC, SIGSTOP) | Writes are fenced, so no acked op is lost. But the woken holder answers hellos and closes the new holder's sockets (**HIGH-1**). |
  | One Store request hangs | The room restarts needlessly (MEDIUM-3). |
  | Store down | Opens fail (`down("room")`); the room stops at the deadline. Correct. |
  | Bus-only partition of the holder | Not handled (the builder says so): the board is down for writers until it heals. Out of scope for M2. |
- **SPOF:** none new; the Store was already the single judge.
- **Scale:** the builder's estimate (300 renew writes/s and ≤ ~860 lease reads/s at 1,000 boards × 10 hosts) is
  plausible and unmeasured. MEDIUM-1's fix (attempt when silent) adds reads only for boards whose holder is silent.

## Gates

| Gate | Result |
|---|---|
| `bun test test/server` ×10 (scratch copy, no DATABASE_URL) | 9 runs: 217 pass, 0 fail. Run 9: 1 fail in test/server/v1.test.js "§ Pacing: frames read … maxLiveQueuedBytes" (20 s timeout), while my real-process and mutation runs loaded the CPU. That test passed 20 of 20 runs alone, and its file isn't part of this job: a flake under load, not this job's. |
| room-host-lease.test.js ×10 with DATABASE_URL (Postgres 17) | 10 of 10: 11 pass, 0 fail. |
| `bun test`, shared tree | 1288 pass, 147 skip, 1 fail (test/core-source: the known herdr-draw drift). |
| `bun test`, shared tree, DATABASE_URL + NATS_URL | 1410 pass, 29 skip, 1 fail (test/core-source). |
| test/architecture.test.js + test/purity.test.js | 17 pass. room-host imports only packages/protocol, `./bus/port.js`, `./log.js`, `./ids.js`, `./breather.js` (no adapter). |
| Job files unchanged during verification | sha256 re-checked at the end: all 18 match the table at the top. |

## Cleanup

- Postgres (PIDs 15350, then 60048, then 62371 after the PGDOWN test restarted it) and nats-server (PIDs 14562,
  then 60113) stopped by PID; none is running. The Postgres test schemas
  my tests made were dropped by their `afterAll`.
- `rm -rf` of the scratch copies and Postgres data dir was **denied** by the permission prompt, so they stay in this
  session's private scratchpad. Nothing was left in the repo (only this report changed) or in /tmp.

## Appendix: the attack tests and mutant script (scratch only; hostv-proc and hostv-pgdown need DATABASE_URL, NATS_URL)

### hostv-child.js

```js
// Child: one room host on Postgres + NATS, holding a board. argv: holder ttlMs schema
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { natsBus } from "../../server/bus/nats.js";
import { createLogger } from "../../server/log.js";
const log = createLogger({ write: l => { if (/stopped|lost|fenced|opened/.test(l)) console.error("CHILD", performance.now().toFixed(0), l.slice(0, 260)); } });
const [holder, ttl, schema] = process.argv.slice(2);
const store = await postgresStore({ url: process.env.DATABASE_URL, schema, max: 3 });
const bus = await natsBus({ url: process.env.NATS_URL });
const h = roomHost({ store, bus, holder, log, leaseTtlMs: Number(ttl), heartbeatMs: 200 });
await h.open("t-aaa", "b-one");
const p = await h.peek("t-aaa", "b-one");
console.log(`OPEN ${p ? p.epoch : "none"}`);
setInterval(() => {}, 1000);
```

### hostv-proc.test.js

```js
// p4-hostv: real processes on Postgres + NATS. The holder is a child process: kill -9, and SIGSTOP past the ttl.
import { test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { natsBus, subjects } from "../../server/bus/nats.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { sleep, until } from "./helpers.js";

const T = "t-aaa", B = "b-one", url = process.env.DATABASE_URL, nurl = process.env.NATS_URL;
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const schemas = [];
afterAll(async () => { const a = new SQL({ url, max: 1 }); for (const s of schemas) await a.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`); await a.close(); });

function gw(bus, id) {
  const got = [], n = new Map();
  bus.subscribe(subjects.gateway(id), m => got.push({ at: performance.now(), conn: m.conn, close: m.close, msg: m.data ? JSON.parse(m.data) : null }));
  const send = (conn, client, msg) => { const k = (n.get(conn) ?? 0) + 1; n.set(conn, k); return bus.publish(subjects.inbox(T, B), { n: k, conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg }); };
  return { got, of: c => got.filter(m => m.conn === c),
    hello: (c, client) => send(c, client, { t: "hello", v: PROTOCOL_VERSION, board: B, client }),
    op: (c, client, k) => send(c, client, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    answer: c => got.find(m => m.conn === c && (m.msg?.t === "welcome" || m.close)) };
}
async function child(holder, ttl, schema) {
  const p = Bun.spawn(["bun", "test/server/hostv-child.js", holder, String(ttl), schema], { stdout: "pipe", stderr: "inherit", env: process.env });
  const reader = p.stdout.getReader(); let out = "";
  while (!/OPEN/.test(out)) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
  return { p, epoch: Number(out.match(/OPEN (\d+)/)?.[1]) };
}

for (const how of ["kill -9", "SIGSTOP"]) test.skipIf(!url || !nurl)(`real child holder on Postgres + NATS: ${how}`, async () => {
  const schema = `pl_hostv_${process.pid}_${how === "kill -9" ? "k" : "s"}`; schemas.push(schema);
  const ttl = 2_000;
  const { p, epoch: eA } = await child("h-child", ttl, schema);
  console.log(`[${how}] child pid ${p.pid} holds epoch ${eA}`);
  const store = await postgresStore({ url, schema, max: 3 }), bus = await natsBus({ url: nurl });
  const Bh = roomHost({ store, bus, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 200 });
  const g = await gw(bus, "g-1");
  try {
    g.hello("c1", "a"); await until(() => g.answer("c1")?.msg?.t === "welcome", "welcome from child", 5000);
    for (let k = 1; k <= 5; k++) { g.op("c1", "a", k); await until(() => g.got.some(m => m.msg?.t === "ack" && m.msg.id === `a:${k}`), `ack ${k}`, 5000); }
    await Bh.open(T, B); expect(Bh.stats().waiting).toBe(1);
    const t0 = performance.now();
    if (how === "kill -9") p.kill(9); else process.kill(p.pid, "SIGSTOP");
    // A hello in the window: answered within ttl + 3 s.
    g.hello("c2", "a");
    await until(() => g.answer("c2"), "c2 answered", ttl + 3_000);
    console.log(`[${how}] first hello answered in ${Math.round(g.answer("c2").at - t0)} ms: ${g.answer("c2").msg?.t ?? ""} close=${g.answer("c2").close}`);
    let w = null;
    for (let i = 3; !w && performance.now() - t0 < 4 * ttl; i++) {
      await Bh.open(T, B); g.hello(`c${i}`, "a");
      await until(() => g.answer(`c${i}`), "answer", 11_000).catch(() => {});
      const a = g.answer(`c${i}`); if (a?.msg?.t === "welcome") w = { conn: `c${i}`, ...a }; else await sleep(100);
    }
    console.log(`[${how}] welcomed after ${Math.round(w.at - t0)} ms, seq ${w.msg.seq}, epoch ${w.msg.room.epoch} (A ${eA})`);
    expect(w.msg.seq).toBe(5); expect(w.msg.room.epoch).toBeGreaterThan(eA);
    if (how === "SIGSTOP") {
      // While A is frozen: a hello and two ops on B. Then wake A: its sockets deliver what queued.
      g.hello("x1", "x"); await until(() => g.answer("x1"), "x1", 5000);
      g.op("x1", "x", 1); g.op(w.conn, "a", 6);
      await until(() => g.got.some(m => m.msg?.id === "a:6"), "a:6", 5000);
      console.log("[SIGSTOP] SIGCONT at", performance.now().toFixed(0), "B room before:", JSON.stringify(await Bh.peek(T,B).then(x=>x&&{epoch:x.epoch,conns:x.conns}))); process.kill(p.pid, "SIGCONT");
      await sleep(2_000);
      console.log("[SIGSTOP] B room after:", JSON.stringify(await Bh.peek(T,B).then(x=>x&&{epoch:x.epoch,conns:x.conns})));
      const welcomes = c => g.of(c).filter(m => m.msg?.t === "welcome").length;
      const acks = id => g.got.filter(m => m.msg?.t === "ack" && m.msg.id === id).map(m => m.msg.seq);
      console.log(`[SIGSTOP] after SIGCONT: welcomes x1=${welcomes("x1")}, ${w.conn}=${welcomes(w.conn)}; acks x:1=${JSON.stringify(acks("x:1"))} a:6=${JSON.stringify(acks("a:6"))}; closes to ${w.conn}: ${JSON.stringify(g.of(w.conn).filter(m => m.close).map(m => m.close))}`);
      console.log(`[SIGSTOP] all messages to x1 and ${w.conn}:`, JSON.stringify(g.got.filter(m => m.conn === "x1" || m.conn === w.conn).map(m => [m.msg?.t, m.msg?.code ?? m.msg?.id ?? m.msg?.seq, m.close])));
      const full = await store.read(T, B, 1, 100);
      console.log(`[SIGSTOP] log after SIGCONT: ${full.map(e => `${e.seq}:${e.id}`).join(",")}; lease ${JSON.stringify(await store.lease(T, B))}`);
      expect(full.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(full.map(e => e.id)).toEqual(["a:1", "a:2", "a:3", "a:4", "a:5", "x:1", "a:6"]);
      expect(acks("x:1")).toEqual([6]); expect(acks("a:6")).toEqual([7]);
      expect(welcomes("x1")).toBe(1);
    }
    const log = await store.read(T, B, 1, 100);
    console.log(`[${how}] log ids: ${log.map(e => e.id).join(",")}`);
    for (let k = 1; k <= 5; k++) expect(log.filter(e => e.id === `a:${k}`).length).toBe(1);
  } finally { try { p.kill(9); } catch {} await Bh.close(); await bus.close(); await store.close(); }
}, 40_000);
```

### hostv-pgdown.test.js

```js
// p4-hostv: Postgres stopped under a live holder: do renews reject (retried) or hang (MEDIUM-3)?
import { test, expect } from "bun:test";
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { memoryBus } from "../../server/bus/memory.js";
import { sleep, until } from "./helpers.js";
const url = process.env.DATABASE_URL, PGDATA = process.env.HOSTV_PGDATA, PGOPTS = process.env.HOSTV_PGOPTS;
test.skipIf(!url || !PGDATA)("Postgres down under a live holder", async () => {
  const raw = await postgresStore({ url, schema: `pl_hostv_down_${process.pid}`, max: 2 }), bus = memoryBus();
  const seen = [];
  const store = { ...raw, renew: (...a) => { const t = performance.now(); const p = raw.renew(...a); p.then(() => seen.push(["ok", Math.round(performance.now() - t)]), e => seen.push(["rejected", Math.round(performance.now() - t), e.code ?? e.errno ?? e.message?.slice(0, 50)])); return p; } };
  let stopped = false;
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 3_000 });
  try {
    await A.open("t-aaa", "b-one");
    await sleep(1_200); seen.length = 0;
    const t0 = performance.now();
    Bun.spawnSync(["/opt/homebrew/opt/postgresql@17/bin/pg_ctl", "-D", PGDATA, "stop", "-m", "immediate"]);
    await until(async () => (await A.peek("t-aaa", "b-one")) === null, "room stops", 6_000);
    console.log(`PGDOWN: room stopped ${Math.round(performance.now() - t0)} ms after Postgres went down; renews settled meanwhile: ${JSON.stringify(seen)}`);
  } finally {
    Bun.spawnSync(["/opt/homebrew/opt/postgresql@17/bin/pg_ctl", "-D", PGDATA, "-o", PGOPTS, "-l", PGDATA + "/../pg.log", "start", "-w"]);
    await A.close(); await bus.close(); await raw.close().catch(() => {});
  }
}, 30_000);
```

### hostv-attack.test.js

```js
// p4-hostv attacks (verifier scratch, never in the repo). Each test prints what it measured.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { roomHost } from "../../server/room-host.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { cleanup, tempDir, sleep, until } from "./helpers.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one";
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const never = () => new Promise(() => {});
const sq = () => sqliteStore({ path: join(tempDir(), "p.db") });

function fakeGateway(bus, id = "g-1") {
  const got = [], n = new Map();
  bus.subscribe(subjects.gateway(id), m => got.push({ at: performance.now(), conn: m.conn, close: m.close, msg: m.data ? JSON.parse(m.data) : null }));
  const send = (conn, client, msg) => { const k = (n.get(conn) ?? 0) + 1; n.set(conn, k); return bus.publish(subjects.inbox(T, B), { n: k, conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg }); };
  return {
    got, of: conn => got.filter(m => m.conn === conn),
    hello: (conn, client) => send(conn, client, { t: "hello", v: PROTOCOL_VERSION, board: B, client }),
    op: (conn, client, k) => send(conn, client, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    answer: conn => got.find(m => m.conn === conn && (m.msg?.t === "welcome" || m.close)),
    ack: (conn, id) => until(() => got.find(m => m.conn === conn && m.msg?.t === "ack" && m.msg.id === id)?.msg, `ack ${id}`, 5000),
  };
}
/** Retry hellos (open first, as the gateway does) until welcomed; returns ms from t0 to the welcome. */
async function retryUntilWelcome(host, g, t0, maxMs, tag) {
  for (let i = 0; ; i++) {
    if (performance.now() - t0 > maxMs) return Infinity;
    await host.open(T, B);
    const c = `${tag}${i}`; g.hello(c, "a");
    const a = await until(() => g.answer(c), "answer", 11_000).catch(() => null);
    if (a?.msg?.t === "welcome") return a.at - t0;
    await sleep(50);
  }
}

test("A. cold open race: a hello forwarded through the waiting host while the holder is still building", async () => {
  const raw = await sq(), bus = memoryBus();
  let slow = true;
  const slowStore = { ...raw, read: async (...a) => { if (slow) { slow = false; await sleep(1_500); } return raw.read(...a); } };
  const A = roomHost({ store: slowStore, bus, holder: "h-a", leaseTtlMs: 10_000 });   // default heartbeat 2 s
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: 10_000 });
  try {
    const opening = A.open(T, B);
    await sleep(50);
    await Bh.open(T, B);                                   // B's gateway: open resolves (watch), then forwards
    expect(Bh.stats().waiting).toBe(1);
    const g = fakeGateway(bus);
    const t0 = performance.now();
    g.hello("c1", "a");
    await opening;
    await sleep(4_000);                                     // well past A's build and B's silence rule
    const a = g.answer("c1");
    console.log("A: answer to a hello sent mid-build, 4 s after A opened:", a ? `${a.msg?.t ?? a.close} at ${Math.round(a.at - t0)} ms` : "NONE (gateway would wait its 10 s hello timeout)");
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 20_000);

test("B. clean release with a watcher already in place: how long until the watching host serves the board", async () => {
  const raw = await sq(), bus = memoryBus();
  const ttl = 3_000;
  const A = roomHost({ store: raw, bus, holder: "h-a", leaseTtlMs: ttl, heartbeatMs: 100 });
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 100 });
  try {
    await A.open(T, B); await Bh.open(T, B);
    const g = fakeGateway(bus);
    await sleep(500);
    await A.close();                                        // a rolling deploy: clean, released
    expect((await raw.lease(T, B)).live).toBe(false);
    const t0 = performance.now();
    const ms = await retryUntilWelcome(Bh, g, t0, 3 * ttl, "r");
    console.log(`B: after A's clean release, B welcomed a writer after ${Math.round(ms)} ms (ttl ${ttl})`);
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 20_000);

test("C. takeover latency worst case: the lease's expiry falls just after a watcher's attempt", async () => {
  const raw = await sq(), bus = memoryBus();
  const ttl = 2_000;
  await raw.acquire(T, B, "h-dead", ttl);                  // a holder that will die (its host is gone; nothing heartbeats)
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 100 });
  try {
    const w0 = performance.now();
    await Bh.open(T, B);
    expect(Bh.stats().waiting).toBe(1);
    // B's first attempt is at w0 + ttl*1.05 = w0 + 2100. The dying holder's last renew lands so its lease expires at w0 + 2150.
    await until(() => performance.now() - w0 >= 150, "t", 1000);
    const l = await raw.lease(T, B);
    expect(await raw.renew(T, B, "h-dead", l.epoch, ttl)).not.toBe(null);
    const death = performance.now();                        // it dies right after this renew
    await until(async () => (await Bh.peek(T, B)) !== null, "B's takeover", 10_000);
    const ms = performance.now() - death;
    console.log(`C: holder death to B's room: ${Math.round(ms)} ms = ${(ms / ttl).toFixed(2)} ttl (lease expired at ~${ttl} ms)`);
  } finally { await Bh.close(); await raw.close(); await bus.close(); }
}, 20_000);

test("F. one renew that hangs (then the Store is fine again): is it retried before the deadline?", async () => {
  const raw = await sq(), bus = memoryBus();
  let hangNext = false, renews = 0;
  const store = { ...raw, renew: (...a) => { renews++; if (hangNext) { hangNext = false; return never(); } return raw.renew(...a); } };
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 900 });
  try {
    await A.open(T, B);
    await sleep(400);
    hangNext = true; const r0 = renews;
    await sleep(1_500);
    const alive = (await A.peek(T, B)) !== null;
    console.log(`F: after one hung renew: renew calls since = ${renews - r0}, room alive = ${alive}`);
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10_000);

test("G. host deadline counts from the renew's SEND time (slow renews, then they hang)", async () => {
  const raw = await sq(), bus = memoryBus();
  let mode = "slow", lastSend = 0;
  const store = { ...raw, renew: async (...a) => {
    if (mode === "hang") return never();
    lastSend = performance.now(); await sleep(250); return raw.renew(...a);
  } };
  const ttl = 900;   // renew every 300; deadline = last good send + 600
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: ttl });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await until(() => g.answer("c1"), "welcome");
    await sleep(1_000);
    // Let the in-flight slow renew finish successfully, then hang the rest.
    const sendOfLastGood = lastSend;
    mode = "hang";
    await until(() => g.of("c1").some(x => x.close === 1013), "stopped", 3_000);
    const stopAt = g.of("c1").find(x => x.close === 1013).at;
    const after = stopAt - sendOfLastGood;
    console.log(`G: stopped ${Math.round(after)} ms after the last good renew's send (send-time rule: <= ${ttl - 300}; receive-time: ~${ttl - 300 + 250})`);
    expect(after).toBeLessThan(ttl - 300 + 100);
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10_000);

test("H. codex's claim: a stall past the host deadline but short of the lease's expiry, then a renew that succeeds", async () => {
  for (const ms of [700, 1500]) {
    const raw = await sq(), bus = memoryBus();
    const A = roomHost({ store: raw, bus, holder: "h-a", leaseTtlMs: 900 });
    try {
      await A.open(T, B); await sleep(350);
      const end = performance.now() + ms; while (performance.now() < end) { /* block the event loop */ }
      await sleep(200);
      const l = await raw.lease(T, B);
      console.log(`H: blocked ${ms} ms (deadline 600, ttl 900): room alive = ${(await A.peek(T, B)) !== null}, lease epoch ${l.epoch} live ${l.live} holder ${l.holder}`);
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }
}, 10_000);

test("I. two hosts with different leaseTtlMs: the short-ttl watcher never takes or answers a long-ttl holder's live board; then the holder dies", async () => {
  const raw = await sq(), bus = memoryBus();
  let dead = false;
  const deadBus = { ...bus, publish: (s, x) => (dead ? Promise.resolve() : bus.publish(s, x)), subscribe: (s, fn) => bus.subscribe(s, x => { if (!dead) fn(x); }) };
  let hang = false;
  const storeA = { ...raw, renew: (...a) => hang ? never() : raw.renew(...a) };
  const A = roomHost({ store: storeA, bus: deadBus, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 100 });
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: 600, heartbeatMs: 100 });
  try {
    await A.open(T, B); await Bh.open(T, B);
    const g = fakeGateway(bus);
    for (let i = 0; i < 20; i++) { g.hello(`c${i}`, `x${i}`); await sleep(200); }   // 4 s: > one A ttl, ~6 B attempts
    await bus.flush(); await sleep(100);
    const welcomes = g.got.filter(x => x.msg?.t === "welcome").length, others = g.got.filter(x => x.close || x.msg?.t === "error").length;
    const l = await raw.lease(T, B);
    console.log(`I: 20 hellos over 4 s: welcomes ${welcomes}, errors/closes ${others}; B ${JSON.stringify(Bh.stats())}; lease holder ${l.holder} epoch ${l.epoch}`);
    expect(welcomes).toBe(20); expect(others).toBe(0); expect(l.holder).toBe("h-a");
    dead = true; hang = true; const t0 = performance.now();
    await until(async () => (await Bh.peek(T, B)) !== null, "B takes over", 10_000);
    console.log(`I: holder (ttl 3 s) died; short-ttl watcher took over after ${Math.round(performance.now() - t0)} ms`);
  } finally { dead = false; await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 20_000);

test("J. a takeover attempt racing the watcher's own close(): mid-acquire and mid-build", async () => {
  for (const where of ["acquire", "read"]) {
    const raw = await sq(), bus = memoryBus();
    let slowNext = false, entered = false;
    const store = { ...raw,
      acquire: async (...a) => { if (where === "acquire" && slowNext) { entered = true; await sleep(400); } return raw.acquire(...a); },
      read: async (...a) => { if (where === "read" && slowNext) { entered = true; await sleep(400); } return raw.read(...a); } };
    const A = roomHost({ store: raw, bus, holder: "h-a", leaseTtlMs: 600, heartbeatMs: 100 });
    const Bh = roomHost({ store, bus, holder: "h-b", leaseTtlMs: 600, heartbeatMs: 100 });
    try {
      await A.open(T, B); await Bh.open(T, B);
      slowNext = true; await A.close();                     // released: B's next attempt (≤ 630 ms) wins
      await until(() => entered, "B's attempt under way", 2_000);
      await Bh.close();
      await sleep(800);
      const l = await raw.lease(T, B);
      console.log(`J(${where}): after B.close() mid-takeover: lease holder ${l.holder} live ${l.live} epoch ${l.epoch}; B stats ${JSON.stringify(Bh.stats())}`);
      expect(l.live).toBe(false);
    } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
  }
}, 20_000);

test("K. renews that reject (the Store down): retried every tick, the room stops at the deadline, never released", async () => {
  const raw = await sq(), bus = memoryBus();
  let reject = false, calls = [];
  const store = { ...raw, renew: (...a) => { if (reject) { calls.push(performance.now()); return Promise.reject(new Error("connection refused")); } return raw.renew(...a); } };
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 1_500 });   // renew every 500, deadline last good send + 1000
  try {
    await A.open(T, B);
    const g = fakeGateway(bus); g.hello("c1", "a"); await until(() => g.answer("c1"), "welcome");
    await sleep(300); reject = true; const t0 = performance.now();
    await until(() => g.of("c1").some(x => x.close === 1013), "stopped", 3_000);
    const l = await raw.lease(T, B);
    console.log(`K: ${calls.length} rejected renews retried before the stop at ${Math.round(performance.now() - t0)} ms; lease holder ${l.holder} (not released)`);
    expect(calls.length).toBeGreaterThanOrEqual(1); expect(l.holder).toBe("h-a");
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10_000);
```

### mutate.py

```python
import sys
name, path = sys.argv[1], sys.argv[2]
RH = "server/room-host.js"
M = {
 "append-no-epoch": [(RH, "store.append(tenant, board, entries, expectSeq, slot.epoch)", "store.append(tenant, board, entries, expectSeq)")],
 "cp-no-epoch": [(RH, "store.putCheckpoint(tenant, board, cp, slot.epoch)", "store.putCheckpoint(tenant, board, cp)")],
 "ignore-null-renew": [(RH, 'if (!l) return lost(slot, "lease renew refused: the lease is gone");', "if (!l) return;")],
 "inbox-without-lease": [(RH, "if (l) return start(tenant, board, key, l, sent);", "if (l) return start(tenant, board, key, l, sent);\n      return start(tenant, board, key, { epoch: (await store.lease(tenant, board))?.epoch ?? 1 }, sent);")],
 "release-on-fail": [(RH, "slot.dead = true; slot.unsub(); stopLease(slot);", "slot.dead = true; slot.unsub(); stopLease(slot); Promise.resolve(store.release(slot.tenant, slot.board, me, slot.epoch)).catch(() => {});")],
 "deadline-by-now": [(RH, "renewEvery - perf()));", "renewEvery - now()));"), (RH, "const sent = perf();\n    let p;", "const sent = now();\n    let p;"), (RH, "const sent = perf();\n      const l = await store.acquire", "const sent = now();\n      const l = await store.acquire")],
 "renew-receive-time": [(RH, "if (sent > slot.okAt) { slot.okAt = sent; armDeadline(slot); }", "{ const r = perf(); if (r > slot.okAt) { slot.okAt = r; armDeadline(slot); } }")],
 "answer-live-holder": [(RH, "if (perf() - w.heardAt > silentAfter) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);", "return reply(m.gateway, m.conn, UNAVAILABLE, 1013);")],
 "renew-after-rebuild": [(RH, "startLease(slot, sentAt);\n    held.set", "held.set"), (RH, "slot.durable = slot.room.status().resolved;", "slot.durable = slot.room.status().resolved; startLease(slot, perf());")],
 "sqlite-seam": [("server/store/sqlite.js", "ready(tenant, board); needWriteEpoch(epoch);\n      if (!Number.isSafeInteger(expectSeq)", "ready(tenant, board); needEpoch(epoch);\n      if (!Number.isSafeInteger(expectSeq)"), ("server/store/sqlite.js", "const fence = (tenant, board, epoch) => {\n", "const fence = (tenant, board, epoch) => {\n    if (epoch === undefined) return;\n")],
 "no-release-on-close": [(RH, "try { await store.release(slot.tenant, slot.board, me, slot.epoch); }", "try { }")],
 "watcher-never-answers": [(RH, "if (perf() - w.heardAt > silentAfter) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);", ""), (RH, "if (perf() - w.heardAt > silentAfter) { for (const h of w.pending.splice(0)) reply(h.gateway, h.conn, UNAVAILABLE, 1013); return; }", "if (perf() - w.heardAt > silentAfter) { w.pending.length = 0; return; }")],
 "pg-seam": [("server/store/postgres.js", "const needWriteEpoch = epoch => { if (!posInt(epoch))", "const needWriteEpoch = epoch => { if (epoch !== undefined && !posInt(epoch))"), ("server/store/postgres.js", "const fence = async (tx, tenant, board, epoch) => {\n", "const fence = async (tx, tenant, board, epoch) => {\n    if (epoch === undefined) return;\n")],
 "pg-no-ttl-cap": [("server/store/postgres.js", "const leaseLock = ttlMs => Math.min(leaseLockTimeoutMs, ttlMs === undefined ? leaseLockTimeoutMs : ttlMs / 2);", "const leaseLock = ttlMs => leaseLockTimeoutMs;")],
 "pg-25p03-raw": [("server/store/postgres.js", "if (err?.errno === IDLE_CUT) throw", "if (false) throw")],
}
if name == "list":
    print(" ".join(M)); sys.exit(0)
for f, a, b in M[name]:
    p = f"{path}/{f}"; s = open(p).read()
    if s.count(a) != 1: sys.exit(f"MUTANT {name}: pattern not found once in {f}: {a[:60]!r} (count {s.count(a)})")
    open(p, "w").write(s.replace(a, b))
print(f"applied {name}")
```

# Round 2

Verifier t1hd, 2026-11-12. Fix round by t1h5 (docs/m2/reports/p4-host.md § Round 2; brief docs/m2/briefs/p4-host-r2.md).

**Verdict: PASS.** Every round-1 finding is fixed or answered, and every repro passes. HIGH-1 is fixed in a real
SIGSTOP/SIGCONT on Postgres + NATS (3 of 3 runs). All 28 mutants are caught. One new LOW (R2-L1, a slowly growing
set), nothing above LOW.

**Files verified** (sha256, first 12; the scratch copy hash-checked against these; re-checked unchanged before the
final suite runs):

```
80804d4e08b5 server/room-host.js          03330eb28cbf test/server/room-host-lease.test.js
537f04793dc2 server/store/sqlite.js       fdd8ab33ab0a test/server/room-host-proc.test.js
a8cbe5a5b2f2 server/store/postgres.js     20baad9612ed test/server/room-host-child.js
234e8cbf9076 packages/protocol/ports.js   1ed9322eae71 test/server/store-contract.js
377779da0d6c packages/protocol/room.js    aafb9d3ca7d1 test/server/store.test.js
3f3d8d4a086c server/bus/port.js           96212a7a0ae8 test/server/pg-store.test.js
563a72538590 server/server.js             666f26210b2a test/server/gateway.test.js
27f60d610669 server/feed.js (read only)   802e511a1164 test/server/main.test.js
```

## (1) My round-1 repros, rerun unchanged against the round-2 code

| Repro | Round 1 | Round 2 |
|---|---|---|
| **SIGSTOP** (real child, Postgres 17 + NATS; run 3×) | stale welcome ×2, then 1013 ×2 to the new holder's connections | **Fixed** (3 of 3 runs). `welcomes x1=1, c18=1`; no close to the new holder's connections; acks `x:1=[6] a:6=[7]`; log `1:a:1 … 5:a:5, 6:x:1, 7:a:6`; lease `h-b` epoch 2. |
| kill -9 (same harness) | passed | Passes: log `a:1..a:5`. |
| A (hello sent mid-build) | no answer | **Fixed:** answered `unavailable` at 1,452 ms (1.5 s rebuild). |
| B (clean release, watcher in place) | 2,684 ms (ttl 3 s) | **Fixed:** 58 ms. |
| C (worst-case takeover) | 2.03 ttl | **Fixed:** 1.02 ttl (2,042 ms, ttl 2 s). |
| F (one hung renew) | 1 renew call, room dead | **Fixed:** 6 renew calls, room alive. |
| G (send-time deadline, ttl 900, 250 ms renews) | correct (600 ms) | **Not applicable as written:** at ttl 900 the new renew bound is 150 ms, so every 250 ms renew times out and no renew succeeds ("stopped 69 ms after the last *sent* renew"). This is the builder's documented ttl/6 deviation, and its rescaled test "L1 (repro G)" (ttl 1.8 s) holds the send-time rule; the receive-time mutant is caught by it (below). |
| H (stall 700 / 1,500 ms past a 600 ms deadline) | room revived by a late renew | **Fixed (L3):** room gone both times, lease not renewed. |
| I (different `leaseTtlMs`) | safe | Safe: 20 welcomes, 0 errors; takeover 2,901 ms after a 3 s-ttl holder died. |
| J (takeover racing the watcher's close) | safe | Safe: lease released, no room, no watch. |
| K (renews reject) | retried, stopped at the deadline | Retried 4× (ttl/12 retry), stopped at 694 ms, not released. |
| PGDOWN (Postgres stopped under a holder) | stopped at 1,800 ms | Stopped at 1,799 ms; 4 refused renews retried (the builder didn't re-run this; now done). |

Each finding also has a builder test in room-host-lease.test.js (HIGH-1 in-process, MEDIUM-1/-2/-3, L1-L5, L7) and
room-host-proc.test.js (SIGSTOP, kill -9).

## (2) The deviations

- **Renew bound ttl/6, retry ttl/12** (I = ttl/3; the deadline is 2I after the last good send). I checked the
  arithmetic: a renew sent at I that hangs times out at 1.5I, and the retry goes out at 1.75I with 0.25I left to
  land before the deadline at 2I. A second hang times out at 2.25I, after the deadline, so the deadline stops the
  room. With the brief's literal bound (I), the first timeout would land at 2I, with no time left to retry. The
  deviation is needed, and the arithmetic is right. At the default ttl 10 s this is a 1.67 s bound per renew, retried
  833 ms later.
  - **Cost:** a Store whose renews take longer than ttl/6 can never renew. Repro G at ttl 900 shows it (150 ms
    bound). Fine at 10 s.
- **A late renew never moves `okAt` or revives a lost room.**
  - **By reading:** the success handler runs only if `Promise.race([p, late])` settles with the renew, so a renew
    that loses to the timeout is ignored. A result that arrives after the deadline calls `lost`, and nothing after
    `slot.dead` touches `okAt`.
  - **By test:** repro H (above), and mutants `l3-revive` and `medium3-no-timeout` are caught.
- **`opened: true` on the first heartbeat.**
  - **Gateways:** `server/feed.js:127-138` reads only `epoch`, `items`/`from`/`to` and `seq`, so `opened` and
    `released` are ignored there (read).
  - **Can a watcher be fooled into answering a live holder's board?** `fresh` is `opened === true`, or an epoch
    above one already heard, and the watcher's first heartbeat sets its epoch without counting as fresh. A live
    holder's ordinary heartbeats never set `opened`. A woken stale holder publishes nothing: the heartbeat is
    guarded by `expired`.
  - **By test:** my mutant `opened-always-fresh` (a watcher answers its held hellos on every heartbeat) is caught by
    the two-host probe and "a live remote holder's board is never answered".
  - **Remaining case:** the cross-subject reorder the builder lists as a risk. With one NATS server, the holder's
    PUB of the heartbeat precedes its SUB on the same connection, so the watcher gets the heartbeat before any hello
    the holder can also see. Only a multi-server NATS route could reorder it (not tested).

## (3) `lease().remainingMs` is judged by the Store's clock

- **SQLite:** `expires_at − t`, with `t` read once from the store's `clock()`.
- **Postgres:** `expires_at − n.now`, where `n.now` is `DB_NOW` from the same SELECT.
- **Both:** 0 unless live (read). The contract test "lease: remainingMs…" catches both `*-remaining-fixed` mutants.
- **room-host:** never compares `expiresAt` with its own clock. It only waits `remainingMs + margin`, capped at
  ttl/3 on retries.

## (4) `fail()` sends 1013 only to welcomed connections

- **Code:** `if (!slot.leaseLost || slot.welcomed.has(ck))`. A failure that isn't a lost lease still tells every
  connection, which is right because the room is this host's.
- **SIGSTOP:** the new holder's connections got no close.
- **Mutant:** `high1-fail-tells-all` is caught by the in-process HIGH-1 test.

## (5) Approved test edits

- **gateway.test.js:265-281:** still exact matches, so not loosened. The first beat is
  `toEqual({ seq: 0, epoch: 1, opened: true })`, and a later beat is `toEqual({ seq: 3, epoch: 1 })` (no `opened`).
  `heartbeatMs: 50` only makes the later beat arrive within the test.
- **main.test.js:** round 0 now needs a plain welcome (`connect` + `next(welcome)`). L8 is fixed, and that is
  stricter than before.

## (6) Mutants (28, each in its own scratch copy, each pattern matched exactly once)

Run against room-host-lease, store and pg-store tests with DATABASE_URL; the two `high1-*` also against
room-host-proc (Postgres + NATS). The builder published no script, so its 13 were re-made from its descriptions
(`mutate2.py`, appendix below).

| Group | Mutants | Result |
|---|---|---|
| Mine, round 1, adapted | append-no-epoch (9 fail), cp-no-epoch (3), ignore-null-renew (1), inbox-without-lease (8), release-on-fail (2), deadline-by-now (2), renew-receive-time (1: "L1 (repro G)"), answer-live-holder (4), renew-after-rebuild (1), sqlite-seam (1), no-release-on-close (4), watcher-never-answers (2), pg-seam (1), pg-no-ttl-cap (1), pg-25p03-raw (1) | 15 / 15 caught |
| The builder's 13 | high1-no-guards (2, incl. the real SIGSTOP), high1-fail-tells-all (1, in-process), medium1-whole-ttl (2), l2-no-release-signal (1), medium2-drop-held (1), medium3-no-timeout (6), l3-revive (1), l4-append-not-settled (1), l5-no-release (1), l7-drop-extra (1), sqlite-remaining-fixed (1), pg-remaining-fixed (1); l1-receive-time is my renew-receive-time | 13 / 13 caught |
| Mine, round 2 | opened-always-fresh (2) | caught |

## (7) Gates

| Gate | Result |
|---|---|
| `bun test test/server` ×10 (scratch copy of round 2, my attack files excluded) | 9 runs 228 pass, 0 fail. Run 5: 1 fail, test/server/tune.test.js "R2: a timed pass whose Registry calls fail…" (`rechecks.retries` 3, expected 2: an extra timed re-check pass). It fails the same way at HEAD, without this job: **1 of 100 runs at HEAD, 2 of 100 on round 2** (plus 1 of 20 earlier). A pre-existing gateway timing flake (p2-tune, a90cd6b), not this job's. Worth a ticket for its owner. |
| `bun test`, shared tree | 1399 pass, 151 skip, 3 fail. **None is this job's:** test/core-source (known drift); test/architecture "hexagonal import rules", whose 8 violations are all the untracked `scripts/load/*` and `scripts/cluster-rig.js` (another session's load-test work in progress; nothing under server/ or packages/; room-host's imports are unchanged since round 1); test/deploy cluster rig "`up` SIGKILLed midway…" (untracked test/deploy/, another session's). |
| `bun test`, shared tree, DATABASE_URL + NATS_URL (includes room-host-proc kill -9 and SIGSTOP) | 1525 pass, 30 skip, 3 fail: core-source and architecture (as above), and test/web/p8-tidy.test.js "MEDIUM-1: Retry (offline banner)…" (untracked, another session's web work; it passed in the plain run). room-host-proc, room-host-lease, store and pg-store all pass. |

## New finding

### R2-L1 (LOW): `slot.welcomed` only grows while the room lives

`welcomed.delete` runs only when the slot itself ends a connection with `unavailable`. A close notice (`m.closed`),
the gateway's 5 s listing and the sweep remove a connection from `slot.conns`, but not from `slot.welcomed`.

**Repro** (scratch copy, `peek()` instrumented to report the set's size): 2,000 hellos, then 1,000 close notices and
a listing that drops 500 more. Output: `conns=500 welcomed=2000`. A room lives for a whole all-hands, so every
reconnect adds an entry (~100 B each; ~10 MB per 100k reconnects). Correctness isn't affected: `fail()` iterates
`slot.conns` and only asks the set. **Fix:** delete from `welcomed` wherever a connection leaves `slot.conns`
(the `m.closed` branch, after `room.listed`, the sweep), or keep the flag on the connection entry instead of a set.

## Cleanup (round 2)

- **Servers:** Postgres (PID 93859, then 97278 after the PGDOWN test restarted it) and nats-server (PID 94423),
  stopped by PID after the gates.
- **Scratch:** copies (t2, rep2, mut2, head, t2probe) stay in the session's private scratchpad, because `rm -rf` is
  denied. Nothing in the repo changed except this report.

## Appendix (round 2): mutate2.py

```python
import sys
name, path = sys.argv[1], sys.argv[2]
RH = "server/room-host.js"; SQ = "server/store/sqlite.js"; PG = "server/store/postgres.js"
M = {
 # verifier round 1, adapted to round-2 code
 "append-no-epoch": [(RH, "store.append(tenant, board, entries, expectSeq, slot.epoch)", "store.append(tenant, board, entries, expectSeq)")],
 "cp-no-epoch": [(RH, "store.putCheckpoint(tenant, board, cp, slot.epoch)", "store.putCheckpoint(tenant, board, cp)")],
 "ignore-null-renew": [(RH, 'if (!l) return lost(slot, "lease renew refused: the lease is gone");', "if (!l) return;")],
 "inbox-without-lease": [(RH, "if (l) return start(tenant, board, key, l, sent);", "if (l) return start(tenant, board, key, l, sent);\n      return start(tenant, board, key, { epoch: (await store.lease(tenant, board))?.epoch ?? 1 }, sent);")],
 "release-on-fail": [(RH, "slot.dead = true; slot.unsub(); stopLease(slot);", "slot.dead = true; slot.unsub(); stopLease(slot); Promise.resolve(store.release(slot.tenant, slot.board, me, slot.epoch)).catch(() => {});")],
 "deadline-by-now": [(RH, "const perf = monotonic;", "const perf = now;")],
 "renew-receive-time": [(RH, "if (sent > slot.okAt) { slot.okAt = sent; armDeadline(slot); }", "{ const r = perf(); if (r > slot.okAt) { slot.okAt = r; armDeadline(slot); } }")],
 "answer-live-holder": [(RH, "if (perf() - w.heardAt > silentAfter || w.pending.length >= 1_000) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);", "return reply(m.gateway, m.conn, UNAVAILABLE, 1013);")],
 "renew-after-rebuild": [(RH, "startLease(slot, sentAt);\n    held.set", "held.set"), (RH, "slot.durable = slot.room.status().resolved;", "slot.durable = slot.room.status().resolved; startLease(slot, perf());")],
 "sqlite-seam": [(SQ, "ready(tenant, board); needWriteEpoch(epoch);\n      if (!Number.isSafeInteger(expectSeq)", "ready(tenant, board); needEpoch(epoch);\n      if (!Number.isSafeInteger(expectSeq)"), (SQ, "const fence = (tenant, board, epoch) => {\n", "const fence = (tenant, board, epoch) => {\n    if (epoch === undefined) return;\n")],
 "no-release-on-close": [(RH, "await store.release(slot.tenant, slot.board, me, slot.epoch);\n          // A host", "// A host")],
 "watcher-never-answers": [(RH, "if (perf() - w.heardAt > silentAfter || w.pending.length >= 1_000) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);", "if (w.pending.length >= 1_000) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);"), (RH, "      answerHeld(w);\n      attemptNow(w);\n    }, Math.max(1", "      w.pending.length = 0;\n      attemptNow(w);\n    }, Math.max(1")],
 "pg-seam": [(PG, "const needWriteEpoch = epoch => { if (!posInt(epoch))", "const needWriteEpoch = epoch => { if (epoch !== undefined && !posInt(epoch))"), (PG, "const fence = async (tx, tenant, board, epoch) => {\n", "const fence = async (tx, tenant, board, epoch) => {\n    if (epoch === undefined) return;\n")],
 "pg-no-ttl-cap": [(PG, "const leaseLock = ttlMs => Math.min(leaseLockTimeoutMs, ttlMs === undefined ? leaseLockTimeoutMs : ttlMs / 2);", "const leaseLock = ttlMs => leaseLockTimeoutMs;")],
 "pg-25p03-raw": [(PG, "if (err?.errno === IDLE_CUT) throw", "if (false) throw")],
 # builder's round-2 list, re-made from its descriptions
 "high1-no-guards": [(RH, '    if (slot.leaseLost) return;\n    if (expired(slot)) return lost(slot, "the host deadline passed (a stall?) before an inbox message");\n', ""), (RH, '      if (slot.leaseLost) return;\n      if (expired(slot)) return lost(slot, "the host deadline passed before a reply");\n', "")],
 "high1-fail-tells-all": [(RH, '    if (slot.leaseLost) return;\n    if (expired(slot)) return lost(slot, "the host deadline passed (a stall?) before an inbox message");\n', ""), (RH, "if (!slot.leaseLost || slot.welcomed.has(ck)) reply(", "reply(")],
 "medium1-whole-ttl": [(RH, "arm(w, lease?.live ? lease.remainingMs + margin : 0);", "arm(w, leaseTtlMs + Math.max(25, Math.floor(leaseTtlMs / 20)));"), (RH, "arm(w, Math.min(renewEvery, info?.live ? info.remainingMs + margin : renewEvery));", "arm(w, leaseTtlMs + Math.max(25, Math.floor(leaseTtlMs / 20)));"), (RH, "      answerHeld(w);\n      attemptNow(w);\n    }, Math.max(1", "      answerHeld(w);\n    }, Math.max(1"), (RH, "if (m?.released === true) { answerHeld(w); clearTimeout(w.silence); attemptNow(w); return; }", "if (m?.released === true) { answerHeld(w); return; }")],
 "l2-no-release-signal": [(RH, "bus.publish(subjects.entries(slot.tenant, slot.board), { seq: slot.durable, epoch: slot.epoch, released: true })?.catch?.(() => {});", "")],
 "medium2-drop-held": [(RH, "if (fresh) answerHeld(w); else w.pending.length = 0;", "w.pending.length = 0;")],
 "medium3-no-timeout": [(RH, "Promise.race([p, late]).then(", "p.then(")],
 "l3-revive": [(RH, '      if (slot.dead) return;\n      if (expired(slot)) return lost(slot, "no lease renew succeeded by the host deadline");\n      if (!l)', "      if (slot.dead) return;\n      if (!l)"), (RH, '    if (slot.dead || slot.renewing) return;\n    if (expired(slot)) return lost(slot, "no lease renew succeeded by the host deadline");\n', "    if (slot.dead || slot.renewing) return;\n")],
 "l4-append-not-settled": [(RH, "slot.writes.add(w); w.finally", "w.finally")],
 "l5-no-release": [(RH, "if (!slot.leaseLost) Promise.resolve().then(() => store.release(tenant, board, me, slot.epoch))", "if (false) Promise.resolve().then(() => store.release(tenant, board, me, slot.epoch))")],
 "l7-drop-extra": [(RH, "if (perf() - w.heardAt > silentAfter || w.pending.length >= 1_000) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);\n    w.pending.push", "if (perf() - w.heardAt > silentAfter) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);\n    if (w.pending.length >= 1_000) return;\n    w.pending.push")],
 "sqlite-remaining-fixed": [(SQ, "remainingMs: live ? row.expires_at - t : 0", "remainingMs: live ? 1 : 0")],
 "pg-remaining-fixed": [(PG, "remainingMs: live ? Number(r.expires_at) - Number(r.now) : 0", "remainingMs: live ? 1 : 0")],
 # verifier round 2
 "opened-always-fresh": [(RH, "const fresh = m?.opened === true || (ep !== null && w.epoch !== null && ep > w.epoch);", "const fresh = true;")],
}
if name == "list":
    print(" ".join(M)); sys.exit(0)
for f, a, b in M[name]:
    p = f"{path}/{f}"; s = open(p).read()
    if s.count(a) != 1: sys.exit(f"MUTANT {name}: pattern not found once in {f}: {a[:70]!r} (count {s.count(a)})")
    open(p, "w").write(s.replace(a, b))
print(f"applied {name}")
```
