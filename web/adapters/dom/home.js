// The Home page: a driving adapter over the DOM that renders web/core/home.js's model (Recent, Starred, Shared with me,
// the Group/Space tree, search). Part of the dom group; the composition root (web/main.js) mounts it when someone is signed in with no
// board in the link. All text goes in through textContent (titles and names are other people's words). Keyboard: "/"
// focuses search, Escape clears it, every card is a link plus a star button. Visuals are intentionally plain: #56 restyles.

import { h, replace } from "./dom.js";
import { keeper } from "./focus.js";
import { overflowMenu } from "./spaces.js";
import { startMove } from "./move.js";
import { pathText, whenText } from "../../core/home.js";

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/home.js").createHomeModel>, clock: import("../../ports/clock.js").Clock,
 *   boardHref: (id: string) => string, spaceHref: (id: string) => string, groupHref: (id: string) => string,
 *   move?: { port: import("../../ports/move.js").MovePort, clock: import("../../ports/clock.js").Clock, newKey?: (() => string)|null }|null,
 *   org?: Pick<import("../../ports/admin.js").AdminPort, "createTenant"|"listTenantMembers"|"addTenantMember"|"removeTenantMember"|"adminAudit"> | null,
 *   dialogs: Pick<ReturnType<typeof import("./dialogs.js").createDialogs>, "newBoard"|"newSpace"|"newGroup">, homeHref?: string, signIn?: { href: string, text?: string } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountHome({ root, model, clock, boardHref, spaceHref, groupHref, teamsHref = null, trashHref = null, rolesHref = null, offboardHref = null, unitAccessHref = null, dialogs, homeHref = "./", signIn = null, move = null, org = null }) {
  const S = model.state, keys = keeper(), mark = keys.mark;
  let destroyed = false;
  /** @type {null|"members"|"audit"} */ let panel = null;
  let orgBusy = false;
  const mem = { status: "idle", tenant: null, members: [], admins: [], busy: false, removing: null, seq: 0 };
  const audit = { status: "idle", tenant: null, events: [], nextBefore: null, loadingMore: false, seq: 0 };

  const status = h("div.home-status", { role: "status", "aria-live": "polite" });
  const search = h("input.home-search", { type: "search", placeholder: "Search boards and Spaces", "aria-label": "Search boards and Spaces", autocomplete: "off", maxlength: "100", spellcheck: "false",
    oninput: e => { panel = null; model.setQuery(e.target.value); },
    onkeydown: e => { if (e.key === "Escape" && search.value) { search.value = ""; model.setQuery(""); e.preventDefault(); } } });
  const side = h("nav.home-side", { "aria-label": "Home navigation" });
  const main = h("main.home-main", { id: "home-main", tabindex: "-1" });
  const who = h("span.home-who");
  const top = h("header.home-top", {},
    h("a.logo", { href: homeHref, "aria-label": "Plenary home" }, "Plenary"),
    h("div.home-searchbox", { role: "search" }, search, h("kbd", { "aria-hidden": "true" }, "/ or ⌘K")),
    h("span.spacer"), who);
  const home = h("div.home", { id: "home" }, top, status, h("div.home-body", {}, side, main));
  root.replaceChildren(home);

  // Persistent inputs for self-serve Workspace creation and Members add-by-email (kept across redraws so typing never loses focus).
  const orgNameInput = h("input.field.home-org-input", { type: "text", maxlength: "80", autocomplete: "off", placeholder: "Workspace name (e.g. My Studio)", "aria-label": "Workspace name" });
  const orgCreateBtn = h("button.btn.primary.home-org-btn", { type: "submit" }, "Create Workspace");
  const orgCreateErr = h("p.sp-error", { role: "alert" });
  const orgCreateCard = h("section.home-org-card", { "aria-label": "Create your own Workspace" },
    h("h2", {}, "Create your own Workspace"),
    h("p.muted", {}, "Start a personal workspace to create boards, Spaces, and invite collaborators by email."),
    h("form.home-org-form", { onsubmit: e => { e.preventDefault?.(); submitCreateOrg(); } }, orgNameInput, orgCreateBtn),
    orgCreateErr);

  const memEmailInput = h("input.field.home-org-input", { type: "email", maxlength: "320", autocomplete: "off", placeholder: "friend@gmail.com", "aria-label": "Collaborator email" });
  const memAddBtn = h("button.btn.primary.home-org-btn", { type: "submit" }, "Add by email");
  const memErr = h("p.sp-error", { role: "alert" });
  const memAddForm = h("form.home-org-form", { onsubmit: e => { e.preventDefault?.(); submitAddMember(); } }, memEmailInput, memAddBtn);

  async function submitCreateOrg() {
    if (!org || orgBusy) return;
    const name = String(orgNameInput.value ?? "").trim();
    if (!name) { orgCreateErr.textContent = "Enter a workspace name."; orgNameInput.focus?.(); return; }
    orgBusy = true; orgCreateErr.textContent = ""; orgCreateBtn.disabled = true; orgCreateBtn.textContent = "Creating…";
    try {
      const res = await org.createTenant({ name });
      if (destroyed) return;
      orgNameInput.value = "";
      model.notify(`Workspace "${res?.tenant?.name || name}" created.`);
      await model.load();
    } catch (e) {
      if (destroyed) return;
      orgCreateErr.textContent = e?.message || "Could not create workspace.";
    } finally {
      orgBusy = false;
      orgCreateBtn.disabled = false;
      orgCreateBtn.textContent = "Create Workspace";
    }
  }

  async function loadMembers(tenantId) {
    if (!org || !tenantId) return;
    const seq = ++mem.seq;
    mem.tenant = tenantId;
    if (mem.status !== "ready") mem.status = "loading";
    render();
    try {
      const r = await org.listTenantMembers(tenantId);
      if (destroyed || seq !== mem.seq) return;
      mem.members = Array.isArray(r?.members) ? r.members : [];
      mem.admins = Array.isArray(r?.admins) ? r.admins : [];
      mem.status = "ready";
    } catch {
      if (destroyed || seq !== mem.seq) return;
      mem.status = "error";
    }
    render();
  }

  function openMembers() {
    const id = S.data?.unit?.id;
    if (!id || !org) return;
    panel = "members";
    memErr.textContent = "";
    loadMembers(id);
  }

  async function submitAddMember() {
    const tenantId = S.data?.unit?.id;
    if (!org || !tenantId || mem.busy) return;
    const email = String(memEmailInput.value ?? "").trim();
    if (!email) { memErr.textContent = "Enter an email address."; memEmailInput.focus?.(); return; }
    mem.busy = true; memErr.textContent = ""; memAddBtn.disabled = true; memAddBtn.textContent = "Adding…";
    try {
      const r = await org.addTenantMember(tenantId, email);
      if (destroyed) return;
      memEmailInput.value = "";
      model.notify(`Added ${r?.email || email}.`);
      await loadMembers(tenantId);
    } catch (e) {
      if (destroyed) return;
      memErr.textContent = e?.message || "Could not add member.";
    } finally {
      mem.busy = false; memAddBtn.disabled = false; memAddBtn.textContent = "Add by email";
    }
  }

  async function removeMember(email) {
    const tenantId = S.data?.unit?.id;
    if (!org || !tenantId || mem.removing) return;
    mem.removing = email; memErr.textContent = "";
    render();
    try {
      await org.removeTenantMember(tenantId, email);
      if (destroyed) return;
      model.notify(`Removed ${email}.`);
      await loadMembers(tenantId);
    } catch (e) {
      if (destroyed) return;
      memErr.textContent = e?.message || "Could not remove member.";
    } finally {
      mem.removing = null;
      if (!destroyed) render();
    }
  }

  async function loadAudit(tenantId, { before = null, append = false } = {}) {
    if (!org || typeof org.adminAudit !== "function" || !tenantId) return;
    const seq = ++audit.seq;
    audit.tenant = tenantId;
    if (append) audit.loadingMore = true;
    else audit.status = "loading";
    render();
    try {
      const r = await org.adminAudit({ tenant: tenantId, limit: 50, ...(before ? { before } : {}) });
      if (destroyed || seq !== audit.seq) return;
      const evs = Array.isArray(r?.events) ? r.events : [];
      audit.events = append ? [...audit.events, ...evs] : evs;
      audit.nextBefore = r?.nextBefore ?? null;
      audit.status = "ready";
    } catch {
      if (destroyed || seq !== audit.seq) return;
      if (!append) audit.status = "error";
      else model.notify("Could not load more audit events.");
    } finally {
      audit.loadingMore = false;
      if (!destroyed) render();
    }
  }

  function openAudit() {
    const id = S.data?.unit?.id;
    if (!id || !org || typeof org.adminAudit !== "function") return;
    panel = "audit";
    loadAudit(id);
  }

  const guest = () => !!S.data?.guest;
  // Every control that can hold focus is marked with a stable key, so a redraw (a star toggled, a view picked, a load, a notice) puts focus back.
  const newBoard = () => mark(h("button.btn.primary", { type: "button", onclick: e => dialogs.newBoard({ opener: e.currentTarget }) }, "＋ New board"), "new-board");
  const newSpace = () => mark(h("button.btn", { type: "button", onclick: e => dialogs.newSpace({ opener: e.currentTarget }) }, "＋ New space"), "new-space");
  const newGroup = () => (S.data?.can?.createGroup ? mark(h("button.btn", { type: "button", onclick: e => dialogs.newGroup({ opener: e.currentTarget }) }, "＋ New group"), "new-group") : null);
  const navBtn = (view, label, count) => mark(h("button.nav", { type: "button", "aria-current": S.view === view && !panel && !S.query.trim() ? "page" : null,
    onclick: () => { panel = null; search.value = ""; model.setQuery(""); model.setView(view); } }, label, count != null ? h("span.n", {}, String(count)) : null), `nav:${view}`);

  function star(c, sec) {
    return mark(h("button.star", { type: "button", "aria-pressed": c.starred ? "true" : "false", "aria-label": `${c.starred ? "Unstar" : "Star"} ${c.title || "Untitled"}`,
      title: c.starred ? "Unstar" : "Star", onclick: () => model.toggleStar(c.id) }, c.starred ? "★" : "☆"), `star:${sec}:${c.id}`);
  }
  function card(c, sec) {
    const when = c.at != null ? whenText(c.at, clock.now()) : "";
    const where = pathText(c.path);
    // ⋯ menu: Move to… only for a card whose `can.move` is true (PROTOCOL.md § Move board, "Where it appears"); the menu is kept across redraws so an open one survives a star toggle.
    const label = c.title || "Untitled";
    const menuCfg = { label: `More for ${label}`, items: [{ text: "Move to…", hidden: !move || !c.can?.move, onSelect: opener => startMove({ host: root, move, board: c.id, opener, reload: () => model.load(), restoreFocus: () => main.focus?.() }) }] };
    const menu = move && c.can?.move ? keys.keep(`menu:${sec}:${c.id}`, () => overflowMenu(menuCfg)) : null;
    menu?.update(menuCfg);
    if (menu) mark(menu.button, `menu:${sec}:${c.id}`);
    return h(`li.card${menu ? ".has-menu" : ""}`, {},
      mark(h("a.card-open", { href: boardHref(c.id) }, h("span.t", {}, label), h("span.p", {}, [where, c.role, when].filter(Boolean).join(" · "))), `card:${sec}:${c.id}`),
      menu ? h("span.card-menu.home-menu", {}, menu.el) : null,
      guest() ? null : star(c, sec));
  }
  const cardList = (cards, label) => h("ul.cards", { "aria-label": label }, cards.map(c => card(c, label)));
  const empty = e => h("div.home-empty", {}, h("h2", {}, e.title), e.detail ? h("p", {}, e.detail) : null);

  function renderSide() {
    const d = S.data;
    if (!d) return replace(side);
    // A Space opens its own page (?space=<id>), a Group its (?group=<id>).
    const node = s => mark(h("a.nav.sub", { href: spaceHref(s.id), title: `Open ${s.name}`, "aria-label": `Open ${s.name}` }, s.personal ? "◐ " : "▢ ", s.name), `space:${s.id}`);
    const t = d.tree;
    const isPersonalAdmin = !d.guest && !!org && d.unit?.personal === true && d.unit?.isAdmin === true;
    const canAudit = !d.guest && !!org && typeof org.adminAudit === "function" && d.unit?.isAdmin === true;
    const membersBtn = isPersonalAdmin
      ? mark(h("button.nav", { type: "button", "aria-current": panel === "members" && !S.query.trim() ? "page" : null,
        onclick: () => { search.value = ""; model.setQuery(""); openMembers(); } }, "Members"), "nav:members")
      : null;
    const auditBtn = canAudit
      ? mark(h("button.nav", { type: "button", "aria-current": panel === "audit" && !S.query.trim() ? "page" : null,
        onclick: () => { search.value = ""; model.setQuery(""); openAudit(); } }, "Audit log"), "nav:audit")
      : null;
    const orgLinks = d.guest ? [] : [teamsHref ? mark(h("a.nav", { href: teamsHref }, "Teams"), "link:teams") : null,
      trashHref ? mark(h("a.nav", { href: trashHref }, "Trash"), "link:trash") : null,
      membersBtn,
      auditBtn,
      unitAccessHref && d.unit && d.can?.manageAccess ? mark(h("a.nav", { href: unitAccessHref(d.unit.id) }, "Organization access"), "link:unit-access") : null,
      rolesHref && d.can?.manageRoles ? mark(h("a.nav", { href: rolesHref }, "Roles"), "link:roles") : null,
      offboardHref && d.can?.manageAccess ? mark(h("a.nav", { href: offboardHref }, "Offboard a member"), "link:offboard") : null];
    replace(side, d.guest ? null : newBoard(), d.guest ? null : newSpace(), newGroup(), navBtn("home", "Home"), d.guest ? null : navBtn("starred", "Starred", d.starred.length), navBtn("shared", "Shared with me", d.shared.length), orgLinks,
      t && h("div.tree", { role: "group", "aria-label": "Groups and Spaces" },
        t.groups.map(g => h("div.grp", {}, h("h4", {}, mark(h("a", { href: groupHref(g.id) }, g.name), `group:${g.id}`)), g.spaces.map(node))),
        t.spaces.length ? h("div.grp", {}, h("h4", {}, "Not in a group"), t.spaces.map(node)) : null,
        t.more ? h("p.muted", {}, "Some Spaces or boards are not listed. Use search.") : null));
  }

  function renderMembersPanel() {
    const d = S.data, unitName = d?.unit?.name || "Personal Workspace";
    const body = mem.status === "loading" && !mem.members.length && !mem.admins.length
      ? h("p.muted", {}, "Loading members…")
      : mem.status === "error"
        ? [empty({ title: "Could not load members.", detail: "Check your connection and try again." }),
          mark(h("button.btn.home-org-btn", { type: "button", onclick: () => loadMembers(d.unit.id) }, "Try again"), "members-retry")]
        : [
          mem.admins.length ? h("section", { "aria-label": "Admins" },
            h("h2.sec", {}, "Admins"),
            h("ul.rows", {}, mem.admins.map(a => h("li.row", {}, h("span.who", {}, a), h("span.badge", {}, "Admin"))))) : null,
          h("section", { "aria-label": "Collaborators" },
            h("h2.sec", {}, `Collaborators (${mem.members.length})`),
            mem.members.length
              ? h("ul.rows", {}, mem.members.map(email => h("li.row", {},
                h("span.who", {}, email),
                mark(h("button.btn.home-org-btn", { type: "button", disabled: mem.removing === email,
                  "aria-label": `Remove ${email}`, onclick: () => removeMember(email) },
                mem.removing === email ? "Removing…" : "Remove"), `member-rm:${email}`))))
              : h("p.muted", {}, "No collaborators added yet.")),
        ];
    return replace(main,
      mark(h("h1", { tabindex: "-1" }, "Workspace members"), "heading"),
      h("p.home-panel-sub", {}, `${unitName} — add collaborators by email so they can open shared Spaces and boards.`),
      memAddForm, memErr, body);
  }

  function renderAuditPanel() {
    const d = S.data, unitName = d?.unit?.name || "your workspace";
    const refresh = mark(h("button.btn.home-org-btn", { type: "button", disabled: audit.status === "loading",
      onclick: () => loadAudit(d.unit.id) }, "Refresh"), "audit-refresh");
    const body = audit.status === "loading" && !audit.events.length
      ? h("p.muted", {}, "Loading audit log…")
      : audit.status === "error"
        ? [empty({ title: "Could not load audit log.", detail: "Check your connection and try again." }),
          mark(h("button.btn.home-org-btn", { type: "button", onclick: () => loadAudit(d.unit.id) }, "Try again"), "audit-retry")]
        : audit.events.length
          ? [
            h("ul.rows.home-audit-list", { "aria-label": "Audit log events" }, audit.events.map(ev => h("li.row", {},
              h("span.badge", {}, String(ev.action ?? "")),
              h("span.who", {}, [ev.actor, ev.board ? `board ${ev.board}` : (ev.target ? `target ${ev.target}` : null)].filter(Boolean).join(" · ")),
              h("span.muted", {}, whenText(ev.at, clock.now()))))),
            audit.nextBefore ? mark(h("button.btn.home-org-btn", { type: "button", disabled: audit.loadingMore,
              onclick: () => loadAudit(d.unit.id, { before: audit.nextBefore, append: true }) },
            audit.loadingMore ? "Loading…" : "Load more"), "audit-more") : null,
          ]
          : h("p.muted", {}, "No audit events yet.");
    return replace(main,
      h("div.home-panel-head", {}, mark(h("h1", { tabindex: "-1" }, "Audit log"), "heading"), refresh),
      h("p.home-panel-sub", {}, `Recent activity in ${unitName}.`),
      body);
  }

  function renderMain() {
    if (S.status === "loading" && !S.data) return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "error") return replace(main, empty({ title: "Could not load Home.", detail: "The server did not answer. Check your connection and try again." }), mark(h("button.btn", { type: "button", onclick: () => model.load() }, "Try again"), "retry"));
    if (S.status === "signed-out") return replace(main, empty({ title: "You are signed out.", detail: "Sign in again to see your boards." }),
      signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null);
    if (!S.query.trim() && panel === "members" && S.data && !S.data.guest && S.data.unit?.personal && S.data.unit?.isAdmin && org) return renderMembersPanel();
    if (!S.query.trim() && panel === "audit" && S.data && !S.data.guest && S.data.unit?.isAdmin && org && typeof org.adminAudit === "function") return renderAuditPanel();
    const m = model.main();
    if (!m) return replace(main);
    if (m.kind === "search") {
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), m.status === "loading" && !m.cards.length ? h("p.muted", {}, "Searching…")
        : m.status === "error" ? empty({ title: "Search failed.", detail: "Try again in a moment." })
          : m.cards.length ? cardList(m.cards, "Search results") : empty(m.empty),
      m.more ? h("p.muted", {}, "More boards match. Narrow the search.") : null);
    }
    const guestCreate = guest() && org ? orgCreateCard : null;
    if (m.sections) {
      const shown = m.sections.filter(s => s.cards.length);
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), shown.length ? shown.map(s => h("section", { "aria-label": s.title }, h("h2.sec", {}, s.title), cardList(s.cards, s.title))) : empty(m.empty), guestCreate);
    }
    return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), m.cards.length ? cardList(m.cards, m.title) : empty(m.empty), guestCreate);
  }

  function render() { keys.around(draw); }
  function draw() {
    renderSide();
    renderMain();
    who.textContent = S.data ? S.data.user.name : "";
    status.textContent = S.notice ?? "";
    status.hidden = !S.notice;
    if (S.notice) status.append(" ", mark(h("button.btn.ghost", { type: "button", onclick: () => model.dismissNotice() }, "Dismiss"), "dismiss"));
  }
  const unsub = model.subscribe(render);
  const onKey = e => {
    const typing = /^(input|textarea|select)$/i.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
    if ((e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) || ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey)) { e.preventDefault(); search.focus(); }
  };
  document.addEventListener("keydown", onKey);
  render();
  return { destroy() { destroyed = true; unsub(); document.removeEventListener("keydown", onKey); root.replaceChildren(); } };
}
