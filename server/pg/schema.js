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

/** The column names a table's DDL (the cluster test `ddlColumns equals the catalog` checks it against Postgres for every table of the Store and the Registry) (`tables` entries: "col defs, constraints") declares: its depth-0 comma parts, minus table constraints. */
export function ddlColumns(defs) {
  const parts = []; let depth = 0, cur = "";
  let quoted = false;   // inside "…" (an identifier may hold a comma or a parenthesis)
  for (const ch of defs) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted) { if (ch === "(") depth++; else if (ch === ")") depth--; }
    if (ch === "," && depth === 0 && !quoted) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(p)).map(p => p.split(/\s+/)[0].replace(/"/g, ""));
}

/**
 * The old-format rule: refuses to start when any table of `tables` ({ name: "column definitions" }, as `migrate` takes them)
 * already exists with other columns than its DDL declares (the adapters never ALTER). Without it the server starts and every call that touches
 * the table fails later with an obscure 42703. One catalog query for all tables. Call inside the start-up transaction, BEFORE
 * `migrate`. The advice is always to reset the whole store: dropping one table is unsafe (the Store's `pl_leases` holds every
 * board's epoch, which would restart at 1 and un-fence old holders), so no table is ever advised on its own.
 * @param {*} tx @param {string} schema @param {Record<string, string>} tables
 */
export async function assertShapes(tx, schema, tables) {
  const s = needSchema(schema);
  // pg_catalog, not information_schema.columns: that view shows only columns the role holds a privilege on, so a limited role would see none.
  const rows = await tx.unsafe(`SELECT c.relname AS t, string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname`, [s, Object.keys(tables)]);
  const have = new Map(rows.map(r => [r.t, r.cols]));
  for (const [t, defs] of Object.entries(tables)) {
    const need = ddlColumns(defs).sort().join(",");
    if (have.has(t) && have.get(t) !== need)
      throw Object.assign(new Error(`postgres: table "${s}".${t} has columns (${have.get(t)}) but this version needs (${need}): it is from an older version. `
        + `Reset the store: drop the schema "${s}" (every table in it, never one), and the next start-up recreates it`), { code: "old-format" });
  }
}
