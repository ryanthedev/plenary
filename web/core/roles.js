// Who may do what in the canvas chrome. Pure: no DOM, no protocol imports (tested headless).
//
// The room's roles (PROTOCOL.md) map onto three kinds of chrome, as in the design mock:
//   owner, editor        → presenter  (every tool, the side panel, timeline, Mermaid, export)
//   annotator            → annotator  (notes-stream tools; changes only notes they made)
//   commenter, viewer    → viewer     (hand, zoom, fit, frames; reads notes)
// Commenter maps to viewer on the canvas: the v1 draft says it writes records (comments) only, not notes,
// although v0's envelope still lets it write `notes`. Phase 7 gives it the comment composer.

import { TOOLS } from "../../packages/core/editor.js";

export const UI_ROLES = ["presenter", "annotator", "viewer"];

/** welcome.role → the chrome to show. Unknown or missing → viewer (the safe side). */
export function uiRole(role) {
  if (role === "owner" || role === "editor") return "presenter";
  if (role === "annotator") return "annotator";
  return "viewer";
}

// Tools that are not core TOOLS ids (mock EXTRAS). `stream` says where their elements go.
export const EXTRAS = [
  { id: "image", icon: "⊡", name: "Image", keys: [] },
  { id: "note", icon: "❏", name: "Note", keys: ["n"] },
  { id: "highlighter", icon: "▰", name: "Highlighter", keys: ["m"] },
];

export const ROLE_TOOLS = {
  presenter: { tools: TOOLS.map(t => t.id), extras: ["image", "note", "highlighter"] },
  annotator: { tools: ["select", "hand", "arrow", "freedraw", "text", "eraser"], extras: ["image", "note", "highlighter"] },
  viewer: { tools: ["hand"], extras: [] },
};

/** The tool buttons a role gets, in toolbar order: core TOOLS first, then the extras. */
export function toolsFor(role) {
  const r = ROLE_TOOLS[role] ?? ROLE_TOOLS.viewer;
  return [...TOOLS.filter(t => r.tools.includes(t.id)), ...EXTRAS.filter(e => r.extras.includes(e.id))];
}
export const mayUseTool = (role, id) => toolsFor(role).some(t => t.id === id);

/** Which stream (and so which Editor) a tool draws into for a role. */
export function streamFor(role, tool) {
  if (role === "annotator") return "notes";
  if (tool === "note" || tool === "highlighter") return "notes";
  return "board";
}

/** May this session write at all? `readOnly` = a downgrade (welcome.role lower than the chrome shown). */
export const canEdit = (role, readOnly = false) => role !== "viewer" && !readOnly;

// View-only keys: what a viewer (or a read-only session) may press. Everything else may write.
// Escape is not here: core's Escape switches to the Select tool.
export function viewKey(key, m = {}) {
  const k = String(key).toLowerCase(), mod = m.cmd || m.ctrl;
  if (mod) return k === "=" || k === "-" || k === "0";
  if (m.shift) return k === "1" || k === "2";
  return k === "h" || k === "pageup" || k === "pagedown";
}

// Keys the session handles itself (never forwarded to an Editor as-is): clipboard keys come through the
// browser's copy/cut/paste events, or paste would run twice.
export const clipboardKey = (key, m = {}) => !!(m.cmd || m.ctrl) && ["c", "x", "v"].includes(String(key).toLowerCase());

// Keys that change a stream's settings (appState): only presenters (the room refuses others).
export const settingsKey = (key, m = {}) => !!(m.cmd || m.ctrl) && String(key) === "'";

/** Both writer caps end in the same id-less `limit` (a ninth tab, or a third connection of one tab), so this says both. */
export const LIMIT_TEXT = "This board is open in too many of your tabs or windows, or this tab reconnected too quickly";

// Pill text per connection state, as in the mock. Viewers never have edits waiting.
// `congested`: the outbound backlog is over CONGESTED_BYTES (web/ports/transport.js); `limited`: the room refused this
// tab's connection by a writer cap (8 tabs per user and board, or 2 connections per tab: the client can't tell which,
// so no text names one). It retries on the backoff by itself; closing a tab may free a slot.
export function pillFor({ status, online = true, pending = 0, role, readOnly = false, congested = false }) {
  const waiting = role === "viewer" || !pending ? "" : `${pending} edit${pending === 1 ? "" : "s"} waiting`;
  // stopped: the room speaks rules this app doesn't know. It never retries; only an update helps.
  if (status === "stopped") return { cls: "offline", text: "Update needed", sub: "reload the app" };
  if (status === "refused") return { cls: "offline", text: "Refused", sub: "sign in again" };
  if (status === "limited") return { cls: "offline", text: "Connection limit", sub: "close a tab: retrying by itself" };
  if (!online) return { cls: "offline", text: "Offline", sub: waiting };
  if (status !== "live") return { cls: "reconnecting", text: status === "catching-up" ? "Catching up…" : "Connecting…", sub: waiting };
  const slow = congested ? "slow link" : "";
  if (role === "viewer" || readOnly) return { cls: "readonly", text: "View only", sub: slow };
  return { cls: congested ? "reconnecting" : "connected", text: "Live", sub: [slow, waiting].filter(Boolean).join(" · ") };
}

// The connection banner over the canvas (one at most), as text and the one action it offers. Pure, so the chrome's
// choices are tested: a capped tab shows only the cap's banner (p7-wirev LOW-1), with when it tries again.
//   status: the session's merged status; viewer: the effective chrome is the viewer's; limited: the cap's message;
//   nextTryIn: ms until the cap's next automatic try (null: none armed).
export function connectionBanner({ status, online = true, viewer = false, pending = 0, readOnly = false, limited = null, nextTryIn = null, relogin = false }) {
  if (status === "stopped") return { text: `⚠ This app is older than the board's room and has stopped: reload to update it.${pending ? ` Reloading loses ${pending} edits not yet acknowledged.` : ""} `, action: "reload" };
  // Refused (`auth`): Retry reconnects with the same token, which a dead token can't pass, so the banner also offers a
  // fresh sign-in (p7-chrome, C-9). `relogin`: the page has a sign-in to go to (production; the dev rooms have none).
  if (status === "refused") return { text: `⚠ The room refused this sign-in (token or board).${relogin ? ` Sign in again to keep going${pending ? `; ${pending} unsent ${pending === 1 ? "edit" : "edits"} in this tab are lost when you leave` : ""}.` : ""} `, action: "retry", relogin: !!relogin };
  if (status === "limited") {
    const when = nextTryIn == null ? "" : ` Trying again ${nextTryIn < 1000 ? "now" : `in ${Math.ceil(nextTryIn / 1000)} s`}.`;
    return { text: `⚠ ${LIMIT_TEXT} (${limited ?? "the room's limit"}). Close one; this tab retries by itself.${when} `, action: "retry" };
  }
  if (!online) return { text: viewer ? "⚠ You're offline. The live view is paused until you reconnect." : (pending ? `⚠ You're offline. ${pending} ${pending === 1 ? "edit waits" : "edits wait"} in this tab and send when you reconnect. Closing the tab loses them.` : "⚠ You're offline. Nothing is waiting to send; edits you make now are kept in this tab until you reconnect."), action: "retry" };
  if (status !== "live") return { text: viewer ? "⟳ Connecting… the live view is paused." : `⟳ Connecting… ${pending ? `${pending} edits waiting. ` : ""}Keep working: they're sent with the same ids when the room is back.`, action: null };
  if (readOnly) return { text: "👁 Read-only: the server gave this session a lower role. Ask the board's owner for edit access.", action: null };
  return null;
}

/** How long before the sign-in's expiry the page warns (C-9). */
export const EXPIRY_WARN_MS = 5 * 60_000;

/**
 * The sign-in expiry warning, or null. expAt: when the sign-in ends (ms, the clock's now() scale), null when unknown
 * (dev tokens); now: the clock's now(). The room checks the token on each hello, so an expired sign-in keeps a
 * live link until the next reconnect, which is then refused: the warning says so before it happens.
 * @returns {{ text: string, expired: boolean, bucket: string } | null}  bucket: changes only when the text does.
 */
export function expiryNotice({ expAt = null, now, warnMs = EXPIRY_WARN_MS }) {
  if (!Number.isFinite(expAt) || !Number.isFinite(now)) return null;
  const left = expAt - now;
  if (left > warnMs) return null;
  if (left <= 0) return { text: "⚠ Your sign-in has ended. The board stays live until the connection drops; sign in again now so you're not cut off. ", expired: true, bucket: "ended" };
  const min = Math.ceil(left / 60_000);
  return { text: `⚠ Your sign-in ends in ${min} min. Sign in again to stay connected. `, expired: false, bucket: `m${min}` };
}

/** After this long hidden, a tab coming back to the front reconnects (C-4): its link may have died unseen. */
export const RESUME_PROBE_MS = 30_000;

/**
 * Should the page reconnect now (C-4: the browser came back online, or a tab long hidden came back)? Never while
 * refused or stopped (the same token or app is refused again) or capped (it would defeat the cap's backoff), and
 * never under a gesture in flight. The session handle offers only reconnect(): the hello carries `since`, so a
 * healthy link pays a small catch-up, not a snapshot.
 */
export function shouldProbe({ status, gesture = null }) {
  return !gesture && !["refused", "stopped", "limited"].includes(status);
}

/** The board a page asked to come back to after signing in (C-9): the server's login lands on its fixed page. */
export const RETURN_KEY = "plenary.return";
const BOARD_RE = /^[\w-]{1,64}$/;
/** Remember `board` before leaving for sign-in. Never throws (a failing store just loses the way back). */
export function rememberBoard(storage, board) { try { if (BOARD_RE.test(board ?? "")) storage.set(RETURN_KEY, board); } catch {} }
/**
 * The board to return to, once: read and removed. Only after a fresh sign-in (`signed-in`) on a page with no board
 * of its own; anything not a board id is ignored. Never throws.
 */
export function takeReturnBoard(storage, { outcome, board }) {
  let v = null;
  try { v = storage.get(RETURN_KEY); if (v !== null) storage.remove(RETURN_KEY); } catch { return null; }
  if (outcome !== "signed-in" || board) return null;
  return BOARD_RE.test(v ?? "") ? v : null;
}

/** The pill's tooltip for a pill class (pillFor's `cls`). The cap's text wins over the viewer's "no live connection". */
export function pillTitleFor({ cls, status, viewer = false, readOnly = false }) {
  if (status === "limited") return `${LIMIT_TEXT}. Close one: this tab retries by itself (or press Retry).`;
  if (viewer && cls !== "readonly") return "No live connection. The live view is paused until it's back.";
  return {
    connected: "Connected: every edit is acknowledged by the board's room.",
    reconnecting: "Connecting or catching up. Edits not yet acknowledged are kept and resent with the same ids.",
    offline: "No connection. Unacknowledged edits stay in this tab and are resent on reconnect; closing the tab loses them.",
    readonly: readOnly ? "The server gave this session a lower role (welcome.role): nothing you do is sent." : "You're watching: viewers change nothing on the board.",
  }[cls];
}
