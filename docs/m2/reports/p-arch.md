# Report: p-arch (architecture boundary test)

**Result: done.** The repo-wide hexagonal boundary test passes on today's tree, fails on a planted violation of
each kind (shown in scratch), and `bun test` is green (979 pass, 80 skip, 0 fail). The known adapter → adapter
import (p5-hexv L8) is fixed through a new shared helper, server/pg/schema.js. The Postgres Store and Registry
contracts pass against a local Postgres 17 (44 pass, 0 skip). One violation is allowlisted and proposed below as a
fix job. Nothing is committed.

## What changed (files)

| File | Change |
|---|---|
| test/arch-scan.js (new) | Shared static scanner, API documented at the top: `ROOT`, `listFiles(dirs)`, `importsOf(file, src?)`, `checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots, allowed, allowlist })`. Same import grammar as platform's verified test/auth parser (static, re-export, `import()`, `require()`, JSDoc `import("…")` types). |
| test/architecture.test.js (new) | Rules for packages/, server/ and scripts/, with classes derived from folders, the allowlist, sanity checks against a vacuous pass, and planted-source tests of each rule. |
| test/server/architecture.test.js | **Deleted** (p2-swap's narrow test, folded in). The deletion is not staged. |
| server/pg/schema.js (new) | `needSchema`, `ensureSchema`, `migrate(tx, schema, tables)`. A leaf (imports nothing): adapter-only support code, not an adapter of any port. |
| server/store/postgres.js | The three helpers are moved out. The Store keeps its DDL as `export const STORE_TABLES` and calls `migrate(tx, s, STORE_TABLES)`. No re-exports, because nothing else imported them. |
| server/registry/postgres.js | Import line only: `../store/postgres.js` becomes `../pg/schema.js`. |

**Departure from the brief:** the brief named `migrate(tx, schema)`. A shared helper with the Store's tables in it
would belong to one port, so `migrate` now takes the table map, and the Store owns `STORE_TABLES`. The behaviour is
the same: it looks each table up first with `to_regclass` and creates only what is missing.

## The rules (test/architecture.test.js)

**How files are classified.** Every class comes from a folder or a file name, never from a hand-kept file list
(p2-swapv L4).

| Class | What it covers |
|---|---|
| adapter | Every file under server/store, registry, bus, blobs or auth, except ports and the two listed `NOT_ADAPTERS`. A new file in one of these folders is an adapter by default, the strict side. |
| port | Named `port.js` or `*-port.js` inside an adapter folder. |
| not an adapter (explicit list) | server/auth/util.js (shared pure helpers) and server/auth/tenancy.js (core, as platform's `CLASSES` has it). |
| adapter-only support | server/pg/. Any adapter may import it; core may not. It may not import another adapter. |
| core | Everything else under packages/ and server/: packages/protocol/*, packages/core/*, server/gateway.js, room-host.js, server.js, feed.js, breather.js, ids.js, log.js, server/admin/boards.js, the ports, and `NOT_ADAPTERS`. Every server/ sub-folder must be listed as core (`CORE_DIRS`, now only server/admin/), adapter or support, so a new adapter folder can't pass as core by default. |
| composition root | server/main.js, and scripts/dev-google.js. The latter is platform's dev harness, which calls itself a composition root and wires auth adapters. Any other scripts/ file that imports an adapter fails as `unclassified` + `wiring`. |

**Adapter groups.** Each adapter is its own group: its file, or its own sub-folder if it grows to several files. So
blobs/s3.js and blobs/disk.js are two adapters, and one importing the other is a violation.

**What fails the test:**
- **core → adapter:** core imports an adapter or adapter-only support code.
- **adapter → adapter:** an adapter imports one in a different group.
- **wiring:** a file that is neither core nor adapter imports an adapter (only composition roots wire).
- **unclassified:** a scanned file has no class.
- **unresolved:** a relative import without an extension (it would dodge classification).
- **stale-allowlist:** an allowlist entry that no longer occurs, so the list can only shrink.
- **unclassified folder:** a server/ sub-folder in no list.

Tests are not scanned, so they may import anything.

## Allowlisted violations: proposed fix jobs

| # | Import | Fix job (owner) |
|---|---|---|
| 1 | server/blobs/s3.js → server/blobs/disk.js (`checkBlob`, `imageKind`, `MAX_BLOB_BYTES`) | Move these into a Blobs port module (server/blobs/port.js) that both adapters import, then delete the allowlist entry (engine). |

## Other fix jobs found (not boundary violations)

- **Registry start-up is not least privilege (platform).** server/registry/postgres.js still runs `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. A role without CREATE then fails against a migrated schema, which the Store already avoids. Fix: `migrate(tx, s, REGISTRY_TABLES)` from server/pg/schema.js, plus a `to_regclass` check before each index. This job owned only that file's import line.
- **Duplicated start-up transaction (engine or platform).** Both Postgres adapters repeat the advisory lock and start-up transaction (`pg_advisory_xact_lock(hashtext('plenary-schema:'+s))`). It could become one helper in server/pg/schema.js.
- **Duplicated parser (platform).** test/auth/architecture.test.js has its own copy of `importsOf`. It could import test/arch-scan.js instead, which has the same grammar.
- **Disagreement on server/admin (needs a decision).** p2-swap's deleted test treated server/admin as an adapter folder; platform's `CLASSES` treats admin/boards.js as core. I followed platform: it is admin use cases over the Registry port.
  - **Consequence:** this test is narrower than the deleted one there. The old test stopped the engine core importing anything under server/admin or server/auth. Mine lets it import admin/boards.js, auth/tenancy.js, auth/util.js and the auth ports, none of which are adapters.
- **Plan note for p5-pgpriv (platform):** manager-engine.md expects it to build on server/pg/schema.js. It gets `migrate(tx, schema, tables)` with a table map, which suits the Registry's tables directly, not the brief's `migrate(tx, schema)`.
- **web/ rules (client).** client's test/web/architecture.test.js should reuse `checkBoundaries`, with web/adapters/* as adapters and the web entry as a composition root.

## How I checked it

- **Raw scan first:** with nothing allowed, the scanner printed every edge into an adapter folder, including registry/postgres → store/postgres, s3 → disk, both registries → auth/registry-port and auth/util, and main.js → every adapter.
- **Planted violations (scratch copy, not the repo):** the copy is at /private/tmp/claude-501/-Users-r-repos-plenary/e17173a8-9c29-4084-8c95-ab69d4f97757/scratchpad/plant and its output at /private/tmp/claude-501/-Users-r-repos-plenary/e17173a8-9c29-4084-8c95-ab69d4f97757/scratchpad/planted-run.txt. Planted in it:
  - gateway.js → store/sqlite.js, reported as `core->adapter`
  - registry/sqlite.js → store/sqlite.js, reported as `adapter->adapter`
  - a root-level wire.js → bus/nats.js, reported as `unclassified` + `wiring`
  - s3.js no longer importing disk.js, reported as `stale-allowlist`
  - a new server/cache/redis.js, failing the folder-classification test

  The scratch run's failing lines:

  ```
  (fail) packages/ and server/ follow the hexagonal import rules
  +   "server/gateway.js -> server/store/sqlite.js [runtime]: core->adapter",
  +   "server/registry/sqlite.js -> server/store/sqlite.js [runtime]: adapter->adapter",
  +   "wire.js: neither core, adapter nor a composition root",
  +   "wire.js -> server/bus/nats.js [runtime]: wiring",
  +   "allowlist entry server/blobs/s3.js -> server/blobs/disk.js no longer occurs: delete it",
  (fail) every server/ sub-folder is classified (core, adapter or adapter-only support)
  +   "server/cache/",
   10 pass
   2 fail
  ```

  Only the two real-tree tests failed. The rule tests check just their planted file, with their own allowlist, so
  they don't depend on the real tree. With the plants removed, s3 fixed and `ALLOWLIST` emptied (the state after
  fix job 1), the scratch copy is green: 12 pass.

  The same kinds are also durable tests on synthetic sources in test/architecture.test.js. They cover runtime, re-export, `import()`, JSDoc type, extensionless and commented-out imports.
- **Postgres:** a throwaway Postgres 17 (brew postgresql@17), initdb'd in the scratchpad, TCP-only on free port 64927, PID 87936. Ran with `DATABASE_URL` set: test/server/pg-store.test.js and test/server/pg-registry.test.js gave 44 pass, 0 skip. The least-privilege test ran (no skip warning). The server was stopped with `pg_ctl stop`, and PID 87936 is gone.
- **Full suite:** `bun test`: 979 pass, 80 skip, 0 fail. The count rose from 895 during the job because other sessions added tests.
- **Leftover references:** a repo-wide grep finds no importer of the moved helpers outside the two Postgres adapters. Older reports mention `migrate()` on store/postgres.js, as history.
- **Other non-test JS:** outside the scanned folders there are only docs/m2/design/mock.js (no imports) and scripts/dev-google.js (now scanned, a root). web/ is client's.

## Not verified

- **NATS and S3 suites:** not run live. No code there changed; they are among the 80 skips without services.
- **Scanner blind spots:** computed specifiers, `import.meta.resolve`, a block comment between `import` and `(`. These are documented at the top of arch-scan.js.
- **Adapter imports of non-adapters are not restricted.** An adapter may import any port and any non-adapter file. The explicit lists of what an adapter may share are `NOT_ADAPTERS` (auth/util.js, auth/tenancy.js), ports by name, and `SUPPORT_DIRS` (server/pg/). server/ids.js passes only because it is core, and adapters may import core.
  - **Why:** auth/http.js, a driving adapter, legitimately imports admin/boards.js.
  - **Open question for the manager:** should adapters be limited to an explicit shared list (ids.js, auth/util.js, server/pg/, ports)? Then an adapter importing gateway.js would fail; today it passes.

## Risks

- **Concurrent edits:** other sessions were changing files in the tree at the same time (ci.yml, deploy/, test/server/rig.js, test/server/harness.test.js). I touched none of them, and the green run includes their state at the time.

## Systems design skill

`distributed-systems-design` was applied in APPLIER mode, lightly:
- **Scope and estimate:** taken from the brief; the scan is 53 files in about 5 ms.
- **High-level design:** classes derived from folders.
- **Deep dives:** adapter grouping (one adapter per group, which catches same-port imports), and the support-folder class for the Postgres helper.
- **Wrap-up (failure modes):** found the "new folder silently becomes core" false negative and closed it with the folder-classification test.

Most of the skill's checklist (load balancers, caches, sharding) doesn't apply to a static test.

## Follow-up (after p-archv, manager t18m, 2026-11-12)

**Result: done, uncommitted.** All 3 MEDIUMs are fixed, the adapter-import limit (decision 2) is in, scripts/admin-bootstrap.js is a composition root, the cheap LOWs are fixed, and the allowlist is empty: s3 → disk is gone through server/blobs/port.js. Gates:
- **Full suite:** `bun test`: 1044 pass, 83 skip, 0 fail.
- **Architecture tests:** test/architecture.test.js 17 pass; client's test/web/architecture.test.js 7 pass; purity passes.
- **Blobs:** test/server/ports.test.js plus the S3 suite give 27 pass, 11 skip (S3 skips without a server, as asked).
- **Postgres:** the store and registry contracts on a scratch Postgres 17 (PID 97651, port 49665, stopped and gone afterwards) give 47 pass, 0 skip.

### Files

| File | Change |
|---|---|
| test/arch-scan.js | M1 adds rule `imports-root`. M2 rewrites `onComment`. Adds `packagesOf(file)` for bare imports. Adds options `adapterMayImport` (rule `adapter->core`), `allowPackage` (rule `core->package`) and `urls`. `listFiles` and "unresolved" now cover .cjs, .ts, .mts and .cts. |
| test/architecture.test.js | Explicit core lists and the DRIVING adapters. SHARED limits driven adapters. scripts/admin-bootstrap.js added as a root. deploy/ is scanned. The allowlist is empty. New planted tests cover each new rule. |
| server/blobs/port.js (new) | `MAX_BLOB_BYTES`, `imageKind`, `checkBlob`, moved verbatim from disk.js. |
| server/blobs/disk.js, s3.js | Both import from ./port.js. disk.js re-exports the three, because test/server/ports.test.js and blobs-contract.js (p2-tune's files) import them from disk.js. |
| server/store/postgres.js | `STORE_TABLES` is frozen (L5). |

**Backward compatibility of arch-scan.js.** Every existing export and parameter keeps its meaning. The new checks run only when a caller passes the new options, except `imports-root`, which is the M1 fix and applies to everyone.
- **The `new URL(…, import.meta.url)` edges are opt-in (`urls: true`)** because the default turned client's web test red. web/adapters/transport/shared-worker/client.js names its worker entry, a web composition root, by URL; that starts a program rather than importing it.
- **When opted in,** these edges get kind `"url"`, and a `"url"` edge may name a root. Client can opt in with `urls: true`; its own `adapter-imports` rule would then need the same exemption.

### Findings

| Finding | What changed |
|---|---|
| **M1:** core could import a composition root | New rule `imports-root`: no scanned file may import a root (roots themselves are not checked as importers). |
| **M2:** `/* … */ import …` was hidden | `onComment` now treats a position as commented only after `//`, inside a `/*` still open at it, or on a `*` continuation line whose comment doesn't close before it. Planted: `/* hot path */ import …`, `/* x */ require(…)`, and `*/ import …` closing a JSDoc are all caught; real comments are still ignored. |
| **M3:** a new packages/<dir> or top-level server/*.js became core silently | Core is now explicit: `CORE_DIRS` (packages/protocol/, packages/core/, server/admin/), `CORE_FILES` (server/gateway, room-host, feed, breather, ids, log), the ports and `NOT_ADAPTERS`. Anything else is "unclassified". Core may import no bare package (`allowPackage: () => false`); today no core file does. The folder test now covers packages/ too. |

**Decision 2 (adapter-import limit).**
- **Driven adapters** may import only ports, `SHARED` (server/ids.js, server/auth/util.js), server/pg/, their own group and bare packages. Anything else is the new rule `adapter->core`. auth/tenancy.js wasn't needed: no adapter imports it.
- **Driving adapters:** `DRIVING` exempts server/auth/http.js, as the manager decided. It also lists server/server.js and server/static.js, as one group, `server/http`.
  - **Why server.js and static.js:** p-serve's new server/static.js calls itself a driving adapter and imports `node:fs`, and server.js imports it. Kept as core, both would have failed the new rules. server.js is the HTTP/WebSocket driving adapter (p-archv L7).
  - **Effect:** no core file may import server.js or static.js any more. Today only main.js and tests do.

**Platform ask:** scripts/admin-bootstrap.js is in `COMPOSITION_ROOTS`. Only server/main.js has to exist, so a missing script never fails the test.
- **Already landed:** the file appeared during this round. Its core part, server/admin/tenants.js, is core (server/admin/) and imports only auth/util.js.

**Item 5 (Blobs):** done as described above; the allowlist is empty.

### LOWs

| LOW | Status |
|---|---|
| L1 Worker URLs | Fixed, opt-in (`urls: true`); on for packages/, server/ and scripts/. |
| L2 .cjs/.ts and deploy/ | Fixed: `listFiles` takes .cjs, .ts, .mts and .cts, and deploy/ is scanned (no JS there today). |
| L3 scripts/ strict | Decided: strict. Every script must be a composition root, listed when it is written (said in the test header). |
| L5 mutable `STORE_TABLES` | Fixed: `Object.freeze`. |
| L7 server.js / log.js | server.js is now a driving adapter. log.js (port plus stdout adapter) stays core, noted in the header. |
| L9 | No action (the verifier agreed with it). |
| L4 import-like string literal reported | Listed, not fixed: a false positive that fails safe. Fixing it needs a real tokenizer, and a regex literal holding a quote breaks a cheap one. |
| L6 Registry start-up not least privilege | Listed: platform fix job. server/registry/postgres.js should call `migrate(tx, s, REGISTRY_TABLES)` from server/pg/schema.js. |
| L8 config not exported | Listed: if platform wants the server classes, move the predicates to an importable test/arch-server.js. Not done, because importing a `.test.js` would re-register its tests. |
| Known parser misses | Still open: a comment inside `import(`, `import.meta.resolve`, computed specifiers, an apostrophe in a comment inside a multi-line import. |

### Planted proof (scratch copy, not the repo)

The copy is at /private/tmp/claude-501/-Users-r-repos-plenary/e17173a8-9c29-4084-8c95-ab69d4f97757/scratchpad/plant2, and the full output at /private/tmp/claude-501/-Users-r-repos-plenary/e17173a8-9c29-4084-8c95-ab69d4f97757/scratchpad/planted-run2.txt. These are the verifier's misses:

```
+   "packages/natsbus/bus.js: neither core, adapter nor a composition root",
+   "server/bus/nats.js -> server/room-host.js [runtime]: adapter->core",
+   "server/feed.js -> server/blobs/s3.js [url]: core->adapter",
+   "server/gateway.js -> bun [runtime]: core->package",
+   "server/gateway.js -> server/main.js [runtime]: imports-root",
+   "server/gateway.js -> server/store/sqlite.js [runtime]: core->adapter",      (/* hot path */ import …)
+   "server/redis-cache.js: neither core, adapter nor a composition root",
(fail) packages/, server/ and scripts/ follow the hexagonal import rules
+   "packages/natsbus/",
(fail) every server/ and packages/ sub-folder is classified
 14 pass, 2 fail
```

### Not verified, and risks

- **S3 live:** not run; the suite skips without an S3 server.
- **Concurrent edits:** p2-tune, p-serve, client and platform were editing during the round. The green run reflects the tree at that moment.
- **New top-level server/ files:** they now fail as unclassified until listed in `CORE_FILES` or `DRIVING`. That is intended, but a worker adding one (as p-serve did with static.js) must add it to the list.
