// The Registry port on Postgres (PROTOCOL.md § Registry): tenants, boards, grants, invites, share links, link uses.
// Same contract and semantics as server/auth/registry.js (memory) and server/registry/sqlite.js; method names are
// stable. Tested by test/auth/registry-contract.js.
//
// Durable = every write transaction commits with `SET LOCAL synchronous_commit = on` (per transaction, because the
// client is a pool). Timestamps (`createdAt`) come from the injected `now()`, never from SQL's clock.
//
// Last owner: `setGrant` takes `SELECT … FOR UPDATE` on the board's row first, then reads the current role and the
// owner count in later statements of the same READ COMMITTED transaction (each sees everything committed before it
// ran), then writes. Two concurrent demotions of one board's last two owners queue on that row lock; the second sees
// the first's commit and throws code "last-owner", changing nothing.
//
// Lookups never throw on bad input: a garbage id (non-string, or a string holding NUL, which Postgres refuses as
// text) resolves to null / [] / false (PROTOCOL.md § Auth: null = `auth`, a throw = `unavailable`).
//
// Least privilege (PROTOCOL.md § Store, "Least privilege"; the Registry too): start-up creates only what is missing
// (migrate() in server/pg/schema.js for the tables, the same to_regclass look-up here for the two indexes), so the
// server may run as a role with USAGE on the schema and SELECT/INSERT/UPDATE/DELETE on these tables, against a schema
// an owner role created ahead of time. Nothing here ever ALTERs, DROPs or GRANTs. A start-up refused for lack of a
// privilege (a missing table with no CREATE right, or no USAGE) throws "postgres registry: start-up in schema … was
// refused for lack of a privilege (…)", naming both fixes (deploy/README.md, Postgres roles).
//
// Start-up also probes this role's rights on every table (SELECT, INSERT, UPDATE and DELETE, each on its own:
// has_table_privilege with a list means "any of"), so a role with USAGE but no table grants (PG15+ revokes CREATE on
// public, so this is the common mistake) fails start-up with the same message, code "denied", instead of starting
// and then failing every call with 42501.
//
// Timeouts (server/auth/registry-port.js, Failure semantics: a timeout REJECTS). Every statement is bounded on the
// server: `lock_timeout` (lockTimeoutMs) and `statement_timeout` (statementTimeoutMs), both 15 s by default.
//   - The pool the adapter opens from `url` gets both as session settings (start-up parameters, no extra round trip).
//   - Every write transaction also sets both with SET LOCAL, in the round trip that sets synchronous_commit, so writes
//     are bounded on a caller's `sql` too. Reads on a caller's `sql` use that client's session settings (pass
//     `connection: { lock_timeout, statement_timeout }` when you build it); without them only the client-side
//     backstop below bounds them for the caller, and the connection stays busy until the lock clears.
//   - A call that runs out on the server rejects with a PgRegistryError: code "lock-timeout" (55P03, waited
//     lockTimeoutMs for a lock) or "statement-timeout" (57014 with Postgres's statement-timeout message, ran past
//     statementTimeoutMs; with equal limits this one fires first on a lock wait too). The connection is usable again
//     at once: Postgres cancels the statement, not the session. Any other cancel passes through unchanged.
//
// The gate (client side). Bun's pool queues calls on busy connections and a server limit only starts once a call is
// sent, so without a gate the k-th call queued behind a lock rejects at about k x the limit, and reads of unlocked
// tables stall behind it too (p5-pgpriv2v H1, M1; measured on Bun 1.4.4 with prepared statements). So every call
// passes this adapter's own gate first:
//   - At most `maxInFlight` calls are sent at once (default: the pool's `max`, or 10, Bun's default), so Bun always
//     has a free connection for a sent call and never queues it. Each call holds one connection at a time.
//   - Up to `maxQueued` more wait here, in order (default 10 x maxInFlight). Past that a call rejects at once with
//     code "overloaded" (nothing sent): shed load fast, fail closed; callers decide whether to retry.
//   - A call still waiting here after `queueTimeoutMs` (default 0.2 x the smaller limit + 50 ms) rejects with code
//     "queue-timeout" and is never sent: "queue-timeout" always means the call did nothing. The deadline is also
//     checked where a waiting call is taken to be sent, so a call is not sent late after an event-loop stall.
//   - Once sent, the server limits answer. A backstop (code "client-timeout", the larger limit + 1 s after sending)
//     bounds the whole call: a peer that never answers, reads on a caller's `sql` without session limits, and a
//     multi-statement call whose statements each stayed under the limit. It does NOT mean nothing happened (a write
//     may still commit). The call keeps its slot until it really settles.
//   - So a caller hears back within about queueTimeoutMs + the limit that applies (+ 1 s only past the backstop).
//     Basing the queue wait on the smaller limit means calls queued behind a stuck lock give up before a second
//     wave is sent, whichever limit fires: measured, every call settles by about 1 x the lock limit.
//   - The gate sizes itself to the pool's `max`, assuming this Registry is that pool's only user; a caller's `sql`
//     shared with other users (the Store) can bring Bun's queueing back. Pass maxInFlight below the pool size then.
//   - close() rejects every waiting call ("registry: closed"). No retries inside the adapter.
//   - Cluster gateways: set statementTimeoutMs (and lockTimeoutMs) to 3-5 s, above the gateway's 2 s
//     recheckLookupMs. That keeps queueTimeoutMs (0.65-1.05 s) below 2 s, so a re-check the gateway has given up on
//     is never sent; with the 15 s defaults queueTimeoutMs is 3050 ms and it can be. It also pins each connection for
//     less time under a stuck lock. The 15 s default matches the Store.
//   - The start-up transaction waits at most lockTimeoutMs for the schema's start-up lock (the Store does the same),
//     then fails with code "lock-timeout": a wedged migrator or hung node must fail start-up loudly, not hang it.
//
// The factory is async (schema created on start, idempotently, under an advisory lock). Pass `url` (the adapter
// owns that pool) or `sql` (a Bun SQL client you own). `schema` names the Postgres schema. Never reads env.

import { SQL } from "bun";
import { mint } from "../auth/registry-port.js";
import { normEmail } from "../auth/util.js";
import { needSchema, migrate } from "../pg/schema.js";

/**
 * Thrown by `setGrant` when the change would leave a board with no owner ("last-owner"), by a call that ran out of time
 * on the server ("lock-timeout", "statement-timeout"), and by the client-side gate ("overloaded" and "queue-timeout":
 * never sent; "client-timeout": sent, no answer). Match on `err.code`.
 */
export class PgRegistryError extends Error {
  /** @param {"last-owner" | "lock-timeout" | "statement-timeout" | "overloaded" | "queue-timeout" | "client-timeout"} code */
  constructor(code, message, options) { super(message, options); this.name = "RegistryError"; this.code = code; }
}

const UNIQUE = "23505";
/** SQLSTATEs: insufficient_privilege; lock_not_available (lock_timeout fired); query_canceled (statement_timeout). */
const DENIED = "42501", LOCK_TIMEOUT = "55P03", CANCELED = "57014";
/** The table rights a runtime role needs, probed one by one at start-up. */
const RIGHTS = ["SELECT", "INSERT", "UPDATE", "DELETE"];
/** How long after sending a call the client-side backstop fires, past the larger server limit. */
const BACKSTOP_MS = 1000;
/** A timeout setting in whole ms, at least 1 (0 would mean "no limit" to Postgres). */
const ms = v => Math.max(1, Math.floor(Number(v) || 0));

/**
 * The Registry's tables, in foreign-key order (§ Registry, § Store "Least privilege"). Created by `migrate`
 * (server/pg/schema.js), which looks each one up first and creates only what is missing; an operator may create them
 * ahead of time as the owner role. `$S` stands for the quoted schema name. Identity columns (`n`) keep insertion
 * order; a runtime role needs no sequence grant for them (identity sequences are used through the table's INSERT).
 */
const REGISTRY_TABLE_DDL = {
  reg_tenants: "id TEXT PRIMARY KEY, domain TEXT UNIQUE, created_at BIGINT NOT NULL",
  reg_tenant_admins: "tenant TEXT NOT NULL REFERENCES $S.reg_tenants(id), member TEXT NOT NULL, n BIGINT GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (tenant, member)",
  reg_boards: "id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES $S.reg_tenants(id), title TEXT NOT NULL, member_role TEXT, created_at BIGINT NOT NULL",
  reg_grants: "board TEXT NOT NULL REFERENCES $S.reg_boards(id), member TEXT NOT NULL, role TEXT NOT NULL, n BIGINT GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (board, member)",
  reg_invites: "n BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES $S.reg_boards(id), email TEXT NOT NULL, role TEXT NOT NULL, expires_at BIGINT, revoked BOOLEAN NOT NULL, by_user TEXT, created_at BIGINT NOT NULL",
  reg_links: "n BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES $S.reg_boards(id), role TEXT NOT NULL, expires_at BIGINT, revoked BOOLEAN NOT NULL, by_user TEXT, created_at BIGINT NOT NULL",
  reg_link_uses: "board TEXT NOT NULL, member TEXT NOT NULL, link TEXT NOT NULL REFERENCES $S.reg_links(id), n BIGINT GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (board, member, link)",
};
/** Index name → "table (columns)"; created after the tables, only if missing (to_regclass), like the tables. */
export const REGISTRY_INDEXES = {
  reg_tenant_admins_member: "reg_tenant_admins (member)",
  reg_invites_board: "reg_invites (board, email)",
  reg_links_board: "reg_links (board)",
};
/** The tables' column definitions for one schema (foreign keys name it), as `migrate` takes them. */
export const registryTables = schema => {
  const q = `"${needSchema(schema)}"`;
  return Object.fromEntries(Object.entries(REGISTRY_TABLE_DDL).map(([k, v]) => [k, v.replaceAll("$S", q)]));
};
/** A string Postgres will take as text (no NUL). */
const key = v => typeof v === "string" && !v.includes("\0");
const num = v => (v == null ? null : Number(v));
const nz = v => (v === undefined ? null : v);

/**
 * @param {{ url?: string, sql?: import("bun").SQL, max?: number, schema?: string, now?: () => number,
 *   lockTimeoutMs?: number, statementTimeoutMs?: number, maxInFlight?: number, maxQueued?: number,
 *   queueTimeoutMs?: number }} o
 *   lockTimeoutMs: the longest a statement waits for a lock, and start-up for the schema's start-up lock (default 15 s).
 *   statementTimeoutMs: the longest a statement runs, lock waits included (default 15 s). See "Timeouts" above.
 *   maxInFlight, maxQueued, queueTimeoutMs: the client-side gate (see "The gate" above for the defaults).
 * @returns {Promise<import("../auth/registry-port.js").Registry & { close(): Promise<void>, settings(): Promise<object> }>}
 */
export async function postgresRegistry({ url, sql, max, schema = "public", now = Date.now, lockTimeoutMs = 15_000, statementTimeoutMs = 15_000,
  maxInFlight, maxQueued, queueTimeoutMs }) {
  if (!sql && !url) throw new Error("postgres registry: pass url or sql");
  const s = needSchema(schema);
  const lockMs = ms(lockTimeoutMs), stmtMs = ms(statementTimeoutMs);
  const owned = !sql;
  const db = sql ?? new SQL({ url, ...(max ? { max } : {}),
    connection: { lock_timeout: String(lockMs), statement_timeout: String(stmtMs) } });
  let open = true;
  const T = `"${s}".reg_tenants`, A = `"${s}".reg_tenant_admins`, BD = `"${s}".reg_boards`, G = `"${s}".reg_grants`,
    I = `"${s}".reg_invites`, L = `"${s}".reg_links`, U = `"${s}".reg_link_uses`;

  try {
    await db.begin(async tx => {
      // Bounded by lock_timeout alone: statement_timeout is lifted for start-up (it would fire first on the advisory
      // lock with equal limits, and DDL itself only ever waits on locks), so a stuck holder reads as "lock-timeout".
      await tx.unsafe("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', '0', true)", [String(lockMs)]);
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`plenary-schema:${s}`]);
      await migrate(tx, s, registryTables(s));
      for (const [name, def] of Object.entries(REGISTRY_INDEXES)) {
        const [{ r }] = await tx.unsafe("SELECT to_regclass($1) AS r", [`"${s}".${name}`]);
        if (r === null) await tx.unsafe(`CREATE INDEX ${name} ON "${s}".${def}`);
      }
      // Every right on every table, each on its own (the names are constants and `s` passed needSchema).
      const pairs = Object.keys(REGISTRY_TABLE_DDL).flatMap(t => RIGHTS.map(p => `('${t}', '${p}')`)).join(", ");
      const missing = await tx.unsafe(`SELECT t, p FROM (VALUES ${pairs}) AS v(t, p)
        WHERE NOT has_table_privilege(format('%I.%I', $1::text, t), p)`, [s]);
      if (missing.length) {
        const lack = missing.map(m => `${m.p} on ${m.t}`).join(", ");
        throw Object.assign(new Error(`permission denied: this role lacks ${lack}`), { errno: DENIED });
      }
    });
  } catch (err) {
    if (owned) await db.close();
    if (err?.errno === LOCK_TIMEOUT) {
      throw new PgRegistryError("lock-timeout", `postgres registry: start-up waited ${lockMs} ms for schema "${s}"'s start-up lock, `
        + "held by another session (a migrate or a node starting); try again, or end that session", { cause: err });
    }
    if (err?.errno === DENIED) {
      throw Object.assign(new Error(`postgres registry: start-up in schema "${s}" was refused for lack of a privilege (${err.message}). `
        + "If tables are missing, run the migrate step as the schema owner; otherwise grant this role USAGE on the schema "
        + "and SELECT, INSERT, UPDATE, DELETE on its tables (deploy/README.md, Postgres roles)", { cause: err }), { code: "denied" });
    }
    throw err;
  }

  const ready = () => { if (!open) throw new Error("registry: closed"); };
  /** One durable, bounded write transaction: the timeouts ride the synchronous_commit round trip (a caller's `sql` too). */
  const write = f => db.begin(async tx => {
    await tx.unsafe("SELECT set_config('synchronous_commit', 'on', true), set_config('lock_timeout', $1, true), "
      + "set_config('statement_timeout', $2, true)", [String(lockMs), String(stmtMs)]);
    return f(tx);
  });
  /** A Postgres timeout as a coded rejection; anything else unchanged. */
  const timedOut = (name, err, stmtLimit = stmtMs) => {
    if (err?.errno === LOCK_TIMEOUT) return new PgRegistryError("lock-timeout", `postgres registry: ${name} waited over ${lockMs} ms for a lock`, { cause: err });
    // 57014 is any cancel; only statement_timeout's is ours to name (an operator's pg_cancel_backend passes through).
    if (err?.errno === CANCELED && /statement timeout/.test(err.message)) return new PgRegistryError("statement-timeout", `postgres registry: ${name} ran past ${stmtLimit} ms (statement_timeout)`, { cause: err });
    return err;
  };
  const one = async (q, text, params) => (await q.unsafe(text, params))[0] ?? null;
  /** A fresh server-minted id: retried on the (astronomically rare) collision. */
  const fresh = async (q, f, table) => {
    for (;;) { const id = f(); if (!(await one(q, `SELECT 1 AS x FROM ${table} WHERE id = $1`, [id]))) return id; }
  };

  const getTenant = async (q, id) => {
    const r = await one(q, `SELECT id, domain, created_at FROM ${T} WHERE id = $1`, [id]);
    if (!r) return null;
    const admins = (await q.unsafe(`SELECT member FROM ${A} WHERE tenant = $1 ORDER BY n`, [id])).map(a => a.member);
    return { id: r.id, domain: r.domain, admins, createdAt: num(r.created_at) };
  };
  const rowBoard = r => r && { id: r.id, tenant: r.tenant, title: r.title, memberRole: r.member_role, createdAt: num(r.created_at) };
  const rowInvite = r => r && { id: r.id, board: r.board, email: r.email, role: r.role, expiresAt: num(r.expires_at), revoked: !!r.revoked, by: r.by_user, createdAt: num(r.created_at) };
  const rowLink = r => r && { id: r.id, board: r.board, role: r.role, expiresAt: num(r.expires_at), revoked: !!r.revoked, by: r.by_user, createdAt: num(r.created_at) };
  const boardExists = async (q, id) => key(id) && !!(await one(q, `SELECT 1 AS x FROM ${BD} WHERE id = $1`, [id]));

  const api = {
    async createTenant({ domain, admins = [] }) {
      ready();
      const d = domain ? String(domain).toLowerCase() : null;
      const list = [...admins].map(String);
      const createdAt = now();
      try {
        return await write(async tx => {
          if (d && (await one(tx, `SELECT 1 AS x FROM ${T} WHERE domain = $1`, [d]))) throw new Error("registry: domain already has a tenant");
          const id = await fresh(tx, mint.tenant, T);
          await tx.unsafe(`INSERT INTO ${T} (id, domain, created_at) VALUES ($1, $2, $3)`, [id, d, createdAt]);
          for (const a of list) await tx.unsafe(`INSERT INTO ${A} (tenant, member) VALUES ($1, $2) ON CONFLICT (tenant, member) DO NOTHING`, [id, a]);
          return getTenant(tx, id);
        });
      } catch (err) {
        // Two creates for one domain at once: the unique key decides, with the same answer as the check above.
        if (err?.errno === UNIQUE && err?.constraint?.endsWith("domain_key")) throw new Error("registry: domain already has a tenant");
        throw err;
      }
    },
    async tenant(id) { ready(); return key(id) ? getTenant(db, id) : null; },
    async tenantByDomain(domain) {
      ready();
      if (!key(domain) || !domain) return null;
      const r = await one(db, `SELECT id FROM ${T} WHERE domain = $1`, [domain.toLowerCase()]);
      return r ? getTenant(db, r.id) : null;
    },
    async tenantAdminsAmong(users, { timeoutMs } = {}) {
      ready();
      const us = users.filter(key);
      if (!us.length) return [];
      const ask = q => q.unsafe(`SELECT DISTINCT member FROM ${A} WHERE member = ANY($1::text[])`, [us]);
      // With a bound, the server itself cancels the query when it runs over (statement_timeout, this transaction only), so
      // a caller that gave up does not leave it holding a pool slot until the pool's own limit.
      const bound = Number.isSafeInteger(timeoutMs) && timeoutMs > 0;
      try {
        const rows = bound
          ? await db.begin(async tx => { await tx.unsafe("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]); return ask(tx); })
          : await ask(db);
        return rows.map(r => r.member);
      } catch (err) { throw timedOut("tenantAdminsAmong", err, bound ? timeoutMs : stmtMs); }
    },
    async addTenantAdmin(tenant, user) {
      ready();
      if (!key(tenant)) throw new Error("registry: no such tenant");
      await write(async tx => {
        if (!(await one(tx, `SELECT 1 AS x FROM ${T} WHERE id = $1`, [tenant]))) throw new Error("registry: no such tenant");
        await tx.unsafe(`INSERT INTO ${A} (tenant, member) VALUES ($1, $2) ON CONFLICT (tenant, member) DO NOTHING`, [tenant, String(user)]);
      });
    },

    async createBoard({ tenant, title = "", memberRole = "viewer" }) {
      ready();
      if (!key(tenant)) throw new Error("registry: no such tenant");
      const createdAt = now();
      return write(async tx => {
        // Nothing deletes tenants today; the foreign key is the fence if that changes.
        if (!(await one(tx, `SELECT 1 AS x FROM ${T} WHERE id = $1`, [tenant]))) throw new Error("registry: no such tenant");
        const id = await fresh(tx, mint.board, BD);
        await tx.unsafe(`INSERT INTO ${BD} (id, tenant, title, member_role, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [id, tenant, String(title), nz(memberRole), createdAt]);
        return rowBoard(await one(tx, `SELECT * FROM ${BD} WHERE id = $1`, [id]));
      });
    },
    async board(id) { ready(); return key(id) ? rowBoard(await one(db, `SELECT * FROM ${BD} WHERE id = $1`, [id])) : null; },

    async setGrant(board, user, role) {
      ready();
      if (!key(board)) throw new Error("registry: no such board");
      const u = String(user), r = nz(role);
      await write(async tx => {
        // The board row lock serialises every grant change on this board; the reads below run after it is held.
        if (!(await one(tx, `SELECT id FROM ${BD} WHERE id = $1 FOR UPDATE`, [board]))) throw new Error("registry: no such board");
        const cur = (await one(tx, `SELECT role FROM ${G} WHERE board = $1 AND member = $2`, [board, u]))?.role ?? null;
        if (cur === "owner" && r !== "owner") {
          const c = Number((await one(tx, `SELECT count(*) AS c FROM ${G} WHERE board = $1 AND role = 'owner'`, [board])).c);
          if (c <= 1) throw new PgRegistryError("last-owner", "a board keeps at least one owner");
        }
        if (r == null) await tx.unsafe(`DELETE FROM ${G} WHERE board = $1 AND member = $2`, [board, u]);
        else await tx.unsafe(`INSERT INTO ${G} (board, member, role) VALUES ($1, $2, $3)
          ON CONFLICT (board, member) DO UPDATE SET role = excluded.role`, [board, u, r]);
      });
    },
    async grant(board, user) {
      ready();
      if (!key(board) || !key(user)) return null;
      return (await one(db, `SELECT role FROM ${G} WHERE board = $1 AND member = $2`, [board, user]))?.role ?? null;
    },
    async grants(board) {
      ready();
      if (!key(board)) return [];
      return (await db.unsafe(`SELECT member, role FROM ${G} WHERE board = $1 ORDER BY n`, [board])).map(r => ({ user: r.member, role: r.role }));
    },

    async createInvite({ board, email, role, expiresAt = null, by }) {
      ready();
      if (!key(board)) throw new Error("registry: no such board");
      const createdAt = now();
      return write(async tx => {
        if (!(await boardExists(tx, board))) throw new Error("registry: no such board");
        const id = await fresh(tx, mint.invite, I);
        await tx.unsafe(`INSERT INTO ${I} (id, board, email, role, expires_at, revoked, by_user, created_at)
          VALUES ($1, $2, $3, $4, $5, false, $6, $7)`, [id, board, normEmail(email), role, nz(expiresAt), nz(by), createdAt]);
        return rowInvite(await one(tx, `SELECT * FROM ${I} WHERE id = $1`, [id]));
      });
    },
    async invite(id) { ready(); return key(id) ? rowInvite(await one(db, `SELECT * FROM ${I} WHERE id = $1`, [id])) : null; },
    async invites(board) {
      ready();
      return key(board) ? (await db.unsafe(`SELECT * FROM ${I} WHERE board = $1 ORDER BY n`, [board])).map(rowInvite) : [];
    },
    async invitesFor(board, email) {
      ready();
      const e = normEmail(email);
      if (!key(board) || !key(e)) return [];
      return (await db.unsafe(`SELECT * FROM ${I} WHERE board = $1 AND email = $2 ORDER BY n`, [board, e])).map(rowInvite);
    },
    async revokeInvite(id) {
      ready();
      if (!key(id)) return false;
      return write(async tx => (await tx.unsafe(`UPDATE ${I} SET revoked = true WHERE id = $1`, [id])).count > 0);
    },

    async createLink({ board, role, expiresAt = null, by }) {
      ready();
      if (!key(board)) throw new Error("registry: no such board");
      const createdAt = now();
      return write(async tx => {
        if (!(await boardExists(tx, board))) throw new Error("registry: no such board");
        const id = await fresh(tx, mint.link, L);
        await tx.unsafe(`INSERT INTO ${L} (id, board, role, expires_at, revoked, by_user, created_at)
          VALUES ($1, $2, $3, $4, false, $5, $6)`, [id, board, role, nz(expiresAt), nz(by), createdAt]);
        return rowLink(await one(tx, `SELECT * FROM ${L} WHERE id = $1`, [id]));
      });
    },
    async link(id) { ready(); return key(id) ? rowLink(await one(db, `SELECT * FROM ${L} WHERE id = $1`, [id])) : null; },
    async links(board) {
      ready();
      return key(board) ? (await db.unsafe(`SELECT * FROM ${L} WHERE board = $1 ORDER BY n`, [board])).map(rowLink) : [];
    },
    async revokeLink(id) {
      ready();
      if (!key(id)) return false;
      return write(async tx => (await tx.unsafe(`UPDATE ${L} SET revoked = true WHERE id = $1`, [id])).count > 0);
    },

    async addLinkUse(link, user) {
      ready();
      if (!key(link)) throw new Error("registry: no such link");
      await write(async tx => {
        const l = await one(tx, `SELECT board FROM ${L} WHERE id = $1`, [link]);
        if (!l) throw new Error("registry: no such link");
        await tx.unsafe(`INSERT INTO ${U} (board, member, link) VALUES ($1, $2, $3)
          ON CONFLICT (board, member, link) DO NOTHING`, [l.board, String(user), link]);
      });
    },
    async linkUses(board, user) {
      ready();
      if (!key(board) || !key(user)) return [];
      return (await db.unsafe(`SELECT link FROM ${U} WHERE board = $1 AND member = $2 ORDER BY n`, [board, user])).map(r => r.link);
    },
    // The optional batch (registry-port.js): one query, the users bound as one JSON array.
    async linkUsesFor(board, users) {
      ready();
      const out = new Map();
      const us = (users ?? []).filter(key);
      if (!key(board) || !us.length) return out;
      const rows = await db.unsafe(`SELECT member, link FROM ${U} WHERE board = $1
        AND member IN (SELECT jsonb_array_elements_text($2::text::jsonb)) ORDER BY member, n`, [board, JSON.stringify(us)]);
      for (const r of rows) { if (!out.has(r.member)) out.set(r.member, []); out.get(r.member).push(r.link); }
      return out;
    },

    /** What a write transaction runs with, read back from Postgres (for /health and tests). */
    settings() {
      return write(async tx => ({
        synchronous_commit: Object.values((await tx.unsafe("SHOW synchronous_commit"))[0])[0],
        fsync: Object.values((await tx.unsafe("SHOW fsync"))[0])[0],
        lock_timeout: Object.values((await tx.unsafe("SHOW lock_timeout"))[0])[0],
        statement_timeout: Object.values((await tx.unsafe("SHOW statement_timeout"))[0])[0],
      }));
    },
    /** What a plain read runs with (the session's settings: the adapter's own pool sets them; a caller's `sql` may not). */
    async readSettings() {
      const [r] = await db.unsafe("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s");
      return { lock_timeout: r.l, statement_timeout: r.s };
    },

    async close() { if (!open) return; open = false; if (owned) await db.close(); },
  };
  // The gate (header, "The gate"). Timers use the real clock, never the injected `now` (tests pin that).
  const limit = Math.max(lockMs, stmtMs);
  const slots = Math.max(1, Math.floor(maxInFlight ?? db.options?.max ?? 10));
  const room = Math.max(0, Math.floor(maxQueued ?? slots * 10));
  const queueMs = ms(queueTimeoutMs ?? Math.ceil(Math.min(lockMs, stmtMs) * 0.2) + 50);
  let running = 0;
  /** Waiting calls, oldest first: each is { send, expire, deadline } (deadline on performance.now()). */
  const waiting = [];
  // An entry past its deadline is never sent, even when its queue timer hasn't fired yet: after an event-loop stall,
  // the I/O that frees a slot (and this pump, in its microtasks) runs before the overdue timer (p5-pgpriv3v M1).
  const pump = () => {
    while (running < slots && waiting.length) {
      const w = waiting.shift();
      if (performance.now() >= w.deadline) w.expire(); else w.send();
    }
  };
  const gated = (name, f) => (...args) => new Promise((resolve, reject) => {
    let settled = false, timer = null;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const send = () => {
      clearTimeout(timer);
      running++;
      timer = setTimeout(() => settle(reject, new PgRegistryError("client-timeout",
        `postgres registry: ${name} was sent but had no answer after ${limit + BACKSTOP_MS} ms (it may still have taken effect)`)), limit + BACKSTOP_MS);
      // The slot is held until the call really settles, even after the backstop answered the caller.
      Promise.resolve().then(() => f(...args)).then(v => settle(resolve, v), err => settle(reject, timedOut(name, err)))
        .finally(() => { running--; pump(); });
    };
    if (running < slots) return send();
    if (waiting.length >= room) {
      return settle(reject, new PgRegistryError("overloaded",
        `postgres registry: ${name} refused: ${running} calls running and ${waiting.length} waiting (nothing sent)`));
    }
    /** Rejects without sending and without taking a slot (the queue timer, or pump finding the deadline passed). */
    const expire = () => settle(reject, new PgRegistryError("queue-timeout",
      `postgres registry: ${name} waited ${queueMs} ms for a free connection and was not sent`));
    const entry = { send, expire, deadline: performance.now() + queueMs, fail: err => settle(reject, err) };
    waiting.push(entry);
    timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      expire();
    }, queueMs);
  });
  for (const [name, f] of Object.entries(api)) if (name !== "close") api[name] = gated(name, f);
  const closeDb = api.close;
  api.close = async () => {
    for (const w of waiting.splice(0)) w.fail(new Error("registry: closed"));
    await closeDb();
  };
  /** The gate's state (for /health and tests). */
  api.gate = () => ({ running, waiting: waiting.length, maxInFlight: slots, maxQueued: room, queueTimeoutMs: queueMs });
  return api;
}
