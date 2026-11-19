// Shared Postgres start-up helpers for the Postgres adapters (server/store/postgres.js, server/registry/postgres.js).
// Not an adapter of any port: adapter-only support code. Adapters of different ports never import each other,
// so what both need lives here. Core code must not import it
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
 * Which of `names` (tables or indexes in `schema`) don't exist yet, in the order given: ONE lookup (to_regclass per
 * name, server-side) however many names, so a cold start-up of N objects costs 2 round trips, not N+1.
 * @returns {Promise<string[]>}
 */
export async function missing(tx, schema, names) {
  const s = needSchema(schema);
  if (!names.length) return [];
  const rows = await tx.unsafe(`SELECT t FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i)
    WHERE to_regclass(format('%I.%I', $2::text, t)) IS NULL ORDER BY i`, [names, s]);
  return rows.map(r => r.t);
}

/**
 * Creates the schema and each missing table of `tables` ({ name: "column definitions" }), looking them up first
 * (to_regclass, one query: `missing`) and creating only what is missing, in the order given (so foreign keys resolve),
 * in one round trip. Call inside a transaction, after the advisory lock. The caller owns its tables' DDL (the Store's
 * is STORE_TABLES in server/store/postgres.js); an operator may run this as the owner role ahead of time.
 * @param {*} tx  a Bun SQL transaction
 * @param {string} schema
 * @param {Record<string, string>} tables
 */
export async function migrate(tx, schema, tables) {
  const s = needSchema(schema);
  await ensureSchema(tx, s);
  const todo = await missing(tx, s, Object.keys(tables));
  if (todo.length) await tx.unsafe(todo.map(name => `CREATE TABLE "${s}".${name} (${tables[name]})`).join(";\n"));
}

/**
 * Refuses to start on a table whose columns are not exactly `columns` (a store from before a schema change: the adapters never ALTER).
 * Without it the server starts and every call that touches the table fails later with an obscure 42703. Call inside the start-up transaction.
 * @param {*} tx @param {string} schema @param {string} table @param {string[]} columns the expected column names
 */
export async function assertColumns(tx, schema, table, columns) {
  const s = needSchema(schema);
  // pg_catalog, not information_schema.columns: that view shows only columns the role holds a privilege on, so a limited role would see none.
  const have = (await tx.unsafe(`SELECT a.attname AS column_name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`, [s, table])).map(r => r.column_name);
  if (have.length && JSON.stringify(have) !== JSON.stringify([...columns].sort()))
    throw new Error(`postgres: table "${s}".${table} has columns (${have.join(", ")}) but this version needs (${[...columns].sort().join(", ")}): it is from an older version. `
      + `Reset the store, or have the schema owner run DROP TABLE "${s}".${table} (the runtime role cannot); the next start-up recreates it`);
}
