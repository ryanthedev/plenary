# Report: p-archv (verify p-arch: architecture boundary test, Postgres schema helper)

Verifier t1g0, 2026-11-12. Tree: shared main, job uncommitted. I changed nothing in the tree except this report;
every planted violation ran in a scratch copy (packages/, server/, scripts/, test/arch-scan.js,
test/architecture.test.js), one fresh copy per case.

## Verdict: PASS (no HIGH). 3 MEDIUM, 8 LOW.

core -> adapter, adapter -> adapter (across ports and within one), non-root wiring, a new server/ sub-folder and a
stale allowlist entry are all caught, in every syntax the brief lists. One brief item is only partly covered: a new
**server/ sub-folder** can't silently become core, but a new **packages/<dir>/** or a new **top-level server/*.js**
does (M3). The Postgres move is behaviour-preserving (contracts and the least-privilege test pass against a live
Postgres 17), and `bun test` is green.

Why M3 is MEDIUM, not HIGH: packages/ is all-core by design (CLAUDE.md "Shape"), the old test didn't cover it
either, so this is no regression; it needs someone to write an adapter outside the adapter folders; and one cheap
rule (M3's "core imports no bare package") closes both cases. Each MEDIUM is a small follow-up; none blocks the commit.

## Gates

| Gate | Result |
|---|---|
| `bun test` (whole tree, 2026-11-12) | 990 pass, 80 skip, 0 fail, 56 files |
| `test/architecture.test.js` alone | 12 pass |
| Postgres store + registry contracts (brew postgresql@17, own initdb, 127.0.0.1:55879, PID 66087) | 44 pass, 0 fail |
| p2-swap least-privilege test (`-t "least privilege"`) | ran (superuser, not skipped), 1 pass, 5 expects |
| sdd ensemble (codex high + grok; agy out of quota, resets in ~59 h) | no finding shared by two harnesses, so no HIGH candidate; see below |

## 1. Planted violations (scratch copy, `bun test test/architecture.test.js`)

Caught (test went red with the right rule):

| Plant | Rule reported |
|---|---|
| core static import of adapter (`server/gateway.js` imports `./store/sqlite.js`) | core->adapter |
| core re-export (`packages/protocol/room.js`: `export * from "../../server/bus/nats.js"`) | core->adapter |
| core `import()` / `require()` / JSDoc `import("./auth/oidc.js")` type | core->adapter (type kind for JSDoc) |
| `./admin/../store/sqlite.js`, `./x/../registry/postgres.js` | core->adapter (normalized) |
| `.js`-less `./store/sqlite`, directory `./store/` | unresolved |
| `packages/core/doc.js` importing an adapter | core->adapter |
| adapter -> adapter, different ports (`registry/sqlite.js` -> `store/sqlite.js`) | adapter->adapter |
| adapter -> adapter, same port (`bus/nats.js` -> `bus/memory.js`) | adapter->adapter |
| adapter `import()` with quote or template literal | adapter->adapter |
| non-root file wiring (`scripts/seed.js`, `scripts/x.mjs`) | unclassified + wiring |
| new server/ sub-folder (`server/cache/redis.js`) | "every server/ sub-folder is classified" fails |
| new file in an adapter folder imported by core (`server/auth/helper.js`) | core->adapter |
| port or NOT_ADAPTERS file importing an adapter (`bus/port.js`, `auth/util.js`) | core->adapter |
| `server/bus/nats-port.js` (port by name) importing an adapter | core->adapter |
| `.json` file in an adapter folder | core->adapter |
| allowlisted s3 -> disk import removed | stale-allowlist ("no longer occurs: delete it") |

Missed (test stayed green):

| Plant | Severity |
|---|---|
| `server/gateway.js`: `import { x } from "./main.js"` (core imports the composition root, and so every adapter) | MEDIUM (M1) |
| `/* hot path */ import { a } from "./store/sqlite.js";` and `/* x */ const r = require("./store/sqlite.js");` on a code line | MEDIUM (M2) |
| new top-level `server/redis-cache.js` with `import { RedisClient } from "bun"`; `server/gateway.js` with `import { SQL } from "bun"`; new `packages/natsbus/bus.js` importing `@nats-io/transport-node` | MEDIUM (M3) |
| adapter imports core (`store/sqlite.js` -> `../gateway.js`, `bus/nats.js` -> `../room-host.js`, `bus/nats.js` -> `../main.js`) | builder's listed risk; see question 3 |
| core imports `../scripts/dev-google.js` (a root) | part of M1 |
| `import(/* chunk */ "./store/sqlite.js")`, `import.meta.resolve`, `import("./store/" + "sqlite.js")`, `const p = "…"; import(p)` | LOW, builder's known list |
| multi-line import with `// it's` inside | LOW, builder's known list |
| `new Worker(new URL("./store/sqlite.js", import.meta.url))` | LOW (L1) |
| `scripts/x.cjs`, `scripts/x.ts` | LOW (L2) |
| a JS file under deploy/ | LOW (L2) |

`packages/protocol` importing server code passes this test but test/purity.test.js catches it (protocol may import
only its own files and core's doc.js/model.js), so that is covered.

## Findings

**M1 (MEDIUM): a core file may import a composition root.** `checkBoundaries` skips roots as importers but never
checks them as targets, and `isAdapter("server/main.js")` is false. Repro: append
`import { x } from "./main.js";` to server/gateway.js: green. The core then reaches every adapter transitively.
Fix: a rule "imports-root": no file but a test may import a composition root (one line in checkBoundaries:
`if (roots.has(to)) v("imports-root")`).

**M2 (MEDIUM): a block comment at the start of a code line hides the import on that line.** `onComment` treats any
line starting with `/*` as a comment, even when the comment closes before the import. Repro: append
`/* hot path */ import { a } from "./store/sqlite.js";` (or the same with `require`) to server/gateway.js: green. Not
in the builder's blind-spot list. Fix: strip comments first, as test/purity.test.js does
(`.replace(/\/\*[\s\S]*?\*\//g, "")` and `//…` per line), keeping JSDoc `import("…")` types by scanning the comment
text separately; or check whether the `/*` closes before the match.

**M3 (MEDIUM): core may import an infrastructure package, so a new adapter written outside the adapter folders
passes as core.** Bare specifiers ("bun", "bun:sqlite", "@nats-io/…") are never returned by `importsOf`, and any new
top-level server/*.js or new packages/<dir>/ is core by default (only new server/ sub-folders are forced to be
classified). OFFICE.md says the core depends on no adapter "or a framework". Repro: new `server/redis-cache.js`
with `import { RedisClient } from "bun"`, imported by gateway.js: green. Verified today: no core file imports any
bare specifier (only main.js `node:fs`/`node:path`, and adapters `bun`, `bun:sqlite`, `@nats-io/transport-node`,
`node:fs/promises`, `node:path`), so a "core imports no bare package" rule costs nothing now. Globals such as
`Bun.serve` (server/server.js) stay invisible to any import rule. Checked: package.json has no `imports`, `exports`
or `workspaces` map and packages/ has no package.json, so no non-relative specifier can reach an adapter today.

**L1:** `new Worker/SharedWorker(new URL("./x.js", import.meta.url))` edges are not seen. web/ uses this
(web/adapters/transport/shared-worker/client.js:18), so client's web rule should know.
**L2:** only .js/.mjs are scanned; .cjs/.ts/.mts (Bun runs them) and deploy/ are not. None exist today.
**L3:** any new file in scripts/ fails as "unclassified" even when it imports nothing. Strict on purpose per the
test's header, but every dev script must then be added to COMPOSITION_ROOTS or a new class. Decide and say so.
**L4 (codex):** look-alike strings in code are reported: planted `const s = 'import("./store/sqlite.js")';` in
server/gateway.js gives `core->adapter`. False positive only (fails safe).
**L9 (relaxation vs the deleted test, I agree with it):** p2-swap's test/server/architecture.test.js put all of
server/admin/ and server/auth/ in ADAPTER_DIRS and exempted only server/bus/port.js, so gateway, room-host, feed and
server.js could import nothing from admin/ or auth/, not even the auth ports, util.js or tenancy.js. The new test
makes those ports, shared or core, so such imports now pass. That matches OFFICE.md (core depends on ports;
tenancy.js and admin/boards.js are core logic). Checked: none of the old test's 8 core files imports anything under
admin/ or auth/ today, so nothing relied on the old strictness.
**L5 (codex):** `STORE_TABLES` (server/store/postgres.js) is now an exported mutable object passed straight to
`migrate`; `Object.freeze` it. Before, the table map was local to `migrate`.
**L6 (pre-existing, outside this job):** the Postgres registry cannot start as a least-privilege role: it runs
`CREATE TABLE IF NOT EXISTS` unconditionally (server/registry/postgres.js:53+). Checked on the local Postgres: a role
with USAGE only gets `permission denied for schema` on `CREATE TABLE IF NOT EXISTS` of an existing table. Now trivial
to fix: call `migrate(tx, s, REGISTRY_TABLES)` from server/pg/schema.js. Platform's file; propose a fix job.
**L7 (classification, judgment):** server/server.js is the HTTP/WebSocket driving adapter (Bun.serve), classified
core; server/log.js is the Log port and its stdout adapter in one file. Both fine as they are today (nothing but
main.js and core import them), worth a line in the test header.
**L8 (API):** the config (isCore, isAdapter, adapterGroup, roots) is not exported from test/architecture.test.js, so
platform's test/auth rule can't reuse the server classes without copying them. Move them to an export (e.g.
test/arch-server.js) if platform wants the same sets.

## 2. Classification of every file under packages/ and server/

Dumped with the test's own predicates (scratch). All agree with the brief, except the judgment calls in L7:

- **core:** packages/protocol/* and packages/core/*, server/{gateway,room-host,server,feed,breather,ids,log}.js,
  server/admin/boards.js, server/auth/tenancy.js (listed NOT_ADAPTERS), server/auth/util.js (shared).
- **port:** server/bus/port.js, server/auth/{port,idp-port,registry-port}.js. auth/port.js holds `authPort`, a
  composition over injected verifiers (logic, not a typedef); as a non-adapter it gets core's rules, which is right.
- **adapter (one group each):** store/{sqlite,postgres}, registry/{sqlite,postgres}, bus/{memory,nats},
  blobs/{disk,s3}, auth/{dev,oidc,session,registry,http}.
- **support:** server/pg/schema.js (group "server/pg/schema"; grok said "server/pg/", which is wrong).
- **roots:** server/main.js, scripts/dev-google.js.

## 3. Question for the manager: limit adapters to ports + an explicit shared list?

**Recommendation: yes, for driven adapters; exempt driving adapters by name.** Today every adapter -> non-adapter
edge is a port, `server/ids.js`, `server/auth/util.js` or `server/pg/`, except one: `server/auth/http.js` ->
`server/admin/boards.js`. That one is legitimate: http.js is a driving adapter (HTTP calls into the core's public
API, OFFICE.md "Driving adapters"). So the rule is: an adapter may import ports, SHARED = [server/ids.js,
server/auth/util.js], SUPPORT_DIRS, its own group, and bare packages; DRIVING = [server/auth/http.js] may also import
core. Ran it in scratch with the test's own predicates: today's tree gives zero violations, and it closes the builder's listed risk (an adapter importing gateway.js,
room-host.js, feed.js or main.js). Pair it with M1's "nobody imports a root".

## 4. server/pg/schema.js move

Behaviour unchanged: `needSchema`, `ensureSchema` are byte-for-byte the old bodies; `migrate(tx, schema, tables)`
runs the same SQL in the same order (pl_entries, pl_checkpoints, pl_leases) with the table map passed in;
postgresStore still takes the advisory lock first. No other file imported the old exports from
server/store/postgres.js (rg over the repo). Contracts and the least-privilege test pass live (Gates).

## 5. test/arch-scan.js API for client and platform

Documented at the top and usable for web/ as is: a 15-line scratch rule (adapters = web/adapters/**, core =
web/core/**, web/ports/**, roots = web/main.js, web/dev.js, web/collab/dev.js) caught a planted
`web/core/sync.js -> adapters/transport/ws.js` (core->adapter) and `dom/app.js -> transport/ws.js`
(adapter->adapter), and on today's tree reported dom-internal edges (app.js -> paint/panel/export/dom.js) and
`shared-worker/worker.js -> transport/local.js`, which client must group or allowlist. Notes: L1 (Worker URLs),
L8 (config not exported). grok's MEDIUM "callers must supply their own predicates" is by design per the brief; not a
defect.

## 6. sdd ensemble

codex (effort high) and grok, in a scratch copy (never the shared tree). agy: quota exhausted.
- codex MEDIUM "variable or commented `import()` slips": confirmed, already on the builder's known list (LOW).
- codex LOW string false positive: confirmed (L4). codex LOW mutable STORE_TABLES: confirmed (L5).
- grok HIGH "extensionless import dodges core->adapter": **refuted**, it is reported as "unresolved" and the test
  fails (plant core-extless above).
- grok HIGH "unclassified wiring slips": **refuted**, `scripts/seed.js` and `tools/start.js` both fail
  (unclassified + wiring).
- grok MEDIUM "adapterGroup(server/pg/schema.js) is server/pg/": **refuted**, it is "server/pg/schema".
- grok MEDIUM API reuse: by design (see 5); the true part is L8.
No finding was shared by two harnesses.

## 7. Systems design (CHECKER, light)

The job is a static test plus a code move; most of the checklist (load balancing, caching, sharding, CAP) doesn't
apply. What applies: swappable single-node/cluster adapters behind ports is what the test now enforces (good), and
concurrent start-up of two Postgres adapters on one schema still serializes on the same advisory lock
(`plenary-schema:<schema>`) in both. Failure mode found: L6 (registry not least-privilege), pre-existing.

## Not verified

- NATS and S3 suites (no code there changed).
- Concurrent edits by p2-tune and p6-hex were landing during my run; my `bun test` was green at that moment only.
- The fixes I suggest are untested: M1's "imports-root" line, M2's comment stripping, M3's bare-package rule, L5's
  freeze, and L6's switch of the registry to `migrate`.

## Cleanup

Postgres PID 66087 stopped with `pg_ctl stop` on its own data dir (checked: process gone). The scratch copies and the
stopped pgdata were NOT deleted: `rm -rf` was refused by a permission rule. They sit only in this session's private
scratchpad (/private/tmp/claude-501/-Users-r-repos-plenary/d173e83a-a248-4e83-ac8d-31e428f3bf47/scratchpad: pgdata,
case, tree, review, bin), nothing in the repo.
