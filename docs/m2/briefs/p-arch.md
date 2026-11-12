# Brief: p-arch (architecture boundary test)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Architecture"), CLAUDE.md, test/purity.test.js (the
pattern to follow), then every .js file under packages/ and server/ (imports only).

- **Your tab:** `worker p-arch (engine): architecture boundary test`. Manager: `manager engine`, terminal `t14j`.
- **You own:** test/architecture.test.js (new) only. Don't edit code; violations become fix jobs.
- **Systems design skill:** apply `distributed-systems-design` (APPLIER mode) before writing (if not listed, read
  /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and its references/).
- **Report:** docs/m2/reports/p-arch.md. Then stop, idle. Don't commit.

## Goal (CEO: hexagonal architecture)

A boundary test, static like purity.test.js (parse import specifiers, no execution), that fails on:
- **core → adapter:** core = packages/protocol/**, server/gateway.js, server/room-host.js, server/server.js (and other
  non-adapter server files: decide and list them); adapters = server/store/*, server/registry/*, server/bus/*,
  server/blobs/*, server/auth/* adapters (oidc, dev), web transports later (client adds web/ rules).
- **adapter → adapter:** any adapter folder importing another adapter folder (an adapter may import its port types and
  shared pure helpers such as server/ids.js; list the allowed shared modules explicitly).
- **only composition roots wire adapters:** server/main.js (and the web entry, client's) may import adapters; nothing
  else outside tests.
- Tests may import anything.

**Shared scanner for other tracks:** put the import-graph scanning in **test/arch-scan.js** (you own it too):
export `importsOf(file)` and `checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots, allowed,
allowlist })` returning violations. test/architecture.test.js uses it for packages/ and server/; client's
test/web/architecture.test.js and platform's test/auth/ rule reuse it. Document its API at the top of the file.

**Current violations** must not turn the shared `bun test` red: record each in an explicit, commented allowlist at
the top of the test (file → import, why), with the test failing on any violation NOT in the list and on any list
entry that no longer occurs (so the list can only shrink). List every allowlisted violation in your report as a
proposed fix job.

## Done when

- The test passes on today's tree, fails on a planted violation of each kind (show it in scratch, not in the repo),
  and `bun test` stays green.

**Known violation to fix in this job (p5-hexv L8):** server/registry/postgres.js imports `needSchema`/`ensureSchema`
from ../store/postgres.js (adapter to adapter). Move both into a shared Postgres helper (e.g. server/pg/schema.js,
not an adapter of any port) that both adapters import; run the Postgres store and registry contracts after.
