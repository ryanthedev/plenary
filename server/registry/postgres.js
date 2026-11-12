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
// The factory is async (schema created on start, idempotently, under an advisory lock). Pass `url` (the adapter
// owns that pool) or `sql` (a Bun SQL client you own). `schema` names the Postgres schema. Never reads env.

import { SQL } from "bun";
import { mint } from "../auth/registry-port.js";
import { normEmail } from "../auth/util.js";
import { needSchema, migrate } from "../pg/schema.js";

/** Thrown by `setGrant` when the change would leave a board with no owner. Match on `err.code`. */
export class PgRegistryError extends Error {
  /** @param {"last-owner"} code */
  constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; }
}

const UNIQUE = "23505";
/** Postgres SQLSTATE for "permission denied" (insufficient_privilege). */
const DENIED = "42501";

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
 * @param {{ url?: string, sql?: import("bun").SQL, max?: number, schema?: string, now?: () => number }} o
 * @returns {Promise<import("../auth/registry-port.js").Registry & { close(): Promise<void>, settings(): Promise<object> }>}
 */
export async function postgresRegistry({ url, sql, max, schema = "public", now = Date.now }) {
  if (!sql && !url) throw new Error("postgres registry: pass url or sql");
  const s = needSchema(schema);
  const owned = !sql;
  const db = sql ?? new SQL(max ? { url, max } : url);
  let open = true;
  const T = `"${s}".reg_tenants`, A = `"${s}".reg_tenant_admins`, BD = `"${s}".reg_boards`, G = `"${s}".reg_grants`,
    I = `"${s}".reg_invites`, L = `"${s}".reg_links`, U = `"${s}".reg_link_uses`;

  try {
    await db.begin(async tx => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`plenary-schema:${s}`]);
      await migrate(tx, s, registryTables(s));
      for (const [name, def] of Object.entries(REGISTRY_INDEXES)) {
        const [{ r }] = await tx.unsafe("SELECT to_regclass($1) AS r", [`"${s}".${name}`]);
        if (r === null) await tx.unsafe(`CREATE INDEX ${name} ON "${s}".${def}`);
      }
    });
  } catch (err) {
    if (owned) await db.close();
    if (err?.errno === DENIED) {
      throw new Error(`postgres registry: start-up in schema "${s}" was refused for lack of a privilege (${err.message}). `
        + "If tables are missing, run the migrate step as the schema owner; otherwise grant this role USAGE on the schema "
        + "and SELECT, INSERT, UPDATE, DELETE on its tables (deploy/README.md, Postgres roles)", { cause: err });
    }
    throw err;
  }

  const ready = () => { if (!open) throw new Error("registry: closed"); };
  /** One durable write transaction. */
  const write = f => db.begin(async tx => { await tx.unsafe("SET LOCAL synchronous_commit = on"); return f(tx); });
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

  return {
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

    /** What a write transaction runs with, read back from Postgres (for /health and tests). */
    settings() {
      return write(async tx => ({
        synchronous_commit: Object.values((await tx.unsafe("SHOW synchronous_commit"))[0])[0],
        fsync: Object.values((await tx.unsafe("SHOW fsync"))[0])[0],
      }));
    },

    async close() { if (!open) return; open = false; if (owned) await db.close(); },
  };
}
