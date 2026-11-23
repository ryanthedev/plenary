// @ts-check
// The Roles screen (driving adapter over the DOM), rendering web/core/role-admin.js: the roles as named list items, the selected role's
// permission matrix (a real checkbox per management permission, cells that say where it applies), duplicate, edit, save, delete, and the
// many-people confirmation. Plain on purpose (#56 restyles); structure follows design/orgs/mock.html [roles].
//
// Rules this file keeps: names are other people's words (textContent only); every control is a real button, link, input or select; rows are
// named list items; stable `data-fk` keys (`rolepick:<id>` is a role's neutral name, `perm:<id>` a checkbox) and focus goes back by exact key only,
// to a neutral name when its control is gone; `aria-disabled`, never `disabled`; changes are said in the polite live region (announce());
// the matrix scrolls sideways inside its own region at 390 px and the page does not.

import { h, replace } from "./dom.js";
import { keeper } from "./focus.js";
import { shell, showNotice, gate, message } from "./spaces.js";
import { act, setOff, speak, quiet } from "./access.js";
import { SCOPE_LABEL, LADDER_LABEL, usedText, impactText, rangeText } from "../../core/role-admin.js";

const KIND = { builtin: "Built-in, read-only", member: "Built-in, permissions editable", custom: "Custom" };
const CELL = { yes: ["✓", "applies"], no: ["", "not granted"], na: ["–", "not at this scope"] };

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/role-admin.js").createRolesModel>, hrefs: { home: string },
 *   signIn?: { href: string, text?: string } | null }} o
 */
export function mountRolesPage({ root, model, hrefs, signIn = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  const keys = keeper();
  let after = null, deleting = false, saveBtn = null, discardBtn = null, controls = [];
  const nameIn = h("input.field", { type: "text", maxlength: "250", "aria-label": "Role name", oninput: e => { model.setName(e.target.value); sync(); } });
  const ctl = el => { controls.push(el); return el; };
  const dirtyNow = () => model.dirty();
  /** Save and Discard follow the draft while the person types (no redraw: the input keeps its caret). */
  function sync() { if (saveBtn) setOff(saveBtn, S.busy || !dirtyNow()); if (discardBtn) setOff(discardBtn, S.busy || !dirtyNow()); }

  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) { quiet(S); return; }
    if (S.busy && S.page) { for (const c of controls) c.setAttribute("aria-disabled", "true"); return; }
    const f = after; after = null;
    const to = f?.() ?? null;                                  // where focus goes on purpose: named before the redraw, so a vanished control is not announced as "no longer here"
    speak(S, () => keys.around(draw, { to }));
    if (to) keys.focusKey(to);
  }

  const listItem = r => {
    const used = usedText(r), range = rangeText(r), selected = r.id === S.selected && !S.draft?.isNew;
    return h("li.row.role-row", { "aria-label": [r.name, KIND[r.kind], r.summary, range, used].filter(Boolean).join(", "), ...(selected ? { "data-selected": "true" } : {}) },
      h("div.role-row-main", {},
        h("div.role-row-head", {},
          keys.mark(h("button.btn.ghost.who.role-pick", { type: "button", "aria-current": selected ? "true" : "false", onclick: () => { deleting = false; after = () => "heading-detail"; model.select(r.id); } }, r.name), `rolepick:${r.id}`),
          h("span.badge.role-kind", {}, KIND[r.kind])),
        r.summary ? h("p.role-summary", {}, r.summary) : null),
      (range || used) ? h("div.role-row-meta", {},
        range ? h("span.badge.role-scope", {}, range) : null,
        used ? h("small.role-used", {}, used) : null) : null);
  };

  function matrixView(rows, editable) {
    const head = h("tr", {}, h("th", { scope: "col" }, "Permission"), h("th", { scope: "col" }, "Granted"), S.page.matrix.scopes.map(s => h("th", { scope: "col" }, SCOPE_LABEL[s] ?? s)));
    let tierHead = false;
    const body = rows.flatMap(r => {
      const heading = r.group === "content-tier" && !tierHead && (tierHead = true)
        ? h("tr.tier-head", {}, h("th", { scope: "colgroup", colspan: String(2 + S.page.matrix.scopes.length) }, "Content tier", h("br"), h("small", {}, "Opening boards beyond your own access. Held at the organization only; only someone who holds a permission can give it.")))
        : null;
      const grant = r.group === "content"
        ? h("td", {}, h("span", {}, r.ticked ? "Yes" : "No"), h("small", {}, " set by board access"))
        : h("td", {}, keys.mark(ctl(h("input", { type: "checkbox", checked: r.ticked, "aria-label": `${r.label}, ${r.id}`, "aria-disabled": r.tickable ? "false" : "true", ...(r.reason ? { "aria-describedby": `reason-${r.id.replace(/\W/g, "-")}` } : {}),
          onclick: e => { if (!r.tickable || S.busy) { e.preventDefault?.(); return; } model.toggle(r.id); } })), `perm:${r.id}`));
      const row = h("tr", {}, h("th", { scope: "row" }, r.label, h("br"), h("code", {}, r.id), r.help ? h("br") : null, r.help ? h("small", {}, r.help) : null, r.reason ? h("br") : null, r.reason ? h("small", { id: `reason-${r.id.replace(/\W/g, "-")}`, class: "reason" }, r.reason) : null), grant,
        r.cells.map(c => h("td", {}, h("span", { "aria-hidden": "true" }, CELL[c.state][0]), h("span.sr-only", {}, `${SCOPE_LABEL[c.scope]}: ${CELL[c.state][1]}`))));
      return heading ? [heading, row] : [row];
    });
    return h("div.matrix-scroll", { role: "region", "aria-label": "Permission matrix", tabindex: "0" },
      h("table.matrix", {}, h("caption", {}, editable ? "Permissions by scope. Tick a permission to grant it." : "Permissions by scope. This role is read-only."), h("thead", {}, head), h("tbody", {}, body)));
  }

  function detail() {
    const d = S.draft, r = model.current();
    const shown = d ?? r;
    if (!shown) return message("No role selected.", "");
    const editable = !!d, member = !d?.isNew && r?.kind === "member";
    const canName = editable && !member;
    nameIn.value = d ? d.name : r.name;
    nameIn.setAttribute("aria-readonly", canName ? "false" : "true");
    nameIn.readOnly = !canName;
    const ladders = S.page.matrix.ladders;
    const ladderSel = keys.mark(ctl(h("select.field", { "aria-label": "Board access", "aria-disabled": editable && !member ? "false" : "true",
      onchange: e => { if (!editable || member || S.busy) { e.target.value = shown.ladder ?? ""; return; } model.setLadder(e.target.value); } },
      member || !editable ? h("option", { value: shown.ladder ?? "", selected: true }, shown.ladder ? (LADDER_LABEL[shown.ladder] ?? shown.ladder) : "None") : null,
      editable && !member ? [...new Set([...ladders, ...(shown.ladder && !ladders.includes(shown.ladder) ? [shown.ladder] : [])])].map(l => h("option", { value: l, selected: l === shown.ladder }, LADDER_LABEL[l] ?? l)) : null)), "ladder");
    saveBtn = editable ? keys.mark(act({}, d.isNew ? "Create role" : "Save role", () => { if (dirtyNow() || d.isNew) model.save(); }, () => S.busy), "save") : null;
    discardBtn = editable ? keys.mark(act({}, d.isNew ? "Cancel copy" : "Discard changes", () => { after = () => "heading-detail"; model.discard(); }, () => S.busy), "discard") : null;
    sync();
    if (saveBtn && d.isNew) setOff(saveBtn, S.busy);
    const used = r ? usedText(r) : null;
    return h("section.role-detail", { "aria-label": "Role details" },
      h("div.sp-head", {}, keys.mark(h("h2", { id: "role-title", tabindex: "-1" }, d?.isNew ? "New role" : r.name), "heading-detail"), h("span.badge", {}, d?.isNew ? "Custom, unsaved" : KIND[r.kind]),
        d?.isNew ? h("span.badge", {}, `Copy of ${S.page.roles.find(x => x.id === d.base)?.name ?? "a role"}`) : null,
        !d?.isNew && r?.kind === "custom" && r.base ? h("span.badge", {}, `Like ${S.page.roles.find(x => x.id === r.base)?.name ?? "another role"}`) : null),
      used ? h("p", {}, used) : null,
      !editable ? h("p.muted", {}, r?.kind === "member" ? "Only an organization admin can change what every member gets." : r?.kind === "custom" ? "This role gives more than you hold yourself, so you can't change it. Duplicate it to make your own." : "Built-in roles are read-only. Duplicate one to make your own.") : member ? h("p.muted", {}, "Everyone in the organization has this role. You can change its permissions, not its name or board access.") : null,
      h("div.pick-row", {}, h("label.l", {}, "Name", nameIn), h("label.l", {}, "Board access", ladderSel)),
      matrixView(model.rows(), editable),
      S.confirm ? h("div.banner", { role: "alert" }, h("p", {}, impactText(r ?? { kind: "custom" }, S.confirm.impact), " Saving changes what they can do within about a minute."),
        keys.mark(act({}, "Save anyway", () => { after = () => "save"; model.confirmSave(); }, () => S.busy), "confirm-save"), keys.mark(act({}, "Cancel", () => { after = () => "save"; model.cancelConfirm(); }, () => S.busy), "confirm-cancel")) : null,
      h("div.pick-row", {}, saveBtn, discardBtn, r ? keys.mark(act({}, "Duplicate", () => { after = () => "heading-detail"; model.duplicate(r.id); }, () => S.busy), "duplicate") : null),
      r?.kind === "custom" && r.editable && !d?.isNew ? h("section.danger", { "aria-label": "Delete role" }, deleting
        ? [h("p", {}, `Delete ${r.name}? A role that is in use cannot be deleted.`),
          keys.mark(act({}, "Delete role", () => { deleting = false; after = () => model.roleOf(r.id) ? "delete-role" : "heading"; model.remove(); }, () => S.busy), "confirm-delete"),
          keys.mark(act({}, "Cancel", () => { deleting = false; after = () => "delete-role"; render(); }, () => S.busy), "cancel-delete")]
        : keys.mark(act({}, "Delete role…", () => { deleting = true; after = () => "confirm-delete"; render(); }), "delete-role")) : null);
  }

  function draw() {
    controls = [];
    const p = S.page;
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /"),
      h("div.sp-head", {}, keys.mark(h("h1", { id: "page-title", tabindex: "-1" }, "Roles"), "heading"), h("span.badge", {}, "Organization")),
      h("p.muted", {}, "Choose what people can view, edit, and manage across your organization, areas, spaces, and boards."),
      h("ul.rows", { "aria-label": "Roles" }, p.roles.map(listItem)),
      p.roles.every(r => r.kind !== "custom") ? message("No custom roles yet.", "Built-in roles cover most needs. Duplicate one to make your own.") : null,
      detail());
  }
  model.subscribe(render);
  render();
  return { destroy() { root.replaceChildren(); } };
}
