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

import { normEmail } from "../auth/util.js";

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
 * @param {{ registry: Registry, domain?: string|null, personal?: boolean, admins?: string[] }} o
 * @returns {Promise<{ tenant: Tenant, created: boolean, added: string[] }>}  `added`: admins this call added
 */
export async function bootstrapTenant({ registry, domain, personal = false, admins = [] }) {
  if (!Array.isArray(admins)) throw new BootstrapError("admins must be a list");
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
    return { tenant: (await registry.tenant(t.id)) ?? t, created, added };
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
  return { tenant: (await registry.tenant(t.id)) ?? t, created, added };
}
