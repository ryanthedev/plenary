// @ts-check
// Mobile Participants & Follow Sheet (#11 fix).
// - Replaces the non-clickable mobile "+N" overflow chip with an interactive button that opens
//   a standardized 2-detent bottom sheet listing EVERY participant (presenters 3+ are 100% reachable).
// - Supports Follow / Following toggle per presenter, manual pan/unfollow detection,
//   and a "Stopped following · Re-follow" recovery toast.
// - Announces follow/unfollow state changes via polite aria-live.

import { h, replace } from "../dom.js";
import { announce } from "../focus.js";
import { colorOf, initials } from "../../../core/collab/presence-model.js";
import { createBottomSheet } from "./sheet.js";

export const MOBILE_VISIBLE_AVATARS = 2;
export const REFOLLOW_TOAST_MS = 6000;

/**
 * @typedef {{
 *   id: string,
 *   user?: string,
 *   name: string,
 *   role?: "owner" | "editor" | "presenter" | "annotator" | "viewer" | string,
 *   presenting?: boolean,
 * }} MobileParticipant
 */

/**
 * Sort participants so active presenters come first, then editors/owners, then everyone else.
 * @param {MobileParticipant[]} list
 * @returns {MobileParticipant[]}
 */
export function sortParticipants(list) {
  const rank = p => {
    if (p.presenting) return 0;
    if (p.role === "owner" || p.role === "presenter" || p.role === "editor") return 1;
    if (p.role === "annotator") return 2;
    return 3;
  };
  return [...(Array.isArray(list) ? list : [])].filter(Boolean).sort((a, b) => rank(a) - rank(b));
}

/**
 * Create the Mobile Participants strip, Follow bottom sheet, and "Stopped following · Re-follow" toast.
 *
 * @param {{
 *   host: HTMLElement,
 *   sheetHost?: HTMLElement,
 *   toastHost?: HTMLElement,
 *   participants?: MobileParticipant[],
 *   followingId?: string | null,
 *   visibleAvatars?: number,
 *   toastMs?: number,
 *   clock?: { set: (fn: () => void, ms: number) => any, clear: (id: any) => void } | null,
 *   onFollow?: (p: MobileParticipant) => void,
 *   onUnfollow?: (p: MobileParticipant, reason: string) => void,
 *   doc?: Document | null,
 *   win?: any,
 * }} opts
 */
export function createParticipantsController({
  host,
  sheetHost = host,
  toastHost = host,
  participants = [],
  followingId = null,
  visibleAvatars = MOBILE_VISIBLE_AVATARS,
  toastMs = REFOLLOW_TOAST_MS,
  clock = null,
  onFollow = null,
  onUnfollow = null,
  doc = globalThis.document ?? null,
  win = globalThis.window ?? globalThis,
}) {
  let list = sortParticipants(participants);
  let activeFollowId = followingId ?? null;
  /** @type {MobileParticipant | null} */
  let lastFollowed = activeFollowId ? list.find(p => p.id === activeFollowId) ?? null : null;
  let toastEl = /** @type {HTMLElement | null} */ (null);
  let toastTimer = /** @type {any} */ (null);
  let destroyed = false;

  const liveEl = h("div.mp2-sr-only", {
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    "data-live": "follow",
  });

  function say(text) {
    liveEl.textContent = "";
    liveEl.textContent = text;
    announce(text);
    return text;
  }

  const stripEl = h("div.mp2-participants-strip", {
    role: "group",
    "aria-label": "Participants",
    "data-participants-strip": "",
  });

  const el = h("div.mp2-participants", {}, stripEl, liveEl);
  host.append(el);

  const listEl = h("div.mp2-participant-list", {
    role: "list",
    "aria-label": "All participants",
  });

  const sheet = createBottomSheet({
    host: sheetHost,
    title: "Participants",
    subtitle: `${list.length} active`,
    kind: "participants",
    initialDetent: "half",
    allowDetents: ["half", "full"],
    body: listEl,
    doc,
    win,
  });

  /** @type {HTMLElement | null} */
  let chipEl = null;

  function avatarBadge(p) {
    return h("span.mp2-avatar", {
      style: { background: colorOf(p.user ?? p.id) },
      "aria-hidden": "true",
    }, initials(p.name));
  }

  function renderStrip() {
    const shown = list.slice(0, visibleAvatars);
    const overflow = Math.max(0, list.length - shown.length);

    const buttons = shown.map(p => {
      const following = p.id === activeFollowId;
      return h("button.mp2-avatar-btn" + (following ? ".following" : ""), {
        type: "button",
        "data-participant-id": p.id,
        "aria-pressed": String(following),
        "aria-label": following ? `Following ${p.name}. Tap to manage` : `Follow ${p.name}`,
        onclick: () => openSheet(/** @type {HTMLElement} */ (doc?.activeElement ?? null)),
      }, avatarBadge(p));
    });

    if (overflow > 0) {
      chipEl = h("button.mp2-participants-chip", {
        type: "button",
        "data-participants-more": "",
        "aria-haspopup": "dialog",
        "aria-expanded": String(sheet.isOpen()),
        "aria-label": `Show all ${list.length} participants (${overflow} more)`,
        onclick: () => openSheet(chipEl),
      }, `+${overflow}`);
    } else {
      chipEl = h("button.mp2-participants-chip.all-visible", {
        type: "button",
        "data-participants-more": "",
        "aria-haspopup": "dialog",
        "aria-expanded": String(sheet.isOpen()),
        "aria-label": `Show all ${list.length} participants`,
        onclick: () => openSheet(chipEl),
      }, String(list.length));
    }

    replace(stripEl, ...buttons, chipEl);
  }

  function renderSheetList() {
    const presentersCount = list.filter(p => p.presenting || p.role === "owner" || p.role === "presenter" || p.role === "editor").length;
    sheet.setTitle("Participants", `${list.length} active · ${presentersCount} ${presentersCount === 1 ? "presenter" : "presenters"}`);

    const rows = list.map(p => {
      const isFollowing = p.id === activeFollowId;
      const roleText = p.presenting ? "Presenting" : (p.role ?? "Participant");
      return h("div.mp2-participant-row" + (isFollowing ? ".following" : ""), {
        role: "listitem",
        "data-participant-row": p.id,
      },
      avatarBadge(p),
      h("div.mp2-participant-info", {},
        h("span.mp2-participant-name", {}, p.name),
        h("span.mp2-participant-role", {}, roleText)),
      h("button.mp2-follow-btn" + (isFollowing ? ".active" : ""), {
        type: "button",
        "data-follow-id": p.id,
        "aria-pressed": String(isFollowing),
        "aria-label": isFollowing ? `Stop following ${p.name}` : `Follow ${p.name}`,
        onclick: () => {
          if (isFollowing) {
            stopFollowing({ reason: "manual" });
          } else {
            follow(p.id);
          }
        },
      }, isFollowing ? "Following" : "Follow"));
    });

    replace(listEl, rows);
  }

  function clearToast() {
    if (toastTimer !== null && clock?.clear) {
      clock.clear(toastTimer);
      toastTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  /** @param {MobileParticipant} prev */
  function showRefollowToast(prev) {
    clearToast();
    const refollowBtn = h("button.mp2-refollow-btn", {
      type: "button",
      "data-action": "refollow",
      "aria-label": `Re-follow ${prev.name}`,
      onclick: () => {
        clearToast();
        follow(prev.id);
      },
    }, "Re-follow");

    const dismissBtn = h("button.mp2-toast-dismiss", {
      type: "button",
      "aria-label": "Dismiss follow notice",
      onclick: () => clearToast(),
    }, "Dismiss");

    toastEl = h("div.mp2-follow-toast", {
      role: "group",
      "aria-label": "Follow status",
      "data-follow-toast": "",
    },
    h("span.mp2-follow-toast-text", {}, `Stopped following ${prev.name} · `),
    refollowBtn,
    dismissBtn);

    toastHost.append(toastEl);

    if (clock?.set && toastMs > 0) {
      toastTimer = clock.set(() => {
        toastTimer = null;
        clearToast();
      }, toastMs);
    }
  }

  /** @param {string} id */
  function follow(id) {
    const target = list.find(p => p.id === id);
    if (!target) return false;
    clearToast();
    activeFollowId = target.id;
    lastFollowed = target;
    renderStrip();
    renderSheetList();
    onFollow?.(target);
    say(`Following ${target.name}`);
    return true;
  }

  /** @param {{ reason?: "pan" | "manual" | "left" | string, showToast?: boolean }} [opts] */
  function stopFollowing({ reason = "pan", showToast = true } = {}) {
    if (!activeFollowId) return false;
    const prev = list.find(p => p.id === activeFollowId) ?? lastFollowed;
    activeFollowId = null;
    renderStrip();
    renderSheetList();
    if (prev) {
      onUnfollow?.(prev, reason);
      say(`Stopped following ${prev.name}`);
      if (showToast) showRefollowToast(prev);
    }
    return true;
  }

  /** @param {HTMLElement | null} [trigger] */
  function openSheet(trigger = chipEl) {
    renderSheetList();
    sheet.open({ detent: "half", returnFocusTo: trigger ?? chipEl });
    chipEl?.setAttribute("aria-expanded", "true");
  }

  function closeSheet() {
    sheet.close("programmatic");
    chipEl?.setAttribute("aria-expanded", "false");
  }

  /** @param {MobileParticipant[]} nextList */
  function setParticipants(nextList) {
    list = sortParticipants(nextList);
    if (activeFollowId && !list.some(p => p.id === activeFollowId)) {
      stopFollowing({ reason: "left", showToast: false });
    }
    renderStrip();
    if (sheet.isOpen()) renderSheetList();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearToast();
    sheet.destroy();
    el.remove();
  }

  renderStrip();
  renderSheetList();

  return {
    el,
    get chipEl() { return chipEl; },
    sheet,
    liveEl,
    openSheet,
    closeSheet,
    isSheetOpen: () => sheet.isOpen(),
    setParticipants,
    follow,
    stopFollowing,
    getFollowing: () => list.find(p => p.id === activeFollowId) ?? null,
    getToastEl: () => toastEl,
    destroy,
  };
}
