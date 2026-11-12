# Brief: p5-pgpriv3 (fix round: bound Registry calls on the client side)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187;
never prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; record Podman ids you start
and remove only those. Never print .env values. If a full run fails, name the failing tests
(`bun test 2>&1 | grep -E '\(fail\)'`). Append "Round 3" to docs/m2/reports/p5-pgpriv2.md.

## Why

Verifier docs/m2/reports/p5-pgpriv2v.md: FAIL on H1. Read H1, M1, L1-L5 and its systems-design section. Bun's pool
queues calls client-side, so with prepared statements (the normal running state) the k-th call queued behind a lock
rejects at about k x the limit, and one locked table stalls every Registry read on the node (M1).

## Do

1. **H1 + M1:** in the adapter's wrapper (server/registry/postgres.js ~346), give every call a client-side deadline
   (about max(lockMs, stmtMs) + margin) that rejects with a coded error (`queue-timeout`), and a bounded in-flight gate
   (about pool size x k, configurable) that rejects at once with a coded error (`overloaded`) when full. A call whose
   deadline passed before it got a connection must not be sent. No retries inside the adapter; stay fail-closed.
2. **Test (verifier's recipe):** run `grant()` before taking the lock (warm/prepared), fire more calls than the pool
   has connections, assert every call settles under about 1.5 x the limit; plus a test that an unrelated read
   (`board()`) on a saturated pool is shed or bounded, not stuck. Each confirmed failing with the fix removed.
3. **L3:** a test that fails if the SQLite `busy_timeout` restore after start-up is removed.
4. **L1 (optional, cheap):** bound reads on a caller-owned `sql` the same way, or document why not in the header.
5. **Header + deploy/README.md:** correct the "Not covered: time queued in Bun's pool" text; document the new codes;
   recommend a cluster `statementTimeoutMs` of 3-5 s (above the gateway's 2 s `recheckLookupMs`). Update the
   registry-port.js wording in your report (:135-142) to name the client-side bound too.
6. **Design check:** `distributed-systems-design` APPLIER, short, on the gate size at 830 hellos/s cluster-wide.

## Files you own

server/registry/postgres.js, server/registry/sqlite.js, test/server/pg-registry.test.js,
test/server/sqlite-registry-open.test.js, test/server/registry.test.js, deploy/README.md (Postgres section only),
docs/m2/reports/p5-pgpriv2.md.

## Done when

The above, real Postgres runs (Podman), full `bun test` with and without DATABASE_URL, Round 3 written. Then stop.
Do not commit. If your context passes 60%, write what you have and stop.
