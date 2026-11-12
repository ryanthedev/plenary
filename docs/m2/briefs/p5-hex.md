# Brief: p5-hex (server/auth and server/admin follow the hexagonal rule)

docs/m2/BRIEF-BASE.md applies, including its Architecture line. Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-hex.md. Never pkill/killall; port 0; kill only PIDs you recorded.

## Goal (CEO, 2026-11-11)

"make sure we are doing hexagonal application architecture and use the systems design skill when building this
stuff out." Read docs/m2/OFFICE.md "Architecture" first. Proxy's mapping for platform: **Auth, Registry and the IdP
are ports; oidc.js and the fake IdP are adapters; http.js is a driving adapter.** Core code depends only on ports;
adapters never import each other; only composition roots (server/main.js, engine-owned) wire adapters; every adapter
passes its port's contract test.

**Systems design skill:** this job defines ports, so apply the `distributed-systems-design` skill in APPLIER mode
before coding (if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md
and the relevant `references/`). Keep it proportionate: a short note in the report on what it changed or confirmed
(failure behaviour of each port, what a second adapter must honour).

## The manager's audit (confirm or correct it; don't trust it)

| Where | Finding |
|---|---|
| server/registry/sqlite.js:18, postgres.js:20 (+ type import postgres.js:38) | engine's Registry adapters import `mint` from `server/auth/registry.js`, the in-memory **adapter**. Cross-adapter import: the one real violation. |
| server/auth/dev.js:5, port.js:15 | JSDoc `Identity` type imported from oidc.js (an adapter). Type-only, but the type belongs to a port. |
| server/auth/registry.js | port pieces (`mint`, `RegistryError`, the `Registry` typedef) live inside the memory adapter. |
| http.js | driving adapter; takes `oidc`, `sessions`, `registry`, `tenancy` injected. Calls `oidc.begin()` / `oidc.finish()`: that shape is the IdP port, but it is written down nowhere and has no contract test. |
| server/admin/boards.js | core use cases; imports only auth/util.js. Looks fine; check. |
| test/architecture.test.js | doesn't exist (engine owns it). |

## Do

1. **Port modules, no adapter code in them:**
   - `server/auth/registry-port.js`: `mint`, `RegistryError`, the `Registry` typedef. `server/auth/registry.js` (memory
     adapter) imports from it; keep a re-export of `mint`/`RegistryError` there **only** until engine's files switch.
   - The `Identity` typedef and the IdP port shape (`begin()`, `finish({ code, state, expected })`, failure
     semantics) in a port module (e.g. `server/auth/idp-port.js`); the Auth port (`verify`, `role`) stays defined in
     port.js or moves beside it, your call, say why. oidc.js, dev.js, session.js, port.js import types only from ports.
2. **Contract tests:** an IdP port contract run against `googleOidc` (driven by the existing fake IdP network) and a
   fake IdP adapter (move/make one under test/auth/); an Auth-verifier contract (`verify(token) → Identity|null`, never
   throws on garbage) run against `sessions` and `devAuth`. Existing tests keep passing.
3. **Engine's three import lines** (server/registry/sqlite.js:18, postgres.js:20, postgres.js:38): engine (t14j)
   agreed. Switch exactly those lines to `../auth/registry-port.js`, nothing else in those files. These files may be
   engine-uncommitted: platform's commit won't include them, so **keep the re-export in auth/registry.js** (marked
   "until engine's registry adapters import registry-port.js") and say in the report which lines you changed.
4. **Import-rule test** `test/auth/architecture.test.js`, scoped to server/auth and server/admin: parse each file's
   imports (static `import`, `import()` and JSDoc `import("…")` types); fail if an adapter file imports another
   adapter, or a core file (tenancy.js, admin/boards.js, util.js, session.js?: classify each file in a table in the
   test) imports an adapter. Must fail on the current tree's violation before your fix (show it).

## Files you own

server/auth/, server/admin/, test/auth/. With engine's agreement only: the three import lines above. Nothing else
(not main.js, not test/server/).

## Done when

Imports follow the rule (the new test proves it and fails on a re-introduced violation); contract tests pass for every
adapter; behaviour unchanged (every existing test passes; `bun test` full suite passes, and if a full run fails,
name the failing tests: `bun test 2>&1 | grep -E '\(fail\)'`). Report: file classification table, what moved, the
skill note, not-verified, risks. Then stop. Do not commit.
