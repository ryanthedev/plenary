// Shared Postgres start-up helpers for the Postgres adapters (server/store/postgres.js, server/registry/postgres.js).
// Not an adapter of any port: adapter-only support code. Adapters of different ports never import each other
//, so what both need lives here. Core code must not import it
// (test/architecture.test.js). A leaf: it imports nothing.
//
// Least privilege: Postgres checks CREATE privilege before IF NOT EXISTS, so every helper looks first (pg_namespace,
// to_regclass) and only creates what is missing. A role that may read and write the tables, but not own the schema,
// then starts fine against a schema an owner role migrated, and only an owner ever runs a CREATE.

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/** A schema name we may splice into SQL: lower-case identifier characters only. */
export function needSchema(schema) {
  if (typeof schema !== "string" || !SCHEMA.test(schema)) throw new Error(`postgres: bad schema name ${JSON.stringify(schema)}`);
  return schema;
}

/**
 * Creates the schema unless it exists. The existence check comes first because Postgres checks CREATE on the
 * database before IF NOT EXISTS, so a least-privilege role would fail on a schema an operator made for it.
 * Call inside the start-up transaction, after the advisory lock.
 */
export async function ensureSchema(tx, schema) {
  const s = needSchema(schema);
  if (!(await tx.unsafe("SELECT 1 AS x FROM pg_namespace WHERE nspname = $1", [s])).length) await tx.unsafe(`CREATE SCHEMA "${s}"`);
}

/**
 * Creates the schema and each missing table of `tables` ({ name: "column definitions" }), looking each one up first
 * (to_regclass). Call inside a transaction, after the advisory lock. The caller owns its tables' DDL (the Store's
 * is STORE_TABLES in server/store/postgres.js); an operator may run this as the owner role ahead of time.
 * @param {*} tx  a Bun SQL transaction
 * @param {string} schema
 * @param {Record<string, string>} tables
 */
export async function migrate(tx, schema, tables) {
  const s = needSchema(schema);
  await ensureSchema(tx, s);
  for (const [name, cols] of Object.entries(tables)) {
    const [{ r }] = await tx.unsafe("SELECT to_regclass($1) AS r", [`"${s}".${name}`]);
    if (r === null) await tx.unsafe(`CREATE TABLE "${s}".${name} (${cols})`);
  }
}
