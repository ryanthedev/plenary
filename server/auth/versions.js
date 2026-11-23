// @ts-check
// Board version history & named snapshots (#19): domain service over the Registry port and tenancy.
//
// Roles:
//   - viewer+ (viewer, commenter, annotator, editor, owner) may list and read versions of a live board.
//   - editor+ (editor, owner) may create and delete named snapshots of a live board.
// Unknown boards, trashed boards, cross-tenant boards and callers without sufficient role all get `forbidden`
// so board existence never leaks.
// Caps:
//   - Max versions per board: BOARD_VERSIONS.maxPerBoard (50), enforced atomically in the Registry.
//   - Max snapshot JSON payload: BOARD_VERSIONS.maxSnapshotBytes (2 MB).
//   - Label: control/bidi characters stripped, trimmed, 1..120 chars.

import { AdminError } from "../admin/boards.js";
import { BOARD_VERSIONS } from "./registry-port.js";
import { rank, utf8 } from "./util.js";

// Control characters (C0, DEL, C1), line/paragraph separators, and bidi overrides (keeps ZWJ/emoji intact).
const CONTROL = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

const forbidden = () => new AdminError("forbidden", "not allowed");
const notFound = () => new AdminError("not-found", "version not found");
const bad = m => new AdminError("bad-request", m);

/**
 * Sanitize and validate a snapshot label (<= maxLabelLength chars, non-empty).
 * @param {unknown} raw
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeVersionLabel(raw, maxLen = BOARD_VERSIONS.maxLabelLength) {
  if (typeof raw !== "string") throw bad("label must be a string");
  const clean = raw.replace(CONTROL, "").trim();
  if (!clean) throw bad("label is required");
  if (clean.length > maxLen) throw bad(`label must be at most ${maxLen} characters`);
  return clean;
}

/**
 * Validate snapshot shape, count its elements, and serialize with UTF-8 byte cap.
 * @param {unknown} snapshot
 * @param {number} [maxBytes]
 * @returns {{ snapshotJson: string, elementCount: number }}
 */
export function validateSnapshot(snapshot, maxBytes = BOARD_VERSIONS.maxSnapshotBytes) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw bad("snapshot must be a JSON object");
  }
  const s = /** @type {Record<string, any>} */ (snapshot);
  let elementCount = 0;
  if (s.elements !== undefined) {
    if (Array.isArray(s.elements)) elementCount = s.elements.length;
    else if (s.elements && typeof s.elements === "object") elementCount = Object.keys(s.elements).length;
    else throw bad("snapshot.elements must be an array or object");
  }
  let snapshotJson;
  try { snapshotJson = JSON.stringify(s); } catch { throw bad("snapshot is not serializable"); }
  if (typeof snapshotJson !== "string") throw bad("snapshot is not serializable");
  if (utf8(snapshotJson).byteLength > maxBytes) {
    throw new AdminError("too-large", `snapshot exceeds ${maxBytes} bytes`, { data: { httpStatus: 413 } });
  }
  return { snapshotJson, elementCount };
}

/** @param {import("./registry-port.js").BoardVersionMeta} r */
const toPublicMeta = r => ({
  id: r.id,
  label: r.label,
  createdBy: r.createdBy,
  createdByName: r.createdByName ?? null,
  createdAt: r.createdAt,
  elementCount: r.elementCount,
});

/**
 * @param {{
 *   registry: import("./registry-port.js").Registry,
 *   tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   now?: () => number,
 *   maxPerBoard?: number,
 *   maxSnapshotBytes?: number,
 * }} deps
 */
export function versionService({
  registry,
  tenancy,
  now = Date.now,
  maxPerBoard = BOARD_VERSIONS.maxPerBoard,
  maxSnapshotBytes = BOARD_VERSIONS.maxSnapshotBytes,
}) {
  if (!registry || !tenancy) throw new Error("versions: registry and tenancy are required");

  /**
   * Authorize caller on `boardId` with at least `minRole`.
   * @param {import("./idp-port.js").Identity} caller
   * @param {string} boardId
   * @param {import("./registry-port.js").Role} minRole
   */
  async function authorize(caller, boardId, minRole) {
    if (!caller || typeof caller.user !== "string" || !caller.user || typeof boardId !== "string" || !boardId || boardId.length > 128) {
      throw forbidden();
    }
    const [board, role] = await Promise.all([registry.board(boardId), tenancy.role(caller, boardId)]);
    if (!board || board.trashedAt != null || !role || rank(role) < rank(minRole)) throw forbidden();
    return { board, role };
  }

  return {
    /**
     * List version metadata (newest first, omitting snapshot JSON). Requires viewer+.
     * @param {import("./idp-port.js").Identity} caller
     * @param {string} boardId
     */
    async list(caller, boardId) {
      const { board } = await authorize(caller, boardId, "viewer");
      const rows = await registry.listBoardVersions({ tenantId: board.tenant, boardId: board.id, limit: maxPerBoard });
      return { versions: rows.map(toPublicMeta) };
    },

    /**
     * Create a named snapshot. Requires editor+.
     * @param {import("./idp-port.js").Identity} caller
     * @param {string} boardId
     * @param {{ label?: unknown, snapshot?: unknown }} body
     */
    async create(caller, boardId, body) {
      const { board } = await authorize(caller, boardId, "editor");
      const label = sanitizeVersionLabel(body?.label);
      const { snapshotJson, elementCount } = validateSnapshot(body?.snapshot, maxSnapshotBytes);
      const createdByName = typeof caller.name === "string" && caller.name.trim()
        ? caller.name.replace(CONTROL, "").trim().slice(0, 200) || null
        : null;
      let meta;
      try {
        meta = await registry.createBoardVersion({
          tenantId: board.tenant,
          boardId: board.id,
          label,
          createdBy: caller.user,
          createdByName,
          elementCount,
          snapshotJson,
          maxPerBoard,
          at: now(),
        });
      } catch (e) {
        if (e?.code === "limit") throw new AdminError("limit", `board version limit (${maxPerBoard}) reached`);
        if (e?.code === "in-trash") throw forbidden();
        throw e;
      }
      if (typeof registry.appendAudit === "function") {
        await registry.appendAudit({
          tenant: board.tenant,
          board: board.id,
          actor: caller.user,
          action: "version.create",
          target: meta.id,
          detail: { label: meta.label, elementCount: meta.elementCount },
          at: meta.createdAt,
        });
      }
      return { version: toPublicMeta(meta) };
    },

    /**
     * Fetch a single version with its full parsed snapshot. Requires viewer+.
     * @param {import("./idp-port.js").Identity} caller
     * @param {string} boardId
     * @param {string} versionId
     */
    async get(caller, boardId, versionId) {
      const { board } = await authorize(caller, boardId, "viewer");
      if (typeof versionId !== "string" || !versionId || versionId.length > 128) throw notFound();
      const row = await registry.getBoardVersion({ tenantId: board.tenant, boardId: board.id, versionId });
      if (!row) throw notFound();
      const snapshot = JSON.parse(row.snapshotJson);
      return { version: { ...toPublicMeta(row), snapshot } };
    },

    /**
     * Delete a named snapshot. Requires editor+.
     * @param {import("./idp-port.js").Identity} caller
     * @param {string} boardId
     * @param {string} versionId
     */
    async remove(caller, boardId, versionId) {
      const { board } = await authorize(caller, boardId, "editor");
      if (typeof versionId !== "string" || !versionId || versionId.length > 128) throw notFound();
      const deleted = await registry.deleteBoardVersion({ tenantId: board.tenant, boardId: board.id, versionId });
      if (!deleted) throw notFound();
      if (typeof registry.appendAudit === "function") {
        await registry.appendAudit({
          tenant: board.tenant,
          board: board.id,
          actor: caller.user,
          action: "version.delete",
          target: versionId,
          detail: null,
          at: now(),
        });
      }
      return true;
    },
  };
}
