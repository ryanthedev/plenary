// @ts-check
// Responsive Admin & RBAC card renderers for mobile viewports (< 640px).
// Collapses wide `table.matrix` permission/offboarding grids into single-column cards
// with 40-44px touch rows while preserving exact ARIA, focus-key (`data-fk`), and keyboard semantics.

import { h } from "../dom.js";

export const MOBILE_CARD_BREAKPOINT_PX = 640;

/**
 * True when the viewport is narrower than 640px (falls back to false on minimal test DOMs).
 * @param {boolean | null} [override]
 * @returns {boolean}
 */
export function isMobileCardViewport(override = null) {
  if (typeof override === "boolean") return override;
  try {
    if (typeof globalThis.matchMedia === "function") {
      return Boolean(globalThis.matchMedia(`(max-width: ${MOBILE_CARD_BREAKPOINT_PX - 1}px)`).matches);
    }
  } catch {
    // Ignore restricted matchMedia stubs.
  }
  return false;
}

/**
 * Render a Roles permission matrix as single-column mobile cards (40-44px touch rows).
 * Keeps the same `perm:<id>` focus keys, checkbox labels, `aria-disabled`, and scope descriptions as the desktop table.
 * @param {{
 *   rows: any[],
 *   scopeLabels: Record<string, string>,
 *   cellMeta: Record<string, string[]>,
 *   editable: boolean,
 *   busy: boolean,
 *   onToggle: (id: string) => void,
 *   mark: (el: HTMLElement, key: string) => HTMLElement,
 *   ctl: (el: HTMLElement) => HTMLElement,
 * }} opts
 */
export function renderRolePermissionCards({ rows, scopeLabels, cellMeta, editable, busy, onToggle, mark, ctl }) {
  let tierHead = false;
  const items = rows.flatMap(r => {
    const heading = r.group === "content-tier" && !tierHead && (tierHead = true)
      ? h("li.mobile-admin-tier-head", { role: "presentation" },
        h("strong", {}, "Content tier"),
        h("small", {}, "Opening boards beyond your own access. Held at the organization only; only someone who holds a permission can give it."))
      : null;

    const reasonId = r.reason ? `reason-${r.id.replace(/\W/g, "-")}` : null;
    const grantControl = r.group === "content"
      ? h("span.mobile-perm-fixed", {}, h("strong", {}, r.ticked ? "Yes" : "No"), h("small", {}, " set by board access"))
      : h("label.mobile-touch-row.mobile-perm-toggle", {},
        mark(ctl(h("input", {
          type: "checkbox",
          checked: r.ticked,
          "aria-label": `${r.label}, ${r.id}`,
          "aria-disabled": r.tickable ? "false" : "true",
          ...(reasonId ? { "aria-describedby": reasonId } : {}),
          onclick: e => {
            if (!r.tickable || busy) { e.preventDefault?.(); return; }
            onToggle(r.id);
          },
        })), `perm:${r.id}`),
        h("span.mobile-perm-toggle-text", {}, r.ticked ? "Granted" : "Not granted"));

    const scopeChips = h("div.mobile-scope-chips", { "aria-label": `Scopes for ${r.label}` },
      r.cells.map(c => {
        const meta = cellMeta[c.state] ?? ["", ""];
        const scopeName = scopeLabels[c.scope] ?? c.scope;
        return h("span", {
          class: `mobile-scope-chip mobile-scope-${c.state}`,
        },
        h("span", { "aria-hidden": "true" }, `${scopeName}: ${meta[0] || "—"}`),
        h("span.sr-only", {}, `${scopeName}: ${meta[1]}`));
      }));

    const card = h("li.mobile-admin-card.role-perm-card", { "data-perm-id": r.id },
      h("div.mobile-admin-card-head", {},
        h("div.mobile-admin-card-title", {},
          h("strong", {}, r.label),
          h("code", {}, r.id)),
        grantControl),
      r.help ? h("p.mobile-admin-card-help", {}, r.help) : null,
      r.reason ? h("p.reason.mobile-admin-card-reason", { id: reasonId }, r.reason) : null,
      scopeChips);

    return heading ? [heading, card] : [card];
  });

  return h("section.mobile-matrix-cards", {
    role: "region",
    "aria-label": "Permission matrix",
    "data-mobile-cards": "roles",
  },
  h("p.sr-only", {}, editable ? "Permissions by scope. Tick a permission to grant it." : "Permissions by scope. This role is read-only."),
  h("ul.mobile-admin-card-list", { "aria-label": "Permissions" }, items));
}

/**
 * Render an Offboarding ownership grid as single-column mobile cards (40-44px touch rows).
 * Keeps the same `pick:<key>` focus keys, labelled native `<select>`, and alert/status lines as the desktop table.
 * @param {{
 *   memberName: string,
 *   items: any[],
 *   model: any,
 *   busy: boolean,
 *   defaults: { recipient: { id: string, name: string }, reason: string },
 *   results: Map<string, any>,
 *   itemLabel: (i: any) => string,
 *   onChoose: (item: any, person: any, fk: string) => void,
 * }} opts
 */
export function renderOffboardCards({ memberName, items, model, busy, defaults, results, itemLabel, onChoose }) {
  const people = model.people();
  const cards = items.map(i => {
    const to = model.recipientOf(i);
    const res = results.get(model.itemKey(i));
    const may = i.can.reassign || i.can.handover === true;
    const fk = "pick:" + model.itemKey(i).replace("\n", ":");
    const sel = h("select.field.mobile-touch-row", {
      "data-fk": fk,
      "aria-label": `New owner of ${i.name}`,
      "aria-disabled": may && !busy ? "false" : "true",
      onchange: e => {
        const p = people.find(x => x.id === e.target.value);
        if (p && may && !busy) onChoose(i, p, fk);
        else e.target.value = to.id;
      },
    }, people.map(p => h("option", { value: p.id, selected: p.id === to.id },
      p.id === defaults.recipient.id ? `${p.name} (${defaults.reason === "manager" ? "their manager" : "you"})` : p.name)));

    const statusNode = res
      ? h("span", { role: res.ok ? null : "alert" }, res.ok ? "Done. " : "Not done. ", res.text)
      : h("span.muted", {}, i.can.reassign ? "Not yet" : i.can.handover ? "Goes with the removal" : "Skipped");

    return h("li.mobile-admin-card.offboard-item-card", { "data-item-key": model.itemKey(i) },
      h("div.mobile-admin-card-head", {},
        h("div.mobile-admin-card-title", {},
          h("strong", {}, itemLabel(i)),
          h("div.mobile-admin-badges", {},
            h("span.badge", {}, i.type === "group" ? "Area" : i.personal ? "Personal space" : "Space"),
            i.trashed ? h("span.badge", {}, "In Trash") : null))),
      h("div.mobile-admin-card-row", {},
        h("span.mobile-admin-label", {}, "New owner"),
        may ? sel : h("span.muted", {}, i.can.why ?? "You can't hand this on.")),
      h("div.mobile-admin-card-row", {},
        h("span.mobile-admin-label", {}, "Status"),
        statusNode));
  });

  return h("section.mobile-matrix-cards", {
    role: "region",
    "aria-label": `What ${memberName} solely owns`,
    "data-mobile-cards": "offboard",
  },
  h("ul.mobile-admin-card-list", { "aria-label": `What ${memberName} solely owns` }, cards));
}
