// @ts-check
// Admin & Share DOM UI (part of the `dom` adapter group).
// Two self-contained components styled with Warm Studio / Obsidian CSS custom properties:
//   - mountBoardsHome({ root, admin, me, onOpenBoard, onLogout, theme, setTheme })
//   - mountShareDialog({ root, board, boardTitle, role, isAdmin, admin, origin, onClose }) / openShareSheet
// Untrusted text (titles, emails, actors, errors) goes strictly through textContent via h(), never innerHTML.

import { h, replace } from "./dom.js";
import { trapFocus } from "./a11y.js";

const STYLE_ID = "plenary-admin-styles";

const ADMIN_CSS = `
.adm-shell {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--canvas-bg, #F8F7F4);
  color: var(--fg, #18181B);
  font: 13.5px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.adm-nav {
  position: sticky;
  top: 0;
  z-index: 20;
  min-height: 58px;
  background: var(--surface, #FFFFFF);
  border-bottom: 1px solid var(--border, #E3E0D8);
  padding: 8px 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.adm-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.02em;
}
.adm-brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent, #3B48E8);
  color: var(--accent-fg, #FFFFFF);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.adm-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}
.adm-tab {
  height: 34px;
  padding: 0 12px;
  border-radius: 8px;
  border: 0;
  background: none;
  color: var(--fg-muted, #52504A);
  font: 500 13px/1 inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.adm-tab:hover { background: var(--surface-hover, #EBE8E1); color: var(--fg, #18181B); }
.adm-tab.active { background: var(--accent-soft, rgba(59, 72, 232, 0.10)); color: var(--accent, #3B48E8); font-weight: 600; }
.adm-spacer { flex: 1 1 auto; }
.adm-search {
  min-width: 180px;
  max-width: 280px;
  flex: 0 1 240px;
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #E3E0D8);
  background: var(--surface-subtle, #F2F0EB);
  color: var(--fg, #18181B);
  font: inherit;
}
.adm-search:focus { outline: 2px solid var(--accent, #3B48E8); outline-offset: 1px; background: var(--surface, #FFFFFF); }
.adm-btn {
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #E3E0D8);
  background: var(--surface, #FFFFFF);
  color: var(--fg, #18181B);
  font: 500 13px/1 inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.adm-btn:hover:not(:disabled) { background: var(--surface-hover, #EBE8E1); }
.adm-btn:disabled { opacity: 0.55; cursor: default; }
.adm-btn.primary {
  background: var(--accent, #3B48E8);
  border-color: var(--accent, #3B48E8);
  color: var(--accent-fg, #FFFFFF);
}
.adm-btn.primary:hover:not(:disabled) { background: var(--accent-hover, #303CC9); }
.adm-btn.danger {
  color: var(--bad, #C81E1E);
  border-color: var(--border, #E3E0D8);
}
.adm-btn.danger:hover:not(:disabled) { background: var(--bad-bg, #FEF2F2); }
.adm-btn.sm { height: 30px; padding: 0 10px; font-size: 12px; }
.adm-user {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--fg-muted, #52504A);
}
.adm-main {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 48px;
}
.adm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.adm-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.adm-sub { color: var(--fg-muted, #52504A); font-size: 13px; margin: 4px 0 0; }
.adm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.adm-card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--border, #E3E0D8);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-sm, 0 1px 3px rgba(24, 24, 27, 0.06));
  display: flex;
  flex-direction: column;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.adm-card:hover {
  border-color: var(--border-strong, #858178);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(24, 24, 27, 0.08));
}
.adm-thumb {
  height: 112px;
  background: var(--canvas-bg, #F8F7F4);
  border-bottom: 1px solid var(--border, #E3E0D8);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.adm-card-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.adm-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.adm-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg, #18181B);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.adm-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
  background: var(--surface-subtle, #F2F0EB);
  color: var(--fg-muted, #52504A);
  flex-shrink: 0;
}
.adm-badge.owner { background: var(--accent-soft, rgba(59, 72, 232, 0.10)); color: var(--accent, #3B48E8); }
.adm-badge.ok { background: var(--ok-bg, #ECFDF3); color: var(--ok, #157F3D); }
.adm-badge.warn { background: var(--warn-bg, #FFFBEB); color: var(--warn, #B45309); }
.adm-badge.bad { background: var(--bad-bg, #FEF2F2); color: var(--bad, #C81E1E); }
.adm-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--fg-dim, #625F57);
}
.adm-card-acts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.adm-rename-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.adm-rename-input {
  height: 30px;
  padding: 0 8px;
  font-size: 13px;
  flex: 1 1 120px;
}
.adm-btn.danger.solid {
  background: var(--bad, #C81E1E);
  border-color: var(--bad, #C81E1E);
  color: var(--bad-fg, #FFFFFF);
}
.adm-btn.danger.solid:hover:not(:disabled) { opacity: 0.9; background: var(--bad, #C81E1E); }
.adm-error {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bad-bg, #FEF2F2);
  color: var(--bad, #C81E1E);
  border: 1px solid color-mix(in srgb, var(--bad, #C81E1E) 28%, transparent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 13px;
}
.adm-notice {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--accent-soft, rgba(59, 72, 232, 0.10));
  color: var(--fg, #18181B);
  border: 1px solid var(--border, #E3E0D8);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 13px;
}
.adm-empty, .adm-loading {
  padding: 40px 20px;
  text-align: center;
  background: var(--surface, #FFFFFF);
  border: 1px dashed var(--border, #E3E0D8);
  border-radius: 12px;
  color: var(--fg-muted, #52504A);
}
.adm-empty h3 { margin: 0 0 6px; color: var(--fg, #18181B); font-size: 15px; }
.adm-empty p { margin: 0 0 14px; font-size: 13px; }
.adm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.adm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-subtle, #F2F0EB);
  border: 1px solid var(--border, #E3E0D8);
}
.adm-row-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
.adm-row-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adm-row-sub { font-size: 12px; color: var(--fg-dim, #625F57); font-variant-numeric: tabular-nums; }
.adm-row-url { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; color: var(--fg-muted, #52504A); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adm-row-acts { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.adm-audit-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--border, #E3E0D8);
}
.adm-audit-ts { font: 12px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--fg-dim, #625F57); font-variant-numeric: tabular-nums; }
.adm-veil {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--veil, rgba(17, 17, 19, 0.45));
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.adm-modal {
  width: 100%;
  max-width: 540px;
  max-height: 86vh;
  background: var(--surface, #FFFFFF);
  color: var(--fg, #18181B);
  border: 1px solid var(--border, #E3E0D8);
  border-radius: 16px;
  box-shadow: var(--shadow-lg, 0 20px 50px rgba(24, 24, 27, 0.16));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.adm-modal-head {
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border, #E3E0D8);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.adm-modal-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.adm-modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.adm-modal-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--border, #E3E0D8);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.adm-form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.adm-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.adm-field label { font-size: 12px; font-weight: 500; color: var(--fg-muted, #52504A); }
.adm-input, .adm-select {
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border, #E3E0D8);
  background: var(--surface-subtle, #F2F0EB);
  color: var(--fg, #18181B);
  font: inherit;
}
.adm-input { flex: 1 1 160px; min-width: 0; }
.adm-field .adm-input, .adm-field .adm-select { flex: 0 0 auto; width: 100%; }
.adm-input:focus, .adm-select:focus { outline: 2px solid var(--accent, #3B48E8); outline-offset: 1px; background: var(--surface, #FFFFFF); }
.adm-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-dim, #625F57);
  margin: 4px 0 0;
}
.adm-org-card, .adm-org-panel {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--border, #E3E0D8);
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: var(--shadow-sm, 0 1px 3px rgba(24, 24, 27, 0.06));
  margin-bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.adm-org-card {
  border-color: var(--accent, #3B48E8);
  background: linear-gradient(180deg, var(--accent-soft, rgba(59, 72, 232, 0.06)) 0%, var(--surface, #FFFFFF) 100%);
}
.adm-org-card h2, .adm-org-panel h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.adm-org-card p, .adm-hint {
  margin: 0;
  font-size: 13px;
  color: var(--fg-muted, #52504A);
}
.adm-org-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.adm-org-pill {
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border, #E3E0D8);
  background: var(--surface-subtle, #F2F0EB);
  color: var(--fg, #18181B);
  font: 500 13px/1 inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.adm-org-pill:hover { background: var(--surface-hover, #EBE8E1); }
.adm-org-pill.active {
  background: var(--accent-soft, rgba(59, 72, 232, 0.12));
  border-color: var(--accent, #3B48E8);
  color: var(--accent, #3B48E8);
  font-weight: 600;
}
.adm-ico {
  width: 16px;
  height: 16px;
  display: inline-block;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
@media (pointer: coarse) {
  .adm-search, .adm-input, .adm-select { font-size: 16px; min-height: 44px; }
  .adm-btn, .adm-tab { min-height: 44px; }
}
@media (max-width: 640px) {
  .adm-veil { align-items: flex-end; padding: 0; }
  .adm-modal { max-width: 100%; max-height: 90dvh; border-radius: 20px 20px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }
  .adm-search, .adm-input, .adm-select { font-size: 16px; }
}
`;

function ensureStyles() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById?.(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = ADMIN_CSS;
  document.head.append(style);
}

/** Create an inline 24x24 stroke SVG icon, falling back cleanly on stub DOMs without createElementNS. */
function icon(paths, cls = "adm-ico") {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") {
    return h("span", { class: cls, "aria-hidden": "true" });
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const ICONS = {
  brand: () => icon(["M4 6a2 2 0 0 1 2-2h5v7H4V6z", "M13 4h5a2 2 0 0 1 2 2v5h-7V4z", "M4 13h7v7H6a2 2 0 0 1-2-2v-5z", "M13 13h7v5a2 2 0 0 1-2 2h-5v-7z"]),
  plus: () => icon(["M12 5v14", "M5 12h14"]),
  share: () => icon(["M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7", "M16 6l-4-4-4 4", "M12 2v13"]),
  close: () => icon(["M18 6L6 18", "M6 6l12 12"]),
  copy: () => icon(["M9 9h10v10H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"]),
  check: () => icon(["M20 6L9 17l-5-5"]),
  link: () => icon(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]),
  sun: () => icon(["M12 3v2", "M12 19v2", "M4.93 4.93l1.41 1.41", "M17.66 17.66l1.41 1.41", "M3 12h2", "M19 12h2", "M4.93 19.07l1.41-1.41", "M17.66 6.34l1.41-1.41", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"]),
  moon: () => icon(["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"]),
  edit: () => icon(["M12 20h9", "M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"]),
  trash: () => icon(["M3 6h18", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"]),
};

function boardPreviewSvg() {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") {
    return h("span.adm-preview-stub", { "aria-hidden": "true" });
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 200 90");
  svg.setAttribute("width", "180");
  svg.setAttribute("height", "80");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  /** @type {[string, Record<string, string>][]} */
  const shapes = [
    ["rect", { x: "16", y: "20", width: "54", height: "34", rx: "6", stroke: "var(--border-strong, #858178)", "stroke-width": "1.6", fill: "var(--surface, #FFFFFF)" }],
    ["rect", { x: "124", y: "34", width: "58", height: "34", rx: "6", stroke: "var(--accent, #3B48E8)", "stroke-width": "1.6", fill: "var(--accent-soft, rgba(59,72,232,0.10))" }],
    ["path", { d: "M70 37 C 96 37, 98 51, 124 51", stroke: "var(--fg-dim, #625F57)", "stroke-width": "1.5", "stroke-linecap": "round" }],
  ];
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return String(ms);
  }
}

function formatDateTime(ms) {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(ms);
  }
}

function errMessage(err, fallback = "Something went wrong") {
  if (!err) return fallback;
  if (err.code === "forbidden" || err.status === 403) return "You do not have permission for this action.";
  if (err.code === "last-owner" || err.status === 409) return "A board must keep at least one owner.";
  return String(err.message || err.code || fallback);
}

const AUDIT_LABELS = {
  "board.create": "Created board",
  "board.update": "Updated board",
  "board.delete": "Deleted board",
  "grant.set": "Updated role",
  "invite.create": "Sent invite",
  "invite.revoke": "Revoked invite",
  "link.create": "Created share link",
  "link.revoke": "Revoked share link",
  "tenant.create": "Created workspace",
  "tenant.member.add": "Added org member",
  "tenant.member.remove": "Removed org member",
};

function auditSummary(ev) {
  const label = AUDIT_LABELS[ev.action] ?? ev.action;
  const d = ev.detail && typeof ev.detail === "object" ? ev.detail : {};
  if (ev.action === "board.create") return `${label}${d.title ? ` "${d.title}"` : ""}`;
  if (ev.action === "board.update") return `${label}${d.title ? ` "${d.title}"` : ""}`;
  if (ev.action === "board.delete") return `${label}${d.title ? ` "${d.title}"` : ""}`;
  if (ev.action === "invite.create") return `${label} to ${d.email ?? ev.target ?? ""} (${d.role ?? ""})`;
  if (ev.action === "invite.revoke") return `${label} for ${d.email ?? ev.target ?? ""}`;
  if (ev.action === "link.create") return `${label} (${d.role ?? ""})`;
  if (ev.action === "link.revoke") return `${label} (${d.role ?? ""})`;
  if (ev.action === "grant.set") return `${label} for ${ev.target ?? ""} → ${d.role ?? "removed"}`;
  if (ev.action === "tenant.create") return `${label}${d.name ? ` "${d.name}"` : ""}`;
  if (ev.action === "tenant.member.add") return `${label} ${d.email ?? ev.target ?? ""}`;
  if (ev.action === "tenant.member.remove") return `${label} ${d.email ?? ev.target ?? ""}`;
  return `${label}${ev.target ? ` (${ev.target})` : ""}`;
}

/**
 * Mount the Share, Invites, Grants & Board Audit modal / mobile bottom-sheet.
 * @param {{
 *   root: Element,
 *   board: string,
 *   boardTitle?: string,
 *   role?: string | null,
 *   isAdmin?: boolean,
 *   admin: import("../../ports/admin.js").AdminPort,
 *   origin?: string,
 *   onClose?: () => void,
 * }} o
 */
export function mountShareDialog({ root, board, boardTitle = null, role = null, isAdmin = false, admin, origin = "", onClose = null }) {
  ensureStyles();
  const base = (origin || "").replace(/\/+$/, "");
  const state = {
    tab: "links",
    links: [],
    linksLoaded: false,
    linksLoading: false,
    invites: [],
    invitesLoaded: false,
    invitesLoading: false,
    audit: [],
    auditNext: null,
    auditLoaded: false,
    auditLoading: false,
    error: null,
    copiedId: null,
    notice: null,
    linkRole: "viewer",
    linkExpiry: "",
    inviteEmail: "",
    inviteRole: "editor",
    grantUser: "",
    grantRole: "editor",
    busy: false,
  };

  let closed = false;
  let trap = null;
  const veil = h("div.adm-veil", {
    onclick: e => { if (e.target === veil) close(); },
    onkeydown: e => trap?.handleKeyDown(e),
  });
  const modal = h("div.adm-modal", { role: "dialog", "aria-modal": "true", "aria-label": `Share ${boardTitle || board}`, tabindex: "-1" });
  veil.append(modal);
  root.append(veil);

  function close() {
    if (closed) return;
    closed = true;
    trap?.deactivate({ restoreFocus: true });
    veil.remove();
    onClose?.();
  }
  trap = trapFocus(modal, { onEscape: close });

  async function loadLinks() {
    state.linksLoading = true; state.error = null; render();
    try {
      const res = await admin.listLinks(board);
      state.links = Array.isArray(res?.links) ? res.links : [];
      state.linksLoaded = true;
    } catch (err) {
      state.error = errMessage(err, "Failed to load share links");
    } finally {
      state.linksLoading = false;
      if (!closed) render();
    }
  }

  async function loadInvites() {
    state.invitesLoading = true; state.error = null; render();
    try {
      const res = await admin.listInvites(board);
      state.invites = Array.isArray(res?.invites) ? res.invites : [];
      state.invitesLoaded = true;
    } catch (err) {
      state.error = errMessage(err, "Failed to load invites");
    } finally {
      state.invitesLoading = false;
      if (!closed) render();
    }
  }

  async function loadAudit(append = false) {
    state.auditLoading = true; state.error = null; render();
    try {
      const res = await admin.boardAudit(board, { limit: 50, before: append ? state.auditNext : null });
      const rows = Array.isArray(res?.events) ? res.events : [];
      state.audit = append ? [...state.audit, ...rows] : rows;
      state.auditNext = res?.nextBefore ?? null;
      state.auditLoaded = true;
    } catch (err) {
      state.error = errMessage(err, "Failed to load board activity");
    } finally {
      state.auditLoading = false;
      if (!closed) render();
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    state.error = null;
    state.notice = null;
    render();
    if (tab === "links" && !state.linksLoaded && !state.linksLoading) loadLinks();
    if (tab === "people" && !state.invitesLoaded && !state.invitesLoading) loadInvites();
    if (tab === "audit" && !state.auditLoaded && !state.auditLoading) loadAudit(false);
  }

  const shareUrlOf = link => {
    if (link && typeof link === "object" && typeof link.url === "string" && link.url) return link.url;
    const id = typeof link === "string" ? link : link?.id;
    return `${base}/links/${encodeURIComponent(id)}`;
  };

  async function onCreateLink(e) {
    e?.preventDefault?.();
    if (state.busy) return;
    state.busy = true; state.error = null; state.notice = null; render();
    try {
      const ttl = Number(state.linkExpiry);
      const expiresAt = Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl : null;
      const res = await admin.createLink(board, { role: state.linkRole, expiresAt });
      if (res?.link) {
        const item = typeof res.url === "string" && res.url ? { ...res.link, url: res.url } : res.link;
        state.links = [...state.links, item];
      }
      state.notice = "Share link created.";
    } catch (err) {
      state.error = errMessage(err, "Failed to create share link");
    } finally {
      state.busy = false;
      if (!closed) render();
    }
  }

  async function onRevokeLink(id) {
    if (state.busy) return;
    state.busy = true; state.error = null; render();
    try {
      await admin.revokeLink(board, id);
      state.links = state.links.map(l => (l.id === id ? { ...l, revoked: true } : l));
    } catch (err) {
      state.error = errMessage(err, "Failed to revoke share link");
    } finally {
      state.busy = false;
      if (!closed) render();
    }
  }

  async function onCopyLink(link) {
    const url = shareUrlOf(link);
    try {
      await globalThis.navigator?.clipboard?.writeText?.(url);
      state.copiedId = link.id;
      render();
    } catch {
      state.notice = url;
      render();
    }
  }

  async function onCreateInvite(e) {
    e?.preventDefault?.();
    const email = state.inviteEmail.trim();
    if (!email || state.busy) return;
    state.busy = true; state.error = null; state.notice = null; render();
    try {
      const res = await admin.createInvite(board, { email, role: state.inviteRole });
      if (res?.invite) state.invites = [...state.invites, res.invite];
      state.inviteEmail = "";
      state.notice = `Invited ${email}.`;
    } catch (err) {
      state.error = errMessage(err, "Failed to send invite");
    } finally {
      state.busy = false;
      if (!closed) render();
    }
  }

  async function onRevokeInvite(id) {
    if (state.busy) return;
    state.busy = true; state.error = null; render();
    try {
      await admin.revokeInvite(board, id);
      state.invites = state.invites.map(i => (i.id === id ? { ...i, revoked: true } : i));
    } catch (err) {
      state.error = errMessage(err, "Failed to revoke invite");
    } finally {
      state.busy = false;
      if (!closed) render();
    }
  }

  async function onSetGrant(e) {
    e?.preventDefault?.();
    const user = state.grantUser.trim();
    if (!user || state.busy) return;
    state.busy = true; state.error = null; state.notice = null; render();
    try {
      const nextRole = state.grantRole || null;
      await admin.setGrant(board, user, nextRole);
      state.grantUser = "";
      state.notice = nextRole ? `Set ${user} to ${nextRole}.` : `Removed grant for ${user}.`;
    } catch (err) {
      state.error = errMessage(err, "Failed to update grant");
    } finally {
      state.busy = false;
      if (!closed) render();
    }
  }

  function renderLinksTab() {
    const form = h("form.adm-form-row", { onsubmit: onCreateLink },
      h("select.adm-select", {
        name: "role",
        "aria-label": "Link role",
        value: state.linkRole,
        onchange: e => { state.linkRole = e.target.value; },
      },
      h("option", { value: "viewer", selected: state.linkRole === "viewer" }, "Can view"),
      h("option", { value: "commenter", selected: state.linkRole === "commenter" }, "Can comment"),
      h("option", { value: "annotator", selected: state.linkRole === "annotator" }, "Can annotate"),
      h("option", { value: "editor", selected: state.linkRole === "editor" }, "Can edit")),
      h("select.adm-select", {
        name: "expires",
        "aria-label": "Link expiry",
        value: state.linkExpiry,
        onchange: e => { state.linkExpiry = e.target.value; },
      },
      h("option", { value: "", selected: state.linkExpiry === "" }, "Never expires"),
      h("option", { value: String(86_400_000), selected: state.linkExpiry === String(86_400_000) }, "24 hours"),
      h("option", { value: String(604_800_000), selected: state.linkExpiry === String(604_800_000) }, "7 days"),
      h("option", { value: String(2_592_000_000), selected: state.linkExpiry === String(2_592_000_000) }, "30 days")),
      h("button.adm-btn.primary", { type: "submit", "data-action": "create-link", disabled: state.busy }, ICONS.plus(), "Create link"));

    if (state.linksLoading && !state.linksLoaded) return [form, h("div.adm-loading", {}, "Loading share links…")];
    const active = state.links.filter(l => !l.revoked);
    const revoked = state.links.filter(l => l.revoked);
    const list = h("div.adm-list", {},
      active.length === 0 ? h("div.adm-empty", {}, h("p", {}, "No active share links yet.")) : active.map(l => {
        const url = shareUrlOf(l);
        const copied = state.copiedId === l.id;
        return h("div.adm-row", { "data-link-id": l.id },
          h("div.adm-row-main", {},
            h("div.adm-row-title", {}, h("span.adm-badge.ok", {}, l.role), l.expiresAt ? ` · expires ${formatDate(l.expiresAt)}` : " · no expiry"),
            h("div.adm-row-url", { title: url }, url)),
          h("div.adm-row-acts", {},
            h("button.adm-btn.sm", { type: "button", "data-action": "copy-link", onclick: () => onCopyLink(l) }, copied ? ICONS.check() : ICONS.copy(), copied ? "Copied" : "Copy"),
            h("button.adm-btn.sm.danger", { type: "button", "data-action": "revoke-link", disabled: state.busy, onclick: () => onRevokeLink(l.id) }, "Revoke")));
      }),
      revoked.length ? [
        h("div.adm-section-label", {}, `Revoked (${revoked.length})`),
        ...revoked.map(l => h("div.adm-row", { "data-link-id": l.id, "data-revoked": "true" },
          h("div.adm-row-main", {},
            h("div.adm-row-title", {}, h("span.adm-badge.bad", {}, "Revoked"), ` · ${l.role}`),
            h("div.adm-row-sub", {}, l.id)))),
      ] : null);
    return [form, list];
  }

  function renderPeopleTab() {
    const inviteForm = h("form.adm-form-row", { onsubmit: onCreateInvite },
      h("input.adm-input", {
        type: "email",
        name: "email",
        placeholder: "Invite by email (e.g. alex@acme.com)",
        value: state.inviteEmail,
        oninput: e => { state.inviteEmail = e.target.value; },
      }),
      h("select.adm-select", {
        name: "role",
        "aria-label": "Invite role",
        value: state.inviteRole,
        onchange: e => { state.inviteRole = e.target.value; },
      },
      h("option", { value: "viewer", selected: state.inviteRole === "viewer" }, "Viewer"),
      h("option", { value: "commenter", selected: state.inviteRole === "commenter" }, "Commenter"),
      h("option", { value: "annotator", selected: state.inviteRole === "annotator" }, "Annotator"),
      h("option", { value: "editor", selected: state.inviteRole === "editor" }, "Editor")),
      h("button.adm-btn.primary", { type: "submit", "data-action": "create-invite", disabled: state.busy }, "Send invite"));

    const invitesBlock = state.invitesLoading && !state.invitesLoaded
      ? h("div.adm-loading", {}, "Loading invites…")
      : h("div.adm-list", {},
        state.invites.length === 0
          ? h("div.adm-empty", {}, h("p", {}, "No email invites sent yet."))
          : state.invites.map(inv => h("div.adm-row", { "data-invite-id": inv.id },
            h("div.adm-row-main", {},
              h("div.adm-row-title", {}, inv.email),
              h("div.adm-row-sub", {}, inv.revoked ? `${inv.role} · revoked` : `${inv.role} · pending`)),
            h("div.adm-row-acts", {},
              inv.revoked
                ? h("span.adm-badge.bad", {}, "Revoked")
                : h("button.adm-btn.sm.danger", { type: "button", "data-action": "revoke-invite", disabled: state.busy, onclick: () => onRevokeInvite(inv.id) }, "Revoke")))));

    const grantForm = h("form.adm-form-row", { onsubmit: onSetGrant },
      h("input.adm-input", {
        type: "text",
        name: "user",
        placeholder: "User ID (e.g. google:123)",
        value: state.grantUser,
        oninput: e => { state.grantUser = e.target.value; },
      }),
      h("select.adm-select", {
        name: "grantRole",
        "aria-label": "Member grant role",
        value: state.grantRole,
        onchange: e => { state.grantRole = e.target.value; },
      },
      isAdmin ? h("option", { value: "owner", selected: state.grantRole === "owner" }, "Owner") : null,
      h("option", { value: "editor", selected: state.grantRole === "editor" }, "Editor"),
      h("option", { value: "annotator", selected: state.grantRole === "annotator" }, "Annotator"),
      h("option", { value: "commenter", selected: state.grantRole === "commenter" }, "Commenter"),
      h("option", { value: "viewer", selected: state.grantRole === "viewer" }, "Viewer"),
      h("option", { value: "", selected: state.grantRole === "" }, "Remove grant")),
      h("button.adm-btn", { type: "submit", "data-action": "set-grant", disabled: state.busy }, "Update role"));

    return [
      h("div.adm-section-label", {}, "Email Invites"),
      inviteForm,
      invitesBlock,
      h("div.adm-section-label", {}, "Direct Member Grant"),
      grantForm,
    ];
  }

  function renderAuditTab() {
    if (state.auditLoading && !state.auditLoaded) return [h("div.adm-loading", {}, "Loading activity…")];
    if (!state.audit.length) return [h("div.adm-empty", {}, h("p", {}, "No recorded activity on this board yet."))];
    return [
      h("div.adm-list", {}, state.audit.map(ev => h("div.adm-audit-row", { "data-audit-id": String(ev.id) },
        h("span.adm-badge", {}, ev.action),
        h("div.adm-row-main", {},
          h("div.adm-row-title", {}, auditSummary(ev)),
          h("div.adm-row-sub", {}, `by ${ev.actor}`)),
        h("span.adm-audit-ts", {}, formatDateTime(ev.at))))),
      state.auditNext ? h("button.adm-btn", {
        type: "button",
        "data-action": "load-more-audit",
        disabled: state.auditLoading,
        onclick: () => loadAudit(true),
      }, state.auditLoading ? "Loading…" : "Load more") : null,
    ];
  }

  function render() {
    const tabs = h("div.adm-tabs", { role: "tablist" },
      h("button.adm-tab" + (state.tab === "links" ? ".active" : ""), { type: "button", role: "tab", "aria-selected": String(state.tab === "links"), "data-tab": "links", onclick: () => switchTab("links") }, ICONS.link(), "Share Links"),
      h("button.adm-tab" + (state.tab === "people" ? ".active" : ""), { type: "button", role: "tab", "aria-selected": String(state.tab === "people"), "data-tab": "people", onclick: () => switchTab("people") }, "People & Invites"),
      h("button.adm-tab" + (state.tab === "audit" ? ".active" : ""), { type: "button", role: "tab", "aria-selected": String(state.tab === "audit"), "data-tab": "audit", onclick: () => switchTab("audit") }, "Activity"));

    const bodyContent = state.tab === "links" ? renderLinksTab()
      : state.tab === "people" ? renderPeopleTab()
      : renderAuditTab();

    replace(modal,
      h("div.adm-modal-head", {},
        h("div", {},
          h("h2", {}, `Share "${boardTitle || board}"`),
          role ? h("div.adm-row-sub", {}, `Your role: ${role}`) : null),
        h("button.adm-btn.sm", { type: "button", "data-action": "close", "aria-label": "Close share dialog", onclick: close }, ICONS.close())),
      h("div.adm-modal-body", {},
        tabs,
        state.error ? h("div.adm-error", { role: "alert" }, h("span", {}, state.error)) : null,
        state.notice ? h("div.adm-row-sub", { role: "status" }, state.notice) : null,
        ...bodyContent));
  }

  const ready = loadLinks();
  return { destroy: close, ready };
}

export const openShareSheet = mountShareDialog;

/**
 * Mount the Boards Home Dashboard (rendered at `/` when signed in with no `?board=`).
 * @param {{
 *   root: Element,
 *   admin: import("../../ports/admin.js").AdminPort,
 *   me?: { user?: string, name?: string, email?: string | null, domain?: string | null },
 *   onOpenBoard: (boardId: string) => void,
 *   onLogout?: (() => void) | null,
 *   onRelogin?: (() => void) | null,
 *   notice?: string | null,
 *   theme?: "light" | "dark" | null,
 *   setTheme?: ((t: "light" | "dark") => void) | null,
 * }} o
 */
export function mountBoardsHome({ root, admin, me = {}, onOpenBoard, onLogout = null, onRelogin = null, notice = null, theme: theme0 = null, setTheme = null }) {
  ensureStyles();
  const state = {
    tab: "boards",
    boards: [],
    tenants: [],
    activeTenantId: null,
    isAdmin: false,
    loading: true,
    error: null,
    authExpired: false,
    notice: notice || null,
    search: "",
    theme: theme0 ?? document.documentElement?.dataset?.theme ?? "light",
    newOpen: false,
    newTitle: "",
    newMemberRole: "viewer",
    newTenantId: "",
    creating: false,
    createError: null,
    renamingId: null,
    renameTitle: "",
    renameBusy: false,
    renameError: null,
    deleteTarget: null,
    deleting: false,
    deleteError: null,
    orgName: "",
    creatingOrg: false,
    orgError: null,
    membersByTenant: {},
    memberEmail: "",
    memberBusy: false,
    memberError: null,
    audit: [],
    auditNext: null,
    auditLoaded: false,
    auditLoading: false,
    auditError: null,
  };

  let destroyed = false;
  let activeShare = null;
  const shell = h("div.adm-shell");
  const modalSlot = h("div.adm-modals");
  // Persistent search input so typing never loses focus across re-renders.
  const searchInput = h("input.adm-search", {
    type: "search",
    "data-admin-search": "",
    "aria-label": "Search boards",
    placeholder: "Search boards…",
    value: "",
    oninput: e => { state.search = e.target.value; renderMain(); },
  });
  const navSlot = h("div.adm-nav-slot");
  const mainSlot = h("main.adm-main");
  shell.append(navSlot, mainSlot);
  replace(root, shell, modalSlot);

  const adminTenants = () => state.tenants.filter(t => t.isAdmin);
  const activeTenant = () => state.tenants.find(t => t.id === state.activeTenantId) ?? adminTenants()[0] ?? state.tenants[0] ?? null;

  async function loadBoards() {
    state.loading = true; state.error = null; state.authExpired = false; render();
    try {
      const [res, tRes] = await Promise.all([
        admin.listBoards(),
        typeof admin.listTenants === "function" ? admin.listTenants().catch(() => ({ tenants: [] })) : Promise.resolve({ tenants: [] }),
      ]);
      state.boards = Array.isArray(res?.boards) ? res.boards : [];
      state.tenants = Array.isArray(tRes?.tenants) ? tRes.tenants : [];
      if (!state.activeTenantId || !state.tenants.some(t => t.id === state.activeTenantId)) {
        state.activeTenantId = (adminTenants()[0] ?? state.tenants[0])?.id ?? null;
      }
      state.isAdmin = Boolean(res?.isAdmin) || adminTenants().length > 0;
    } catch (err) {
      state.authExpired = err?.status === 401;
      state.error = state.authExpired ? "Your sign-in has expired." : errMessage(err, "Failed to load boards");
    } finally {
      state.loading = false;
      if (!destroyed) render();
    }
  }

  async function loadTenantMembers(tenantId) {
    if (!tenantId || typeof admin.listTenantMembers !== "function") return;
    const prev = state.membersByTenant[tenantId] ?? { members: [], admins: [], loaded: false, loading: false, error: null };
    state.membersByTenant[tenantId] = { ...prev, loading: true, error: null };
    render();
    try {
      const res = await admin.listTenantMembers(tenantId);
      state.membersByTenant[tenantId] = {
        members: Array.isArray(res?.members) ? res.members : [],
        admins: Array.isArray(res?.admins) ? res.admins : [],
        loaded: true,
        loading: false,
        error: null,
      };
    } catch (err) {
      state.authExpired = err?.status === 401;
      state.membersByTenant[tenantId] = {
        ...prev,
        loading: false,
        error: state.authExpired ? "Your sign-in has expired." : errMessage(err, "Failed to load org members"),
      };
    } finally {
      if (!destroyed) render();
    }
  }

  async function submitCreateOrg(e) {
    e?.preventDefault?.();
    if (state.creatingOrg || typeof admin.createTenant !== "function") return;
    const name = state.orgName.trim();
    if (!name) { state.orgError = "Please enter a workspace name."; renderMain(); return; }
    state.creatingOrg = true; state.orgError = null; render();
    try {
      const res = await admin.createTenant({ name });
      if (res?.tenant) {
        state.tenants = [...state.tenants, res.tenant];
        state.activeTenantId = res.tenant.id;
        state.isAdmin = true;
        state.orgName = "";
        state.notice = `Workspace "${res.tenant.name}" created.`;
        state.auditLoaded = false;
      }
    } catch (err) {
      state.orgError = errMessage(err, "Failed to create workspace");
    } finally {
      state.creatingOrg = false;
      if (!destroyed) render();
    }
  }

  async function submitAddMember(e) {
    e?.preventDefault?.();
    const t = activeTenant();
    const email = state.memberEmail.trim();
    if (!t || !email || state.memberBusy || typeof admin.addTenantMember !== "function") return;
    state.memberBusy = true; state.memberError = null; render();
    try {
      const res = await admin.addTenantMember(t.id, email);
      const added = res?.email ?? email.toLowerCase();
      const cur = state.membersByTenant[t.id] ?? { members: [], admins: [], loaded: true, loading: false, error: null };
      const members = cur.members.includes(added) ? cur.members : [...cur.members, added].sort();
      state.membersByTenant[t.id] = { ...cur, members, loaded: true };
      state.memberEmail = "";
      state.notice = `Added ${added} to ${t.name}.`;
    } catch (err) {
      state.memberError = errMessage(err, "Failed to add member");
    } finally {
      state.memberBusy = false;
      if (!destroyed) render();
    }
  }

  async function onRemoveMember(tenantId, email) {
    if (state.memberBusy || typeof admin.removeTenantMember !== "function") return;
    state.memberBusy = true; state.memberError = null; render();
    try {
      await admin.removeTenantMember(tenantId, email);
      const cur = state.membersByTenant[tenantId];
      if (cur) {
        state.membersByTenant[tenantId] = { ...cur, members: cur.members.filter(m => m !== email) };
      }
      state.notice = `Removed ${email}.`;
    } catch (err) {
      state.memberError = errMessage(err, "Failed to remove member");
    } finally {
      state.memberBusy = false;
      if (!destroyed) render();
    }
  }

  function selectTenant(tenantId) {
    state.activeTenantId = tenantId;
    state.memberError = null;
    state.auditLoaded = false;
    render();
    const t = activeTenant();
    if (state.tab === "org" && t?.isAdmin) {
      const slot = state.membersByTenant[t.id];
      if (!slot?.loaded && !slot?.loading) loadTenantMembers(t.id);
    }
  }

  async function loadTenantAudit(append = false) {
    state.auditLoading = true; state.auditError = null; render();
    try {
      const opts = { limit: 50, before: append ? state.auditNext : null };
      const cur = activeTenant();
      if (adminTenants().length > 1 && cur?.isAdmin) opts.tenant = cur.id;
      const res = await admin.adminAudit(opts);
      const rows = Array.isArray(res?.events) ? res.events : [];
      state.audit = append ? [...state.audit, ...rows] : rows;
      state.auditNext = res?.nextBefore ?? null;
      state.auditLoaded = true;
    } catch (err) {
      state.authExpired = err?.status === 401;
      state.auditError = state.authExpired ? "Your sign-in has expired." : errMessage(err, "Failed to load audit log");
    } finally {
      state.auditLoading = false;
      if (!destroyed) render();
    }
  }

  async function submitNewBoard(e) {
    e?.preventDefault?.();
    if (state.creating) return;
    state.creating = true; state.createError = null; render();
    try {
      const memberRole = state.newMemberRole === "" ? null : state.newMemberRole;
      const payload = { title: state.newTitle.trim(), memberRole };
      const admList = adminTenants();
      if (admList.length > 1) {
        payload.tenant = state.newTenantId || (activeTenant()?.isAdmin ? activeTenant().id : admList[0].id);
      }
      const res = await admin.createBoard(payload);
      if (res?.board) {
        state.boards = [{ ...res.board, role: "owner" }, ...state.boards];
        state.newOpen = false;
        state.newTitle = "";
        state.newMemberRole = "viewer";
        render();
        onOpenBoard?.(res.board.id);
        return;
      }
      state.newOpen = false;
    } catch (err) {
      state.createError = errMessage(err, "Failed to create board");
    } finally {
      state.creating = false;
      if (!destroyed) render();
    }
  }

  function openShare(b) {
    activeShare?.destroy();
    activeShare = mountShareDialog({
      root: modalSlot,
      board: b.id,
      boardTitle: b.title || "Untitled board",
      role: b.role ?? null,
      isAdmin: state.isAdmin,
      admin,
      origin: globalThis.location?.origin ?? "",
      onClose: () => { activeShare = null; },
    });
  }

  function startRename(b) {
    state.renamingId = b.id;
    state.renameTitle = b.title || "";
    state.renameError = null;
    renderMain();
    const inp = mainSlot.querySelector?.('input[name="renameTitle"]');
    inp?.focus?.();
    inp?.select?.();
  }

  function cancelRename() {
    state.renamingId = null;
    state.renameTitle = "";
    state.renameError = null;
    renderMain();
  }

  async function submitRename(e, b) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (state.renameBusy || typeof admin.updateBoard !== "function") return;
    const trimmed = state.renameTitle.trim();
    state.renameBusy = true;
    state.renameError = null;
    renderMain();
    try {
      const res = await admin.updateBoard(b.id, { title: trimmed });
      const updated = res?.board;
      const nextTitle = updated?.title ?? trimmed;
      state.boards = state.boards.map(x => (x.id === b.id ? { ...x, ...(updated || { title: trimmed }), role: x.role } : x));
      state.renamingId = null;
      state.renameTitle = "";
      state.notice = `Renamed board to "${nextTitle || "Untitled board"}".`;
    } catch (err) {
      state.renameError = errMessage(err, "Failed to rename board");
    } finally {
      state.renameBusy = false;
      if (!destroyed) renderMain();
    }
  }

  function openDeleteConfirm(b) {
    state.deleteTarget = b;
    state.deleteError = null;
    render();
  }

  function closeDeleteConfirm() {
    state.deleteTarget = null;
    state.deleteError = null;
    render();
  }

  async function confirmDeleteBoard() {
    const target = state.deleteTarget;
    if (!target || state.deleting || typeof admin.deleteBoard !== "function") return;
    state.deleting = true;
    state.deleteError = null;
    render();
    try {
      await admin.deleteBoard(target.id);
      state.boards = state.boards.filter(x => x.id !== target.id);
      if (state.renamingId === target.id) { state.renamingId = null; state.renameTitle = ""; }
      state.deleteTarget = null;
      state.notice = `Deleted board "${target.title || "Untitled board"}".`;
    } catch (err) {
      state.deleteError = errMessage(err, "Failed to delete board");
    } finally {
      state.deleting = false;
      if (!destroyed) render();
    }
  }

  function filteredBoards() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.boards;
    return state.boards.filter(b => (b.title || "").toLowerCase().includes(q) || (b.id || "").toLowerCase().includes(q));
  }

  function filteredAudit() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.audit;
    return state.audit.filter(ev =>
      (ev.action || "").toLowerCase().includes(q)
      || (ev.actor || "").toLowerCase().includes(q)
      || (ev.board || "").toLowerCase().includes(q)
      || auditSummary(ev).toLowerCase().includes(q));
  }

  function renderDeleteConfirmModal() {
    const target = state.deleteTarget;
    if (!target) return null;
    const title = target.title || "Untitled board";
    return h("div.adm-veil", { onclick: e => { if (e.target === e.currentTarget && !state.deleting) closeDeleteConfirm(); } },
      h("div.adm-modal", { role: "dialog", "aria-modal": "true", "aria-label": "Delete Board", "data-dialog": "delete-board" },
        h("div.adm-modal-head", {},
          h("h2", {}, "Delete Board"),
          h("button.adm-btn.sm", { type: "button", "data-action": "cancel-delete", "aria-label": "Close", disabled: state.deleting, onclick: closeDeleteConfirm }, ICONS.close())),
        h("div.adm-modal-body", {},
          state.deleteError ? h("div.adm-error", { role: "alert" }, h("span", {}, state.deleteError)) : null,
          h("p", { style: { margin: "0" } }, `Are you sure you want to delete "${title}"?`),
          h("p.adm-hint", {}, "This removes the board and revokes all access, share links, and invites.")),
        h("div.adm-modal-foot", {},
          h("button.adm-btn", { type: "button", "data-action": "cancel-delete", disabled: state.deleting, onclick: closeDeleteConfirm }, "Cancel"),
          h("button.adm-btn.danger.solid", { type: "button", "data-action": "confirm-delete", disabled: state.deleting, onclick: confirmDeleteBoard }, state.deleting ? "Deleting…" : "Delete board"))));
  }

  function renderNewBoardModal() {
    if (state.deleteTarget) { replace(modalSlot, renderDeleteConfirmModal()); return; }
    if (!state.newOpen) { replace(modalSlot); return; }
    const close = () => { state.newOpen = false; state.createError = null; render(); };
    const admList = adminTenants();
    const chosenTenant = state.newTenantId || (activeTenant()?.isAdmin ? activeTenant().id : admList[0]?.id ?? "");
    replace(modalSlot,
      h("div.adm-veil", { onclick: e => { if (e.target === e.currentTarget) close(); } },
        h("form.adm-modal", { role: "dialog", "aria-modal": "true", "aria-label": "New Board", onsubmit: submitNewBoard },
          h("div.adm-modal-head", {},
            h("h2", {}, "New Board"),
            h("button.adm-btn.sm", { type: "button", "data-action": "close-new", "aria-label": "Close", onclick: close }, ICONS.close())),
          h("div.adm-modal-body", {},
            state.createError ? h("div.adm-error", { role: "alert" }, h("span", {}, state.createError)) : null,
            admList.length > 1 ? h("div.adm-field", {},
              h("label", { for: "adm-new-tenant" }, "Workspace"),
              h("select.adm-select", {
                id: "adm-new-tenant",
                name: "tenant",
                value: chosenTenant,
                onchange: e => { state.newTenantId = e.target.value; },
              }, admList.map(t => h("option", { value: t.id, selected: chosenTenant === t.id }, t.name)))) : null,
            h("div.adm-field", {},
              h("label", { for: "adm-new-title" }, "Board title"),
              h("input.adm-input", {
                id: "adm-new-title",
                name: "title",
                type: "text",
                placeholder: "e.g. Q3 Sync Architecture",
                value: state.newTitle,
                oninput: e => { state.newTitle = e.target.value; },
              })),
            h("div.adm-field", {},
              h("label", { for: "adm-new-role" }, "Workspace default access"),
              h("select.adm-select", {
                id: "adm-new-role",
                name: "memberRole",
                value: state.newMemberRole,
                onchange: e => { state.newMemberRole = e.target.value; },
              },
              h("option", { value: "viewer", selected: state.newMemberRole === "viewer" }, "Workspace members can view"),
              h("option", { value: "commenter", selected: state.newMemberRole === "commenter" }, "Workspace members can comment"),
              h("option", { value: "annotator", selected: state.newMemberRole === "annotator" }, "Workspace members can annotate"),
              h("option", { value: "editor", selected: state.newMemberRole === "editor" }, "Workspace members can edit"),
              h("option", { value: "", selected: state.newMemberRole === "" }, "Private (invite or link only)")))),
          h("div.adm-modal-foot", {},
            h("button.adm-btn", { type: "button", onclick: close }, "Cancel"),
            h("button.adm-btn.primary", { type: "submit", "data-action": "submit-new-board", disabled: state.creating }, state.creating ? "Creating…" : "Create board")))));
  }

  function renderCreateOrgCard() {
    if (state.loading || state.error || state.isAdmin || typeof admin.createTenant !== "function") return null;
    return h("section.adm-org-card", { "data-create-org-card": "" },
      h("h2", {}, "Create Org / Workspace"),
      h("p", {}, "Start your own workspace to create boards and invite collaborators by email."),
      state.orgError ? h("div.adm-error", { role: "alert" }, h("span", {}, state.orgError)) : null,
      h("form.adm-form-row", { "data-form": "create-org", onsubmit: submitCreateOrg },
        h("input.adm-input", {
          type: "text",
          name: "orgName",
          placeholder: "Workspace name (e.g. Design Studio)",
          value: state.orgName,
          oninput: e => { state.orgName = e.target.value; },
        }),
        h("button.adm-btn.primary", { type: "submit", "data-action": "create-org", disabled: state.creatingOrg },
          ICONS.plus(), state.creatingOrg ? "Creating…" : "Create Workspace")));
  }

  function renderOrgView() {
    const t = activeTenant();
    const slot = t ? state.membersByTenant[t.id] : null;
    const members = slot?.members ?? [];
    const admins = slot?.admins ?? [];

    const switcherPanel = h("section.adm-org-panel", {},
      h("h2", {}, "Your Workspaces"),
      state.tenants.length
        ? h("div.adm-org-pills", {}, state.tenants.map(org => h("button.adm-org-pill" + (t && org.id === t.id ? ".active" : ""), {
          type: "button",
          "data-tenant-id": org.id,
          onclick: () => selectTenant(org.id),
        }, org.name, org.isAdmin ? h("span.adm-badge.owner", {}, "Admin") : h("span.adm-badge", {}, "Member"))))
        : h("p.adm-hint", {}, "No workspaces yet."),
      typeof admin.createTenant === "function" ? [
        h("div.adm-section-label", {}, "Create another workspace"),
        state.orgError ? h("div.adm-error", { role: "alert" }, h("span", {}, state.orgError)) : null,
        h("form.adm-form-row", { "data-form": "create-org", onsubmit: submitCreateOrg },
          h("input.adm-input", {
            type: "text",
            name: "orgName",
            placeholder: "New workspace name",
            value: state.orgName,
            oninput: e => { state.orgName = e.target.value; },
          }),
          h("button.adm-btn.primary", { type: "submit", "data-action": "create-org", disabled: state.creatingOrg },
            ICONS.plus(), state.creatingOrg ? "Creating…" : "Create Workspace")),
      ] : null);

    if (!t || !t.isAdmin) {
      return h("div", {}, switcherPanel,
        t ? h("div.adm-empty", {}, h("h3", {}, t.name), h("p", {}, "Only workspace admins can manage org members.")) : null);
    }

    const membersPanel = h("section.adm-org-panel", { "data-org-members-panel": t.id },
      h("h2", {}, `Members · ${t.name}`),
      h("p.adm-hint", {}, "Org members automatically get each board's default org role (memberRole)."),
      state.memberError ? h("div.adm-error", { role: "alert" }, h("span", {}, state.memberError)) : null,
      slot?.error ? renderErrorBanner(slot.error, "retry-members", () => loadTenantMembers(t.id)) : null,
      h("form.adm-form-row", { "data-form": "add-member", onsubmit: submitAddMember },
        h("input.adm-input", {
          type: "email",
          name: "memberEmail",
          placeholder: "Add member by email (e.g. friend@gmail.com)",
          value: state.memberEmail,
          oninput: e => { state.memberEmail = e.target.value; },
        }),
        h("button.adm-btn.primary", { type: "submit", "data-action": "add-member", disabled: state.memberBusy },
          ICONS.plus(), state.memberBusy ? "Adding…" : "Add member")),
      slot?.loading && !slot?.loaded
        ? h("div.adm-loading", {}, "Loading members…")
        : h("div.adm-list", {},
          members.length === 0
            ? h("div.adm-empty", {}, h("p", {}, "No org members added yet."))
            : members.map(email => h("div.adm-row", { "data-member-email": email },
              h("div.adm-row-main", {},
                h("div.adm-row-title", {}, email),
                h("div.adm-row-sub", {}, "Org member")),
              h("div.adm-row-acts", {},
                h("button.adm-btn.sm.danger", {
                  type: "button",
                  "data-action": "remove-member",
                  disabled: state.memberBusy,
                  onclick: () => onRemoveMember(t.id, email),
                }, "Remove"))))),
      admins.length ? [
        h("div.adm-section-label", {}, `Admins (${admins.length})`),
        h("div.adm-list", {}, admins.map(a => h("div.adm-row", { "data-admin-entry": a },
          h("div.adm-row-main", {}, h("div.adm-row-title", {}, a)),
          h("span.adm-badge.owner", {}, "Admin")))),
      ] : null);

    return h("div", {}, switcherPanel, membersPanel);
  }

  function renderBoardsView() {
    if (state.loading) return h("div.adm-loading", {}, "Loading boards…");
    const items = filteredBoards();
    const createOrgCard = renderCreateOrgCard();
    if (!items.length) {
      const searching = state.search.trim().length > 0;
      return h("div", {},
        createOrgCard,
        h("div.adm-empty", {},
          h("h3", {}, searching ? "No matching boards" : "No boards yet"),
          h("p", {}, searching ? `No boards match "${state.search.trim()}".` : state.isAdmin ? "Create your first board to start collaborating." : "Boards shared with you will appear here."),
          !searching && state.isAdmin ? h("button.adm-btn.primary", {
            type: "button",
            "data-action": "new-board-empty",
            onclick: () => { state.newOpen = true; render(); },
          }, ICONS.plus(), "New Board") : null));
    }
    return h("div", {},
      createOrgCard,
      h("div.adm-grid", {}, items.map(b => {
        const title = b.title || "Untitled board";
        const isOwner = b.role === "owner";
        const canShare = isOwner || state.isAdmin;
        const isRenaming = state.renamingId === b.id;
        return h("article.adm-card", { "data-board-id": b.id },
          h("div.adm-thumb", { onclick: () => onOpenBoard?.(b.id) }, boardPreviewSvg()),
          h("div.adm-card-body", {},
            isRenaming
              ? [
                h("form.adm-rename-form", {
                  "data-form": "rename-board",
                  onclick: e => e.stopPropagation?.(),
                  onsubmit: e => submitRename(e, b),
                },
                h("input.adm-input.adm-rename-input", {
                  type: "text",
                  name: "renameTitle",
                  maxlength: "120",
                  "aria-label": "Board title",
                  value: state.renameTitle,
                  disabled: state.renameBusy,
                  oninput: e => { state.renameTitle = e.target.value; },
                  onkeydown: e => { if (e.key === "Escape") { e.preventDefault?.(); cancelRename(); } },
                }),
                h("button.adm-btn.sm.primary", { type: "submit", "data-action": "save-rename", disabled: state.renameBusy }, state.renameBusy ? "Saving…" : "Save"),
                h("button.adm-btn.sm", { type: "button", "data-action": "cancel-rename", disabled: state.renameBusy, onclick: e => { e.stopPropagation?.(); cancelRename(); } }, "Cancel")),
                state.renameError ? h("div.adm-error", { role: "alert", style: { marginBottom: "0", padding: "6px 10px", fontSize: "12px" } }, h("span", {}, state.renameError)) : null,
              ]
              : h("div.adm-card-top", {},
                h("span.adm-card-title", { title, onclick: () => onOpenBoard?.(b.id) }, title),
                b.role ? h("span.adm-badge" + (isOwner ? ".owner" : ""), {}, b.role) : null),
            h("div.adm-card-meta", {},
              h("span", {}, formatDate(b.createdAt)),
              h("div.adm-card-acts", {},
                isOwner && !isRenaming ? h("button.adm-btn.sm", {
                  type: "button",
                  "data-action": "rename-board",
                  title: "Rename board",
                  onclick: e => { e.stopPropagation?.(); startRename(b); },
                }, ICONS.edit(), "Rename") : null,
                isOwner ? h("button.adm-btn.sm.danger", {
                  type: "button",
                  "data-action": "delete-board",
                  title: "Delete board",
                  onclick: e => { e.stopPropagation?.(); openDeleteConfirm(b); },
                }, ICONS.trash(), "Delete") : null,
                canShare ? h("button.adm-btn.sm", { type: "button", "data-action": "share-board", onclick: e => { e.stopPropagation?.(); openShare(b); } }, ICONS.share(), "Share") : null,
                h("button.adm-btn.sm", { type: "button", "data-action": "open-board", onclick: () => onOpenBoard?.(b.id) }, "Open")))));
      })));
  }

  function renderErrorBanner(msg, retryAction, retryFn) {
    return h("div.adm-error", { role: "alert" },
      h("span", {}, msg),
      state.authExpired && onRelogin
        ? h("button.adm-btn.sm.primary", { type: "button", "data-action": "relogin", onclick: onRelogin }, "Sign in again")
        : h("button.adm-btn.sm", { type: "button", "data-action": retryAction, onclick: retryFn }, "Retry"));
  }

  function renderAuditView() {
    if (state.auditLoading && !state.auditLoaded) return h("div.adm-loading", {}, "Loading audit log…");
    const rows = filteredAudit();
    return h("div", {},
      state.auditError ? renderErrorBanner(state.auditError, "retry-audit", () => loadTenantAudit(false)) : null,
      !rows.length
        ? h("div.adm-empty", {}, h("h3", {}, "No audit events"), h("p", {}, "Workspace admin activity will appear here."))
        : h("div.adm-list", {}, rows.map(ev => h("div.adm-audit-row", { "data-audit-id": String(ev.id) },
          h("span.adm-badge", {}, ev.action),
          h("div.adm-row-main", {},
            h("div.adm-row-title", {}, auditSummary(ev)),
            h("div.adm-row-sub", {}, `${ev.actor}${ev.board ? ` · ${ev.board}` : ""}`)),
          h("span.adm-audit-ts", {}, formatDateTime(ev.at))))),
      state.auditNext ? h("div", { style: { marginTop: "14px", textAlign: "center" } },
        h("button.adm-btn", {
          type: "button",
          "data-action": "load-more",
          disabled: state.auditLoading,
          onclick: () => loadTenantAudit(true),
        }, state.auditLoading ? "Loading…" : "Load more")) : null);
  }

  function renderMain() {
    const active = activeTenant();
    const heading = state.tab === "boards" ? "Boards" : state.tab === "org" ? "Org & Members" : "Tenant Audit Log";
    const subtitle = active?.name ?? me?.domain ?? null;
    replace(mainSlot,
      h("div.adm-head", {},
        h("div", {},
          h("h1.adm-title", {}, heading),
          subtitle ? h("p.adm-sub", {}, subtitle) : null)),
      state.notice ? h("div.adm-notice", { role: "status" },
        h("span", {}, state.notice),
        h("button.adm-btn.sm", { type: "button", "data-action": "dismiss-notice", "aria-label": "Dismiss notice", onclick: () => { state.notice = null; renderMain(); } }, ICONS.close())) : null,
      state.tab === "boards" && state.error ? renderErrorBanner(state.error, "retry", loadBoards) : null,
      state.tab === "boards" ? renderBoardsView() : state.tab === "org" ? renderOrgView() : renderAuditView());
  }

  function render() {
    const toggleTheme = () => {
      const next = state.theme === "dark" ? "light" : "dark";
      state.theme = next;
      setTheme?.(next);
      render();
    };
    searchInput.setAttribute("aria-label", state.tab === "boards" ? "Search boards" : "Search audit log");
    searchInput.setAttribute("placeholder", state.tab === "boards" ? "Search boards…" : "Filter activity…");
    if (searchInput.value !== state.search) searchInput.value = state.search;
    const canManageOrg = state.isAdmin && typeof admin.listTenantMembers === "function";
    const nav = h("header.adm-nav", {},
      h("div.adm-brand", {},
        h("span.adm-brand-mark", {}, ICONS.brand()),
        h("span", {}, "Plenary")),
      h("nav.adm-tabs", { role: "tablist" },
        h("button.adm-tab" + (state.tab === "boards" ? ".active" : ""), {
          type: "button", role: "tab", "aria-selected": String(state.tab === "boards"), "data-tab": "boards",
          onclick: () => { state.tab = "boards"; render(); },
        }, "Boards"),
        canManageOrg ? h("button.adm-tab" + (state.tab === "org" ? ".active" : ""), {
          type: "button", role: "tab", "aria-selected": String(state.tab === "org"), "data-tab": "org",
          onclick: () => {
            state.tab = "org"; render();
            const t = activeTenant();
            if (t?.isAdmin) {
              const slot = state.membersByTenant[t.id];
              if (!slot?.loaded && !slot?.loading) loadTenantMembers(t.id);
            }
          },
        }, "Org & Members") : null,
        state.isAdmin ? h("button.adm-tab" + (state.tab === "audit" ? ".active" : ""), {
          type: "button", role: "tab", "aria-selected": String(state.tab === "audit"), "data-tab": "audit",
          onclick: () => {
            state.tab = "audit"; render();
            if (!state.auditLoaded && !state.auditLoading) loadTenantAudit(false);
          },
        }, "Audit Log") : null),
      h("span.adm-spacer"),
      searchInput,
      setTheme ? h("button.adm-btn.sm", { type: "button", "data-action": "toggle-theme", title: "Toggle theme", onclick: toggleTheme }, state.theme === "dark" ? ICONS.sun() : ICONS.moon()) : null,
      me?.name || me?.email ? h("span.adm-user", {}, me.name || me.email) : null,
      onLogout ? h("button.adm-btn.sm", { type: "button", "data-action": "logout", onclick: onLogout }, "Sign out") : null,
      state.isAdmin ? h("button.adm-btn.primary", {
        type: "button",
        "data-action": "new-board",
        onclick: () => { state.newOpen = true; state.createError = null; render(); },
      }, ICONS.plus(), "New Board") : null);

    replace(navSlot, nav);
    renderMain();
    if (!activeShare) renderNewBoardModal();
  }

  const onKey = e => {
    if (e.key !== "Escape") return;
    if (state.deleteTarget && !state.deleting) { e.preventDefault?.(); closeDeleteConfirm(); }
    else if (state.newOpen && !state.creating) { e.preventDefault?.(); state.newOpen = false; state.createError = null; render(); }
  };
  document.addEventListener?.("keydown", onKey);

  const ready = loadBoards();
  return {
    refresh: loadBoards,
    destroy() {
      destroyed = true;
      document.removeEventListener?.("keydown", onKey);
      activeShare?.destroy();
      shell.remove();
      modalSlot.remove();
    },
    ready,
  };
}
