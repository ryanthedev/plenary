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
//   email:<addr>   anyone by email, before their first sign-in. Matched by server/admin/boards.js only for a
//                  Google caller (user google:<sub>) whose IdP-vouched email is that address AND whose Workspace
//                  domain is the tenant's; a dev token claiming that email never matches. The address must be on
//                  the tenant's own domain (anything else could never match, so it is refused).
// A bare address (`alice@acme.com`) is taken as email:<addr>. Emails are lower-cased. Control characters are refused.

import { normEmail, verifiedEmail, isTenantAdminRecord } from "../auth/util.js";
import { AdminError } from "./boards.js";

/** @typedef {import("../auth/registry-port.js").Registry} Registry */
/** @typedef {import("../auth/registry-port.js").Tenant} Tenant */

export class BootstrapError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.code = "bad-request"; }
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

// What `shown` escapes beyond JSON.stringify's C0, `"` and `\`: DEL, C1, Unicode format characters (bidi overrides,
// zero-width, soft hyphen, tags) and the line/paragraph separators (p5-devadmin2v F1, F2).
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const hex4 = n => "\\u" + n.toString(16).padStart(4, "0");

/**
 * `text` with every control or format character (and U+2028/9) written as `\uXXXX`, nothing else changed, no
 * quoting and no cut. An astral one is `\u{XXXXX}`, or with `json: true` its surrogate pair `\uXXXX\uXXXX`, so a
 * JSON text run through it stays valid JSON (JSON has no `\u{…}`). The one escape behind every operator value this
 * file and scripts/admin-bootstrap.js print (p5-tidyv V1).
 * @param {string} text
 * @param {{ json?: boolean }} [o]
 */
export function escapeUnsafe(text, { json = false } = {}) {
  return text.replace(UNSAFE, c => {
    const n = c.codePointAt(0);
    if (n <= 0xffff) return hex4(n);
    return json ? hex4(c.charCodeAt(0)) + hex4(c.charCodeAt(1)) : `\\u{${n.toString(16)}}`;
  });
}

const SHOWN_MAX = 80;

/**
 * An operator-supplied value as it may be echoed to a terminal: JSON-quoted and escaped by `escapeUnsafe`. A value
 * over 80 code points is cut first (by code point, so no split pair and no half escape) and `…` follows the closing
 * quote; if its first unsafe character was cut off, a note names its code point and position (p5-tidyv V4), so the
 * reader always sees why it was refused.
 * @param {unknown} v
 */
export function shown(v) {
  const cps = Array.from(typeof v === "string" ? v : String(v ?? ""));
  if (cps.length <= SHOWN_MAX) return escapeUnsafe(JSON.stringify(cps.join("")));
  const out = escapeUnsafe(JSON.stringify(cps.slice(0, SHOWN_MAX).join(""))) + "…";
  const at = cps.findIndex(c => new RegExp(UNSAFE.source, "u").test(c));
  if (at < SHOWN_MAX) return out;   // none, or already shown escaped
  const n = cps[at].codePointAt(0);
  return `${out} (U+${n.toString(16).toUpperCase().padStart(4, "0")} at code point ${at + 1})`;
}

/** A Workspace domain, lower-cased and trimmed; throws on anything else (a null domain would mint a tenant per run). */
export function normDomain(d) {
  const s = typeof d === "string" ? d.trim().toLowerCase() : "";
  if (!DOMAIN.test(s)) throw new BootstrapError(`not a domain: ${shown(d)}`);
  return s;
}

// Control characters (C0, DEL, C1) and Unicode format characters (zero-width, bidi overrides): never in an admin name.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * An admin name in its stored form: google:<sub>, dev:<name> or email:<addr>; throws on anything else.
 * With `domain` (the tenant's, already normalised), an email admin must be on exactly that domain: the match in
 * server/admin/boards.js needs the caller's Workspace domain to be the tenant's and Google's `hd` to equal the
 * email's domain, so an address elsewhere could never match anyone. Any control character is refused.
 * @param {unknown} a
 * @param {string} [domain]
 */
export function normAdmin(a, domain) {
  const s = typeof a === "string" ? a.trim() : "";
  if (typeof a === "string" && CONTROL.test(a)) throw new BootstrapError(`admin name has a control character: ${shown(a)}`);
  if (/^google:[^\s]{1,255}$/.test(s) || /^dev:[A-Za-z0-9_.@-]{1,64}$/.test(s)) return s;
  const e = normEmail(s.startsWith("email:") ? s.slice(6) : s);
  if (e && EMAIL.test(e) && e.length <= 320) {
    if (domain === null && !e.endsWith("@gmail.com"))
      throw new BootstrapError(`personal tenant email admin must end in @gmail.com (use google:<sub> for other accounts): ${shown(a)}`);
    if (domain !== undefined && domain !== null && e.slice(e.lastIndexOf("@") + 1) !== domain)
      throw new BootstrapError(`email admin is not on the tenant's domain ${domain}: ${shown(a)}`);
    return "email:" + e;
  }
  throw new BootstrapError(`not an admin name (google:<sub>, dev:<name> or an email): ${shown(a)}`);
}

/**
 * A user id that may hold a content-tier role (#88): `google:<sub>` or `dev:<name>`. An `email:` name is refused: a grant is held by a user id (the admin list alone matches by email before first sign-in).
 * @param {unknown} a
 */
export function normContentAdmin(a) {
  const s = normAdmin(a);
  if (s.startsWith("email:")) throw new BootstrapError(`a content admin is named by user id (google:<sub> or dev:<name>), not an email: ${shown(a)}`);
  return s;
}

/**
 * @param {{ registry: Registry, domain?: string|null, personal?: boolean, admins?: string[], contentAdmins?: string[], contentAdminsPersonal?: string[] }} o
 *   contentAdmins / contentAdminsPersonal: users given the built-in Unit role `content-admin` (every shared Space's boards) or `content-admin-personal` (those and personal spaces) at the Unit. The content tier can be
 *   passed on only by a holder (PROTOCOL.md § Admin levels), so this operator step is the one way the first holder appears. Additive like `admins`: it never removes a grant or replaces any other role (a user already
 *   on `content-admin` is raised to `content-admin-personal` when asked).
 * @returns {Promise<{ tenant: Tenant, created: boolean, added: string[], content: string[], skipped: { user: string, role: string }[] }>}  `added`: admins this call added; `content`: users whose content-tier grant this call set; `skipped`: users asked for a content role who already hold another Unit role (kept; change it from the Unit access page)
 */
export async function bootstrapTenant({ registry, domain, personal = false, admins = [], contentAdmins = [], contentAdminsPersonal = [] }) {
  if (!Array.isArray(admins) || !Array.isArray(contentAdmins) || !Array.isArray(contentAdminsPersonal)) throw new BootstrapError("admins and content admins must be lists");
  const shared = [...new Set(contentAdmins.map(normContentAdmin))], personalRoles = [...new Set(contentAdminsPersonal.map(normContentAdmin))];
  const applyContent = async t => {
    const content = [], skipped = [];
    const scope = { type: "unit", id: t.id };
    for (const [users, role] of [[shared, "content-admin"], [personalRoles, "content-admin-personal"]]) for (const user of users) {
      const subject = { type: "user", id: user }, cur = await registry.scopedGrant(scope, subject);
      if (cur === role || (cur === "content-admin-personal" && role === "content-admin")) continue;   // already there (or higher): nothing to do
      if (cur != null && !(cur === "content-admin" && role === "content-admin-personal")) { skipped.push({ user, role: cur }); continue; }   // additive: a user holding another Unit role keeps it, and the caller is told
      await registry.setScopedGrant({ scope, subject, role });
      content.push(user);
    }
    return { content, skipped };
  };
  if (personal) {
    if (domain !== undefined && domain !== null) throw new BootstrapError("cannot specify both personal and domain");
    const want = [...new Set(admins.map(a => normAdmin(a, null)))];
    const existing = typeof registry.listPersonalTenants === "function" ? await registry.listPersonalTenants() : [];
    let t = existing.find(x => want.some(a => x.admins.includes(a))) ?? existing[0] ?? null;
    let created = false;
    if (!t) {
      t = await registry.createTenant({ domain: null, admins: want });
      created = true;
    }
    const added = created ? want.filter(a => t.admins.includes(a)) : [];
    for (const a of want) {
      if (t.admins.includes(a)) continue;
      await registry.addTenantAdmin(t.id, a);
      added.push(a);
    }
    const { content, skipped } = await applyContent(t);
    return { tenant: (await registry.tenant(t.id)) ?? t, created, added, content, skipped };
  }

  const d = normDomain(domain);
  const want = [...new Set(admins.map(a => normAdmin(a, d)))];

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
  const { content, skipped } = await applyContent(t);
  return { tenant: (await registry.tenant(t.id)) ?? t, created, added, content, skipped };
}

// ---- Self-serve personal orgs & email-based org membership ----

const MEMBER_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ORG_NAME_MAX = 80;
export const MAX_PERSONAL_ORGS_PER_USER = 20;
export const MAX_TENANT_MEMBERS = 500;

const okAuthenticatedCaller = caller =>
  Boolean(caller && typeof caller.user === "string" && (caller.user.startsWith("google:") || caller.user.startsWith("dev:")));

async function recordAudit(registry, entry) {
  if (typeof registry.appendAudit === "function") await registry.appendAudit(entry);
}

/**
 * POST /tenants — any authenticated Google or dev user creates their own personal org (`domain: null`).
 * @param {{ caller: import("../auth/idp-port.js").Identity, name: unknown }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function createPersonalTenant({ caller, name }, { registry, now = Date.now }) {
  if (!okAuthenticatedCaller(caller)) throw new AdminError("forbidden", "not allowed");
  if (typeof name !== "string" || CONTROL.test(name)) throw new AdminError("bad-request", "bad org name");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > ORG_NAME_MAX) throw new AdminError("bad-request", `org name must be 1..${ORG_NAME_MAX} characters`);
  const vEmail = verifiedEmail(caller);
  const existing = typeof registry.tenantsForAdmin === "function"
    ? await registry.tenantsForAdmin(caller.user, vEmail)
    : (typeof registry.listPersonalTenants === "function" ? await registry.listPersonalTenants() : []);
  const personalCount = existing.filter(t => t.domain === null && isTenantAdminRecord(t, caller)).length;
  if (personalCount >= MAX_PERSONAL_ORGS_PER_USER) {
    throw new AdminError("limit", `maximum of ${MAX_PERSONAL_ORGS_PER_USER} personal workspaces reached`);
  }
  const admins = [caller.user];
  if (vEmail) admins.push("email:" + vEmail);
  const t = await registry.createTenant({ name: trimmed, domain: null, admins });
  await recordAudit(registry, {
    tenant: t.id,
    board: null,
    actor: caller.user,
    action: "tenant.create",
    target: t.id,
    detail: { name: t.name },
    at: now(),
  });
  return { id: t.id, name: t.name, domain: t.domain, isAdmin: true };
}

/**
 * GET /tenants — every org the authenticated caller is an admin of or a member of (domain or reg_tenant_members).
 * @param {{ caller: import("../auth/idp-port.js").Identity }} req
 * @param {{ tenancy: { tenantsFor(id: object): Promise<Tenant[]> } }} deps
 */
export async function listTenants({ caller }, { tenancy }) {
  if (!caller || typeof caller.user !== "string") return { tenants: [] };
  const list = typeof tenancy.tenantsFor === "function" ? await tenancy.tenantsFor(caller) : [];
  return {
    tenants: list.map(t => ({
      id: t.id,
      name: t.name ?? t.domain ?? "Personal Workspace",
      domain: t.domain,
      isAdmin: isTenantAdminRecord(t, caller),
    })),
  };
}

const liveTenantAdmin = async (registry, t, caller) => Boolean(t && isTenantAdminRecord(t, caller) && !(await registry.memberState?.(t.id, caller.user))?.removed);

/**
 * GET /tenants/:tenant/members — org admins only; 404 for unknown tenant, 403 for non-admin.
 * Returns human-friendly admin identifiers (stripped `email:` addresses and non-`google:` ids) without leaking raw
 * internal `google:<sub>` ids.
 * @param {{ caller: import("../auth/idp-port.js").Identity, tenant: string }} req
 * @param {{ registry: Registry }} deps
 */
export async function listTenantMembers({ caller, tenant }, { registry }) {
  if (typeof tenant !== "string" || !tenant) throw new AdminError("not-found", "no such tenant");
  const t = await registry.tenant(tenant);
  if (!t) throw new AdminError("not-found", "no such tenant");
  if (!(await liveTenantAdmin(registry, t, caller))) throw new AdminError("forbidden", "not allowed");
  const members = await registry.tenantMembers(t.id);
  const emailAdmins = t.admins.filter(a => a.startsWith("email:")).map(a => a.slice(6));
  const otherAdmins = t.admins.filter(a => !a.startsWith("email:") && !a.startsWith("google:"));
  const admins = [...new Set([...emailAdmins, ...otherAdmins])];
  return { members, admins };
}

/**
 * POST /tenants/:tenant/members — org admins only; personal orgs (`domain === null`) only; validates email, enforces
 * member cap, adds to reg_tenant_members, and audits only when newly added.
 * @param {{ caller: import("../auth/idp-port.js").Identity, tenant: string, email: unknown }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function addTenantMember({ caller, tenant, email }, { registry, now = Date.now }) {
  if (typeof tenant !== "string" || !tenant) throw new AdminError("not-found", "no such tenant");
  const t = await registry.tenant(tenant);
  if (!t) throw new AdminError("not-found", "no such tenant");
  if (!(await liveTenantAdmin(registry, t, caller))) throw new AdminError("forbidden", "not allowed");
  if (t.domain !== null) throw new AdminError("bad-request", "domain workspaces manage membership via their workspace domain");
  if (typeof email !== "string" || CONTROL.test(email)) throw new AdminError("bad-request", "bad email");
  const e = normEmail(email);
  if (!e || e.length > 320 || !MEMBER_EMAIL.test(e)) throw new AdminError("bad-request", "bad email");
  const current = await registry.tenantMembers(t.id);
  if (!current.includes(e) && current.length >= MAX_TENANT_MEMBERS) {
    throw new AdminError("limit", `maximum of ${MAX_TENANT_MEMBERS} org members reached`);
  }
  const res = await registry.addTenantMember(t.id, e);
  if (res?.added !== false) {
    await recordAudit(registry, {
      tenant: t.id,
      board: null,
      actor: caller.user,
      action: "tenant.member.add",
      target: e,
      detail: { email: e },
      at: now(),
    });
  }
  return { email: e };
}

/**
 * DELETE /tenants/:tenant/members/:email — org admins only; 404 if tenant or member not found; audits.
 * @param {{ caller: import("../auth/idp-port.js").Identity, tenant: string, email: unknown }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function removeTenantMember({ caller, tenant, email }, { registry, now = Date.now }) {
  if (typeof tenant !== "string" || !tenant) throw new AdminError("not-found", "no such tenant");
  const t = await registry.tenant(tenant);
  if (!t) throw new AdminError("not-found", "no such tenant");
  if (!(await liveTenantAdmin(registry, t, caller))) throw new AdminError("forbidden", "not allowed");
  const e = normEmail(email);
  if (!e) throw new AdminError("bad-request", "bad email");
  const removed = await registry.removeTenantMember(t.id, e);
  if (!removed) throw new AdminError("not-found", "member not found");
  await recordAudit(registry, {
    tenant: t.id,
    board: null,
    actor: caller.user,
    action: "tenant.member.remove",
    target: e,
    detail: { email: e },
    at: now(),
  });
}
