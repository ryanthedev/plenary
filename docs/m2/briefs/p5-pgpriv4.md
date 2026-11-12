# Brief: p5-pgpriv4 (fix round 4: never send a call past its queue deadline)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187;
never prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; record Podman ids you start
and remove only those. Never print .env values. If a full run fails, name the failing tests
(`bun test 2>&1 | grep -E '\(fail\)'`). Append "Round 4" to docs/m2/reports/p5-pgpriv2.md. Do not commit.

## Why

Verifier docs/m2/reports/p5-pgpriv3v.md: FAIL on M1 only. Read M1 (with `exp/b3.js` described there) and L1-L6.
The bar clause "a call whose deadline passed before it got a connection is never sent" fails when the event loop
stalls: `send()` (server/registry/postgres.js ~:385) is reached from `pump()` in a microtask before the overdue queue
timer (a macrotask) fires, so the call is sent late and commits.

## Do

1. **M1:** keep each queued entry's absolute deadline (`performance.now() + queueMs`). Where an entry is taken off
   the queue to be sent, reject it with `queue-timeout` instead (clear its timer, no slot taken) if its deadline has
   passed, and move on to the next entry. No slot may leak on this path.
2. **Test:** a real-Postgres test (skipped without DATABASE_URL, like the rest of pg-registry.test.js) along the
   lines of the verifier's `b3.js`: one connection, a lock released by the server side (e.g. `pg_sleep` in a separate
   session), the loop blocked with `Bun.sleepSync` past B's deadline; assert B rejects `queue-timeout` and its row is
   absent. Confirm the test fails with your fix removed.
3. **L2 (doc):** in the header and deploy/README.md "Registry time limits", say why 3-5 s matters: it keeps
   `queueTimeoutMs` (0.65-1.05 s) below the gateway's 2 s `recheckLookupMs`, so a call the gateway gave up on is not
   sent; with the 15 s defaults it is 3050 ms.
4. **L1 (optional, only with a measurement):** if you raise the default `maxQueued`, show the bound still holds and
   say why. Otherwise just note in the README that bursts above `maxInFlight + maxQueued` get `overloaded`.
5. **Engine's README request** (t18m, p4-store-lease 00cf69c), deploy/README.md "Postgres roles" section, before
   `### Registry time limits`:
   - **Upgrade paragraph:** copy the text at docs/m2/reports/p4-store-lease.md:52-55 (pre-lease `pl_leases`:
     nodes refuse with `needs-migration`; run the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS holder ..., expires_at
     ...` once as the owner; idempotent, keeps every board's epoch). Check the column types against
     server/store/postgres.js.
   - **Store grant probe:** the Store probes its grants at start-up and refuses with code `denied`, naming what is
     missing; it needs SELECT/INSERT on pl_entries, SELECT/INSERT/DELETE on checkpoints, SELECT/INSERT/UPDATE on
     pl_leases (the fence's FOR SHARE needs UPDATE). Step 3's grants cover it. Replace the now-stale sentence "The
     Store's message is Postgres's own `permission denied …`". Confirm each claim in server/store/postgres.js.
     "They never ALTER, DROP or GRANT anything" must stay true.
   Touch only the Postgres section; the endpoints hunk near line 20 belongs to another job.

## Done when

Round 4 appended (what changed, test names, the fail-without-fix check, gates with and without DATABASE_URL; known
unrelated failures: test/core-source.test.js, tune.test.js R2 tests, web/collab wire2 LOW tests). Then stop.
