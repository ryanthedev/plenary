# Report: p3-registry (durable SQLite Registry)

**Done.** `sqliteRegistry({ path })` implements every Registry method with the in-memory adapter's semantics,
passes platform's shared contract (test/auth/registry-contract.js, present in the tree), survives close/reopen, and
keeps the last owner atomically across two processes. Not committed, not wired into main.js (snippet below).

`bun test` (full, re-run at the end): **206 pass, 0 fail**. (An earlier run had 4 failures in
test/server/gateway.test.js while the p3-scaffold fix builder was mid-edit; they are gone now.)

## Files (all new)

| File | What |
|---|---|
| server/registry/sqlite.js | `sqliteRegistry({ path, now?, fullfsync?, busyTimeoutMs? })` (alias `createSqliteRegistry`), plus `close()` and `pragmas()` |
| test/server/registry.test.js | contract + differential + durability + two-handle + two-process tests |

## How it works

- **Same style as server/store/sqlite.js:** `bun:sqlite`, WAL, `synchronous=FULL`, `fullfsync` on by default,
  `busy_timeout` 5 s. Tables prefixed `reg_` so it can share a file with the Store, though I recommend its own file.
- **Every write is `BEGIN IMMEDIATE`:** the write lock is taken before any read the write depends on.
- **Last owner:** `setGrant` reads the current grant and the owner count and writes in one IMMEDIATE transaction;
  a refusal throws `{ code: "last-owner" }` (class `SqlRegistryError`, `name` "RegistryError") and writes nothing.
- **Ids:** minted with `mint` from server/auth/registry.js (same formats), retried on collision.
- **Lookups never throw on bad input** (PROTOCOL.md § Auth: throw = `unavailable`): a non-string or unknown id
  gives null / [] / false. Only infrastructure errors and a closed registry throw.
- **Postgres-ready SQL:** no rowid ordering, no `INSERT OR IGNORE`, no `WITHOUT ROWID`, no column named `user`
  (it's `member`); insertion order is an explicit `n` column; upserts are `ON CONFLICT`.

## Tests added (test/server/registry.test.js: 23 = platform's 18 contract tests + 5 of mine)

- **Platform's contract** (`registryContract("sqlite", …)`), on a fresh temp file per test, closed after each.
- **Differential vs memoryRegistry:** one script run against both, results compared line by line: list order
  (grants keep position on update, admins, invites, links, link uses), null `memberRole`, numeric title, boolean
  `revoked`, re-revoke true / unknown false, error messages, `last-owner` codes, and 7 garbage ids (undefined,
  null, number, `"../x"`, `""`, unknown, object) against every lookup.
- **Durable:** write everything, close, reads throw "closed", reopen, every read equal; last-owner and domain
  uniqueness still hold after reopen.
- **Two handles, one file** (as the brief asks), 20 rounds.
- **Two processes racing** (`Bun.spawn` of `process.execPath`, own handle each, go-file barrier), 40 rounds: exactly one `ok` and one
  `last-owner` per round, one owner left.

## How I checked the race test is real

The in-process two-handle test can't fail (each `bun:sqlite` call runs to completion), so I mutated the adapter:
removed the transaction from `setGrant` and widened the check-to-write gap by 2 ms. The two-process test failed;
everything else (including the two-handle test) still passed. Restored, re-run green.

## Wiring into server/main.js (for the session that owns it; NOT applied to the repo)

Against main.js as it stood at 2026-11-11 17:40 (after the p3-scaffold fix's `best` grant loop). **Ran on a
scratch copy:** `start()` twice on one temp data dir, PORT=0, dev tokens changed between starts (ann owner then
editor, bob viewer then annotator), `stop()` each. Same dev board id both times; ann kept `owner` (last-owner
caught and logged), bob became `annotator`; registry closed cleanly.

```diff
--- server/main.js	2026-11-11 17:40:27
+++ server/main.js (proposed)	2026-11-11 17:40:50
@@ -13,7 +13,7 @@
 // dev board is created at start and each dev user gets the role its token names (default editor; if two tokens
 // name one user, the highest role). Its id is logged.
 
-import { mkdirSync } from "node:fs";
+import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
 import { join } from "node:path";
 import { createLogger } from "./log.js";
 import { createServer } from "./server.js";
@@ -22,7 +22,7 @@
 import { diskBlobs } from "./blobs/disk.js";
 import { authPort } from "./auth/port.js";
 import { devAuth } from "./auth/dev.js";
-import { memoryRegistry } from "./auth/registry.js";
+import { sqliteRegistry } from "./registry/sqlite.js";
 import { tenancy } from "./auth/tenancy.js";
 import { ROLES } from "../packages/protocol/envelope.js";
 
@@ -40,14 +40,22 @@
   const store = sqliteStore({ path: join(dataDir, "plenary.db") });
   const bus = memoryBus({ onError: (err, subject) => log.error("bus subscriber failed", { subject, err }) });
   const blobs = diskBlobs({ dir: join(dataDir, "blobs") });
-  const registry = memoryRegistry();
+  const registry = sqliteRegistry({ path: join(dataDir, "registry.db") });
   const dev = devAuth(tokens ? { enabled: true, tokens } : undefined);
   const auth = authPort({ dev, tenancy: tenancy({ registry }) });
 
   let devBoard = null;
   if (dev.enabled) {
-    const tenant = await registry.createTenant({ domain: null });
-    const board = await registry.createBoard({ tenant: tenant.id, title: "dev board", memberRole: null });
+    // Reuse the dev board across restarts (the Registry has no list call to find it).
+    const devFile = join(dataDir, "dev-board.json");
+    let saved = null;
+    if (existsSync(devFile)) { try { saved = JSON.parse(readFileSync(devFile, "utf8")).board; } catch { saved = null; } }
+    let board = typeof saved === "string" ? await registry.board(saved) : null;   // a Registry outage throws: start fails
+    if (!board) {
+      const tenant = await registry.createTenant({ domain: null });
+      board = await registry.createBoard({ tenant: tenant.id, title: "dev board", memberRole: null });
+      writeFileSync(devFile, JSON.stringify({ board: board.id }));
+    }
     // Two tokens may name the same user: one grant per user, the highest role wins (ROLES is highest first), so
     // no grant is ever lowered here (the Registry refuses to demote a board's last owner).
     const best = new Map();
@@ -56,13 +64,17 @@
       const user = "dev:" + t.name, role = ROLES.includes(t.role) ? t.role : "editor";
       if (!best.has(user) || ROLES.indexOf(role) < ROLES.indexOf(best.get(user))) best.set(user, role);
     }
-    for (const [user, role] of best) await registry.setGrant(board.id, user, role);
+    // On a restart a token's role may have dropped; the Registry refuses to demote the last owner, so keep it.
+    for (const [user, role] of best) {
+      try { await registry.setGrant(board.id, user, role); }
+      catch (err) { if (err?.code !== "last-owner") throw err; log.warn("dev token would demote the dev board's last owner; kept", { user }); }
+    }
     devBoard = board.id;
-    log.warn("dev tokens are ON: not for production", { board: board.id, tenant: tenant.id, users: best.size });
+    log.warn("dev tokens are ON: not for production", { board: board.id, tenant: board.tenant, users: best.size });
   } else log.warn("dev tokens are off and sign-in is not wired yet: every hello will be refused");
 
   const server = createServer({ auth, registry, store, bus, blobs, log, port: Number(env.PORT ?? 8080), hostname: env.HOST || "127.0.0.1" });
-  return { server, store, bus, log, devBoard, async stop() { await server.stop(); await bus.close(); await store.close(); } };
+  return { server, store, bus, log, devBoard, async stop() { await server.stop(); await bus.close(); await store.close(); await registry.close(); } };
 }
 
 if (import.meta.main) {
```

- **Why its own file:** the Store's appends take the same file's write lock; a separate `registry.db` keeps admin
  writes from queueing behind the hot log. One file also works (tables are prefixed).
- **Why the dev-board change:** without it, a durable Registry mints a new tenant and dev board on every start, so
  the restart gate can't reuse the dev board's id. Boards made by `POST /boards` survive either way.
- **Why the `last-owner` catch:** on restart, a token whose role dropped from `owner` would otherwise crash start.
- **Why the dev-board read is not in the try:** a Registry failure must fail start, not mint a second dev board.

## Not verified

- The main.js change runs on a scratch copy only (above), not in the repo, and without a client connecting: the
  phase-3 restart gate (a client sees the same board and log after a restart) still needs running once it lands.
- Power-loss durability: only close/reopen tested; `synchronous=FULL` + `fullfsync` are set and read back, not
  crash-tested. Tests run with `fullfsync: false` for speed (the default is on).
- Behaviour under `SQLITE_BUSY` past the 5 s busy timeout (it throws, so the gateway answers `unavailable`).

## Risks and differences

- **Postgres port:** SQLite's database-wide write lock is what serialises the last-owner check. Postgres needs
  `SELECT … FOR UPDATE` on the board row (or SERIALIZABLE) in `setGrant`; plain READ COMMITTED would let two
  demotions both pass.
- **Small differences from memoryRegistry, none covered by the contract:** `createTenant` dedupes repeated admins
  (memory keeps duplicates); a missing `by` is stored as null (memory keeps undefined); a non-string user is
  stored via `String()`; `NOT NULL` on invite `email` and on invite/link `role` rejects a non-string email or a
  missing role (memory stores them). The admin layer validates both before calling.
- **Roles are stored as given** (no check), as in memory; tenancy.js caps them on read (`capTo`).
- main.js's header comment (`SEAM(platform): the Registry is the platform track's in-memory one, so boards do NOT
  survive a restart`) goes stale with this change; the owner of main.js should update it in the same edit.
