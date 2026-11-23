// @ts-check
// Driving HTTP adapter for Microsoft Entra ID group sync (#87):
//   GET  /tenants/:tenant/entra/groups   — Unit admin only: lists available Entra groups for mapping UI
//   POST /tenants/:tenant/entra/sync     — Unit admin only: computes & applies (or dry-runs) Entra -> Teams sync

import {
  EntraSyncError,
  normalizeGroupMapping,
  computeEntraSyncPlan,
  applyEntraSyncPlan,
} from "../../core/auth/entra-sync.js";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const GROUPS_RE = /^\/tenants\/([^/]+)\/entra\/groups\/?$/;
const SYNC_RE = /^\/tenants\/([^/]+)\/entra\/sync\/?$/;

/**
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * Read and parse a JSON object body with a hard byte limit.
 * @param {Request} req
 * @param {number} maxBodyBytes
 * @returns {Promise<{ ok: boolean, body?: Record<string, any>, response?: Response }>}
 */
async function readJsonBody(req, maxBodyBytes) {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    return { ok: false, response: json(415, { error: "unsupported-media-type" }) };
  }
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && /^\d+$/.test(lenHeader) && Number(lenHeader) > maxBodyBytes) {
    return { ok: false, response: json(413, { error: "too-large" }) };
  }
  let raw;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: json(400, { error: "bad-request" }) };
  }
  if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) {
    return { ok: false, response: json(413, { error: "too-large" }) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: json(400, { error: "bad-json" }) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: json(400, { error: "bad-request" }) };
  }
  return { ok: true, body: parsed };
}

/**
 * Build the driving HTTP route handler for `/tenants/:tenant/entra/*`.
 * Returns `null` for any non-matching path (matching `auth-http.js` convention).
 *
 * @param {{
 *   directory: import("../../ports/entra-directory.js").EntraDirectoryPort,
 *   registry: import("../../ports/registry.js").Registry,
 *   resolveSession: (req: Request) => Promise<{ user: string, email?: string | null, domain?: string | null } | null> | { user: string, email?: string | null, domain?: string | null } | null,
 *   isUnitAdmin: (session: { user: string, email?: string | null, domain?: string | null }, tenantId: string, tenant?: import("../../ports/registry.js").Tenant | null) => Promise<boolean> | boolean,
 *   allowedRolesFor?: (session: { user: string, email?: string | null, domain?: string | null }, tenantId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined,
 *   maxBodyBytes?: number,
 * }} deps
 * @returns {(req: Request, parsedUrl?: URL) => Promise<Response | null>}
 */
export function entraSyncRoutes({
  directory,
  registry,
  resolveSession,
  isUnitAdmin,
  allowedRolesFor,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  if (!directory || !registry || typeof resolveSession !== "function" || typeof isUnitAdmin !== "function") {
    throw new Error("entra-sync-http: directory, registry, resolveSession, and isUnitAdmin are required");
  }

  /**
   * Authenticate and verify Unit-admin authorization for `:tenant`.
   * @param {Request} req
   * @param {string} rawTenant
   * @returns {Promise<{ ok: boolean, session?: { user: string, email?: string | null, domain?: string | null }, tenantId?: string, response?: Response }>}
   */
  async function authorize(req, rawTenant) {
    let tenantId;
    try {
      tenantId = decodeURIComponent(rawTenant);
    } catch {
      return { ok: false, response: json(400, { error: "bad-request" }) };
    }
    if (!tenantId || tenantId.includes("\0")) {
      return { ok: false, response: json(400, { error: "bad-request" }) };
    }

    let session;
    try {
      session = await resolveSession(req);
    } catch {
      return { ok: false, response: json(503, { error: "unavailable" }) };
    }
    if (!session || typeof session.user !== "string" || !session.user) {
      return { ok: false, response: json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" }) };
    }

    let tenant;
    try {
      tenant = await registry.tenant(tenantId);
    } catch {
      return { ok: false, response: json(503, { error: "unavailable" }) };
    }

    let allowed = false;
    try {
      allowed = Boolean(await isUnitAdmin(session, tenantId, tenant));
    } catch {
      return { ok: false, response: json(503, { error: "unavailable" }) };
    }
    if (!allowed) {
      return { ok: false, response: json(403, { error: "forbidden" }) };
    }
    if (!tenant) {
      return { ok: false, response: json(404, { error: "not-found" }) };
    }

    return { ok: true, session, tenantId };
  }

  /**
   * @param {Request} req
   * @param {URL} [parsedUrl]
   * @returns {Promise<Response | null>}
   */
  return async function handle(req, parsedUrl) {
    const url = parsedUrl ?? new URL(req.url);
    const path = url.pathname;

    const groupsMatch = GROUPS_RE.exec(path);
    if (groupsMatch) {
      if (req.method !== "GET") {
        return json(405, { error: "method-not-allowed" }, { allow: "GET" });
      }
      const authz = await authorize(req, groupsMatch[1]);
      if (!authz.ok) return authz.response;

      try {
        const groups = await directory.listGroups();
        return json(200, { groups });
      } catch {
        return json(502, { error: "directory-unavailable" });
      }
    }

    const syncMatch = SYNC_RE.exec(path);
    if (syncMatch) {
      if (req.method !== "POST") {
        return json(405, { error: "method-not-allowed" }, { allow: "POST" });
      }
      const authz = await authorize(req, syncMatch[1]);
      if (!authz.ok) return authz.response;

      const parsed = await readJsonBody(req, maxBodyBytes);
      if (!parsed.ok) return parsed.response;

      const { dryRun = false, mappings } = parsed.body;
      if (typeof dryRun !== "boolean") {
        return json(400, { error: "bad-request", message: "dryRun must be a boolean" });
      }
      if (mappings == null) {
        return json(400, { error: "bad-request", message: "mappings is required" });
      }

      const allowedRoles = allowedRolesFor ? await allowedRolesFor(authz.session, authz.tenantId) : undefined;
      let normalized;
      try {
        normalized = normalizeGroupMapping(mappings, { allowedRoles });
      } catch (err) {
        if (err instanceof EntraSyncError && err.code === "privilege-escalation") {
          return json(403, { error: "privilege-escalation", message: err.message });
        }
        return json(400, { error: "bad-request", message: err?.message ?? "invalid mappings" });
      }

      // Fetch directory groups and members for mapped groups.
      let allGroups;
      try {
        allGroups = await directory.listGroups();
      } catch {
        return json(502, { error: "directory-unavailable" });
      }

      const mappedIds = new Set(Object.keys(normalized));
      /** @type {import("../../core/auth/entra-sync.js").EntraGroupWithMembers[]} */
      const entraGroups = [];
      for (const g of allGroups) {
        if (!mappedIds.has(g.id)) continue;
        try {
          const members = await directory.listGroupMembers(g.id);
          entraGroups.push({ ...g, members });
        } catch {
          return json(502, { error: "directory-unavailable" });
        }
      }

      // Snapshot current Plenary Teams and their memberships.
      let currentTeams;
      try {
        const teams = await registry.teams(authz.tenantId);
        currentTeams = await Promise.all(
          teams.map(async t => ({
            id: t.id,
            name: t.name,
            members: await registry.teamMembers(t.id),
          })),
        );
      } catch {
        return json(503, { error: "unavailable" });
      }

      const plan = computeEntraSyncPlan({
        entraGroups,
        currentTeams,
        mappings: normalized,
        allowedRoles,
      });

      try {
        const result = await applyEntraSyncPlan({
          plan,
          registry,
          tenantId: authz.tenantId,
          actor: authz.session.user,
          dryRun,
        });

        return json(200, {
          dryRun,
          tenantId: authz.tenantId,
          summary: {
            createdTeams: dryRun ? plan.toCreateTeams.length : result.createdTeams.length,
            addedMembers: dryRun ? plan.toAddMembers.length : result.addedMembers.length,
            removedMembers: dryRun ? plan.toRemoveMembers.length : result.removedMembers.length,
            unchanged: plan.unchanged.length,
            warnings: plan.warnings.length,
          },
          plan,
          result,
        });
      } catch (err) {
        if (err instanceof EntraSyncError && err.code === "not-found") {
          return json(404, { error: "not-found" });
        }
        return json(503, { error: "unavailable" });
      }
    }

    return null;
  };
}
