// @ts-check
// The New board, New space and General access dialogs over the DOM, rendering web/core/spaces.js's models. A dialog is a modal
// (`role="dialog"`, `aria-modal`, labelled by its heading): focus moves in, Tab stays inside, Escape and a click on the backdrop close
// it, and focus goes back to whatever opened it. Text goes in through textContent only (names are other people's words).

import { h, replace } from "./dom.js";
import { trapFocus } from "./a11y.js";
import { createNewBoardModel, createNewSpaceModel, createNewGroupModel, GENERAL_CHOICES } from "../../core/spaces.js";

let seq = 0;

/** A random Idempotency-Key. `crypto.randomUUID` exists only in secure contexts (plain http to a LAN or 0.0.0.0 has none), so fall back to getRandomValues. */
export function randomKey(c = globalThis.crypto) {
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return [...c.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One modal. `body` and `footer` are built by the caller; returns `{ close, el }`.
 * @param {{ host: HTMLElement, title: string, body: Node[], footer: Node[], opener?: { focus?: () => void } | null, onClose?: () => void, form?: boolean, onSubmit?: () => void, sheet?: boolean }} o
 */
export function openDialog({ host, title, body, footer, opener = null, onClose, onSubmit, sheet = false }) {
  const hid = `dlg-title-${++seq}`;
  const form = h("form", { onsubmit: e => { e.preventDefault?.(); onSubmit?.(); } }, h("div.dbody", {}, body), h("footer", {}, footer));
  const dialog = h(`div.dialog.sp-dialog${sheet ? ".sp-sheet-dialog" : ""}`, { role: "dialog", "aria-modal": "true", "aria-labelledby": hid, tabindex: "-1", ...(sheet ? { "data-mobile-sheet": "true" } : {}) },
    sheet ? h("div.sheet-grabber", { "aria-hidden": "true" }) : null,
    h("h2", { id: hid }, title), form);
  let trap = null;
  const veil = h(`div.dialog-veil.sp-veil${sheet ? ".sp-sheet-veil" : ""}`, {
    onclick: e => { if (e.target === e.currentTarget) close(); },
    onkeydown: e => trap?.handleKeyDown(e),
  }, dialog);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    trap?.deactivate({ restoreFocus: false });
    veil.remove();
    onClose?.();
    opener?.focus?.();
  }
  host.append(veil);
  trap = trapFocus(dialog, { onEscape: close, returnFocusTo: opener });
  return { close, el: veil, dialog };
}

const field = (label, hint, control) => h("label.l", {}, label, hint ? h("span.h", {}, hint) : null, control);
const errorLine = () => h("p.sp-error", { role: "alert" });

/**
 * @param {{ host: HTMLElement, api: import("../../ports/spaces.js").SpacesPort, hrefs: { board(id: string): string, space(id: string): string, group(id: string): string }, go(href: string): void, newKey?: () => string }} o   `newKey`: the Idempotency-Key maker (default crypto.randomUUID)
 */
export function createDialogs({ host, api, hrefs, go, newKey = randomKey }) {
  return {
    /** New board: title + Location (only Spaces where the person can create, their personal space first). */
    newBoard({ opener = null, space = null } = {}) {
      const model = createNewBoardModel({ api, space, newKey });
      const S = model.state;
      const title = h("input.field", { type: "text", maxlength: "200", autocomplete: "off", "aria-label": "Title", placeholder: "Untitled", oninput: e => model.setTitle(e.target.value) });
      const where = h("div.pick", { role: "radiogroup", "aria-label": "Location" }, h("p.muted", {}, "Loading…"));
      const hint = h("p.from", {});
      const err = errorLine();
      const create = h("button.btn.primary", { type: "submit" }, "Create board");
      const cancel = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
      const d = openDialog({ host, title: "New board", opener, onSubmit: () => model.submit(),
        body: [field("Title", null, title), h("div.l", {}, "Location", h("span.h", {}, "Only Spaces where you can create boards."), where), hint, err], footer: [cancel, create] });
      let radios = null;
      const render = () => {
        if (S.status === "ready" && !radios) {
          radios = S.spaces.map(s => ({ s, input: h("input", { type: "radio", name: "loc", value: s.id, checked: s.id === S.space, onchange: () => model.choose(s.id) }) }));
          replace(where, radios.map(({ s, input }) => h("label.opt", {}, input, h("span", {}, s.personal ? "◐ " : "▢ ", s.group ? `${s.group.name} / ${s.name}` : s.name),
            h("span.from", {}, s.personal ? "only you" : s.general ? "Everyone can see it" : "Only people added"))));
          if (S.more) where.append(h("p.muted", {}, "More Spaces exist than are listed."));
          title.focus?.();
        } else if (S.status === "error") replace(where, h("p.muted", {}, "Could not load your Spaces."));
        if (radios) for (const { s, input } of radios) input.checked = s.id === S.space;
        hint.textContent = model.hint();
        err.textContent = S.error ?? "";
        create.disabled = S.busy || S.status !== "ready";
        if (S.created) { d.close(); go(hrefs.board(S.created.id)); }
      };
      model.subscribe(render);
      model.load();
      render();
      return d;
    },

    /** New space: name, Group (where the person is an editor, or none), general access. */
    newSpace({ opener = null, group = null } = {}) {
      const model = createNewSpaceModel(/** @type {any} */ ({ api, group, newKey }));
      const S = model.state;
      const name = h("input.field", { type: "text", maxlength: "200", autocomplete: "off", "aria-label": "Name", oninput: e => model.setName(e.target.value) });
      const groupSel = h("select.field", { "aria-label": "Area", onchange: e => model.setGroup(e.target.value) });
      const viewRadio = h("input", { type: "radio", name: "ga", value: "view", checked: true, onchange: () => model.setGeneral("viewer") });
      const noneRadio = h("input", { type: "radio", name: "ga", value: "none", onchange: () => model.setGeneral(null) });
      const err = errorLine();
      const create = h("button.btn.primary", { type: "submit" }, "Create space");
      const d = openDialog({ host, title: "New space", opener, onSubmit: () => model.submit(),
        body: [field("Name", null, name), field("Area", "You can add Spaces to Areas where you're an editor, or leave it outside any Area.", groupSel),
          h("div.l", { role: "radiogroup", "aria-label": "General access" }, "General access",
            h("label.opt", {}, viewRadio, h("span", {}, "Everyone in your organization can view", h("small", {}, "Members can find and watch its boards. You choose who edits."))),
            h("label.opt", {}, noneRadio, h("span", {}, "Only people added", h("small", {}, "Hidden from search for everyone else.")))),
          h("p.from", {}, "You'll be its owner."), err],
        footer: [h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), create] });
      let built = false;
      const render = () => {
        if (S.status === "ready" && !built) {
          built = true;
          replace(groupSel, S.root ? h("option", { value: "" }, "No area (directly in your organization)") : null, S.groups.map(g => h("option", { value: g.id }, g.name)));
          groupSel.value = S.group ?? "";
          if (!model.canCreate()) { S.error = "You can't create Spaces here."; }
          name.focus?.();
        }
        err.textContent = S.error ?? "";
        create.disabled = S.busy || S.status !== "ready" || (built && !model.canCreate());
        if (S.created) { d.close(); go(hrefs.space(S.created.id)); }
      };
      model.subscribe(render);
      model.load();
      render();
      return d;
    },

    /** New group (offered only to people who may create one): a name and who in the organization can open it. */
    newGroup({ opener = null } = {}) {
      const model = createNewGroupModel(/** @type {any} */ ({ api, newKey }));
      const S = model.state;
      const name = h("input.field", { type: "text", maxlength: "200", autocomplete: "off", "aria-label": "Name", oninput: e => model.setName(e.target.value) });
      const sel = h("select.field", { "aria-label": "General access", onchange: e => model.setGeneral(e.target.value) },
        GENERAL_CHOICES.map(([v, label]) => h("option", { value: v ?? "none", selected: v === null }, label)));
      const err = errorLine();
      const create = h("button.btn.primary", { type: "submit" }, "Create area");
      const d = openDialog({ host, title: "New area", opener, onSubmit: () => model.submit(),
        body: [field("Name", null, name), field("General access", "Applies to the Spaces inside it. People added by name keep their own access.", sel), h("p.from", {}, "You'll be its owner."), err],
        footer: [h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), create] });
      name.focus?.();
      model.subscribe(() => { err.textContent = S.error ?? ""; create.disabled = S.busy; if (S.created) { d.close(); go(hrefs.group(S.created.id)); } });
      return d;
    },

    /** General access for a Space or Group page's model (`page.setGeneral`). */
    general({ opener = null, current = null, onSave }) {
      const sel = h("select.field", { "aria-label": "General access" }, GENERAL_CHOICES.map(([v, label]) => h("option", { value: v ?? "none", selected: v === (current ?? null) }, label)));
      const err = errorLine();
      const save = h("button.btn.primary", { type: "submit" }, "Save");
      const d = openDialog({ host, title: "General access", opener,
        onSubmit: async () => { save.disabled = true; const ok = await onSave(sel.value === "none" ? null : sel.value); save.disabled = false; if (ok) d.close(); else err.textContent = "Could not save. Try again."; },
        body: [field("Who in your organization can open it", "People added by name keep their own access.", sel), err],
        footer: [h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), save] });
      return d;
    },
  };
}
