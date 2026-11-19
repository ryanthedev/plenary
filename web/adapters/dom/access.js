// The Teams list, a Team's page and the access page of a scope (driving adapter over the DOM), rendering web/core/access.js's models. One role
// picker serves every scope: "Add people or teams" searches the directory, then offers only the roles the server lists for this scope.
//
// Rules this file keeps: names are other people's words (textContent only); every control is a real button, link, input or select; rows are named
// list items (`li` with an aria-label); stable `data-fk` keys (`who:<type>:<id>` is a row's neutral name, `role:` and `remove:` its actions) and focus
// goes back by exact key only, to a neutral name when its row is gone; `aria-disabled`, never `disabled`, while a change is pending; changes are
// said in the polite live region (announce()); one column that works at 390 px.

import { h, replace } from "./dom.js";
import { keeper, announce, announced } from "./focus.js";
import { shell, showNotice, gate, message } from "./spaces.js";
import { createPickerModel, sizeText, viaText, generalLine, SCOPE_NOUN, HIDDEN_ABOVE } from "../../core/access.js";
import { ownersText } from "../../core/explain.js";
import { askView, sourceRow } from "./explain.js";

/** A button that is "disabled" without leaving the tab order: clicks are ignored while it says so. */
export const act = (attrs, text, on, isOff) => h("button.btn", { type: "button", ...attrs, onclick: e => { if (e.currentTarget.getAttribute("aria-disabled") === "true" || isOff?.()) { e.preventDefault?.(); return; } on(e); } }, text);
export const setOff = (el, off) => el.setAttribute("aria-disabled", off ? "true" : "false");
/**
 * Run a render and say what a change did. The keeper may also announce a focus fallback ("That person is no longer here; moved to the next one."): both
 * are said as ONE sentence pair, so the fallback does not overwrite the confirmation.
 */
export const speak = (S, draw) => {
  const say = S.said; S.said = null;
  if (!say) { draw(); return; }
  announce("");
  draw();
  const fb = announced();
  announce(fb ? `${say}. ${fb}` : say);
};
export const quiet = S => { if (S.said) { announce(S.said); S.said = null; } };
const subjectKey = s => `${s.type}:${s.id}`;
const who = (s, keys, extra = "") => keys.mark(h("span.who", { tabindex: "-1" }, s.name, extra ? h("small", {}, ` ${extra}`) : null), `who:${subjectKey(s)}`);

/**
 * The picker: a search box over the directory, a list of matches (people and Teams), the chosen one, a role from `rolesFor(subjectType)`, and Add.
 * It is built once and kept across page renders (typing must not lose focus); `refresh()` re-reads the role list.
 * @param {{ api: any, teams: boolean, rolesFor?: (t: string) => { id: string, name: string, summary: string }[], onAdd: (subject: object, role: string|null) => Promise<boolean>, label: string, setTimer?: typeof setTimeout, delayMs?: number }} o
 */
export function pickerView({ api, teams, rolesFor = null, onAdd, label, setTimer = (f, ms) => setTimeout(f, ms), delayMs = 200 }) {
  const model = createPickerModel({ api, teams });
  const S = model.state;
  let timer = null, busy = false, role = null;
  const input = h("input.field", { type: "search", "aria-label": `Search ${teams ? "people or teams" : "people"}`, autocomplete: "off", maxlength: "100", placeholder: teams ? "Name or email, or a team" : "Name or email",
    oninput: e => { if (timer) clearTimeout(timer); timer = setTimer(() => model.search(e.target.value), delayMs); } });
  const list = h("ul.matches", { "aria-label": "Matches" });
  const roleSel = h("select.field", { "aria-label": "Role", onchange: e => { role = e.target.value; } });
  const add = act({ "aria-label": "Add" }, "Add", async () => {
    if (!S.chosen || (rolesFor && !role)) return;
    busy = true; paint();
    const ok = await onAdd(S.chosen, role);
    busy = false;
    if (ok) { model.clear(); input.value = ""; model.search(""); }
    paint();
  });
  const status = h("p.muted", { role: "status" });
  const el = h("div.picker", {}, h("div.pick-row", {}, input), status, list, rolesFor ? h("label.l", {}, "Role", roleSel) : null, add);
  function paint() {
    const hadKey = list.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement.getAttribute("data-fk") : null;
    replace(list, [...S.people, ...S.teams].map(s => {
      const on = S.chosen && S.chosen.type === s.type && S.chosen.id === s.id;
      return h("li", { "aria-label": `${s.name}${s.type === "team" ? ", team" : ""}` }, h("button.btn.ghost", { type: "button", "aria-pressed": on ? "true" : "false", "data-fk": `pick:${subjectKey(s)}`, onclick: () => model.choose(s) },
        s.name, h("small", {}, s.type === "team" ? ` · team of ${s.size}` : s.email ? ` · ${s.email}` : "")));
    }));
    if (hadKey) [...list.querySelectorAll?.("button") ?? list.findAll(e => e.tagName === "BUTTON")].find(b => b.getAttribute("data-fk") === hadKey)?.focus?.();   // pressing a match rebuilds the list: focus stays on it
    status.textContent = S.status === "error" ? S.error : S.status === "loading" ? "Searching…" : S.searched && !S.people.length && !S.teams.length ? "No one matches. People appear here once they have signed in to Plenary." : "";
    if (rolesFor) {
      const opts = S.chosen ? rolesFor(S.chosen.type) : [];
      if (!opts.some(o => o.id === role)) role = opts[0]?.id ?? null;
      replace(roleSel, opts.map(o => h("option", { value: o.id, selected: o.id === role, title: o.summary }, o.name)));
      roleSel.setAttribute("aria-description", opts.find(o => o.id === role)?.summary ?? "");
    }
    setOff(add, busy || !S.chosen || (rolesFor && !role));
  }
  model.subscribe(paint);
  model.search("");
  paint();
  return { el, input, refresh: paint, model };
}

const sortRows = rows => [...rows].sort((a, b) => (a.subject.name.toLowerCase() < b.subject.name.toLowerCase() ? -1 : a.subject.name.toLowerCase() > b.subject.name.toLowerCase() ? 1 : a.subject.id < b.subject.id ? -1 : 1));

/** The Teams list: search, Create (when allowed), Teams as links, Show more. */
export function mountTeamsPage({ root, model, hrefs, signIn = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  const keys = keeper();
  let after = null, moreBtn = null, createBtn = null;
  const q = h("input.field", { type: "search", "aria-label": "Search teams", maxlength: "100", placeholder: "Search teams" });
  const name = h("input.field", { type: "text", "aria-label": "New team name", maxlength: "200", placeholder: "New team name" });
  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) { quiet(S); return; }
    if (S.busy && S.teams) { moreBtn && setOff(moreBtn, true); createBtn && setOff(createBtn, true); return; }
    speak(S, () => keys.around(draw));
    const f = after; after = null; f?.();
  }
  function draw() {
    createBtn = S.can.create ? keys.mark(keys.keep("create-team", () => act({}, "Create team", async () => { const t = await model.create(name.value); if (t) { name.value = ""; after = () => keys.focusKey(`who:team:${t.id}`); model.emit(); } })), "create-team") : null;
    if (createBtn) setOff(createBtn, S.busy);
    const rows = [...S.teams].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
    moreBtn = S.next ? keys.mark(h("button.btn", { type: "button", "aria-disabled": S.busy ? "true" : "false", onclick: e => { if (e.currentTarget.getAttribute("aria-disabled") !== "true") model.loadMore(); } }, "Show more teams"), "show-more") : null;
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /"),
      h("div.sp-head", {}, keys.mark(h("h1", { id: "page-title", tabindex: "-1" }, "Teams"), "heading"), h("span.badge", {}, "Organization")),
      h("form.pick-row", { role: "search", onsubmit: e => { e.preventDefault?.(); model.load(q.value); } }, q, h("button.btn", { type: "submit" }, "Search")),
      createBtn ? h("div.pick-row", {}, name, createBtn) : null,
      rows.length ? h("ul.rows", { "aria-label": "Teams" }, rows.map(t => h("li.row", { "aria-label": t.name },
        keys.mark(h("a.who", { href: hrefs.team(t.id) }, t.name), `who:team:${t.id}`), h("span.p", {}, sizeText(t.size)))))
        : message(S.q ? `No teams match "${S.q}".` : "No teams yet.", S.can.create ? "Create one to give a group of people the same access." : "Admins create teams."),
      moreBtn);
  }
  model.subscribe(render);
  render();
  return { destroy() { root.replaceChildren(); } };
}

/** One Team: rename, members (remove), add a member through the picker, delete. */
export function mountTeamPage({ root, model, api, hrefs, signIn = null, picker = {} }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  const keys = keeper();
  let confirming = false, after = null, view = null, controls = [];
  const pend = () => { for (const c of controls) c.setAttribute("aria-disabled", "true"); };      // a change is in flight: its row controls stay in the tab order but do nothing
  const nameIn = h("input.field", { type: "text", "aria-label": "Team name", maxlength: "200" });
  function render() {
    showNotice(status, model);
    if (S.deleted) {
      quiet(S);
      const back = h("a.btn", { href: hrefs.teams }, "Back to teams");
      replace(main, h("div.home-empty", {}, h("h2", { id: "page-title", tabindex: "-1" }, "Team deleted."), back), back);
      back.focus?.();                                                    // the focused Delete button is gone: put focus on the way out
      return;
    }
    if (gate(S, main, () => model.load(), signIn)) { quiet(S); return; }
    if (S.busy && S.page && view) { view.refresh(); pend(); return; }
    speak(S, () => keys.around(draw));
    const f = after; after = null; f?.();
  }
  function draw() {
    const p = S.page, can = p.can.manage;
    controls = [];
    const ctl = el => { controls.push(el); return el; };
    nameIn.value = p.team.name;
    view ??= pickerView({ api, teams: false, onAdd: async person => model.addMember({ user: person.id, name: person.name, email: person.email }), label: "Add a member", ...picker });
    const rows = sortRows(p.members.map(m => ({ subject: { type: "user", id: m.user, name: m.name }, email: m.email })));
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " / ", h("a", { href: hrefs.teams }, "Teams"), " /"),
      h("div.sp-head", {}, keys.mark(h("h1", { id: "page-title", tabindex: "-1" }, p.team.name), "heading"), h("span.badge", {}, sizeText(p.team.size))),
      can ? h("form.pick-row", { onsubmit: e => { e.preventDefault?.(); model.rename(nameIn.value); } }, nameIn, h("button.btn", { type: "submit" }, "Rename")) : null,
      h("h2", {}, "Members"),
      rows.length ? h("ul.rows", { "aria-label": "Members" }, rows.map(r => h("li.row", { "aria-label": r.subject.name },
        who(r.subject, keys, r.email ?? ""),
        can ? keys.mark(ctl(act({ "aria-label": `Remove ${r.subject.name}` }, "Remove", () => model.removeMember(r.subject.id), () => S.busy)), `remove:user:${r.subject.id}`) : null)))
        : message("No members yet.", can ? "Add people below." : ""),
      p.next ? keys.mark(act({}, "Show more members", () => model.loadMore()), "show-more") : null,
      can ? h("section", { "aria-label": "Add a member" }, h("h2", {}, "Add a member"), view.el) : null,
      can ? h("section.danger", { "aria-label": "Delete team" }, confirming
        ? [h("p", {}, `Delete ${p.team.name}? Everyone in it loses what it gave them.`),
          keys.mark(act({}, "Delete team", async () => { if (await model.remove()) confirming = false; render(); }), "confirm-delete"),
          keys.mark(act({}, "Cancel", () => { confirming = false; after = () => keys.focusKey("delete-team"); render(); }), "cancel-delete")]
        : keys.mark(act({}, "Delete team…", () => { confirming = true; after = () => keys.focusKey("confirm-delete"); render(); }), "delete-team")) : null);
  }
  model.subscribe(render);
  render();
  return { destroy() { root.replaceChildren(); } };
}

/**
 * The access page of a scope (unit | group | space | board): who has access and through what, change or remove a role where the server allows it, and
 * the one picker to add a person or Team.
 */
export function mountAccessPage({ root, model, api, hrefs, signIn = null, picker = {}, newKey = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  const keys = keeper();
  let view = null, after = null, controls = [], ask = null, askSig = null;
  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) { quiet(S); return; }
    if (S.busy && S.page && view) { view.refresh(); for (const c of controls) c.setAttribute("aria-disabled", "true"); return; }
    speak(S, () => keys.around(draw));
    const f = after; after = null; f?.();
  }
  const ctl = el => { controls.push(el); return el; };
  const rowView = r => {
    const s = r.subject, k = subjectKey(s);
    const options = model.rolesFor(s.type);
    const opts = options.some(o => o.id === r.role) ? options : [{ id: r.role, name: r.roleName || r.role }, ...options];
    const select = r.can?.change && options.length
      ? keys.mark(ctl(h("select.field", { "aria-label": `Role of ${s.name}`, onchange: e => { if (S.busy) { e.target.value = r.role; return; } model.set(s, e.target.value).then(ok => { if (!ok) render(); }); } },
        opts.map(o => h("option", { value: o.id, selected: o.id === r.role }, o.name)))), `role:${k}`)
      : h("span.p", {}, r.roleName || r.role);
    return h("li.row", { "aria-label": `${s.name}, ${r.roleName || r.role}, ${viaText(r)}` },
      who(s, keys, s.type === "team" ? `team of ${s.size ?? 0}` : s.email ?? ""), select, h("span.p", {}, viaText(r)),
      r.can?.remove ? keys.mark(ctl(act({ "aria-label": `Remove ${s.name}` }, "Remove", () => model.remove(s), () => S.busy)), `remove:${k}`) : null);
  };
  /** One titled list. `label` names the list for screen readers; the heading is the visible name of the source. */
  const group = (title, label, items, note = null) => (items.length ? h("section", { "aria-label": title }, h("h3", {}, title), note ? h("p.muted", {}, note) : null, h("ul.rows", { "aria-label": label }, items)) : null);
  function draw() {
    controls = [];
    const p = S.page, sc = p.scope, noun = SCOPE_NOUN[sc.type] ?? sc.type, here = { type: sc.type, id: sc.id };
    view ??= pickerView({ api, teams: true, rolesFor: t => model.rolesFor(t), onAdd: (subject, role) => model.set(subject, role), label: "Add people or teams", ...picker });
    view.refresh();
    const back = sc.type === "space" ? hrefs.space(sc.id) : sc.type === "group" ? hrefs.group(sc.id) : sc.type === "board" ? hrefs.board(sc.id) : hrefs.home;
    const addable = p.can.manage && p.roles.length > 0;
    // Your access: every source, the strongest marked; Ask for access when the server says the caller may.
    const w = p.why;
    const askKey = w ? JSON.stringify([sc.id, w.ask]) : null;
    if (askKey !== askSig) { askSig = askKey; ask = w && api?.ask && (w.ask.can || w.ask.pending) ? askView({ api, type: sc.type, id: sc.id, why: w, newKey }) : null; }
    const mineSection = w ? h("section", { "aria-label": "Your access" }, h("h2", {}, "Your access"),
      h("p", {}, w.mine.role ? `You have ${w.mine.role.name} access to this ${noun}. You get everything any of these gives you; the one that gives the most is marked.` : `You have no board access of your own to this ${noun}.`),
      w.mine.sources.length ? h("ul.rows", { "aria-label": "Where your access comes from" }, w.mine.sources.map(s => { const x = sourceRow(s, here); return h("li.row", { "aria-label": x.text + (x.strongest ? ", grants the most" : "") }, h("span.who", {}, x.text), x.strongest ? h("span.badge", {}, "Grants the most") : null); })) : null,
      w.ask.can || w.ask.pending ? h("p", {}, ownersText(w.owners, w.guest)) : null, ask?.el) : null;
    const requests = p.requests?.length ? h("section", { "aria-label": "Access requests" }, h("h2", {}, "Access requests"),
      h("p.muted", {}, "These people asked for more access. Add them below to grant it, or dismiss the request."),
      h("ul.rows", { "aria-label": "Access requests" }, p.requests.map(r => h("li.row", { "aria-label": `${r.user.name} asked for ${r.roleName}` },
        who({ type: "user", id: r.user.id, name: r.user.name }, keys, `asked for ${r.roleName}`),
        keys.mark(ctl(act({ "aria-label": `Dismiss the request of ${r.user.name}` }, "Dismiss", () => model.dismissRequest(r.user.id), () => S.busy)), `remove:request:${r.user.id}`))))) : null;
    const rows = sortRows(p.rows), direct = rows.filter(r => r.via !== "team"), teams = rows.filter(r => r.via === "team");
    const inheritedBy = new Map();
    for (const r of p.inherited) { const k = `${r.scope?.type}:${r.scope?.id}`; if (!inheritedBy.has(k)) inheritedBy.set(k, []); inheritedBy.get(k).push(r); }
    const inheritedRow = r => h("li.row", { "aria-label": `${r.subject.name}, ${r.roleName}, ${viaText(r)}` }, h("span.who", {}, r.subject.name), h("span.p", {}, r.roleName),
      r.scope && r.scope.type !== "unit" ? h("a", { href: hrefs.access(r.scope.type, r.scope.id) }, viaText(r)) : h("span.p", {}, viaText(r)));
    const general = [...p.general.map(g => h("li.row", { "aria-label": generalLine(g) }, h("span.who", {}, generalLine(g))))];
    const orgAdmins = p.organization?.admins ?? [];
    const nothing = !rows.length && !p.inherited.length && !p.general.length && !orgAdmins.length;
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " / ", sc.type === "unit" ? null : [h("a", { href: back }, sc.name ?? noun), " /"]),
      h("div.sp-head", {}, keys.mark(h("h1", { id: "page-title", tabindex: "-1" }, `Access${sc.name ? ": " + sc.name : sc.type === "unit" ? ": organization" : ""}`), "heading"), h("span.badge", {}, sc.personal ? "Personal · only you" : noun)),
      mineSection, requests,
      h("h2", {}, "Who has access"),
      nothing ? message("Only the people set elsewhere have access.", p.can.manage ? "Add people or teams below." : "") : null,
      group("Added directly", `People added directly to this ${noun}`, direct.map(rowView)),
      group("Through teams", `Teams with access to this ${noun}`, teams.map(rowView)),
      [...inheritedBy].map(([k, list]) => { const s = list[0].scope; const from = s?.type === "unit" ? "your organization" : `${SCOPE_NOUN[s?.type] ?? "container"} ${s?.name ?? ""}`.trim();
        return group(`Inherited from ${from}`, `Access inherited from ${from}`, list.map(inheritedRow)); }),
      p.hiddenAbove ? h("p.muted", { "data-fk": "hidden-above" }, HIDDEN_ABOVE) : null,
      group("Everyone in the organization", "General access", general),
      group("Organization admins", "Organization admins", orgAdmins.map(a => h("li.row", { "aria-label": a.name }, h("span.who", {}, a.name))), p.organization?.more ? "They manage access in every Space. The list shows the first few." : "They manage access in every Space; they see boards only where they are added."),
      p.next ? keys.mark(act({}, "Show more", () => model.loadMore()), "show-more") : null,
      p.admins?.length ? [h("h2", {}, "Admins"), h("ul.rows", { "aria-label": "Admins" }, p.admins.map(a => h("li.row", { "aria-label": a.name }, h("span.who", {}, a.name, a.email ? h("small", {}, ` ${a.email}`) : null))))] : null,
      addable ? h("section", { "aria-label": "Add people or teams" }, h("h2", {}, "Add people or teams"), view.el)
        : p.can.manage ? message("There is nothing to add here yet.", sc.type === "unit" ? "Unit roles are custom roles: make one first." : "") : null);
  }
  model.subscribe(render);
  render();
  return { destroy() { root.replaceChildren(); } };
}
