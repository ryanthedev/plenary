// Tenant bootstrap: make a Workspace domain's tenant exist and name its first admins (brief p5-devadmin).
// Core over the Registry port; the CLI (scripts/admin-bootstrap.js) and server/main.js's dev path wire it.
//
// Idempotent and additive: creates the tenant if missing, adds the admins it lacks, never removes or demotes anyone.
// Safe to run twice, and concurrently on two nodes: the Registry keeps one tenant per domain (a unique key on
// Postgres, a write transaction on SQLite). The loser of a create race re-reads the winner's tenant by domain and
// adds its own admins to it; addTenantAdmin is "insert if absent" in every adapter. So two runs with different
// admins end with one tenant holding the union.
//
// How an admin is named (`admins` entries):
//   google:<sub>   a Google user (Identity.user), known only after their first sign-in
//   dev:<name>     a dev-token user
//   email:<addr>   anyone by email, before their first sign-in. Matched by server/admin/boards.js when the
//                  caller's IdP-vouched email is that address AND the caller's Workspace domain is the tenant's.
// A bare address (`alice@acme.com`) is taken as email:<addr>. Emails are lower-cased.

import { normEmail } from "../auth/util.js";

/** @typedef {import("../auth/registry-port.js").Registry} Registry */
/** @typedef {import("../auth/registry-port.js").Tenant} Tenant */

export class BootstrapError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.code = "bad-request"; }
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** A Workspace domain, lower-cased and trimmed; throws on anything else (a null domain would mint a tenant per run). */
export function normDomain(d) {
  const s = typeof d === "string" ? d.trim().toLowerCase() : "";
  if (!DOMAIN.test(s)) throw new BootstrapError(`not a domain: ${JSON.stringify(String(d ?? "")).slice(0, 80)}`);
  return s;
}

/** An admin name in its stored form: google:<sub>, dev:<name> or email:<addr>; throws on anything else. */
export function normAdmin(a) {
  const s = typeof a === "string" ? a.trim() : "";
  if (/^google:[^\s]{1,255}$/.test(s) || /^dev:[A-Za-z0-9_.@-]{1,64}$/.test(s)) return s;
  const e = normEmail(s.startsWith("email:") ? s.slice(6) : s);
  if (e && EMAIL.test(e) && e.length <= 320) return "email:" + e;
  throw new BootstrapError(`not an admin name (google:<sub>, dev:<name> or an email): ${JSON.stringify(s).slice(0, 80)}`);
}

/**
 * @param {{ registry: Registry, domain: string, admins?: string[] }} o
 * @returns {Promise<{ tenant: Tenant, created: boolean, added: string[] }>}  `added`: admins this call added
 */
export async function bootstrapTenant({ registry, domain, admins = [] }) {
  const d = normDomain(domain);
  if (!Array.isArray(admins)) throw new BootstrapError("admins must be a list");
  const want = [...new Set(admins.map(normAdmin))];

  let t = await registry.tenantByDomain(d), created = false;
  if (!t) {
    try { t = await registry.createTenant({ domain: d, admins: want }); created = true; }
    catch (err) {
      // Lost a race with another node (or another run): the domain has its tenant now. The adapters throw a plain
      // Error with no code here, so re-read rather than match the message; anything else is rethrown.
      t = await registry.tenantByDomain(d);
      if (!t) throw err;
    }
  }
  const added = created ? want.filter(a => t.admins.includes(a)) : [];
  for (const a of want) {
    if (t.admins.includes(a)) continue;
    await registry.addTenantAdmin(t.id, a);
    added.push(a);
  }
  return { tenant: (await registry.tenant(t.id)) ?? t, created, added };
}
