// @ts-check
// Concepts-inspired Circular Radial Hub DOM adapter:
// A compact 42-44px circular color-ring hub docked in #hudBR that fans out a radial arc of
// high-frequency tools (Style, Layers, Views, Library, Animate, Settings) plus an inner
// quick-style swatch & stroke-width ring — giving zero-sidebar access to the canvas.

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import {
  RADIAL_SWATCHES,
  RADIAL_WIDTHS,
  computeRadialPositions,
  radialSlotsForRole,
} from "../../core/radial-hub.js";

/**
 * Create a live Concepts-inspired radial hub widget.
 * @param {{
 *   getRole: () => string,
 *   getStyle: () => { strokeColor?: string, strokeWidth?: number },
 *   canEdit: () => boolean,
 *   onSelectSlot: (slotId: string, opener?: HTMLElement | null) => void,
 *   onStylePatch: (patch: { strokeColor?: string, strokeWidth?: number }) => void,
 * }} opts
 */
export function createRadialHub(opts) {
  let open = false;
  const root = h("div.radial-hub", { "data-radial-hub": "1", "data-open": "false" });

  const setOpen = next => {
    const v = Boolean(next);
    if (open === v) return;
    open = v;
    render();
  };

  const onDocPointerDown = e => {
    if (!open) return;
    const t = /** @type {Node | null} */ (e?.target ?? null);
    if (t && root.contains?.(t)) return;
    setOpen(false);
  };

  const onDocKeyDown = e => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault?.();
      e.stopPropagation?.();
      setOpen(false);
    }
  };

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
  }

  function render() {
    root.setAttribute("data-open", open ? "true" : "false");
    const role = opts.getRole?.() ?? "presenter";
    const st = opts.getStyle?.() ?? {};
    const activeColor = st.strokeColor && st.strokeColor !== "transparent" ? st.strokeColor : "#3B48E8";
    const activeWidth = st.strokeWidth ?? 2;
    const editable = Boolean(opts.canEdit?.());
    const slots = radialSlotsForRole(role);

    const trigger = h("button.radial-hub-trigger" + (open ? ".on" : ""), {
      type: "button",
      title: open ? "Close Quick Hub (Esc)" : "Open Concepts Quick Hub",
      "aria-label": open ? "Close Quick Hub" : "Open Quick Hub",
      "aria-expanded": String(open),
      "aria-haspopup": "menu",
      "data-radial-trigger": "1",
      onclick: e => {
        e.stopPropagation?.();
        setOpen(!open);
      },
    },
    h("span.radial-hub-ring", { style: { borderColor: activeColor } },
      h("span.radial-hub-core", { style: { background: activeColor } })));

    if (!open) {
      replace(root, trigger);
      return;
    }

    // Fan upward-left (-190deg to -80deg) so it stays 100% inside the viewport from bottom-right.
    const positions = computeRadialPositions(slots.length, { radius: 112, startDeg: -186, endDeg: -84 });
    const sliceNodes = slots.map((slot, i) => {
      const pos = positions[i];
      return h("button.radial-slice", {
        type: "button",
        role: "menuitem",
        title: slot.title,
        "aria-label": slot.label,
        "data-radial-slot": slot.id,
        style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
        onclick: e => {
          e.stopPropagation?.();
          setOpen(false);
          opts.onSelectSlot?.(slot.id, trigger);
        },
      },
      h("span.radial-slice-ic", {}, icon(slot.icon, { size: 15 })),
      h("span.radial-slice-lab", {}, slot.label));
    });

    const quickStyle = editable
      ? h("div.radial-quick-style", { role: "group", "aria-label": "Quick style" },
        h("div.radial-swatches", {}, RADIAL_SWATCHES.map(color =>
          h("button.radial-sw" + (activeColor.toLowerCase() === color.toLowerCase() ? ".on" : ""), {
            type: "button",
            title: `Stroke ${color}`,
            "aria-label": `Stroke color ${color}`,
            "data-radial-color": color,
            style: { background: color },
            onclick: e => {
              e.stopPropagation?.();
              opts.onStylePatch?.({ strokeColor: color });
              render();
            },
          }))),
        h("div.radial-widths", {}, RADIAL_WIDTHS.map(w =>
          h("button.radial-w" + (activeWidth === w.value ? ".on" : ""), {
            type: "button",
            title: `Stroke width: ${w.id}`,
            "aria-label": `Stroke width ${w.id}`,
            "data-radial-width": String(w.value),
            onclick: e => {
              e.stopPropagation?.();
              opts.onStylePatch?.({ strokeWidth: w.value });
              render();
            },
          }, w.label))))
      : null;

    const wheel = h("div.radial-wheel", {
      role: "menu",
      "aria-label": "Quick Hub",
      "data-radial-wheel": "1",
    }, sliceNodes, quickStyle);

    replace(root, wheel, trigger);
  }

  render();

  return {
    el: root,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh: () => render(),
    destroy: () => {
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
        document.removeEventListener("keydown", onDocKeyDown, true);
      }
    },
  };
}
