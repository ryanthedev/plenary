// @ts-check
// All-hands audience moderation (PROTOCOL.md § Audience moderation): board lock and per-user mute.
// Pure: imports nothing and uses no host globals, so rooms, browsers, phones and Herdr panes agree.

export const MAX_MUTED_USERS = 200;
export const MAX_MODERATION_USER_ID_CHARS = 128;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * @typedef {object} ModerationState
 * @property {boolean} locked
 * @property {string[]} mutedUsers
 */

/**
 * @typedef {{ allowed: true, reason: null } | { allowed: false, reason: "board-locked" | "user-muted" }} ModerationDecision
 */

/**
 * Safely normalize moderation state from a board's `appState` (either `{ herdr: { moderation } }`
 * or a `herdr` settings object `{ moderation }`). Missing or malformed values default to unlocked
 * with no muted users so boards without moderation behave identically to before.
 * @param {any} appState
 * @returns {ModerationState}
 */
export function moderationOf(appState) {
  let raw = null;
  if (appState && typeof appState === "object") {
    if (hasOwn(appState, "herdr") && appState.herdr && typeof appState.herdr === "object") {
      raw = hasOwn(appState.herdr, "moderation") ? appState.herdr.moderation : null;
    } else if (hasOwn(appState, "moderation")) {
      raw = appState.moderation;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { locked: false, mutedUsers: [] };
  const locked = hasOwn(raw, "locked") && raw.locked === true;
  /** @type {string[]} */
  const mutedUsers = [];
  if (hasOwn(raw, "mutedUsers") && Array.isArray(raw.mutedUsers)) {
    const seen = new Set();
    for (const u of raw.mutedUsers) {
      if (typeof u !== "string" || u.length < 1 || u.length > MAX_MODERATION_USER_ID_CHARS) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      mutedUsers.push(u);
      if (mutedUsers.length >= MAX_MUTED_USERS) break;
    }
  }
  return { locked, mutedUsers };
}

/**
 * Strict validator for `appState.herdr.moderation` in `envelope.js`.
 * Returns an error string, or `null` when valid.
 * @param {any} val
 * @returns {string | null}
 */
export function moderationProblem(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return "moderation must be an object";
  for (const k of Object.keys(val)) {
    if (k !== "locked" && k !== "mutedUsers") return `unknown moderation key ${JSON.stringify(k)}`;
  }
  if (!hasOwn(val, "locked") || typeof val.locked !== "boolean") return "moderation.locked must be a boolean";
  if (!hasOwn(val, "mutedUsers") || !Array.isArray(val.mutedUsers)) return "moderation.mutedUsers must be an array";
  if (val.mutedUsers.length > MAX_MUTED_USERS) {
    return `moderation.mutedUsers may hold at most ${MAX_MUTED_USERS} users`;
  }
  const seen = new Set();
  for (const u of val.mutedUsers) {
    if (typeof u !== "string" || u.length < 1 || u.length > MAX_MODERATION_USER_ID_CHARS) {
      return `each muted user id must be a string of 1..${MAX_MODERATION_USER_ID_CHARS} characters`;
    }
    if (seen.has(u)) return "moderation.mutedUsers must not contain duplicates";
    seen.add(u);
  }
  return null;
}

/**
 * Whether a user with `role` and `userId` may write to audience streams (`notes` / `records`)
 * under moderation state `mod`.
 * - `owner` and `editor` (presenters) are never blocked by `locked` or `mutedUsers`.
 * - When `mod.locked === true`: non-moderator writes (`annotator`, `commenter`) are refused with `"board-locked"`.
 * - When `userId` is in `mod.mutedUsers`: non-moderator writes are refused with `"user-muted"`.
 * @param {string} role
 * @param {string | null | undefined} userId
 * @param {ModerationState | null | undefined} mod
 * @returns {ModerationDecision}
 */
export function canWriteUnderModeration(role, userId, mod) {
  if (role === "owner" || role === "editor") return { allowed: true, reason: null };
  if (!mod || typeof mod !== "object") return { allowed: true, reason: null };
  if (mod.locked === true) return { allowed: false, reason: "board-locked" };
  if (typeof userId === "string" && userId.length > 0 && Array.isArray(mod.mutedUsers) && mod.mutedUsers.includes(userId)) {
    return { allowed: false, reason: "user-muted" };
  }
  return { allowed: true, reason: null };
}
