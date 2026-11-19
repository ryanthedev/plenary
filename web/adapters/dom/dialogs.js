// The New board, New space and General access dialogs over the DOM, rendering web/core/spaces.js's models. A dialog is a modal
// (`role="dialog"`, `aria-modal`, labelled by its heading): focus moves in, Tab stays inside, Escape and a click on the backdrop close
// it, and focus goes back to whatever opened it. Text goes in through textContent only (names are other people's words).

import { h, replace } from "./dom.js";
import { createNewBoardModel, createNewSpaceModel, createNewGroupModel, GENERAL_CHOICES } from "../../core/spaces.js";

const FOCUSABLE = "button, input, select, textarea, a[href]";
const focusables = el => (typeof el.querySelectorAll === "function" ? [...el.querySelectorAll(FOCUSABLE)] : el.all().filter(e => /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(e.tagName)))
  .filter(e => !e.disabled && !e.hidden);
let seq = 0;

/**
 * One modal. `body` and `footer` are built by the caller; returns `{ close, el }`.
 * @param {{ host: HTMLElement, title: string, body: Node[], footer: Node[], opener?: { focus?: () => void } | null, onClose?: () => void, form?: boolean, onSubmit?: () => void }} o
 */
export function openDialog({ host, title, body, footer, opener = null, onClose, onSubmit }) {
  const hid = `dlg-title-${++seq}`;
  const form = h("form", { onsubmit: e => { e.preventDefault?.(); onSubmit?.(); } }, h("div.dbody", {}, body), h("footer", {}, footer));
  const dialog = h("div.dialog.sp-dialog", { role: "dialog", "aria-modal": "true", "aria-labelledby": hid }, h("h2", { id: hid }, title), form);
  const veil = h("div.dialog-veil.sp-veil", {
    onclick: e => { if (e.target === e.currentTarget) close(); },
    onkeydown: e => {
      if (e.key === "Escape") { e.preventDefault?.(); close(); return; }
      if (e.key !== "Tab") return;
      const list = focusables(dialog);
      if (!list.length) { e.preventDefault?.(); return; }
      const at = globalThis.document?.activeElement, i = list.indexOf(at);
      if (e.shiftKey && (i <= 0)) { e.preventDefault?.(); list.at(-1).focus(); }
      else if (!e.shiftKey && (i === list.length - 1)) { e.preventDefault?.(); list[0].focus(); }
    },
  }, dialog);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true; veil.remove(); onClose?.(); opener?.focus?.();
  }
  host.append(veil);
  (focusables(dialog)[0] ?? dialog).focus?.();
  return { close, el: veil, dialog };
}

const field = (label, hint, control) => h("label.l", {}, label, hint ? h("span.h", {}, hint) : null, control);
const errorLine = () => h("p.sp-error", { role: "alert" });

/**
 * @param {{ host: HTMLElement, api: import("../../ports/spaces.js").SpacesPort, hrefs: { board(id: string): string, space(id: string): string, group(id: string): string }, go(href: string): void, newKey?: () => string }} o   `newKey`: the Idempotency-Key maker (default crypto.randomUUID)
 */
export function createDialogs({ host, api, hrefs, go, newKey = () => globalThis.crypto.randomUUID() }) {
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
      const model = createNewSpaceModel({ api, group, newKey });
      const S = model.state;
      const name = h("input.field", { type: "text", maxlength: "200", autocomplete: "off", "aria-label": "Name", oninput: e => model.setName(e.target.value) });
      const groupSel = h("select.field", { "aria-label": "Group", onchange: e => model.setGroup(e.target.value) });
      const viewRadio = h("input", { type: "radio", name: "ga", value: "view", checked: true, onchange: () => model.setGeneral("viewer") });
      const noneRadio = h("input", { type: "radio", name: "ga", value: "none", onchange: () => model.setGeneral(null) });
      const err = errorLine();
      const create = h("button.btn.primary", { type: "submit" }, "Create space");
      const d = openDialog({ host, title: "New space", opener, onSubmit: () => model.submit(),
        body: [field("Name", null, name), field("Group", "You can add Spaces to Groups where you're an editor, or leave it outside any Group.", groupSel),
          h("div.l", { role: "radiogroup", "aria-label": "General access" }, "General access",
            h("label.opt", {}, viewRadio, h("span", {}, "Everyone in your organization can view", h("small", {}, "Members can find and watch its boards. You choose who edits."))),
            h("label.opt", {}, noneRadio, h("span", {}, "Only people added", h("small", {}, "Hidden from search for everyone else.")))),
          h("p.from", {}, "You'll be its owner."), err],
        footer: [h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), create] });
      let built = false;
      const render = () => {
        if (S.status === "ready" && !built) {
          built = true;
          replace(groupSel, S.root ? h("option", { value: "" }, "No group (directly in your organization)") : null, S.groups.map(g => h("option", { value: g.id }, g.name)));
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
      const model = createNewGroupModel({ api, newKey });
      const S = model.state;
      const name = h("input.field", { type: "text", maxlength: "200", autocomplete: "off", "aria-label": "Name", oninput: e => model.setName(e.target.value) });
      const sel = h("select.field", { "aria-label": "General access", onchange: e => model.setGeneral(e.target.value) },
        GENERAL_CHOICES.map(([v, label]) => h("option", { value: v ?? "none", selected: v === null }, label)));
      const err = errorLine();
      const create = h("button.btn.primary", { type: "submit" }, "Create group");
      const d = openDialog({ host, title: "New group", opener, onSubmit: () => model.submit(),
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
