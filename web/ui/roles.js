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
export function pillFor({ status, online = true, pending = 0, role, readOnly = false }) {
  const waiting = role === "viewer" || !pending ? "" : `${pending} edit${pending === 1 ? "" : "s"} waiting`;
  if (status === "refused") return { cls: "offline", text: "Refused", sub: "sign in again" };
  if (!online) return { cls: "offline", text: "Offline", sub: waiting };
  if (status !== "live") return { cls: "reconnecting", text: status === "catching-up" ? "Catching up…" : "Connecting…", sub: waiting };
  if (role === "viewer" || readOnly) return { cls: "readonly", text: "View only", sub: "" };
  return { cls: "connected", text: "Live", sub: waiting };
}
