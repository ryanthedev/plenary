// @ts-check
// Accessible Board Version History & Named Snapshots modal (#19).
// Registered on the unified a11y.js overlay stack (trapFocus, Escape, Tab wrap, focus restoration).
// Lists named versions via `versions.list(board)`, lets editors/presenters save named snapshots,
// restore a snapshot onto the board, or delete a saved version.

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";

const ERROR_MESSAGES = {
  auth: "Sign in again to access version history.",
  forbidden: "You don't have permission to manage versions on this board.",
  notfound: "That version could not be found.",
  invalid: "Invalid version label or snapshot.",
  "too-large": "This board snapshot is too large to save as a version.",
  limit: "Maximum number of saved versions reached for this board.",
  unavailable: "Version history is temporarily unavailable.",
  network: "Network error while contacting version history.",
};

/**
 * Format a millisecond timestamp as a short relative time string using `nowMs`.
 * @param {number} ts
 * @param {number} nowMs
 * @returns {string}
 */
export function formatRelativeTime(ts, nowMs) {
  if (!Number.isFinite(ts) || !Number.isFinite(nowMs)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffMo / 12)}y ago`;
}

/**
 * Create a single-instance Version History modal controller.
 * @param {{
 *   host: HTMLElement,
 *   doc?: Document,
 *   board: string,
 *   versions: import("../../ports/versions.js").VersionsPort,
 *   clock: { now(): number },
 *   canWrite: () => boolean,
 *   getSnapshot: () => Record<string, any>,
 *   onRestore: (version: import("../../ports/versions.js").BoardVersion) => boolean,
 *   onToast?: (msg: string, ms?: number) => void,
 *   onRestoreFocus?: (opener: any) => void,
 *   onClose?: () => void,
 * }} opts
 */
export function createVersionsDialog({
  host,
  doc = globalThis.document,
  board,
  versions,
  clock,
  canWrite,
  getSnapshot,
  onRestore,
  onToast = () => {},
  onRestoreFocus = null,
  onClose = null,
}) {
  let openState = false;
  let loading = false;
  let busyId = null;
  let saving = false;
  let labelDraft = "";
  let errorMsg = "";
  /** @type {import("../../ports/versions.js").BoardVersionMeta[]} */
  let list = [];
  let loadGen = 0;
  let sessionGen = 0;

  let veil = null;
  let dialog = null;
  let bodyHost = null;
  let trap = null;
  let openerRef = null;

  function isOpen() {
    return openState;
  }

  function errorText(code) {
    return ERROR_MESSAGES[code] ?? "Something went wrong.";
  }

  function close({ restoreFocus = true } = {}) {
    if (!openState) return;
    openState = false;
    loadGen++;
    sessionGen++;
    busyId = null;
    saving = false;
    errorMsg = "";
    const prevOpener = openerRef;
    openerRef = null;
    trap?.deactivate({ restoreFocus: false });
    trap = null;
    veil?.remove?.();
    veil = null;
    dialog = null;
    bodyHost = null;
    if (restoreFocus) {
      if (typeof onRestoreFocus === "function") onRestoreFocus(prevOpener);
      else if (prevOpener && prevOpener.isConnected !== false) prevOpener.focus?.();
    }
    onClose?.();
  }

  async function refresh() {
    const gen = ++loadGen;
    loading = true;
    errorMsg = "";
    renderBody();
    const res = await versions.list(board);
    if (!openState || gen !== loadGen) return;
    loading = false;
    if ("error" in res) {
      errorMsg = errorText(res.error);
      renderBody();
      return;
    }
    list = [...res.versions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    renderBody();
  }

  async function handleSave() {
    if (!openState || saving || !canWrite()) return;
    const label = labelDraft.trim().slice(0, 120);
    if (!label) {
      errorMsg = "Enter a name for this snapshot.";
      renderBody();
      return;
    }
    const gen = sessionGen;
    saving = true;
    errorMsg = "";
    renderBody();
    const snapshot = getSnapshot();
    const res = await versions.create(board, { label, snapshot });
    if (!openState || gen !== sessionGen) return;
    saving = false;
    if ("error" in res) {
      errorMsg = errorText(res.error);
      renderBody();
      return;
    }
    labelDraft = "";
    list = [res.version, ...list.filter(v => v.id !== res.version.id)];
    onToast(`Saved version: ${res.version.label}`, 2000);
    renderBody();
  }

  async function handleRestore(meta) {
    if (!openState || busyId || !canWrite()) return;
    const gen = sessionGen;
    busyId = meta.id;
    errorMsg = "";
    renderBody();
    const res = await versions.get(board, meta.id);
    if (!openState || gen !== sessionGen) return;
    busyId = null;
    if ("error" in res) {
      errorMsg = errorText(res.error);
      renderBody();
      return;
    }
    const ok = onRestore(res.version);
    if (!ok) {
      errorMsg = "Couldn't restore that snapshot.";
      renderBody();
      return;
    }
    close({ restoreFocus: true });
  }

  async function handleDelete(meta) {
    if (!openState || busyId || !canWrite()) return;
    const gen = sessionGen;
    busyId = meta.id;
    errorMsg = "";
    renderBody();
    const res = await versions.remove(board, meta.id);
    if (!openState || gen !== sessionGen) return;
    busyId = null;
    if ("error" in res) {
      errorMsg = errorText(res.error);
      renderBody();
      return;
    }
    list = list.filter(v => v.id !== meta.id);
    onToast(`Deleted version: ${meta.label}`, 1800);
    renderBody();
  }

  function renderBody() {
    if (!bodyHost) return;
    const writable = canWrite();
    const nowMs = clock.now();
    const nodes = [];

    if (writable) {
      const input = h("input.versions-input", {
        type: "text",
        placeholder: "Snapshot name…",
        "aria-label": "Snapshot name",
        "data-version-label": "1",
        maxLength: 120,
        disabled: saving,
        value: labelDraft,
        oninput: e => {
          labelDraft = e.currentTarget.value;
          if (errorMsg) { errorMsg = ""; }
        },
        onkeydown: e => {
          if (e.key === "Escape") { e.preventDefault?.(); close({ restoreFocus: true }); return; }
          if (e.key === "Enter") { e.preventDefault?.(); handleSave(); return; }
          e.stopPropagation();
        },
      });
      const saveBtn = h("button.btn.primary", {
        type: "button",
        "data-action": "save-version",
        disabled: saving,
        onclick: () => { handleSave(); },
      }, saving ? "Saving…" : "Save snapshot");
      nodes.push(h("div.versions-form", {}, input, saveBtn));
    }

    if (errorMsg) {
      nodes.push(h("div.versions-error", { role: "alert" }, errorMsg));
    }

    if (loading) {
      nodes.push(h("div.hint.versions-empty", { role: "status" }, "Loading versions…"));
    } else if (!list.length) {
      nodes.push(h("div.hint.versions-empty", {}, writable
        ? "No saved versions yet. Save a named snapshot above to mark a milestone."
        : "No saved versions yet."));
    } else {
      nodes.push(h("div.versions-list", { role: "list", "aria-label": "Saved versions" }, list.map(v => {
        const who = v.createdByName || v.createdBy;
        const when = formatRelativeTime(v.createdAt, nowMs);
        const countStr = `${v.elementCount} element${v.elementCount === 1 ? "" : "s"}`;
        const isBusy = busyId === v.id;
        return h("div.versions-row", { role: "listitem", "data-version-id": v.id },
          h("div.versions-info", {},
            h("div.versions-label", {}, v.label),
            h("div.versions-meta", {}, `${who} · ${when} · ${countStr}`)),
          writable ? h("div.versions-acts", {},
            h("button.btn.ghost", {
              type: "button",
              "data-action": "restore-version",
              "data-version-id": v.id,
              "aria-label": `Restore ${v.label}`,
              disabled: Boolean(busyId) || saving,
              onclick: () => { handleRestore(v); },
            }, isBusy ? "…" : "Restore"),
            h("button.tb.versions-del", {
              type: "button",
              "data-action": "delete-version",
              "data-version-id": v.id,
              title: `Delete ${v.label}`,
              "aria-label": `Delete ${v.label}`,
              disabled: Boolean(busyId) || saving,
              onclick: () => { handleDelete(v); },
            }, icon("trash", { size: 14 }))) : null);
      })));
    }

    replace(bodyHost, nodes);
  }

  /**
   * Open the Version History modal and load the board's saved versions.
   * @param {{ opener?: any }} [opts]
   */
  function open({ opener = null } = {}) {
    if (openState) {
      refresh();
      return;
    }
    openState = true;
    openerRef = opener;
    errorMsg = "";

    bodyHost = h("div.dbody.versions-body", {});
    const closeBtn = h("button.tb", {
      type: "button",
      title: "Close",
      "aria-label": "Close version history",
      onclick: () => close({ restoreFocus: true }),
    }, icon("close", { size: 16 }));

    dialog = h("div.dialog.versions-modal", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "versions-dialog-title",
      "aria-label": "Version history",
      tabindex: "-1",
    },
    h("h2", { id: "versions-dialog-title" },
      icon("history", { size: 17 }), " Version history",
      h("span.spacer"),
      closeBtn),
    bodyHost,
    h("footer", {},
      h("button.btn", { type: "button", onclick: () => close({ restoreFocus: true }) }, "Close")));

    veil = h("div.dialog-veil.versions-veil", {
      onclick: e => { if (e.target === e.currentTarget) close({ restoreFocus: true }); },
      onkeydown: e => trap?.handleKeyDown(e),
    }, dialog);

    host.append(veil);
    renderBody();
    trap = trapFocus(dialog, {
      onEscape: () => close({ restoreFocus: true }),
      returnFocusTo: null,
      doc,
    });
    refresh();
  }

  return {
    open,
    close,
    isOpen,
    refresh,
  };
}
