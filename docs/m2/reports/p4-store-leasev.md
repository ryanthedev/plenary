# Report: p4-store-leasev (verify p4-store-lease: lease + epoch fence in the Store)

**Verdict: FAIL (one HIGH: H1, a test gap; the code itself held under every attack).** The lease and fence behave
correctly on both adapters in every attack I ran. But the brief's step 4 gate is missed: on Postgres, "judge expiry
on the host clock" survives the suite, and so does moving the fence out of the write transaction (Goal 2's core
property). The fix round is small: add the three tests below (H1) and bound the lock waits (M1).

Tested: the six job files at these sha1s (unchanged in the shared tree at my gate runs; see the note below):
`server/store/sqlite.js 0f2e7b95`, `server/store/postgres.js 21271904`, `packages/protocol/ports.js cc41f76c`,
`test/server/store-contract.js e8b36efa`, `test/server/store.test.js a70cffba`, `test/server/pg-store.test.js a1d72c11`.
Attacks ran in a scratch copy against brew postgresql@17 (17.11) on free ports (PIDs 66180, then 43428), each
stopped after use; scratch data deleted. The killing tests are reproduced in full at the end of this report.

**Note (2026-11-12, after my last run):** server/store/postgres.js changed in the shared tree (now sha1 `0f37f116`,
+168/−19): a fix round for M1 and L3 is under way. **Nothing in this report covers that version.** Its verifier
should re-run the H1 tests in the appendix and the M1 repro against it.

## Findings

| # | Sev | Where | Finding |
|---|---|---|---|
| H1 | HIGH | test/server/pg-store.test.js, store-contract.js | Postgres tests miss four mutants, including the core fence-atomicity property and the brief's "host clock" mutation |
| M1 | MEDIUM | server/store/postgres.js:121, 126-131, 253-268 | A takeover can wait forever behind a stale holder's open write transaction |
| L1 | LOW | server/store/sqlite.js:40-60 | Two processes opening one SQLite file at once: all but one fail to start |
| L2 | LOW | sqlite.js:66-69, postgres.js:255-259 | `acquire` by the current holder bumps the epoch (brief: "a new holder bumps") |
| L3 | LOW | postgres.js:126-131 | Missing UPDATE on `pl_leases` surfaces as a raw 42501 at the first fenced write, not at start-up |
| L4 | LOW | builder's spec proposal | The proposal leaves out codes and the ttl cap, and contradicts one PROTOCOL.md sentence |
| L5 | LOW | sqlite.js:89, postgres.js:127 (SEAM) | Without an epoch, append and checkpoint are unfenced; today's room-host passes none |

### M1 (MEDIUM): a takeover can wait forever behind a stale holder's open write transaction

- **What:** a fenced append or checkpoint holds `FOR SHARE` on the lease row until it commits. `acquire`, `renew` and
  `release` set no `lock_timeout`, and no write transaction sets `idle_in_transaction_session_timeout`.
- **Failure:** a holder pauses mid-append, between its fence `SELECT` and `COMMIT` (a GC pause, SIGSTOP, or a network
  partition from Postgres). The server keeps its lock until the TCP connection dies, which can take hours with
  default keepalives. Meanwhile every other host's `acquire` blocks.
- **Measured:** later fenced appends at the old epoch do **not** block (share locks don't conflict, and they jump
  the waiting takeover). They resolve, so a live old holder keeps writing while the new host is stuck.
- **Impact:** safety holds. Liveness breaks the "editors notice seconds, not minutes" goal when the old holder is
  wedged: the board is unavailable and p4-host's build hangs inside `acquire`, with no error to act on.
- **Why MEDIUM, not HIGH:** it needs a holder to stall inside a millisecond-long transaction. Under load that is the
  partition case the lease exists for, so it is not rare.
- **Repro (ran it):**
  1. `acquire(h-a, ttl 200)`.
  2. On another connection: `BEGIN; SELECT … FROM pl_leases … FOR SHARE` (stands in for a paused append).
  3. Sleep 300 ms. `lease().live` is now false.
  4. `acquire(h-b)` is still pending after 3 s, and resolves only when the stale transaction ends.
- **Codex agrees** (its MEDIUM "Bound waits on Postgres lease-row locks").
- **Fix, in the adapter (proposed, not run):**
  - Every write transaction runs `SET LOCAL idle_in_transaction_session_timeout = <a few s>`, so a paused holder's
    transaction is killed server-side and releases its lock.
  - Lease calls run `SET LOCAL lock_timeout = <well under ttl>`, and a timeout maps to a PortError (e.g.
    `"unavailable"`) the caller can retry.
  - Add a test: the repro above, expecting `acquire` to settle within the bound.

### H1 (HIGH): Postgres tests miss four mutants, including the core fence property

- **Why HIGH:** brief step 4 says each listed mutation "must be caught by a test", and on Postgres the host-clock one
  isn't. The fence-outside-transaction survivors leave Goal 2's central guarantee unguarded: a refactor could
  reopen the window and every test would stay green. The code is correct today. Only the tests need work.
- **What survives:** the builder's tests catch every brief mutation on SQLite (table below). On Postgres these four
  survive the full suite (`store.test.js` + `pg-store.test.js`, 54/54 pass with DATABASE_URL set):

| Mutant (postgres.js) | Why it matters |
|---|---|
| The fence runs on `db` (its own autocommit statement) instead of `tx`, in `append` | The brief's central requirement: "no window between the fence check and the CAS". A takeover can then commit between the check and the insert, and the stale entry lands after it. |
| The same, in `putCheckpoint` | Same window for checkpoints (codex's LOW "checkpoint fence race untested") |
| `DB_NOW` replaced by the host's `Date.now()` | Brief step 4 asks for "judge expiry on the host clock" to be caught. The builder's clock test brackets `expiresAt` with DB time on the same machine, where the two clocks agree. |
| `clock_timestamp()` replaced by `now()` | The builder listed this as not verified. Surviving it means nothing checks the claim. |

- **Why they survive:** the existing race test parks the takeover, not the write. With the fence outside the
  transaction, the `FOR SHARE` still waits and then reads the new epoch, so the test still passes.
- **Tests that kill them** (I ran each against the real code, where it passes, and against each mutant, where it
  fails). Proposed for test/server/pg-store.test.js:
  1. **Window (append and checkpoint):**
     - Park the write after its fence: on a second connection, `BEGIN` and insert an uncommitted row at the key it
       will write (`pl_entries` seq at+1, or `pl_checkpoints` seq 9).
     - Start the fenced write. It blocks on that key.
     - From a third connection, run the takeover `UPDATE pl_leases SET epoch = epoch + 1 …` (autocommit).
     - Assert, while the write is still parked: the takeover has not settled.
     - `ROLLBACK` the parker. Assert the write resolves and then the epoch is +1.
     - Real code: the takeover waits behind the write's `FOR SHARE`. Mutant: the takeover commits at once.
     - Ran 5× on the real code (pass) and once per mutant (fail).
  2. **Host clock:**
     - Patch `Date.now` to +1 h, then `acquire(ttl 5000)`. Assert `expiresAt` lies within
       [DB t0 + 5000, DB t1 + 5000].
     - Patch `Date.now` to −1 h. Assert `lease().live` is true and another holder's `acquire` returns null.
  3. **`now()` after a lock wait:**
     - Let a 1 ms lease lapse.
     - On another connection, hold the row `FOR UPDATE`. Start `acquire(h-b, 5000)` and let it wait 800 ms.
     - Read DB time `tr`, then commit the blocker.
     - Assert `expiresAt ≥ tr + 5000`.
     - Use `acquire`, not `renew`: see the note under L4.
     - Tests 2 and 3 ran 5× on the real code (pass) and once per mutant (fail).

### L1 (LOW): two processes opening one SQLite file at once

- **Repro (ran it):** 8 OS processes open one file at the same instant.
- **Pre-lease file** (epoch-only `leases`): 7 of 8 fail to open with `duplicate column name: holder` or
  `expires_at`. The `table_info` check and the `ALTER` are not in one transaction. This is the job's new code.
- **New file:** 5 of 6 fail with `SQLITE_BUSY: database is locked` at `PRAGMA journal_mode=WAL`. That line predates
  this job. server/registry/sqlite.js already fixed the same thing (p5-pgpriv: check `journal_mode` first, retry
  BUSY up to `busy_timeout`). The store didn't get the fix.
- **Impact:** a single node owns its file, so this only bites a concurrent restart or a second process. Codex rated
  the ALTER race MEDIUM; I rate it LOW for that reason.
- **Fix:**
  - Do the column check and the ALTERs inside `BEGIN IMMEDIATE`, re-reading `table_info` inside it.
  - Port the registry's WAL retry.

### L2 (LOW): `acquire` by the current holder bumps the epoch

- **Deviation:** Goal 1 says "a new holder bumps the epoch". The code bumps on every successful `acquire`, including
  a live one by the same holder. The builder documents this and tests it.
- **Safety:** I judge it safe and arguably safer, because a rebuild is a new incarnation.
- **Consequence:** a process that uses `acquire` to renew fences its own room. Two processes sharing a holder id take
  the board from each other in turn. p4-host must use a per-boot holder id and `renew` (the builder's hand-off
  items 1 and 5 say so).

### L3 (LOW): a missing UPDATE grant surfaces late, as a raw error

- **What happens:** a role with SELECT and INSERT but no UPDATE on `pl_leases` starts the store. Then every fenced
  `append` or `putCheckpoint` throws a raw `PostgresError` 42501, not a PortError, because `FOR SHARE` needs UPDATE.
  An unfenced append still succeeds.
- **Why only LOW:** deploy/README.md:133 grants UPDATE, so a role set up as documented is fine. Only a misgrant hits
  this.
- **Fix:** probe the privilege at start-up (`has_table_privilege(…, 'UPDATE')`) and refuse with the existing `denied`
  code.

### L4 (LOW): spec proposal vs code

- **Missing from the proposal:**
  - **Error codes:** `bad-clock` (SQLite), `needs-migration`, `lock-timeout` and `denied` (Postgres start-up).
  - **ttl cap:** ttl must be a positive integer up to 10 min, else `bad-entry` (`MAX_TTL`).
  - **Required epoch:** `renew` and `release` with no epoch throw `bad-entry`.
- **Contradicts PROTOCOL.md:** "Where it lives" still says "Single node has the same record (its one host holds every
  lease)", but `openEpoch` now clears the holder. The proposal edits "(phase 4)" in that paragraph but not this
  sentence.
- **The clock comment is not quite right:** postgres.js:13-14 and the proposal say `clock_timestamp()` avoids
  staleness after a lock wait. For `renew`, a plain UPDATE, Postgres evaluates `SET expires_at = clock_timestamp() …`
  before waiting on the row lock: I measured `expiresAt − ttl` 800 ms before the DB time at commit.
  - **Why it's safe:** the stamp is still after the host sent the renew, so the lease ends no later than the
    holder's own deadline (send + ttl).
  - **Where it does hold:** `acquire` evaluates after the lock (`ON CONFLICT DO UPDATE`), so the claim is true there.
  - **Fix:** reword the comment and spec to "stamped when the statement runs; a renew stuck behind a lock may get a
    shorter lease".

### L5 (LOW): the SEAM path leaves the fence unused today

- **What:** `append` and `putCheckpoint` without an epoch skip the fence entirely; my attack confirms an unfenced
  append lands after a takeover. server/room-host.js:92 and :98 pass no epoch, so in today's tree the fence protects
  nothing.
- **Why not HIGH:** codex rated it HIGH. I refute that for this job: the brief sanctioned it ("epoch optional for now,
  with a SEAM(p4) note"), and it is no regression against HEAD.
- **Carry-over to p4-host (not optional):** make the epoch required, delete the SEAM branch in both `fence`s, and
  update `MemoryLog`.

## CHECKER (distributed-systems-design skill, CHECKER mode) against the NFRs

| Check | Verdict | Evidence |
|---|---|---|
| Can two hosts both believe they hold a board? | **At the Store, no.** One `acquire` wins per race. A host can still *believe* it holds an expired lease nobody took, and it may keep writing at its epoch (by design: "the fence is the epoch, not expiry"). Once anyone acquires, its next write is `fenced`. | 20 Postgres pools × 15 rounds and 8 SQLite OS processes: exactly one winner every time, epochs strictly increase. Churn, 6 holders × 40 rounds, both adapters plus 6 OS processes on SQLite: no gap, no duplicate, epochs never decrease along seq, one writer per epoch, every resolved append present. |
| Can a stale holder land an entry or checkpoint after a takeover? | **No**, with the epoch passed. Postgres: `FOR SHARE` in the write's transaction orders it against the takeover's row update. SQLite: `BEGIN IMMEDIATE` serialises. **The guard is untested on Postgres (H1).** | Window test above; the builder's uncommitted-takeover test. |
| Is expiry judged only on the DB's clock? | **Yes.** Postgres uses `clock_timestamp()`; SQLite uses the injected `now`. No path compares a host's clock. `renew` stamps before a lock wait (L4), which is safe. | Host clock ±1 h test passes; `now()` and host-clock mutants are killed only by my new tests (H1). |
| Is `openEpoch` overriding leases safe? | **Single node: yes.** It bumps the epoch and clears the holder, so any fenced writer is cut off. **Cluster: safe but disruptive**, as the builder says. Nothing in cluster mode may call it once p4-host switches to `acquire`. Today room-host calls it in both modes, unfenced, as before the job. | Contract case "openEpoch and the lease share one record". |
| An acknowledged op is never lost | Holds on one database. **Not covered:** Postgres failover to an asynchronous standby can lose acked entries *and roll the epoch back*, so two incarnations could share an epoch. Cluster deploys need a synchronous standby (`synchronous_standby_names`) or must accept that, per § Known limits. Deploy and doc concern, not this job's code. | `synchronous_commit = on` flushes locally only. |
| CAP choice | CP: no Store, no sequencer. Correct for "one sequencer per board". | — |
| Takeover in seconds | Holds when the old holder is dead or idle; **fails when a stale holder pauses mid-write (M1).** | M1 repro. |

## Spec conformance (brief Goal 1-4 vs the code)

| Goal | Verdict |
|---|---|
| 1. acquire / renew / release / DB clock / openEpoch decision | Met. One deviation: L2. `openEpoch` is kept for single node, and the decision is documented. |
| 2. Fence on append and checkpoint, atomic, distinct `fenced`, optional epoch with SEAM | Met in code. Atomicity untested on Postgres (H1). `fenced` wins over `conflict` (tested). |
| 3. storeContract on both adapters, plus the lease cases | Met. It runs on sqlite (F12). The race cases use two holders; I added 20-way and multi-process races. |
| 4. Typedefs | Met. `read`'s `maxBytes` and `.bytes`, `lastSeq`, the lease methods, `close`. `MemoryLog` is unchanged (p4-host's). |

## Mutation checks (scratch copy; store.test.js + pg-store.test.js with DATABASE_URL)

| Mutant | Caught by the builder's tests? |
|---|---|
| SQLite: drop the fence in append; drop it in putCheckpoint; no epoch bump; host clock (`Date.now` for `now`); renew ignores epoch; renew ignores holder; acquire ignores expiry; acquire always wins; openEpoch keeps the holder; release ignores epoch; fence after the conflict check | **Yes, all** |
| SQLite: deferred instead of `BEGIN IMMEDIATE` | No. In WAL mode a stale snapshot then fails with BUSY instead of landing, so it is not a safety mutant. LOW test gap, not listed above. |
| Postgres: drop the fence in append; drop it in putCheckpoint; no epoch bump; renew ignores epoch; plain SELECT instead of `FOR SHARE`; openEpoch keeps the holder; acquire ignores expiry | **Yes, all** |
| Postgres: fence outside the transaction (append, checkpoint); host clock; `now()` | **No (H1).** Killed by my proposed tests. |

## Repeat, architecture, shared tree

- **`bun test test/server` 10× in the copy, with DATABASE_URL:** 277 pass, 26 skip, 0 fail every run. The 300 ms
  ttl cases did not flake.
- **test/architecture.test.js:** green. The adapters import only `bun`/`bun:sqlite`, `../ids.js` and
  `../pg/schema.js` (Postgres).
- **`bun test` in the shared tree:**
  - **Without Postgres:** 1129 pass, 118 skip, 4 fail.
  - **With DATABASE_URL:** 1216 pass, 34 skip, 4 fail.
  - **The 4 failures** are the same in both runs, and none is this job's:
    - test/core-source.test.js: the known herdr-draw drift.
    - Three in test/server/tune.test.js: p2-tune's, untracked. They pass in my snapshot. The only differing file
      is server/gateway.js, which another session edited after my snapshot. The job's files are byte-identical to
      what I tested.

## sdd ensemble

- **Harnesses that passed check_adapter:** codex (`effort: high`) and grok.
- **Failed check_adapter:** agy (quota, resets in ~54 h), kimi (not logged in), mistral (no API key), qwen (not
  installed).
- **No finding had two harnesses agreeing,** so there were no HIGH candidates by that rule. Grok found nothing.
- **Codex's findings, checked one by one:**

| Codex finding | My verdict |
|---|---|
| HIGH: room path bypasses the fence (SEAM) | **Refuted as HIGH** for this job (brief-sanctioned). Kept as L5 and a p4-host must. |
| MEDIUM: SQLite legacy ALTER race | **Confirmed** by repro; rated LOW (L1). |
| MEDIUM: unbounded Postgres lock waits | **Confirmed** by repro (M1). |
| LOW: checkpoint fence race untested | **Confirmed**, and worse than stated: the append's is untested too (H1). |

## Not verified

- A real process pause or network partition against Postgres; I simulated it with an open transaction.
- Postgres failover, and the epoch rollback on an async standby; this is reasoning only.
- Load cost of `FOR SHARE`.
- The PG15+ runtime role with no table grants at all.
- **Covered only by the builder's tests** (passing in my runs, but no independent attack or mutant of mine):
  - the `needs-migration` refusal and `LEASE_UPGRADE_SQL` on a pre-lease table;
  - the start-up `lock_timeout`;
  - the wrapped 42501 at start-up.
- **Reasoning, not a run:** calling deferred `BEGIN` "not a safety mutant" on SQLite.
- **The M1 fix:** proposed only, not run.

## What p4-host and the builder should do

1. **Builder (fix round, small; H1 and M1 are required):**
   - **M1:** `idle_in_transaction_session_timeout` on write transactions, `lock_timeout` on lease calls, plus a test.
   - **H1:** add the three tests above.
   - **L1:** transactional ALTER and the WAL retry.
   - **L3 and L4:** optional.
2. **p4-host:** make the epoch required (L5), use a per-boot holder id and `renew` (L2), and never call `openEpoch`
   in cluster mode.
3. **platform:** cluster deploy docs should say a synchronous standby is required, or accept epoch rollback on
   failover.

## Appendix: the tests that kill the H1 mutants (verifier scratch; ran against the real code and each mutant)

```js
// Kills "fence outside the write transaction": a takeover must never commit between the fence check and the write.
import { test, expect, describe, afterAll } from "bun:test";
import { SQL } from "bun";
import { postgresStore } from "../../server/store/postgres.js";
import { entry, code } from "../server/store-contract.js";

const url = process.env.DATABASE_URL;
const T = "t-aaa", B = "b-one";
let n = 0;
const schemaName = () => `atkw_${process.pid}_${Date.now()}_${n++}`;

describe.skipIf(!url)("pg fence window", () => {
  const admin = new SQL(url);
  afterAll(() => admin.close());

  for (const what of ["append", "checkpoint"]) test(`${what}: a takeover that commits while the write is past its fence check never precedes it`, async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const parker = await admin.reserve(), taker = await admin.reserve();
    try {
      const { epoch } = await store.acquire(T, B, "h-a", 60_000);
      await store.append(T, B, [entry(1)], 0, epoch);
      // Park the write after its fence: an uncommitted row at the key it is about to insert.
      await parker.unsafe("BEGIN");
      if (what === "append") await parker.unsafe(`INSERT INTO "${schema}".pl_entries VALUES ($1, $2, 2, '{}')`, [T, B]);
      else await parker.unsafe(`INSERT INTO "${schema}".pl_checkpoints VALUES ($1, $2, 9, '{}')`, [T, B]);
      let wrote = null;
      const w = (what === "append" ? code(store.append(T, B, [entry(2)], 1, epoch)) : code(store.putCheckpoint(T, B, { seq: 9, by: "a" }, epoch)))
        .then(r => { wrote = r; return r; });
      await Bun.sleep(200);
      // The takeover, from a third session.
      let took = false;
      const take = taker.unsafe(`UPDATE "${schema}".pl_leases SET epoch = epoch + 1, holder = 'h-b' WHERE tenant = $1 AND board = $2`, [T, B])
        .then(() => { took = true; });
      await Bun.sleep(200);
      // The write is past its fence and parked: the takeover must wait for it (FOR SHARE held in the write's transaction).
      expect(took).toBe(false);
      expect(wrote).toBe(null);
      await parker.unsafe("ROLLBACK");
      expect(await w).toBe("resolved");                         // it was fenced in before the takeover: it lands
      await take;
      expect(await store.epoch(T, B)).toBe(epoch + 1);
    } finally { parker.release(); taker.release(); await store.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); }
  });
});
```

```js
// Tests that kill pg-hostclock and pg-now-not-clock (verifier's proposals).
import { test, expect, describe, afterAll } from "bun:test";
import { SQL } from "bun";
import { postgresStore } from "../../server/store/postgres.js";

const url = process.env.DATABASE_URL;
const T = "t-aaa", B = "b-one";
let n = 0;
const schemaName = () => `atkc_${process.pid}_${Date.now()}_${n++}`;
const DBMS = "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t";

describe.skipIf(!url)("pg lease clock", () => {
  const admin = new SQL(url);
  afterAll(() => admin.close());

  test("a host clock an hour off changes nothing: expiresAt and liveness follow the database", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema });
    const real = Date.now;
    try {
      Date.now = () => real() + 3_600_000;                  // this host is an hour ahead
      const t0 = Number((await admin.unsafe(DBMS))[0].t);
      const a = await store.acquire(T, B, "h-a", 5_000);
      const t1 = Number((await admin.unsafe(DBMS))[0].t);
      expect(a.expiresAt).toBeGreaterThanOrEqual(t0 + 5_000);
      expect(a.expiresAt).toBeLessThanOrEqual(t1 + 5_000);
      Date.now = () => real() - 3_600_000;                  // now an hour behind: a live lease must stay live
      expect((await store.lease(T, B)).live).toBe(true);
      expect(await store.acquire(T, B, "h-b", 5_000)).toBe(null);
    } finally { Date.now = real; await store.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); }
  });

  test("expiry is taken after a lock wait (clock_timestamp, not the transaction's now())", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const blocker = await admin.reserve();
    try {
      await store.acquire(T, B, "h-a", 1);
      await Bun.sleep(5);
      await blocker.unsafe("BEGIN");
      await blocker.unsafe(`SELECT 1 FROM "${schema}".pl_leases WHERE tenant=$1 AND board=$2 FOR UPDATE`, [T, B]);
      const p = store.acquire(T, B, "h-b", 5_000);
      await Bun.sleep(800);
      const tr = Number((await blocker.unsafe(DBMS))[0].t);
      await blocker.unsafe("COMMIT");
      const r = await p;
      expect(r.expiresAt).toBeGreaterThanOrEqual(tr + 5_000);   // judged after the wait, not at its start
    } finally { blocker.release(); await store.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); }
  });
});
```

## Round 2

**Verdict (round 2): PASS.** H1, M1 and L3 are fixed, and each fix is caught by a test. I accept the L2 decision.
The corrected spec proposal matches the code. Two new LOWs (R2-L1, R2-L2) don't block.

Tested these sha1s (unchanged in the shared tree at my last run):
`server/store/postgres.js 0f37f116`, `packages/protocol/ports.js 0287c206`, `test/server/pg-store.test.js b79b0e9d`.
The other three job files are unchanged since round 1. Ran against brew postgresql@17 on a free port (PID 86284),
stopped after; scratch data deleted.

### Per finding

| # | Round-2 verdict | Evidence |
|---|---|---|
| H1 | **Fixed.** | All 4 mutants killed by the new tests in pg-store.test.js: fence on `db` in append (2 tests fail), fence on `db` in putCheckpoint (1), host `Date.now()` for `DB_NOW` (2), `now()` for `clock_timestamp()` (1). The window test uses the deterministic form: the takeover must still be pending while the write is parked. |
| M1 | **Fixed.** | My round-1 repro: an `acquire` behind a never-committing `FOR SHARE` now ends `unavailable` in 2.0 s, a renew does the same, and `acquire` succeeds once the lock goes. My new attack: a real fenced append paused for 3 s right after its `FOR SHARE` (`txIdleTimeoutMs` 500), with the lease lapsing meanwhile. The server cut the paused writer off, the takeover got epoch+1 about 100 ms later, the paused write never landed, and that handle's pool then served a `fenced` append and a `lastSeq` fine. A slow-but-legit write (600 ms pause under a 1 s budget) is not cut off. `settings()` reports the idle timeout. Every write path goes through `write()`, so every write transaction sets it. Mutants killed: no idle timeout, idle timeout of 10 min, no `lock_timeout`, timeout not mapped to `unavailable`. |
| L3 | **Fixed.** | A role with every grant except UPDATE on `pl_leases` is refused at start-up with `denied`, and the message names "UPDATE on pl_leases". After the grant, it starts and acquires. Mutants killed: probe removed; UPDATE dropped from the probe list. |
| L2 | **Accepted.** | See below. |
| L1, L5 | Report-only, per the round-2 brief. | Carried in the builder's report. They stay p4-host's and the store's next owner's. |
| L4 | **Proposal matches the code.** | See below. |

### L2: the builder's decision holds

PROTOCOL.md § Recovery, Room identity:
- **What it requires:** the epoch "rises by at least 1 every time a room is built", "a rebuild after a failed
  append" included, "one room incarnation has one epoch", and taking the lease is "the same step" as the increment.
- **Why a non-bumping re-acquire breaks it:** a same-host rebuild would keep its old epoch. Two incarnations would
  then share an epoch, and the old room's in-flight write would pass the fence.
- **Why the workaround is worse:** `release` then `acquire` opens a window where another host takes the board, and it
  relies on every caller getting the order right.
- **The cost:** using `acquire` to renew fences your own room. That is documented, and `renew` exists for it.
- **Verdict:** the brief's "a new holder bumps" is satisfied, and the behaviour goes beyond it. Closed.

### L4: corrected spec proposal vs the code, both ways

Each item below is checked in the code:
- **Arguments:** ttl is a positive integer of at most 600,000; an epoch, where given, is a positive integer;
  `renew` and `release` require it. A bad holder or ids throws `bad-id`, anything else `bad-entry`.
- **`acquire`** stamps its expiry after taking the row lock. **`renew`** may stamp before its lock wait.
- **Lease calls** wait at most `min(2 s, ttl/2)`, then throw `unavailable`. `release` uses 2 s.
- **Write transactions** have the idle cut-off.
- **Start-up codes:** `needs-migration`, `lock-timeout`, `denied` (probed at open), and SQLite's `bad-clock`.
- **`openEpoch`** leaves the board unheld, so the "Where it lives" rewrite is now true.

Nothing in the code is missing from the proposal, except R2-L2.

### New LOW findings

- **R2-L1 (LOW, test gap): the `ttl/2` cap on the lease lock wait is untested.**
  - **Mutant:** replace `Math.min(leaseLockTimeoutMs, ttl/2)` with `leaseLockTimeoutMs`. It survives
    `store.test.js` + `pg-store.test.js` (61/61).
  - **Why it matters a little:** the spec promises the cap. Without it, a short-ttl lease call could wait past its
    own ttl.
  - **Fix:** a test with `leaseLockTimeoutMs: 5_000` and a 400 ms ttl, behind a held row lock, asserting it settles
    `unavailable` in under ~400 ms.
- **R2-L2 (LOW, spec/handling): a writer cut off by the idle timeout gets a raw Postgres error, not a PortError.**
  - **What it sees:** `ERR_POSTGRES_SERVER_ERROR`, the session ended by the server.
  - **Why it's safe:** room-host treats any non-PortError append failure as "failure" and rebuilds, and the rebuild's
    `acquire` returns null while the new holder lives.
  - **Fix:** the proposal should name it ("a write cut off by the server fails like any Store failure"), or the
    adapter could map it to `unavailable`. Either way, p4-host should not treat it as `fenced`.

### Runs

- **Mutation checks:** 15 mutants, 14 killed. All 4 of H1, all 4 of M1's that I defined (no idle timeout, a huge
  one, no `lock_timeout`, no mapping), both of L3's, and 4 round-1 regressions (no fence, no bump, no `FOR SHARE`,
  renew ignores epoch). Only R2-L1 survives.
- **Baseline:** `store.test.js` + `pg-store.test.js` with DATABASE_URL: 61 pass.
- **`bun test test/server` ×10 with DATABASE_URL, tune.test.js excluded** (t1fw is mid-edit there): 287 pass,
  26 skip, 0 fail in every run.
- **`bun test` in the shared tree with DATABASE_URL:** 1261 pass, 34 skip, 2 fail. Neither failure is this job's:
  - test/core-source.test.js: the known herdr-draw drift.
  - tune.test.js "here: bounded with many viewers…": p2-tune's, mid-edit.
- **test/architecture.test.js:** green, as part of that run.

### Not verified (round 2)

- A real network partition or a real SIGSTOP; I simulated the pause with a proxy that sleeps after the fence's
  `FOR SHARE`.
- The idle cut-off under a real event-loop stall in room-host. Room-host doesn't use the lease yet (p4-host).
