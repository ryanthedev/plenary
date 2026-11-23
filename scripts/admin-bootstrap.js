// Operator CLI: create a Workspace domain's tenant and name its first admins (brief p5-devadmin). A composition
// root: it opens the same Registry the server uses and runs bootstrapTenant (server/admin/tenants.js) over it.
//
//   bun scripts/admin-bootstrap.js --domain acme.com --admin alice@acme.com [--admin google:<sub>] [--admin dev:ann] [--content-admin <user>] [--content-admin-personal <user>]
//
// --domain   the Google Workspace domain (the `hd` claim); required
// --admin    required, repeatable; google:<sub>, dev:<name>, or an email on --domain (stored as email:<addr>). An
//            email admin is matched at Google sign-in when Google vouches for that email and the user's Workspace
//            domain is the tenant's, so the first admin can be named before they have ever signed in. An email on
//            another domain, or any control character, is refused (exit 2, naming the entry).
// --content-admin / --content-admin-personal   repeatable; google:<sub> or dev:<name> (never an email): the user gets the Unit role `content-admin` (opens every shared board) or
//            `content-admin-personal` (those and other people's personal spaces). The content tier is passed on only by a holder, so this is how the first holder appears. Additive.
// A user named for a content role who already holds another Unit role is left as is, listed in `skipped`, and the exit code is 1 (everything else was applied).
// --data-dir the single node's data directory (default: PLENARY_DATA_DIR, else ./data), as server/main.js reads it
//
// Which Registry: DATABASE_URL set → Postgres (schema "public", the adapter's default); else SQLite at
// <data dir>/registry.db. Run it with the same environment as the server. Bun loads .env from the cwd.
//
// Idempotent and additive: re-running it changes nothing that is already there, never removes or demotes an
// admin, and is safe while servers run (the Registry settles concurrent creates; see tenants.js). It prints what it
// did as one JSON line; exits 0 on success, 2 on bad arguments, 1 on any other error. No env value is printed.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { bootstrapTenant, normDomain, normAdmin, normContentAdmin, shown, escapeUnsafe } from "../server/core/admin/tenants.js";
import { sqliteRegistry } from "../server/adapters/driven/registry/sqlite.js";
import { postgresRegistry } from "../server/adapters/driven/registry/postgres.js";

const USAGE = "usage: bun scripts/admin-bootstrap.js (--domain <domain> | --personal) --admin <google:sub|dev:name|email> [--admin …] [--content-admin <user>] [--content-admin-personal <user>] [--data-dir <dir>]";

/** @returns {{ domain?: string, personal?: boolean, admins: string[], contentAdmins?: string[], contentAdminsPersonal?: string[], dataDir?: string }} */
export function parseArgs(argv) {
  const o = { admins: [], contentAdmins: [], contentAdminsPersonal: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === "--personal") {
      if (inline !== undefined) throw new UsageError("--personal takes no value");
      o.personal = true;
    } else if (flag === "--domain") {
      const v = value();
      if (v.trim().toLowerCase() === "personal") o.personal = true;
      else o.domain = v;
    } else if (flag === "--admin") o.admins.push(value());
    else if (flag === "--content-admin") o.contentAdmins.push(value());
    else if (flag === "--content-admin-personal") o.contentAdminsPersonal.push(value());
    else if (flag === "--data-dir") o.dataDir = value();
    else throw new UsageError(`unknown argument: ${shown(flag)}`);   // escaped: argv can hold any byte
  }
  if (o.personal && o.domain) throw new UsageError("cannot use both --personal and --domain");
  if (!o.personal && !o.domain) throw new UsageError("--domain or --personal is required");
  // A tenant with no admins can't create boards; refuse rather than make one. Re-runs still only add.
  if (o.admins.length === 0) throw new UsageError("--admin is required (at least one)");
  if (o.personal && !o.contentAdmins.length && !o.contentAdminsPersonal.length) {
    delete o.contentAdmins;
    delete o.contentAdminsPersonal;
  }
  return o;
}
class UsageError extends Error {}

/**
 * @param {string[]} argv   arguments after the script
 * @param {Record<string, string|undefined>} env   read only from here (never process.env), like main.js's start()
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, timeoutMs?: number }} [io]   timeoutMs: the registry open + bootstrap together (default 30 s); past it: exit 1
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env = {}, { out = s => console.log(s), err = s => console.error(s), timeoutMs = 30000 } = {}) {
  let args;
  try {   // validate before opening anything
    args = parseArgs(argv);
    const domain = args.personal ? null : normDomain(args.domain);
    for (const a of args.admins) normAdmin(a, domain);
    for (const a of [...(args.contentAdmins ?? []), ...(args.contentAdminsPersonal ?? [])]) normContentAdmin(a);
  }
  catch (e) { err(`${e.message}\n${USAGE}`); return 2; }

  let registry, store, timer;
  // A database that accepts the connection and never answers (or a host that drops packets) must not hang the CLI.
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
  deadline.catch(() => {});
  try {
    const { tenant, created, added, content, skipped } = await Promise.race([deadline, (async () => {
      if (env.DATABASE_URL) { registry = await postgresRegistry({ url: env.DATABASE_URL }); store = "postgres"; }
      else {
        const dir = args.dataDir || env.PLENARY_DATA_DIR || "./data";
        mkdirSync(dir, { recursive: true });
        registry = sqliteRegistry({ path: join(dir, "registry.db") });
        store = "sqlite";
      }
      return bootstrapTenant({
        registry,
        ...(args.personal ? { personal: true } : { domain: args.domain }),
        admins: args.admins,
        contentAdmins: args.contentAdmins ?? [],
        contentAdminsPersonal: args.contentAdminsPersonal ?? [],
      });
    })()]);
    out(JSON.stringify({ ok: true, registry: store, tenant: tenant.id, domain: tenant.domain, created, added, content, skipped, admins: tenant.admins }));
    if (skipped.length) { err(`not changed: ${skipped.map(x => `${shown(x.user)} already holds ${shown(x.role)}`).join("; ")} (change it from the Unit access page, then run again)`); return 1; }
    return 0;
  } catch (e) {
    // Messages only: a driver error could carry connection details, so no stack and no cause. URLs are redacted
    // first, then the whole line is escaped: a path or database name from argv/env can hold DEL, C1 or bidi
    // characters (p5-tidyv V1). Still valid JSON (`json: true`).
    const line = JSON.stringify({ ok: false, error: e?.code === "bad-request" ? e.message : `failed: ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/gi, "<url>")}` });
    err(escapeUnsafe(line, { json: true }));
    return e?.code === "bad-request" ? 2 : 1;
  } finally {
    clearTimeout(timer);
    try { await Promise.race([registry?.close(), new Promise(r => setTimeout(r, 2000).unref?.())]); } catch { /* closing is best effort, and bounded */ }
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2), process.env));
