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

// Pill text per connection state, as in the mock. Viewers never have edits waiting.
// `congested`: the outbound backlog is over CONGESTED_BYTES (web/ports/transport.js); `limited`: the room refused this
// tab's connection by the writer-connection cap (8 per user and board): no retry loop, the user closes a tab first.
export function pillFor({ status, online = true, pending = 0, role, readOnly = false, congested = false }) {
  const waiting = role === "viewer" || !pending ? "" : `${pending} edit${pending === 1 ? "" : "s"} waiting`;
  // stopped: the room speaks rules this app doesn't know. It never retries; only an update helps.
  if (status === "stopped") return { cls: "offline", text: "Update needed", sub: "reload the app" };
  if (status === "refused") return { cls: "offline", text: "Refused", sub: "sign in again" };
  if (status === "limited") return { cls: "offline", text: "Too many tabs", sub: "close one: retrying by itself" };
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
export function connectionBanner({ status, online = true, viewer = false, pending = 0, readOnly = false, limited = null, nextTryIn = null }) {
  if (status === "stopped") return { text: `⚠ This app is older than the board's room and has stopped: reload to update it.${pending ? ` Reloading loses ${pending} edits not yet acknowledged.` : ""} `, action: "reload" };
  if (status === "refused") return { text: "⚠ The room refused this sign-in (token or board). ", action: "retry" };
  if (status === "limited") {
    const when = nextTryIn == null ? "" : ` Trying again ${nextTryIn < 1000 ? "now" : `in ${Math.ceil(nextTryIn / 1000)} s`}.`;
    return { text: `⚠ This board is open in too many of your tabs (${limited ?? "the room's limit"}). Close one; this tab gets in by itself.${when} `, action: "retry" };
  }
  if (!online) return { text: viewer ? "⚠ You're offline. The live view is paused until you reconnect." : (pending ? `⚠ You're offline. ${pending} ${pending === 1 ? "edit waits" : "edits wait"} in this tab and send when you reconnect. Closing the tab loses them.` : "⚠ You're offline. Nothing is waiting to send; edits you make now are kept in this tab until you reconnect."), action: "retry" };
  if (status !== "live") return { text: viewer ? "⟳ Connecting… the live view is paused." : `⟳ Connecting… ${pending ? `${pending} edits waiting. ` : ""}Keep working: they're sent with the same ids when the room is back.`, action: null };
  if (readOnly) return { text: "👁 Read-only: the server gave this session a lower role. Ask the board's owner for edit access.", action: null };
  return null;
}

/** The pill's tooltip for a pill class (pillFor's `cls`). The cap's text wins over the viewer's "no live connection". */
export function pillTitleFor({ cls, status, viewer = false, readOnly = false }) {
  if (status === "limited") return "This board is open in too many of your tabs. Close one: this tab tries again by itself (or press Retry).";
  if (viewer && cls !== "readonly") return "No live connection. The live view is paused until it's back.";
  return {
    connected: "Connected: every edit is acknowledged by the board's room.",
    reconnecting: "Connecting or catching up. Edits not yet acknowledged are kept and resent with the same ids.",
    offline: "No connection. Unacknowledged edits stay in this tab and are resent on reconnect; closing the tab loses them.",
    readonly: readOnly ? "The server gave this session a lower role (welcome.role): nothing you do is sent." : "You're watching: viewers change nothing on the board.",
  }[cls];
}
