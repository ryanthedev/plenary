// @ts-check
// DOM adapters for @mention autocomplete, comment thread filter pills, and notification center (Issue #13).
// Never uses innerHTML / outerHTML / insertAdjacentHTML — all untrusted strings go through textContent via h().

import { h, replace } from "./dom.js";
import {
  extractMentionQuery,
  insertMention,
  matchMentionCandidates,
} from "../../core/mentions.js";

/** @typedef {import("../../core/mentions.js").Participant} Participant */
/** @typedef {import("../../core/mentions.js").MentionCandidate} MentionCandidate */
/** @typedef {import("../../core/mentions.js").ThreadFilter} ThreadFilter */
/** @typedef {import("../../core/mentions.js").NotificationItem} NotificationItem */

let pickerSeq = 0;

/**
 * Format a badge count cleanly (capped display at "99+").
 * @param {number} n
 * @returns {string}
 */
function formatBadge(n) {
  return n > 99 ? "99+" : String(n);
}

/**
 * Create a keyboard-navigable (ArrowUp/Down/Enter/Tab/Escape) `@mention` autocomplete popover
 * attached to `textarea`.
 *
 * @param {{
 *   textarea: HTMLTextAreaElement,
 *   getParticipants: () => Participant[],
 *   onSelect?: (candidate: MentionCandidate, result: { text: string, cursor: number }) => void,
 *   container?: HTMLElement | null,
 *   maxItems?: number,
 * }} opts
 */
export function createMentionPicker({ textarea, getParticipants, onSelect, container = null, maxItems = 8 }) {
  const idPrefix = `mention-picker-${++pickerSeq}`;
  const listboxId = `${idPrefix}-list`;

  const el = h("div.mention-picker", {
    id: listboxId,
    role: "listbox",
    "aria-label": "Mention a person",
    hidden: true,
  });

  const host = container ?? textarea.parentNode ?? document.body;
  if (host && typeof host.append === "function") host.append(el);

  textarea.setAttribute("aria-autocomplete", "list");
  textarea.setAttribute("aria-controls", listboxId);
  textarea.setAttribute("aria-expanded", "false");

  /** @type {MentionCandidate[]} */
  let items = [];
  let activeIdx = 0;
  let openState = false;

  function render() {
    if (!items.length) {
      close();
      return;
    }
    const rows = items.map((c, idx) => {
      const optId = `${idPrefix}-opt-${idx}`;
      const isSelected = idx === activeIdx;
      const kids = [];
      if (c.name) kids.push(h("span.mention-option-name", {}, c.name));
      kids.push(h("span.mention-option-handle", {}, `@${c.handle}`));
      if (c.email && c.email.toLowerCase() !== c.handle.toLowerCase()) {
        kids.push(h("span.mention-option-email", {}, c.email));
      }
      return h("button.mention-option", {
        type: "button",
        id: optId,
        role: "option",
        class: isSelected ? "is-active" : "",
        "aria-selected": isSelected ? "true" : "false",
        "data-handle": c.handle,
        tabindex: "-1",
        onmousedown: (/** @type {Event} */ e) => {
          e.preventDefault();
        },
        onclick: () => select(idx),
      }, ...kids);
    });

    replace(el, ...rows);
    el.hidden = false;
    openState = true;
    textarea.setAttribute("aria-expanded", "true");
    textarea.setAttribute("aria-activedescendant", `${idPrefix}-opt-${activeIdx}`);
  }

  function close() {
    openState = false;
    items = [];
    activeIdx = 0;
    el.hidden = true;
    replace(el);
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute?.("aria-activedescendant");
  }

  /**
   * @param {number} [idx]
   */
  function select(idx = activeIdx) {
    const candidate = items[idx];
    if (!candidate) return;
    const cursor = typeof textarea.selectionStart === "number"
      ? textarea.selectionStart
      : textarea.value.length;
    const result = insertMention(textarea.value, cursor, candidate);
    textarea.value = result.text;
    if (typeof textarea.setSelectionRange === "function") {
      textarea.setSelectionRange(result.cursor, result.cursor);
    }
    close();
    if (typeof textarea.focus === "function") textarea.focus();
    onSelect?.(candidate, result);
  }

  function refresh() {
    const cursor = typeof textarea.selectionStart === "number"
      ? textarea.selectionStart
      : textarea.value.length;
    const active = extractMentionQuery(textarea.value, cursor);
    if (!active) {
      if (openState) close();
      return;
    }
    const participants = typeof getParticipants === "function" ? getParticipants() : [];
    const next = matchMentionCandidates(active.query, participants, { limit: maxItems });
    if (!next.length) {
      if (openState) close();
      return;
    }
    items = next;
    activeIdx = Math.min(activeIdx, items.length - 1);
    render();
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!openState || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      select(activeIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (openState && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) {
      return;
    }
    refresh();
  }

  function onInput() {
    refresh();
  }

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeyDown);
  textarea.addEventListener("keyup", onKeyUp);

  function destroy() {
    textarea.removeEventListener?.("input", onInput);
    textarea.removeEventListener?.("keydown", onKeyDown);
    textarea.removeEventListener?.("keyup", onKeyUp);
    close();
    el.remove?.();
  }

  return {
    el,
    isOpen: () => openState,
    activeIndex: () => activeIdx,
    candidates: () => [...items],
    refresh,
    close,
    select,
    destroy,
  };
}

/** @type {readonly { id: ThreadFilter, label: string }[]} */
const FILTER_TABS = Object.freeze([
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
  { id: "unread", label: "Unread" },
  { id: "resolved", label: "Resolved" },
]);

/**
 * Render the `All | Mentions | Unread | Resolved` comment thread filter bar
 * with accessible `role="tablist"` and unread badges.
 *
 * @param {{
 *   active?: ThreadFilter,
 *   counts?: Partial<Record<ThreadFilter, number>>,
 *   onChange?: (filter: ThreadFilter) => void,
 * }} opts
 * @returns {HTMLElement}
 */
export function renderThreadFilterPills({ active = "all", counts = {}, onChange } = {}) {
  /** @type {HTMLElement[]} */
  const buttons = [];

  for (let i = 0; i < FILTER_TABS.length; i++) {
    const tab = FILTER_TABS[i];
    const isActive = tab.id === active;
    const rawCount = counts?.[tab.id];
    const count = typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
      ? Math.floor(rawCount)
      : 0;

    const kids = [h("span.thread-filter-label", {}, tab.label)];
    if (count > 0) {
      const badgeClass = tab.id === "unread" || tab.id === "mentions" ? "is-unread" : "";
      kids.push(h("span.thread-filter-badge", {
        class: badgeClass,
        "data-count": String(count),
      }, formatBadge(count)));
    }

    const btn = h("button.thread-filter-pill", {
      type: "button",
      role: "tab",
      class: isActive ? "is-active" : "",
      "data-filter": tab.id,
      "aria-selected": isActive ? "true" : "false",
      tabindex: isActive ? "0" : "-1",
      onclick: () => {
        onChange?.(tab.id);
      },
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        let nextIdx = -1;
        if (e.key === "ArrowRight") nextIdx = (i + 1) % FILTER_TABS.length;
        else if (e.key === "ArrowLeft") nextIdx = (i - 1 + FILTER_TABS.length) % FILTER_TABS.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = FILTER_TABS.length - 1;
        if (nextIdx >= 0) {
          e.preventDefault();
          buttons[nextIdx]?.focus?.();
          onChange?.(FILTER_TABS[nextIdx].id);
        }
      },
    }, ...kids);

    buttons.push(btn);
  }

  return h("div.thread-filter-pills", {
    role: "tablist",
    "aria-label": "Filter comment threads",
  }, ...buttons);
}

/**
 * Create a compact bell button with an unread badge and dropdown notification list.
 *
 * @param {{
 *   getNotifications: () => { items: NotificationItem[], unreadCount: number } | NotificationItem[],
 *   onOpenThread?: (threadId: string, item: NotificationItem) => void,
 *   onMarkAllRead?: () => void,
 * }} opts
 */
export function createNotificationCenter({ getNotifications, onOpenThread, onMarkAllRead }) {
  let openState = false;

  const badge = h("span.notification-badge", { hidden: true }, "0");
  const bellBtn = h("button.notification-bell", {
    type: "button",
    "aria-haspopup": "true",
    "aria-expanded": "false",
    "aria-label": "Notifications",
    onclick: () => toggle(),
  }, h("span.notification-bell-icon", { "aria-hidden": "true" }, "🔔"), badge);

  const markAllBtn = h("button.notification-mark-all", {
    type: "button",
    disabled: true,
    onclick: () => {
      onMarkAllRead?.();
      refresh();
    },
  }, "Mark all read");

  const listEl = h("div.notification-list", { role: "list" });

  const dropdown = h("div.notification-dropdown", {
    role: "region",
    "aria-label": "Notifications",
    hidden: true,
  },
    h("div.notification-header", {},
      h("span.notification-title", {}, "Notifications"),
      markAllBtn,
    ),
    listEl,
  );

  const root = h("div.notification-center", {}, bellBtn, dropdown);

  function readState() {
    const raw = typeof getNotifications === "function" ? getNotifications() : { items: [], unreadCount: 0 };
    if (Array.isArray(raw)) {
      const unreadCount = raw.filter(i => i && i.unread !== false).length;
      return { items: raw, unreadCount };
    }
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const unreadCount = typeof raw?.unreadCount === "number" && Number.isFinite(raw.unreadCount)
      ? Math.max(0, Math.floor(raw.unreadCount))
      : items.length;
    return { items, unreadCount };
  }

  function refresh() {
    const { items, unreadCount } = readState();
    if (unreadCount > 0) {
      badge.hidden = false;
      badge.textContent = formatBadge(unreadCount);
      bellBtn.setAttribute("aria-label", `Notifications (${unreadCount} unread)`);
      markAllBtn.disabled = false;
    } else {
      badge.hidden = true;
      badge.textContent = "0";
      bellBtn.setAttribute("aria-label", "Notifications");
      markAllBtn.disabled = true;
    }

    if (!items.length) {
      replace(listEl, h("div.notification-empty", {}, "No unread notifications"));
      return;
    }

    const rows = items.map(item => {
      const actionLabel = item.kind === "mention" ? "mentioned you" : "replied";
      return h("button.notification-item", {
        type: "button",
        role: "listitem",
        class: item.unread ? "is-unread" : "",
        "data-thread-id": item.threadId,
        "data-kind": item.kind,
        onclick: () => {
          close();
          onOpenThread?.(item.threadId, item);
        },
      },
        h("div.notification-item-meta", {},
          h("span.notification-item-author", {}, item.authorName || item.by || "Someone"),
          h("span.notification-item-kind", {}, ` ${actionLabel}`),
        ),
        h("div.notification-item-text", {}, item.text ?? ""),
      );
    });
    replace(listEl, ...rows);
  }

  function open() {
    refresh();
    openState = true;
    dropdown.hidden = false;
    bellBtn.setAttribute("aria-expanded", "true");
  }

  function close() {
    if (!openState) return;
    openState = false;
    dropdown.hidden = true;
    bellBtn.setAttribute("aria-expanded", "false");
  }

  function toggle() {
    if (openState) close();
    else open();
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (openState && e.key === "Escape") {
      e.preventDefault();
      close();
      bellBtn.focus?.();
    }
  }

  /** @param {MouseEvent} e */
  function onDocClick(e) {
    if (!openState) return;
    const target = /** @type {Node | null} */ (e.target);
    if (target && typeof root.contains === "function" && !root.contains(target)) {
      close();
    }
  }

  root.addEventListener("keydown", onKeyDown);
  document.addEventListener?.("click", onDocClick);

  function destroy() {
    root.removeEventListener?.("keydown", onKeyDown);
    document.removeEventListener?.("click", onDocClick);
    close();
    root.remove?.();
  }

  refresh();

  return {
    el: root,
    button: bellBtn,
    dropdown,
    isOpen: () => openState,
    open,
    close,
    toggle,
    refresh,
    destroy,
  };
}
