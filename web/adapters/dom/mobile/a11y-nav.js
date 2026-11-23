// @ts-check
// First-class accessible non-pixel navigation for frames, elements, and comments,
// plus polite aria-live announcements (part of the dom adapter group).
// Lets screen-reader and keyboard-only users explore and activate every frame, board element,
// and comment thread without touching canvas coordinates.

import { h, replace } from "../dom.js";
import { announce } from "../focus.js";

/**
 * @typedef {"frames" | "elements" | "comments"} NavSection
 */

/**
 * @typedef {{
 *   id: string,
 *   name?: string,
 *   title?: string,
 * }} A11yFrame
 */

/**
 * @typedef {{
 *   id: string,
 *   type?: string,
 *   text?: string,
 *   label?: string,
 *   name?: string,
 *   frameId?: string | null,
 * }} A11yElement
 */

/**
 * @typedef {{
 *   id: string,
 *   author?: string,
 *   text?: string,
 *   replyCount?: number,
 *   resolved?: boolean,
 *   frameId?: string | null,
 * }} A11yComment
 */

/**
 * Build a human-readable accessible description for a board element.
 * @param {A11yElement} item
 * @param {number} index
 * @returns {string}
 */
export function describeElement(item, index) {
  const kind = String(item?.type ?? "element").replace(/[-_]/g, " ");
  const prettyKind = kind.charAt(0).toUpperCase() + kind.slice(1);
  const label = String(item?.label ?? item?.text ?? item?.name ?? "").trim();
  return label ? `${prettyKind}: ${label}` : `${prettyKind} ${index + 1}`;
}

/**
 * Create an accessible non-pixel board navigator for Frames, Elements, and Comments.
 *
 * @param {{
 *   host: HTMLElement,
 *   frames?: A11yFrame[],
 *   elements?: A11yElement[],
 *   comments?: A11yComment[],
 *   initialSection?: NavSection,
 *   onFocusFrame?: (frame: A11yFrame, index: number) => void,
 *   onFocusElement?: (element: A11yElement, index: number) => void,
 *   onOpenComment?: (comment: A11yComment, index: number) => void,
 *   doc?: Document | null,
 * }} opts
 */
export function createAccessibleBoardNavigator({
  host,
  frames = [],
  elements = [],
  comments = [],
  initialSection = "frames",
  onFocusFrame = null,
  onFocusElement = null,
  onOpenComment = null,
  doc = globalThis.document ?? null,
}) {
  let state = {
    section: /** @type {NavSection} */ (initialSection),
    frames: Array.isArray(frames) ? [...frames] : [],
    elements: Array.isArray(elements) ? [...elements] : [],
    comments: Array.isArray(comments) ? [...comments] : [],
  };

  const liveEl = h("div.mp2-sr-only", {
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    "data-live": "a11y-nav",
  });

  function say(text) {
    liveEl.textContent = "";
    liveEl.textContent = text;
    announce(text);
    return text;
  }

  /** @type {Record<NavSection, HTMLElement>} */
  const tabs = /** @type {any} */ ({});
  const tabDefs = /** @type {Array<[NavSection, string]>} */ ([
    ["frames", "Frames"],
    ["elements", "Elements"],
    ["comments", "Comments"],
  ]);

  const tablist = h("div.mp2-a11y-tabs", {
    role: "tablist",
    "aria-label": "Board outline sections",
  }, tabDefs.map(([key, label]) => {
    const btn = h("button.mp2-a11y-tab", {
      type: "button",
      role: "tab",
      id: `mp2-a11y-tab-${key}`,
      "aria-controls": "mp2-a11y-panel",
      "aria-selected": String(state.section === key),
      "data-section": key,
      onclick: () => setSection(key),
    }, label);
    tabs[key] = btn;
    return btn;
  }));

  const listEl = h("div.mp2-a11y-list", {
    id: "mp2-a11y-panel",
    role: "tabpanel",
    "aria-labelledby": `mp2-a11y-tab-${state.section}`,
    onkeydown: e => handleListKeyDown(e),
  });

  const el = h("section.mp2-a11y-nav", {
    role: "region",
    "aria-label": "Accessible board outline",
    "data-a11y-nav": "",
  }, tablist, listEl, liveEl);

  host.append(el);

  function itemButtons() {
    return listEl.children.filter(c => c.tagName === "BUTTON");
  }

  function handleListKeyDown(e) {
    const items = itemButtons();
    if (!items.length) return;
    const current = /** @type {HTMLElement | null} */ (doc?.activeElement ?? null);
    const idx = items.indexOf(current);
    if (e.key === "ArrowDown") {
      e.preventDefault?.();
      items[(idx + 1 + items.length) % items.length]?.focus?.();
    } else if (e.key === "ArrowUp") {
      e.preventDefault?.();
      items[(idx - 1 + items.length) % items.length]?.focus?.();
    } else if (e.key === "Home") {
      e.preventDefault?.();
      items[0]?.focus?.();
    } else if (e.key === "End") {
      e.preventDefault?.();
      items[items.length - 1]?.focus?.();
    }
  }

  function render() {
    for (const [key, label] of tabDefs) {
      const count = state[key].length;
      const selected = state.section === key;
      tabs[key].setAttribute("aria-selected", String(selected));
      tabs[key].classList.toggle("active", selected);
      tabs[key].textContent = `${label} (${count})`;
    }
    listEl.setAttribute("aria-labelledby", `mp2-a11y-tab-${state.section}`);

    if (state.section === "frames") {
      if (!state.frames.length) {
        replace(listEl, h("p.mp2-a11y-empty", {}, "No frames on this board."));
        return;
      }
      replace(listEl, state.frames.map((frame, i) => {
        const title = String(frame.name ?? frame.title ?? "").trim() || `Frame ${i + 1}`;
        return h("button.mp2-a11y-item", {
          type: "button",
          "data-nav-kind": "frame",
          "data-nav-id": frame.id,
          "aria-label": `Jump to frame ${i + 1} of ${state.frames.length}: ${title}`,
          onclick: () => {
            onFocusFrame?.(frame, i);
            say(`Focused frame ${i + 1} of ${state.frames.length}: ${title}`);
          },
        }, h("span.mp2-a11y-item-title", {}, `${i + 1}. ${title}`));
      }));
      return;
    }

    if (state.section === "elements") {
      if (!state.elements.length) {
        replace(listEl, h("p.mp2-a11y-empty", {}, "No elements on this board."));
        return;
      }
      replace(listEl, state.elements.map((item, i) => {
        const desc = describeElement(item, i);
        return h("button.mp2-a11y-item", {
          type: "button",
          "data-nav-kind": "element",
          "data-nav-id": item.id,
          "aria-label": `Select ${desc}`,
          onclick: () => {
            onFocusElement?.(item, i);
            say(`Selected ${desc}`);
          },
        }, h("span.mp2-a11y-item-title", {}, desc));
      }));
      return;
    }

    if (!state.comments.length) {
      replace(listEl, h("p.mp2-a11y-empty", {}, "No comments on this board."));
      return;
    }
    replace(listEl, state.comments.map((c, i) => {
      const who = c.author ?? "Someone";
      const snippet = String(c.text ?? "").trim() || "Comment thread";
      const replies = typeof c.replyCount === "number" && c.replyCount > 0 ? `, ${c.replyCount} replies` : "";
      const status = c.resolved ? " (resolved)" : "";
      return h("button.mp2-a11y-item", {
        type: "button",
        "data-nav-kind": "comment",
        "data-nav-id": c.id,
        "aria-label": `Open comment by ${who}: ${snippet}${replies}${status}`,
        onclick: () => {
          onOpenComment?.(c, i);
          say(`Opened comment by ${who}`);
        },
      },
      h("span.mp2-a11y-item-title", {}, `${who}: ${snippet}`),
      h("span.mp2-a11y-item-meta", {}, `${c.resolved ? "Resolved" : "Open"}${replies}`));
    }));
  }

  /** @param {NavSection} section */
  function setSection(section) {
    if (state.section === section) return;
    state.section = section;
    render();
    say(`${section} list, ${state[section].length} items`);
  }

  /** @param {{ frames?: A11yFrame[], elements?: A11yElement[], comments?: A11yComment[] }} data */
  function update(data) {
    if (data.frames) state.frames = [...data.frames];
    if (data.elements) state.elements = [...data.elements];
    if (data.comments) state.comments = [...data.comments];
    render();
  }

  function destroy() {
    el.remove();
  }

  render();

  return {
    el,
    tablist,
    listEl,
    liveEl,
    setSection,
    getSection: () => state.section,
    update,
    destroy,
  };
}
