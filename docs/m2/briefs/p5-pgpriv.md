# Brief: p5-pgpriv (Registry on Postgres runs with least privilege)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy or engine. Never pkill/killall; servers/containers you start are recorded and only those stopped. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-pgpriv.md.

## Goal

PROTOCOL.md § Store "Least privilege" (read it) holds for the Store since phase 2: start-up only creates missing
tables (`migrate()` in server/pg/schema.js, to_regclass first), so the server can run as a role that reads and writes
the tables without owning the schema; an operator may create them ahead of time as the owner. Engine's p-arch (main
44dd1aa) made server/registry/postgres.js use that same helper. Do the same for the Registry: read how the Store does
it (server/store/postgres.js header, test/server/pg-store.test.js least-privilege tests) and match it.

- The Registry adapter creates only missing tables via migrate(); never ALTER/DROP/own anything at runtime.
- A test (skipped unless DATABASE_URL is set, as the pg tests are) runs the Registry contract as a role with only
  SELECT/INSERT/UPDATE/DELETE on pre-created tables (owner creates them first), and shows start-up succeeds; another
  shows a missing table with no CREATE right fails loudly with a clear message.
- deploy/: document the owner/runtime role split for the Registry tables (or a ready SQL snippet), in deploy/README.md.
- Run the pg tests for real: start a Postgres the way CI does (Podman here; Docker isn't installed) on a free port,
  record its id, remove it after.
- Systems design (APPLIER, short): concurrent start-up of N nodes against an empty database (two migrate() at once).

## Files you own

server/registry/postgres.js, test/server/pg-registry.test.js (or a new test/server/pg-registry-priv.test.js),
deploy/README.md. Not server/pg/schema.js (engine's; if it needs a change, report it).

## Done when

The above, full `bun test` passes, report. Then stop. Do not commit.
