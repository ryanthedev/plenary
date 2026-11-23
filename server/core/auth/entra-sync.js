// @ts-check
// Microsoft Entra ID group -> Plenary Teams sync core (#87).
// Pure core: ZERO bare package imports, no adapter imports, deterministic diff computation.
// Applies sync plans strictly through the Registry port.

import { INVITE_ROLES, normEmail } from "./util.js";

/** Roles a Unit admin may assign via Entra group sync by default (no board-owner or content-tier escalation). */
export const ENTRA_DEFAULT_ALLOWED_ROLES = Object.freeze([...INVITE_ROLES]);

/** Roles that may NEVER be assigned through Entra group sync, even if requested. */
export const ENTRA_FORBIDDEN_ROLES = Object.freeze([
  "admin",
  "member",
  "content-admin",
  "content-admin-personal",
]);

const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TEAM_ID_RE = /^[\w-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_ROLE_SET = new Set(ENTRA_FORBIDDEN_ROLES);

/**
 * Typed domain error for Entra sync validation, authorization, and execution failures.
 */
export class EntraSyncError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "EntraSyncError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   groupId: string,
 *   teamId?: string | null,
 *   teamName?: string | null,
 *   role?: string | null,
 * }} RawGroupMapping
 */

/**
 * @typedef {{
 *   teamId: string | null,
 *   teamName: string | null,
 *   role: string | null,
 * }} NormalizedGroupMapping
 */

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   members?: Array<import("../../ports/entra-directory.js").EntraMember | { email?: string | null, mail?: string | null, userPrincipalName?: string | null, id?: string } | string>,
 * }} EntraGroupWithMembers
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   members: string[],
 *   entraGroupId?: string | null,
 * }} CurrentTeamSnapshot
 */

/**
 * @typedef {{
 *   groupId: string,
 *   teamName: string,
 *   role: string | null,
 *   members: string[],
 * }} PlannedTeamCreate
 */

/**
 * @typedef {{
 *   groupId: string,
 *   teamId: string | null,
 *   teamName: string,
 *   email: string,
 *   role?: string | null,
 * }} PlannedMemberChange
 */

/**
 * @typedef {{
 *   code: string,
 *   groupId: string,
 *   memberId?: string | null,
 *   message: string,
 * }} EntraSyncWarning
 */

/**
 * @typedef {{
 *   toCreateTeams: PlannedTeamCreate[],
 *   toAddMembers: PlannedMemberChange[],
 *   toRemoveMembers: PlannedMemberChange[],
 *   unchanged: PlannedMemberChange[],
 *   warnings: EntraSyncWarning[],
 * }} EntraSyncPlan
 */

/**
 * Check whether a normalized email string is a valid, safe email address.
 * @param {string | null} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (typeof email !== "string" || email.length < 3 || email.length > 320) return false;
  if (/[\s\0\r\n]/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain || domain.length > 253) return false;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return true;
}

/**
 * Extract and normalize an email address from an Entra member record or string.
 * @param {any} member
 * @returns {string | null}
 */
function extractMemberEmail(member) {
  if (typeof member === "string") {
    const e = normEmail(member);
    return isValidEmail(e) ? e : null;
  }
  if (!member || typeof member !== "object") return null;
  for (const raw of [member.mail, member.userPrincipalName, member.email]) {
    if (typeof raw === "string" && raw.trim()) {
      const e = normEmail(raw);
      if (isValidEmail(e)) return e;
    }
  }
  return null;
}

/**
 * Validate and normalize an Entra group Object ID -> Plenary Team mapping table.
 * Enforces that no mapping escalates privileges above the acting Unit admin's allowed roles.
 *
 * Accepts:
 * - An array of `{ groupId, teamId?, teamName?, role? }`
 * - A plain object `{ [groupId]: { teamId?, teamName?, role? } }`
 * - A `Map<string, { teamId?, teamName?, role? }>`
 *
 * @param {RawGroupMapping[] | Record<string, Partial<NormalizedGroupMapping>> | Map<string, Partial<NormalizedGroupMapping>>} mappings
 * @param {{ allowedRoles?: readonly string[] }} [opts]
 * @returns {Record<string, NormalizedGroupMapping>}
 */
export function normalizeGroupMapping(mappings, opts = {}) {
  if (mappings == null || typeof mappings !== "object") {
    throw new EntraSyncError("bad-mapping", "mappings must be an array, object, or Map");
  }

  const requestedAllowed = Array.isArray(opts.allowedRoles) ? opts.allowedRoles : ENTRA_DEFAULT_ALLOWED_ROLES;
  const allowedSet = new Set();
  for (const r of requestedAllowed) {
    if (typeof r !== "string") continue;
    const norm = r.trim().toLowerCase();
    if (!norm || FORBIDDEN_ROLE_SET.has(norm)) continue;
    if (INVITE_ROLES.includes(norm)) allowedSet.add(norm);
  }

  /** @type {Array<[string, any]>} */
  const entries = [];
  if (Array.isArray(mappings)) {
    for (const item of mappings) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new EntraSyncError("bad-mapping", "each mapping entry must be an object");
      }
      entries.push([item.groupId, item]);
    }
  } else if (mappings instanceof Map) {
    for (const [k, v] of mappings.entries()) entries.push([k, v]);
  } else {
    for (const [k, v] of Object.entries(mappings)) entries.push([k, v]);
  }

  /** @type {Record<string, NormalizedGroupMapping>} */
  const out = {};
  for (const [rawGroupId, rawVal] of entries) {
    if (typeof rawGroupId !== "string") {
      throw new EntraSyncError("bad-mapping", "groupId must be a non-empty string");
    }
    const groupId = rawGroupId.trim();
    if (!groupId || FORBIDDEN_KEYS.has(groupId) || !GROUP_ID_RE.test(groupId)) {
      throw new EntraSyncError("bad-mapping", `invalid Entra groupId: ${String(rawGroupId).slice(0, 64)}`);
    }
    if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) {
      throw new EntraSyncError("bad-mapping", `mapping for group ${groupId} must be an object`);
    }

    let teamId = null;
    if (rawVal.teamId != null && rawVal.teamId !== "") {
      if (typeof rawVal.teamId !== "string" || !TEAM_ID_RE.test(rawVal.teamId.trim())) {
        throw new EntraSyncError("bad-mapping", `invalid teamId for group ${groupId}`);
      }
      teamId = rawVal.teamId.trim();
    }

    let teamName = null;
    if (rawVal.teamName != null && rawVal.teamName !== "") {
      if (typeof rawVal.teamName !== "string") {
        throw new EntraSyncError("bad-mapping", `invalid teamName for group ${groupId}`);
      }
      const trimmed = rawVal.teamName.trim();
      if (!trimmed || trimmed.length > 200 || trimmed.includes("\0")) {
        throw new EntraSyncError("bad-mapping", `invalid teamName for group ${groupId}`);
      }
      teamName = trimmed;
    }

    /** @type {string | null} */
    let role = "viewer";
    if (rawVal.role === null) {
      role = null;
    } else if (rawVal.role !== undefined) {
      if (typeof rawVal.role !== "string" || !rawVal.role.trim()) {
        throw new EntraSyncError("bad-mapping", `invalid role for group ${groupId}`);
      }
      const normRole = rawVal.role.trim().toLowerCase();
      if (FORBIDDEN_ROLE_SET.has(normRole) || !allowedSet.has(normRole)) {
        throw new EntraSyncError(
          "privilege-escalation",
          `role "${normRole}" is not allowed for Entra group sync on group ${groupId}`,
        );
      }
      role = normRole;
    } else if (!allowedSet.has("viewer")) {
      role = null;
    }

    out[groupId] = { teamId, teamName, role };
  }

  return out;
}

/**
 * Pure deterministic diff between Entra ID groups and Plenary's current Teams.
 *
 * Guarantees:
 * - Idempotent: re-running with the resulting Teams produces empty create/add/remove lists.
 * - Normalizes emails (trimmed, lowercased) and ignores Entra members without valid emails (emitting warnings).
 * - Leaves all non-Entra-managed Teams completely untouched.
 * - Enforces no privilege escalation via `normalizeGroupMapping`.
 *
 * @param {{
 *   entraGroups: EntraGroupWithMembers[],
 *   currentTeams: CurrentTeamSnapshot[],
 *   mappings: RawGroupMapping[] | Record<string, Partial<NormalizedGroupMapping>> | Map<string, Partial<NormalizedGroupMapping>>,
 *   allowedRoles?: readonly string[],
 * }} input
 * @returns {EntraSyncPlan}
 */
export function computeEntraSyncPlan({ entraGroups = [], currentTeams = [], mappings, allowedRoles }) {
  const normalized = normalizeGroupMapping(mappings, { allowedRoles });

  /** @type {Map<string, EntraGroupWithMembers>} */
  const entraById = new Map();
  for (const g of entraGroups ?? []) {
    if (g && typeof g.id === "string" && g.id.trim()) {
      entraById.set(g.id.trim(), g);
    }
  }

  /** @type {Map<string, CurrentTeamSnapshot>} */
  const teamById = new Map();
  /** @type {Map<string, CurrentTeamSnapshot>} */
  const teamByEntraId = new Map();
  /** @type {Map<string, CurrentTeamSnapshot>} */
  const teamByNormName = new Map();

  for (const t of currentTeams ?? []) {
    if (!t || typeof t.id !== "string") continue;
    teamById.set(t.id, t);
    if (typeof t.entraGroupId === "string" && t.entraGroupId.trim()) {
      teamByEntraId.set(t.entraGroupId.trim(), t);
    }
    if (typeof t.name === "string" && t.name.trim()) {
      const key = t.name.trim().toLowerCase();
      if (!teamByNormName.has(key)) teamByNormName.set(key, t);
    }
  }

  /** @type {PlannedTeamCreate[]} */
  const toCreateTeams = [];
  /** @type {PlannedMemberChange[]} */
  const toAddMembers = [];
  /** @type {PlannedMemberChange[]} */
  const toRemoveMembers = [];
  /** @type {PlannedMemberChange[]} */
  const unchanged = [];
  /** @type {EntraSyncWarning[]} */
  const warnings = [];

  const groupIds = Object.keys(normalized).sort();

  for (const groupId of groupIds) {
    const mapEntry = normalized[groupId];
    const entraGroup = entraById.get(groupId);
    if (!entraGroup) {
      warnings.push({
        code: "group-not-found",
        groupId,
        message: `Mapped Entra group "${groupId}" was not found in directory results`,
      });
      continue;
    }

    const targetName = (mapEntry.teamName || (typeof entraGroup.displayName === "string" ? entraGroup.displayName.trim() : "") || groupId).slice(0, 200);

    // Collect deduplicated, valid, normalized emails from Entra members.
    /** @type {Set<string>} */
    const desiredSet = new Set();
    for (const member of entraGroup.members ?? []) {
      const email = extractMemberEmail(member);
      if (!email) {
        const memberId = member && typeof member === "object" && typeof member.id === "string" ? member.id : null;
        warnings.push({
          code: "invalid-email",
          groupId,
          memberId,
          message: `Ignored Entra member${memberId ? ` "${memberId}"` : ""} in group "${groupId}" with missing or invalid email`,
        });
        continue;
      }
      desiredSet.add(email);
    }
    const desiredEmails = [...desiredSet].sort();

    // Match existing Plenary team (explicit teamId > entraGroupId > case-insensitive teamName).
    let existing = null;
    if (mapEntry.teamId) {
      existing = teamById.get(mapEntry.teamId) ?? null;
    }
    if (!existing) {
      existing = teamByEntraId.get(groupId) ?? null;
    }
    if (!existing) {
      existing = teamByNormName.get(targetName.toLowerCase()) ?? null;
    }

    if (!existing) {
      toCreateTeams.push({
        groupId,
        teamName: targetName,
        role: mapEntry.role,
        members: desiredEmails,
      });
      for (const email of desiredEmails) {
        toAddMembers.push({
          groupId,
          teamId: null,
          teamName: targetName,
          email,
          role: mapEntry.role,
        });
      }
      continue;
    }

    // Build normalized existing member map: normalized -> raw stored identifier (usually normalized email).
    /** @type {Map<string, string>} */
    const existingMembers = new Map();
    for (const rawMember of existing.members ?? []) {
      if (typeof rawMember !== "string" || !rawMember.trim()) continue;
      const norm = normEmail(rawMember);
      if (norm && !existingMembers.has(norm)) existingMembers.set(norm, rawMember.trim());
    }

    for (const email of desiredEmails) {
      if (existingMembers.has(email)) {
        unchanged.push({
          groupId,
          teamId: existing.id,
          teamName: existing.name,
          email,
        });
      } else {
        toAddMembers.push({
          groupId,
          teamId: existing.id,
          teamName: existing.name,
          email,
          role: mapEntry.role,
        });
      }
    }

    const existingKeys = [...existingMembers.keys()].sort();
    for (const normMember of existingKeys) {
      if (!desiredSet.has(normMember)) {
        toRemoveMembers.push({
          groupId,
          teamId: existing.id,
          teamName: existing.name,
          email: existingMembers.get(normMember) ?? normMember,
        });
      }
    }
  }

  return {
    toCreateTeams,
    toAddMembers,
    toRemoveMembers,
    unchanged,
    warnings,
  };
}

/**
 * Apply a computed Entra sync plan through the Registry port.
 * Supports `dryRun: true` which returns the plan without performing any Registry writes.
 *
 * @param {{
 *   plan: EntraSyncPlan,
 *   registry: import("../../ports/registry.js").Registry,
 *   tenantId: string,
 *   actor: string | { user: string },
 *   dryRun?: boolean,
 * }} input
 */
export async function applyEntraSyncPlan({ plan, registry, tenantId, actor, dryRun = false }) {
  if (!plan || typeof plan !== "object") {
    throw new EntraSyncError("bad-plan", "plan is required");
  }
  if (!registry) {
    throw new EntraSyncError("bad-registry", "registry is required");
  }
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new EntraSyncError("bad-tenant", "tenantId is required");
  }

  const actorId = typeof actor === "string" ? actor : actor?.user;
  if (typeof actorId !== "string" || !actorId.trim()) {
    throw new EntraSyncError("bad-actor", "actor is required");
  }

  if (dryRun) {
    return {
      dryRun: true,
      applied: false,
      createdTeams: [],
      addedMembers: [],
      removedMembers: [],
      unchanged: plan.unchanged,
      warnings: plan.warnings,
      plan,
    };
  }

  const tenant = await registry.tenant(tenantId);
  if (!tenant) {
    throw new EntraSyncError("not-found", `tenant "${tenantId}" not found`);
  }

  /** @type {Array<{ groupId: string, teamId: string, teamName: string, role: string | null }>} */
  const createdTeams = [];
  /** @type {Array<{ groupId: string, teamId: string, email: string }>} */
  const addedMembers = [];
  /** @type {Array<{ groupId: string, teamId: string, email: string }>} */
  const removedMembers = [];

  /** @type {Map<string, string>} */
  const createdTeamByGroup = new Map();

  for (const item of plan.toCreateTeams) {
    const created = await registry.createTeam({ tenant: tenantId, name: item.teamName });
    createdTeamByGroup.set(item.groupId, created.id);
    createdTeams.push({
      groupId: item.groupId,
      teamId: created.id,
      teamName: created.name,
      role: item.role ?? null,
    });
  }

  for (const item of plan.toAddMembers) {
    const teamId = item.teamId ?? createdTeamByGroup.get(item.groupId) ?? null;
    if (!teamId) continue;
    await registry.setTeamMember(teamId, item.email, true);
    addedMembers.push({ groupId: item.groupId, teamId, email: item.email });
  }

  for (const item of plan.toRemoveMembers) {
    const teamId = item.teamId ?? createdTeamByGroup.get(item.groupId) ?? null;
    if (!teamId) continue;
    await registry.setTeamMember(teamId, item.email, false);
    removedMembers.push({ groupId: item.groupId, teamId, email: item.email });
  }

  if (typeof registry.appendAudit === "function") {
    await registry.appendAudit({
      tenant: tenantId,
      actor: actorId,
      action: "entra.sync",
      target: tenantId,
      detail: {
        createdTeams: createdTeams.length,
        addedMembers: addedMembers.length,
        removedMembers: removedMembers.length,
        unchanged: plan.unchanged.length,
        warnings: plan.warnings.length,
      },
    });
  }

  return {
    dryRun: false,
    applied: true,
    createdTeams,
    addedMembers,
    removedMembers,
    unchanged: plan.unchanged,
    warnings: plan.warnings,
    plan,
  };
}
