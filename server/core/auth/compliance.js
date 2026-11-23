// @ts-check
// Compliance domain service (#34): per-board & whole-tenant data export + GDPR user erasure.
// Core: depends ONLY on the Registry port (`server/auth/registry-port.js`) and core helpers (no adapter imports).
//
// Invariants:
//   - Zero secret leakage: share-link tokens (`link.id`), audit targets for `link.*` events, and any secret-like
//     keys in audit details are redacted; exports never include session/OIDC secrets or another tenant's data.
//   - Auditability: every export (`board.exported`, `tenant.exported`) and erasure (`gdpr.erased`) appends an
//     immutable audit log entry via `registry.appendAudit`.
//   - Fail-closed erasure: refuses to erase the last remaining live tenant admin (`409 last-admin`), refuses to
//     report success if admin status cannot be revoked (`409 is-admin`) or if sole ownership / directory removal
//     cannot be completed (`409 still-owns`).

import { liveAdmin } from "../admin/boards.js";
import { BOARD_VERSIONS, RegistryError, TEAMS } from "../../ports/registry.js";
import { normEmail } from "./util.js";

/** @typedef {import("../../ports/registry.js").Registry} Registry */
/** @typedef {import("../../ports/registry.js").Tenant} Tenant */
/** @typedef {import("../../ports/registry.js").Board} Board */
/** @typedef {import("../../ports/registry.js").Space} Space */
/** @typedef {import("../../ports/registry.js").Group} Group */
/** @typedef {import("../../ports/registry.js").Link} Link */
/** @typedef {import("../../ports/registry.js").Invite} Invite */
/** @typedef {import("../../ports/registry.js").AuditEvent} AuditEvent */
/** @typedef {import("../../ports/registry.js").BoardVersionMeta} BoardVersionMeta */
/** @typedef {import("../../ports/idp.js").Identity} Identity */

export const EXPORT_SCHEMA_VERSION = 1;
const AUDIT_PAGE_LIMIT = 200;
const AUDIT_MAX_PAGES = 500;
const SCOPE_PAGE_LIMIT = 500;
const SCOPE_MAX_PAGES = 200;
const MEMBER_BATCH = TEAMS.among;

const SECRET_KEY_RE = /(secret|token|password|hash|cookiekey|clientsecret|linkid|privatekey|apikey)/i;

/**
 * Domain error thrown by compliance operations; mapped to HTTP status codes by `server/auth/http.js`.
 */
export class ComplianceError extends Error {
  /**
   * @param {"forbidden"|"bad-request"|"not-found"|"last-admin"|"is-admin"|"still-owns"} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = "ComplianceError";
    this.code = code;
    this.status = code === "forbidden" ? 403
      : code === "not-found" ? 404
        : code === "bad-request" ? 400
          : 409;
  }
}

const forbidden = () => new ComplianceError("forbidden", "not allowed");
const badRequest = m => new ComplianceError("bad-request", m);
const lastAdmin = () => new ComplianceError("last-admin", "cannot erase the last remaining tenant admin");
const isAdminErr = () => new ComplianceError("is-admin", "cannot revoke tenant admin status with the current registry adapter");
const stillOwnsErr = m => new ComplianceError("still-owns", m);

const validUserId = v => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n]/.test(v) && !v.startsWith("email:");
const validId = v => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n]/.test(v);

/** @param {Tenant} t */
const projectTenant = t => ({
  id: t.id,
  name: t.name ?? null,
  domain: t.domain ?? null,
  domains: Array.isArray(t.domains) ? [...t.domains] : [],
  kind: t.kind,
  createdAt: t.createdAt,
});

/** @param {Board} b */
const projectBoard = b => ({
  id: b.id,
  tenant: b.tenant,
  title: b.title,
  memberRole: b.memberRole ?? null,
  space: b.space ?? null,
  createdAt: b.createdAt,
  trashedAt: b.trashedAt ?? null,
  trashedBy: b.trashedBy ?? null,
  trashedWith: b.trashedWith ?? null,
});

/** @param {Space} s */
const projectSpace = s => ({
  id: s.id,
  tenant: s.tenant,
  group: s.group ?? null,
  name: s.name,
  kind: s.kind,
  owner: s.owner ?? null,
  generalRole: s.generalRole ?? null,
  createdAt: s.createdAt,
  trashedAt: s.trashedAt ?? null,
  trashedBy: s.trashedBy ?? null,
  archivedAt: s.archivedAt ?? null,
});

/** @param {Group} g */
const projectGroup = g => ({
  id: g.id,
  tenant: g.tenant,
  name: g.name,
  generalRole: g.generalRole ?? null,
  createdAt: g.createdAt,
});

/**
 * Redact a share link so raw tokens (`link.id`) or hashes are never exported.
 * @param {Link} link
 */
function redactLink(link) {
  return {
    redacted: true,
    role: link.role,
    expiresAt: link.expiresAt ?? null,
    revoked: Boolean(link.revoked),
    by: link.by,
    createdAt: link.createdAt,
  };
}

/** @param {Invite} inv */
const projectInvite = inv => ({
  id: inv.id,
  board: inv.board,
  email: inv.email,
  role: inv.role,
  expiresAt: inv.expiresAt ?? null,
  revoked: Boolean(inv.revoked),
  by: inv.by,
  createdAt: inv.createdAt,
});

/** @param {BoardVersionMeta} v */
const projectVersionMeta = v => ({
  id: v.id,
  label: v.label,
  createdBy: v.createdBy,
  createdByName: v.createdByName ?? null,
  createdAt: v.createdAt,
  elementCount: v.elementCount,
});

/**
 * Recursively strip any secret-like fields from an arbitrary JSON detail payload.
 * @param {any} value
 * @returns {any}
 */
function sanitizeDetail(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeDetail);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) out[k] = "[redacted]";
    else out[k] = sanitizeDetail(v);
  }
  return out;
}

/**
 * Redact share-link tokens from audit events (e.g. `link.create` / `link.revoke` store `link.id` in `target`).
 * @param {AuditEvent} ev
 */
function redactAuditEvent(ev) {
  const isLinkEvent = typeof ev.action === "string" && ev.action.startsWith("link.");
  return {
    id: ev.id,
    tenant: ev.tenant,
    board: ev.board ?? null,
    actor: ev.actor,
    action: ev.action,
    target: isLinkEvent && ev.target != null ? "[redacted]" : (ev.target ?? null),
    detail: sanitizeDetail(ev.detail ?? null),
    at: ev.at,
  };
}

/**
 * Collect paginated audit events strictly scoped to `tenantId` (and optionally `boardId`).
 * Reports `truncated: true` if the safety page limit is reached before the log is exhausted.
 * @param {Registry} registry
 * @param {string} tenantId
 * @param {string|null} boardId
 */
async function collectAudit(registry, tenantId, boardId) {
  if (typeof registry.listAudit !== "function") return { events: [], truncated: false };
  /** @type {ReturnType<typeof redactAuditEvent>[]} */
  const events = [];
  let before = null;
  let truncated = false;
  for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
    const res = await registry.listAudit({ tenant: tenantId, board: boardId, limit: AUDIT_PAGE_LIMIT, before });
    for (const ev of res.events ?? []) {
      if (ev.tenant !== tenantId) continue;
      if (boardId != null && ev.board !== boardId) continue;
      events.push(redactAuditEvent(ev));
    }
    if (!res.nextBefore || res.nextBefore === before) return { events, truncated: false };
    before = res.nextBefore;
    if (page === AUDIT_MAX_PAGES - 1) truncated = true;
  }
  return { events, truncated };
}

/**
 * Collect all trashed spaces of a tenant (bounded pagination).
 * @param {Registry} registry
 * @param {string} tenantId
 * @returns {Promise<Space[]>}
 */
async function collectTrashedSpaces(registry, tenantId) {
  if (typeof registry.trashedSpaces !== "function") return [];
  /** @type {Space[]} */
  const out = [];
  let after = null;
  for (let page = 0; page < SCOPE_MAX_PAGES; page++) {
    const res = await registry.trashedSpaces(tenantId, { after, limit: 200 });
    for (const sp of res.spaces ?? []) if (sp.tenant === tenantId) out.push(sp);
    if (!res.next || res.next === after) break;
    after = res.next;
  }
  return out;
}

/**
 * Collect all trashed boards of a tenant (bounded pagination).
 * @param {Registry} registry
 * @param {string} tenantId
 * @returns {Promise<Board[]>}
 */
async function collectTrashedBoards(registry, tenantId) {
  if (typeof registry.trashedBoards !== "function") return [];
  /** @type {Board[]} */
  const out = [];
  let after = null;
  for (let page = 0; page < SCOPE_MAX_PAGES; page++) {
    const res = await registry.trashedBoards(tenantId, { after, limit: 200 });
    for (const b of res.boards ?? []) if (b.tenant === tenantId) out.push(b);
    if (!res.next || res.next === after) break;
    after = res.next;
  }
  return out;
}

/**
 * Export a single board's portable compliance archive.
 * Requires `actor` to be a live tenant admin OR a board owner (`403 forbidden` otherwise).
 * Appends an immutable `board.exported` audit event.
 *
 * @param {{ registry: Registry, tenant?: string|null, board: string, actor: Identity, now?: () => number }} params
 */
export async function exportBoardData({ registry, tenant = null, board, actor, now = Date.now }) {
  if (!registry) throw new Error("compliance: registry is required");
  if (!actor || !validUserId(actor.user) || !validId(board)) throw forbidden();
  if (tenant != null && !validId(tenant)) throw forbidden();

  const b = await registry.board(board);
  if (!b) throw forbidden();
  if (tenant != null && b.tenant !== tenant) throw forbidden();

  const t = await registry.tenant(b.tenant);
  if (!t) throw forbidden();

  const [grant, isAdmin, memberRow] = await Promise.all([
    registry.grant(b.id, actor.user),
    liveAdmin(registry, t, actor),
    registry.memberState?.(t.id, actor.user) ?? Promise.resolve(null),
  ]);
  const isOwner = grant === "owner" && !memberRow?.removed;
  if (!isOwner && !isAdmin) throw forbidden();

  const [rawGrants, rawLinks, rawVersions, auditResult] = await Promise.all([
    registry.grants(b.id),
    registry.links(b.id),
    typeof registry.listBoardVersions === "function"
      ? registry.listBoardVersions({ tenantId: t.id, boardId: b.id, limit: BOARD_VERSIONS.maxPerBoard })
      : Promise.resolve([]),
    collectAudit(registry, t.id, b.id),
  ]);

  const grants = rawGrants.map(g => ({ user: g.user, role: g.role }));
  const shareLinks = rawLinks.map(redactLink);
  const versions = rawVersions.map(projectVersionMeta);
  const audit = auditResult.events;

  const ts = now();
  const exportedAt = new Date(ts).toISOString();

  await registry.appendAudit({
    tenant: t.id,
    board: b.id,
    actor: actor.user,
    action: "board.exported",
    target: b.id,
    detail: {
      grantCount: grants.length,
      shareLinkCount: shareLinks.length,
      versionCount: versions.length,
      auditCount: audit.length,
      auditTruncated: auditResult.truncated,
    },
    at: ts,
  });

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    tenant: projectTenant(t),
    board: projectBoard(b),
    grants,
    shareLinks,
    versions,
    audit,
    truncated: {
      audit: auditResult.truncated,
    },
  };
}

/**
 * Export a portable tenant-wide compliance archive.
 * Requires `actor` to be a live tenant admin (`403 forbidden` otherwise).
 * Appends an immutable `tenant.exported` audit event.
 *
 * @param {{ registry: Registry, tenant: string, actor: Identity, now?: () => number }} params
 */
export async function exportTenantData({ registry, tenant, actor, now = Date.now }) {
  if (!registry) throw new Error("compliance: registry is required");
  if (!actor || !validUserId(actor.user) || !validId(tenant)) throw forbidden();

  const t = await registry.tenant(tenant);
  if (!t) throw forbidden();
  if (!(await liveAdmin(registry, t, actor))) throw forbidden();

  const [rawGroups, liveSpaces, trashedSpaces, liveBoards, trashedBoards, rawTeams, emailMembers, dirMembers, totalMemberCount, auditResult] = await Promise.all([
    registry.groups(t.id),
    registry.spaces(t.id),
    collectTrashedSpaces(registry, t.id),
    registry.listBoards(t.id),
    collectTrashedBoards(registry, t.id),
    typeof registry.teams === "function" ? registry.teams(t.id) : Promise.resolve([]),
    typeof registry.tenantMembers === "function" ? registry.tenantMembers(t.id) : Promise.resolve([]),
    typeof registry.findMembers === "function" ? registry.findMembers(t.id, { q: null, limit: TEAMS.find.max }) : Promise.resolve([]),
    typeof registry.memberCount === "function" ? registry.memberCount(t.id) : Promise.resolve(0),
    collectAudit(registry, t.id, null),
  ]);

  const groups = rawGroups.filter(g => g.tenant === t.id).map(projectGroup);

  const spaceMap = new Map();
  for (const sp of [...liveSpaces, ...trashedSpaces]) {
    if (sp.tenant === t.id && !spaceMap.has(sp.id)) spaceMap.set(sp.id, projectSpace(sp));
  }
  const spaces = [...spaceMap.values()];

  const boardMap = new Map();
  for (const b of [...liveBoards, ...trashedBoards]) {
    if (b.tenant === t.id && !boardMap.has(b.id)) boardMap.set(b.id, projectBoard(b));
  }
  const boards = [...boardMap.values()];

  // Collect teams and their memberships.
  const tenantTeams = rawTeams.filter(tm => tm.tenant === t.id);
  const teams = await Promise.all(tenantTeams.map(async tm => ({
    id: tm.id,
    name: tm.name,
    createdAt: tm.createdAt,
    members: typeof registry.teamMembers === "function" ? await registry.teamMembers(tm.id) : [],
  })));

  // Collect per-board direct grants, invites, redacted share-links, and version metadata.
  /** @type {{ boardId: string, user: string, role: string }[]} */
  const grants = [];
  /** @type {ReturnType<typeof projectInvite>[]} */
  const invites = [];
  /** @type {(ReturnType<typeof redactLink> & { boardId: string })[]} */
  const shareLinks = [];
  /** @type {(ReturnType<typeof projectVersionMeta> & { boardId: string })[]} */
  const versions = [];

  for (const b of boards) {
    const [bGrants, bInvites, bLinks, bVersions] = await Promise.all([
      registry.grants(b.id),
      typeof registry.invites === "function" ? registry.invites(b.id) : Promise.resolve([]),
      typeof registry.links === "function" ? registry.links(b.id) : Promise.resolve([]),
      typeof registry.listBoardVersions === "function"
        ? registry.listBoardVersions({ tenantId: t.id, boardId: b.id, limit: BOARD_VERSIONS.maxPerBoard })
        : Promise.resolve([]),
    ]);
    for (const g of bGrants) grants.push({ boardId: b.id, user: g.user, role: g.role });
    for (const inv of bInvites) invites.push(projectInvite(inv));
    for (const l of bLinks) shareLinks.push({ boardId: b.id, ...redactLink(l) });
    for (const v of bVersions) versions.push({ boardId: b.id, ...projectVersionMeta(v) });
  }

  // Collect scoped grants across unit, groups, spaces, and boards.
  /** @type {{ scope: { type: "unit"|"group"|"space"|"board", id: string }, subject: { type: "user"|"team", id: string }, role: string }[]} */
  const scopedGrants = [];
  if (typeof registry.scopedGrants === "function") {
    /** @type {{ type: "unit"|"group"|"space"|"board", id: string }[]} */
    const scopes = [
      { type: "unit", id: t.id },
      ...groups.map(g => ({ type: /** @type {"group"} */ ("group"), id: g.id })),
      ...spaces.map(sp => ({ type: /** @type {"space"} */ ("space"), id: sp.id })),
      ...boards.map(b => ({ type: /** @type {"board"} */ ("board"), id: b.id })),
    ];
    for (const scope of scopes) {
      for (const sg of await registry.scopedGrants(scope)) {
        scopedGrants.push({ scope, subject: sg.subject, role: sg.role });
      }
    }
  }

  // Build complete member list: combine `findMembers` with every user referenced in grants/teams/spaces/admins
  // resolved via `membersAmong` (batches of 200), plus email-only personal-org members.
  const membersByUser = new Map();
  const seenEmails = new Set();
  for (const m of dirMembers) {
    const email = m.email ? normEmail(m.email) : null;
    if (email) seenEmails.add(email);
    membersByUser.set(m.user, { user: m.user, name: m.name ?? null, email });
  }

  const candidateUsers = new Set();
  for (const a of t.admins ?? []) if (!a.startsWith("email:") && !membersByUser.has(a)) candidateUsers.add(a);
  for (const sp of spaces) if (sp.owner && !membersByUser.has(sp.owner)) candidateUsers.add(sp.owner);
  for (const g of grants) if (!membersByUser.has(g.user)) candidateUsers.add(g.user);
  for (const sg of scopedGrants) if (sg.subject.type === "user" && !membersByUser.has(sg.subject.id)) candidateUsers.add(sg.subject.id);
  for (const tm of teams) for (const u of tm.members) if (!membersByUser.has(u)) candidateUsers.add(u);

  if (candidateUsers.size > 0 && typeof registry.membersAmong === "function") {
    const ids = [...candidateUsers];
    for (let i = 0; i < ids.length; i += MEMBER_BATCH) {
      const batch = await registry.membersAmong(t.id, ids.slice(i, i + MEMBER_BATCH));
      for (const m of batch) {
        if (m.removed || membersByUser.has(m.user)) continue;
        const email = m.email ? normEmail(m.email) : null;
        if (email) seenEmails.add(email);
        membersByUser.set(m.user, { user: m.user, name: m.name ?? null, email });
      }
    }
  }

  /** @type {{ user: string|null, name: string|null, email: string|null }[]} */
  const members = [...membersByUser.values()];
  for (const rawEmail of emailMembers) {
    const email = normEmail(rawEmail);
    if (email && !seenEmails.has(email)) {
      seenEmails.add(email);
      members.push({ user: null, name: null, email });
    }
  }
  const membersTruncated = totalMemberCount > membersByUser.size && dirMembers.length >= TEAMS.find.max;

  const admins = Array.isArray(t.admins) ? [...t.admins] : [];
  const audit = auditResult.events;

  const ts = now();
  const exportedAt = new Date(ts).toISOString();

  await registry.appendAudit({
    tenant: t.id,
    board: null,
    actor: actor.user,
    action: "tenant.exported",
    target: t.id,
    detail: {
      spaceCount: spaces.length,
      groupCount: groups.length,
      boardCount: boards.length,
      teamCount: teams.length,
      grantCount: grants.length,
      scopedGrantCount: scopedGrants.length,
      inviteCount: invites.length,
      shareLinkCount: shareLinks.length,
      versionCount: versions.length,
      memberCount: members.length,
      adminCount: admins.length,
      auditCount: audit.length,
      membersTruncated,
      auditTruncated: auditResult.truncated,
    },
    at: ts,
  });

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    tenant: projectTenant(t),
    spaces,
    groups,
    boards,
    teams,
    grants,
    scopedGrants,
    invites,
    shareLinks,
    versions,
    members,
    admins,
    audit,
    truncated: {
      audit: auditResult.truncated,
      members: membersTruncated,
    },
  };
}

/**
 * Determine whether `targetUserId` (or their email) is an admin of `tenant`, and return the list of
 * other live admin entries remaining in `tenant.admins`.
 * @param {Registry} registry
 * @param {Tenant} t
 * @param {string} targetUserId
 * @param {string|null} targetEmail
 */
async function adminStatus(registry, t, targetUserId, targetEmail) {
  const admins = Array.isArray(t.admins) ? t.admins : [];
  const emailEntry = targetEmail ? "email:" + targetEmail : null;
  let isTargetAdmin = false;
  /** @type {string[]} */
  const otherLiveAdmins = [];

  for (const entry of admins) {
    if (entry === targetUserId || (emailEntry && entry === emailEntry)) {
      isTargetAdmin = true;
      continue;
    }
    if (!entry.startsWith("email:")) {
      const state = await registry.memberState?.(t.id, entry);
      if (state?.removed) continue;
    }
    otherLiveAdmins.push(entry);
  }
  return { isTargetAdmin, otherLiveAdmins };
}

/**
 * Check whether `actor` belongs to or has access within `tenant` (used for self-erasure by non-admins).
 * @param {Registry} registry
 * @param {Tenant} t
 * @param {Identity} actor
 */
async function actorBelongsToTenant(registry, t, actor) {
  if (actor.domain && Array.isArray(t.domains) && t.domains.includes(actor.domain)) return true;
  const dir = await registry.memberState?.(t.id, actor.user);
  if (dir) return true;
  const email = actor.email ? normEmail(actor.email) : null;
  if (email && typeof registry.isTenantMember === "function" && await registry.isTenantMember(t.id, email)) return true;
  const boards = await registry.listBoards(t.id);
  for (const b of boards) {
    if (b.tenant !== t.id) continue;
    if (await registry.grant(b.id, actor.user)) return true;
    if (email && (await registry.invitesFor(b.id, email)).some(i => !i.revoked)) return true;
  }
  return false;
}

/**
 * Check if a scope belongs to `tenantId`.
 * @param {Registry} registry
 * @param {string} tenantId
 * @param {{ type: "unit"|"group"|"space"|"board", id: string }} scope
 */
async function scopeBelongsToTenant(registry, tenantId, scope) {
  if (scope.type === "unit") return scope.id === tenantId;
  if (scope.type === "space") return (await registry.space(scope.id))?.tenant === tenantId;
  if (scope.type === "group") return (await registry.group(scope.id))?.tenant === tenantId;
  if (scope.type === "board") return (await registry.board(scope.id))?.tenant === tenantId;
  return false;
}

/**
 * Find a live directory member of `t` (other than `targetUserId`) who can receive sole-owner handoffs.
 * @param {Registry} registry
 * @param {Tenant} t
 * @param {Identity} actor
 * @param {boolean} isAdmin
 * @param {boolean} isSelf
 * @param {string} targetUserId
 * @param {string[]} otherLiveAdmins
 */
async function resolveFallbackOwner(registry, t, actor, isAdmin, isSelf, targetUserId, otherLiveAdmins) {
  if (isAdmin && !isSelf) {
    let row = await registry.memberState?.(t.id, actor.user);
    if (!row && typeof registry.touchMember === "function") {
      await registry.touchMember(t.id, { user: actor.user, name: actor.name, email: actor.email });
      row = await registry.memberState?.(t.id, actor.user);
    }
    if (row && !row.removed) return actor.user;
  }
  for (const candidate of otherLiveAdmins) {
    if (candidate.startsWith("email:") || candidate === targetUserId) continue;
    const row = await registry.memberState?.(t.id, candidate);
    if (row && !row.removed) return candidate;
  }
  return null;
}

/**
 * Erase a user's personal access/memberships within a tenant (GDPR right to erasure).
 * - Requires `actor` to be a live tenant admin, OR self-erasure (`actor.user === targetUserId`) when
 *   not the sole remaining tenant admin.
 * - Refuses to erase the last remaining tenant admin (`409 last-admin`).
 * - Refuses to report success if admin status cannot be revoked (`409 is-admin`) or if sole ownership /
 *   directory removal fails (`409 still-owns`).
 * - Revokes board grants, space/group/unit scoped grants, team memberships, pending invites, and
 *   tenant membership via existing `Registry` port methods, then records an immutable `gdpr.erased` audit event.
 *
 * @param {{ registry: Registry, tenant: string, targetUserId: string, actor: Identity, now?: () => number }} params
 */
export async function eraseUserData({ registry, tenant, targetUserId, actor, now = Date.now }) {
  if (!registry) throw new Error("compliance: registry is required");
  if (!actor || !validUserId(actor.user) || !validId(tenant)) throw forbidden();
  if (!validUserId(targetUserId)) throw badRequest("userId must be a valid user identifier");

  const t = await registry.tenant(tenant);
  if (!t) throw forbidden();

  const isAdmin = await liveAdmin(registry, t, actor);
  const isSelf = actor.user === targetUserId;
  if (!isAdmin && !isSelf) throw forbidden();
  if (!isAdmin && isSelf && !(await actorBelongsToTenant(registry, t, actor))) throw forbidden();

  const memberRow = await registry.memberState?.(t.id, targetUserId) ?? null;
  const targetEmail = normEmail(memberRow?.email ?? (isSelf ? actor.email : null));

  const { isTargetAdmin, otherLiveAdmins } = await adminStatus(registry, t, targetUserId, targetEmail);
  if (isTargetAdmin && otherLiveAdmins.length === 0) throw lastAdmin();

  // Fail closed if the target is a non-sole admin and the Registry adapter cannot revoke admin entries.
  const regExt = /** @type {any} */ (registry);
  if (isTargetAdmin && typeof regExt.removeTenantAdmin !== "function") {
    throw isAdminErr();
  }

  const fallbackOwner = await resolveFallbackOwner(registry, t, actor, isAdmin, isSelf, targetUserId, otherLiveAdmins);

  let revokedGrants = 0;
  let revokedScopedGrants = 0;
  let revokedTeams = 0;
  let revokedInvites = 0;
  let removedMember = false;
  let removedTenantMember = false;
  let adminRevoked = false;

  // 1. Revoke tenant admin status first when applicable so directory removal can also proceed cleanly.
  if (isTargetAdmin && typeof regExt.removeTenantAdmin === "function") {
    await regExt.removeTenantAdmin(t.id, targetUserId);
    if (targetEmail) await regExt.removeTenantAdmin(t.id, "email:" + targetEmail);
    adminRevoked = true;
  }

  // 2. Prefer the atomic `removeMember` port contract when the target is a live directory member.
  if (memberRow && !memberRow.removed && typeof registry.removeMember === "function") {
    const personal = typeof registry.personalSpace === "function" ? await registry.personalSpace(t.id, targetUserId) : null;
    const handover = personal && fallbackOwner && fallbackOwner !== targetUserId
      ? { to: fallbackOwner, name: `${memberRow.name ?? targetUserId}'s space (archived)`.slice(0, 200) }
      : undefined;
    try {
      const out = await registry.removeMember({ tenant: t.id, user: targetUserId, by: actor.user, ...(handover ? { handover } : {}) });
      removedMember = Boolean(out.removed);
      revokedGrants += out.grants ?? 0;
      revokedScopedGrants += out.scopedGrants ?? 0;
      revokedTeams += out.teams ?? 0;
      revokedInvites += out.invites ?? 0;
    } catch (e) {
      if (!(e instanceof RegistryError && e.code === "still-owns")) throw e;
      // Fall through to reassign sole-owned shared spaces/groups and retry `removeMember` below.
    }
  }

  // 3. Explicit port-level revocation for any remaining board grants and pending invites in this tenant.
  const [liveBoards, trashedBoards] = await Promise.all([
    registry.listBoards(t.id),
    collectTrashedBoards(registry, t.id),
  ]);
  const seenBoards = new Set();
  for (const b of [...liveBoards, ...trashedBoards]) {
    if (b.tenant !== t.id || seenBoards.has(b.id)) continue;
    seenBoards.add(b.id);

    const g = await registry.grant(b.id, targetUserId);
    if (g != null) {
      try {
        await registry.setGrant(b.id, targetUserId, null);
        revokedGrants++;
      } catch (e) {
        if (e?.code === "last-owner") {
          if (!fallbackOwner || fallbackOwner === targetUserId) {
            throw stillOwnsErr("user is the sole owner of a board and no live recipient is available");
          }
          await registry.setGrant(b.id, fallbackOwner, "owner");
          await registry.setGrant(b.id, targetUserId, null);
          revokedGrants++;
        } else {
          throw e;
        }
      }
    }

    if (targetEmail) {
      const invs = await registry.invitesFor(b.id, targetEmail);
      for (const inv of invs) {
        if (!inv.revoked) {
          if (await registry.revokeInvite(inv.id)) revokedInvites++;
        }
      }
    }
  }

  // 4. Revoke space / group / unit scoped grants belonging to this tenant (reassigning sole-owned shared scopes).
  if (typeof registry.scopesOf === "function") {
    let after = null;
    for (let page = 0; page < SCOPE_MAX_PAGES; page++) {
      const res = await registry.scopesOf({ type: "user", id: targetUserId }, { after, limit: SCOPE_PAGE_LIMIT });
      for (const sc of res.scopes ?? []) {
        if (!(await scopeBelongsToTenant(registry, t.id, sc))) continue;
        // Personal spaces are handed over atomically by `removeMember`, never via `setScopedGrant`.
        if (sc.type === "space") {
          const sp = await registry.space(sc.id);
          if (sp?.kind === "personal" && sp.owner === targetUserId) continue;
        }
        try {
          await registry.setScopedGrant({ scope: { type: sc.type, id: sc.id }, subject: { type: "user", id: targetUserId }, role: null });
          revokedScopedGrants++;
        } catch (e) {
          if (e?.code === "last-owner") {
            if (!fallbackOwner || fallbackOwner === targetUserId) {
              throw stillOwnsErr(`user is the sole owner of ${sc.type} ${sc.id} and no live recipient is available`);
            }
            await registry.setScopedGrant({ scope: { type: sc.type, id: sc.id }, subject: { type: "user", id: fallbackOwner }, role: "owner" });
            await registry.setScopedGrant({ scope: { type: sc.type, id: sc.id }, subject: { type: "user", id: targetUserId }, role: null });
            revokedScopedGrants++;
          } else {
            throw e;
          }
        }
      }
      if (!res.next || res.next === after) break;
      after = res.next;
    }
  }

  // 5. Revoke team memberships in this tenant.
  if (typeof registry.teams === "function") {
    const teams = await registry.teams(t.id);
    for (const team of teams) {
      if (team.tenant !== t.id) continue;
      const members = await registry.teamMembers(team.id);
      if (!members.includes(targetUserId)) continue;
      try {
        await registry.setTeamMember(team.id, targetUserId, false);
        revokedTeams++;
      } catch (e) {
        if (e?.code === "last-owner") {
          throw stillOwnsErr(`user is the last member of sole-owner team ${team.id}`);
        }
        throw e;
      }
    }
  }

  // 6. Remove personal-org email membership if present.
  if (targetEmail && typeof registry.removeTenantMember === "function") {
    removedTenantMember = Boolean(await registry.removeTenantMember(t.id, targetEmail));
  }

  // 7. Complete directory removal if it was initially blocked by sole ownership; fail closed if removal still fails.
  if (memberRow && !memberRow.removed && !removedMember && typeof registry.removeMember === "function") {
    const personal = typeof registry.personalSpace === "function" ? await registry.personalSpace(t.id, targetUserId) : null;
    const handover = personal && fallbackOwner && fallbackOwner !== targetUserId
      ? { to: fallbackOwner, name: `${memberRow.name ?? targetUserId}'s space (archived)`.slice(0, 200) }
      : undefined;
    try {
      const out = await registry.removeMember({ tenant: t.id, user: targetUserId, by: actor.user, ...(handover ? { handover } : {}) });
      removedMember = Boolean(out.removed);
      revokedGrants += out.grants ?? 0;
      revokedScopedGrants += out.scopedGrants ?? 0;
      revokedTeams += out.teams ?? 0;
      revokedInvites += out.invites ?? 0;
    } catch (e) {
      if (e instanceof RegistryError && (e.code === "still-owns" || e.code === "bad-recipient")) {
        throw stillOwnsErr(e.message);
      }
      if (e instanceof RegistryError && e.code === "is-admin") {
        throw isAdminErr();
      }
      throw e;
    }
  }

  const ts = now();
  const erasedAt = new Date(ts).toISOString();

  await registry.appendAudit({
    tenant: t.id,
    board: null,
    actor: actor.user,
    action: "gdpr.erased",
    target: targetUserId,
    detail: {
      selfErasure: isSelf,
      revokedGrants,
      revokedScopedGrants,
      revokedTeams,
      revokedInvites,
      removedMember,
      removedTenantMember,
      adminRevoked,
    },
    at: ts,
  });

  return {
    erased: true,
    tenant: t.id,
    targetUserId,
    erasedAt,
    selfErasure: isSelf,
    revoked: {
      grants: revokedGrants,
      scopedGrants: revokedScopedGrants,
      teams: revokedTeams,
      invites: revokedInvites,
      memberRemoved: removedMember,
      tenantMemberRemoved: removedTenantMember,
      adminRevoked,
    },
  };
}
