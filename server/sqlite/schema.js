// Shared SQLite start-up helper for the SQLite adapters (server/store/sqlite.js, server/registry/sqlite.js). Adapter-only
// support code, like server/pg/schema.js: core must not import it (test/architecture.test.js). It imports no project module.
//
// The old-format rule (PROTOCOL.md § Registry, Store): adapters never ALTER a table. A file whose table has other columns
// than this version's DDL is from an older version and is REFUSED at start-up with code "old-format" ("Reset the store"),
// never read silently. The expected columns come from the adapter's own CREATE statements, run on a scratch in-memory
// database, so the DDL is the single source of truth and no column list is written twice.

import { Database } from "bun:sqlite";

/**
 * Refuses a file in which any table `build` creates already exists with different columns. Call BEFORE the first write
 * to the file (no WAL switch, no CREATE): a refused file is left exactly as found.
 * @param {import("bun:sqlite").Database} db the file, opened
 * @param {(scratch: import("bun:sqlite").Database) => void} build runs the adapter's CREATE TABLE statements on the database it is given
 * @param {string} label e.g. "sqlite store"
 */
export function assertShapes(db, build, label) {
  const scratch = new Database(":memory:");
  try {
    build(scratch);
    const cols = (d, t) => d.query(`PRAGMA table_info("${t}")`).all().map(c => c.name).sort().join(",");
    const tables = scratch.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    for (const t of tables) {
      const have = cols(db, t);
      if (have === "") continue;   // not in the file yet: it will be created
      const need = cols(scratch, t);
      if (have !== need) {
        throw Object.assign(new Error(`${label}: table ${t} has columns (${have}) but this version needs (${need}): the file is from an older version. `
          + "Reset the store (delete the file); the next start-up recreates it"), { code: "old-format" });
      }
    }
  } finally { scratch.close(); }
}
