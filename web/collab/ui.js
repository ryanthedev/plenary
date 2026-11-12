// mountCollab: the collaboration UI over a collab port (port.js). p7-wire mounts it in app.js; dev.html mounts
// it over the fake port. DOM is built with dom.js (text only, never HTML); canvas overlays come from draw.js.
//
//   const collab = mountCollab({ root, canvasOverlay, port, view, theme })
//   root           the board's container (positioned): pins, the thread popover, floating emotes and the
//                  emote picker go in a layer appended to it; screen coords = view.toScreen(world) inside it
//   canvasOverlay  optional <canvas> over the board, sized like it; others' cursors, selections, previews and
//                  lasers are painted there. Without it, call collab.draw(ctx) from your own paint.
//   view           { toScreen, toWorld, scale | view.scale }: the board Editor works as is
//   collab.parts   { avatars, emotes, emoteButton, drawer }: elements for the top bar, the bottom bar (desktop),
//                  the bottom-right corner (phones: one 👏 that opens the picker) and the drawer
//   collab.pointer(world) · collab.selection(stream, ids) · collab.laser(world)   → presence out (paced)
//   collab.startComment(world, on?) · collab.openThread(id) · collab.showDrawer("notes" | "comments")
//   collab.layout()  the view moved: re-place pins and the popover, repaint the overlay
//   collab.setTheme(theme) · collab.destroy()

import { h, replace } from "./dom.js";
import { EMOTES, canWrite } from "./limits.js";
import { FLAGS } from "./flags.js";
import { createOutbox, recordProblem, mayPresence } from "./gate.js";
import { createPresence, colorOf, initials, FLOAT_MS } from "./presence-model.js";
import { recordsView, newRecordId, ago, cornerOf } from "./records-model.js";
import { notesView, safeColor } from "./notes-model.js";
import { drawPresence } from "./draw.js";
import { missingFromPort } from "./port.js";

const BAR = EMOTES.slice(0, 6);
const fmt = n => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const watching = n => n.toLocaleString("en-US");

export function mountCollab({ root, canvasOverlay = null, port, view, theme = "light", clock = null, flags = FLAGS, idGen = newRecordId, maxAvatars = 5 }) {
  const missing = missingFromPort(port);
  if (missing.length) throw new Error(`collab port lacks ${missing.join(", ")}`);
  const C = clock ?? { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: t => clearTimeout(t) };
  const raf = clock?.raf ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : fn => C.setTimer(fn, 16));
  const presence = createPresence({ now: C.now, me: port.me, role: port.role, flags });
  const outbox = createOutbox(port, C);
  const S = { drawer: "comments", list: "open", open: null, compose: null, picker: false, reactFor: null, drafts: new Map(), toast: null, toastTimer: null, theme };
  const live = () => port.status === "live";
  const records = () => recordsView(port.records(), { me: port.me, role: port.role, element: port.element });
  // A user's name: who's here, else what their comments were signed with.
  const nameOf = user => {
    const n = presence.nameOf(user);
    if (n) return n;
    for (const t of port.records().threads) { if (t.by === user && t.name) return t.name; for (const c of t.comments) if (c.by === user && c.name) return c.name; }
    return null;
  };
  const av = (user, name, cls = "") => h(`span.av${cls}`, { style: { background: colorOf(user) }, title: name }, initials(name));

  // ── elements ──
  // Live controls are built once and updated in place: a rebuild on every event (here 1/s, emotes 2/s, every
  // records entry) would wipe a draft, blur a textarea, swallow a click and reset a list's scroll.
  const parts = { avatars: h("div.avatars.collab-avatars"), emotes: h("div.grp.reactions.collab-emotes"), emoteButton: h("div.grp.phone-only.collab-emotebtn"), drawer: h("div.collab-drawer") };
  const pins = h("div.collab-pins"), floats = h("div.collab-floats"), popHost = h("div.collab-pophost"), pickHost = h("div.collab-pickhost"), toast = h("div.collab-toast", { hidden: true, role: "status" });
  const layer = h("div.collab-layer", {}, pins, floats, popHost, pickHost, toast);
  root.append(layer);
  const sigs = {};
  /** Run `build` only when `sig` differs from last time under `key`. */
  const changed = (key, sig) => (sigs[key] === sig ? false : ((sigs[key] = sig), true));

  // ── avatar row (here) ──
  function renderAvatars() {
    const { writers, writerCount, viewers } = presence.view().here;
    parts.avatars.classList.toggle("stale", !live());
    const shown = writers.slice(0, maxAvatars), more = writerCount - shown.length;
    if (!changed("avatars", JSON.stringify([shown, more, viewers]))) return;
    replace(parts.avatars,
      h("span.stack", {}, shown.map(w => av(w.user, w.name ?? "Someone", ".live")), more > 0 ? h("span.av.more", { title: `${watching(writerCount)} people can write` }, `+${fmt(more)}`) : null),
      h("span.watching", { title: `${watching(viewers)} watching` }, h("span.eye", {}, "👁 "), h("b", {}, watching(viewers)), h("span.wtxt", {}, " watching")));
  }

  // ── emote bar and picker ──
  function sendEmote(e) {
    if (!outbox.emote(e)) return false;
    // Writers' emotes float for everyone (presence); a viewer's is only ever counted (`emotes`).
    if (port.role !== "viewer") { presence.float(e, port.me.user); renderFloats(); }
    return true;
  }
  const bar = BAR.map(e => { const n = h("b"); return { e, n, btn: h("button.tb", { onclick: () => sendEmote(e) }, e, n) }; });
  const more = h("button.tb", { title: "More emotes", onclick: togglePicker }, "✨");
  const one = h("button.tb", { onclick: togglePicker }, "👏");   // phones: one button opens the picker
  parts.emotes.append(...bar.map(b => b.btn), h("span.sep"), more);
  parts.emoteButton.append(one);
  const pickerEl = h("div.emote-picker.collab-picker", { role: "menu", hidden: true }, EMOTES.map(e => h("button", { title: e, onclick: () => sendEmote(e) }, e)));
  pickHost.append(pickerEl);
  function renderEmotes() {
    const counts = presence.view().counts, on = live() && mayPresence(port.role, "emote");
    if (!on) S.picker = false;
    for (const b of bar) {
      b.btn.disabled = !on;
      b.btn.setAttribute("title", on ? `Send ${b.e}: never saved. Writers' emotes float up live; viewers' are counted every 500 ms.` : "Emotes need a live connection");
      const text = counts[b.e] ? fmt(counts[b.e]) : "";
      if (b.n.textContent !== text) replace(b.n, text);
    }
    for (const b of [more, one]) { b.disabled = !on; b.classList.toggle("on", S.picker); }
    one.setAttribute("title", on ? "Emotes" : "Emotes need a live connection");
    pickerEl.hidden = !S.picker;
  }
  function togglePicker() { S.picker = !S.picker; renderEmotes(); }

  const floatEls = new Map();   // floater id → element, so a running animation is never restarted
  function renderFloats() {
    const now = C.now(), keep = new Set();
    for (const f of presence.view().floaters) {
      if (now - f.at >= FLOAT_MS) continue;
      keep.add(f.id);
      if (!floatEls.has(f.id)) { const el = h("span.emote.collab-float", { style: { left: `calc(50% + ${(f.lane - 2) * 44}px)` } }, f.e); floatEls.set(f.id, el); floats.append(el); }
    }
    for (const [id, el] of floatEls) if (!keep.has(id)) { el.remove(); floatEls.delete(id); }
  }

  // ── pins and the popover ──
  const screen = p => view.toScreen(p);
  const pinEls = new Map();     // thread id → pin, updated in place
  function renderPins(rv = records()) {
    const keep = new Set();
    for (const t of rv.threads) {
      keep.add(t.id);
      let el = pinEls.get(t.id);
      if (!el) { el = h("button.pin", { "data-thread": t.id, onclick: ev => { ev.stopPropagation?.(); openThread(S.open === t.id ? null : t.id); } }); pinEls.set(t.id, el); pins.append(el); }
      const p = screen(t), first = t.comments.find(c => !c.deleted);
      for (const [c, on] of [["resolved", !!t.resolved], ["active", S.open === t.id], ["pending", t.pending], ["detached", t.detached]]) el.classList.toggle(c, on);
      el.style.setProperty("background", colorOf(t.by)); el.style.setProperty("left", `${p.x}px`); el.style.setProperty("top", `${p.y - 28}px`);
      el.setAttribute("title", `${t.name}: ${first?.text ?? ""}`);
      const label = t.resolved ? "✓" : String(t.count);
      if (el.textContent !== label) replace(el, label);
    }
    for (const [id, el] of pinEls) if (!keep.has(id)) { el.remove(); pinEls.delete(id); }
  }
  function place(pop, world) {
    const p = screen(world), w = root.clientWidth || 1200, hgt = root.clientHeight || 800;
    let left = p.x + 20, top = p.y - 30;
    if (left + 310 > w) left = Math.max(8, p.x - 316);
    top = Math.max(8, Math.min(top, hgt - 340));
    pop.style.setProperty("left", `${left}px`); pop.style.setProperty("top", `${top}px`);
  }
  const mount = el => { if (el.parentNode !== popHost) replace(popHost, el); };
  const anchorText = t => (t.point ? "On a spot on the board" : t.detached ? "Detached: its element was deleted" : t.on.stream === "notes" ? "On a note" : "On an element of the board");

  function message(t, c) {
    const rv = c.reactions, canReact = c.canReact;
    const chips = (rv.length || canReact) && !c.deleted ? h("div.react-chips.collab-chips", {},
      rv.map(r => h(`button.chip-r${r.mine ? ".mine" : ""}${r.pending ? ".pending" : ""}`, {
        disabled: !c.canReact, title: c.canReact ? (r.mine ? `Remove your ${r.emoji}` : `React ${r.emoji}`) : `${r.n} reacted ${r.emoji}`,
        onclick: () => recordOp(r.mine ? "unreact" : "react", { do: "react", id: c.id, emoji: r.emoji, on: !r.mine }) }, `${r.emoji} `, h("b", {}, String(r.n)))),
      c.canReact ? h("button.chip-r.add", { title: "React", onclick: () => { S.reactFor = S.reactFor === c.id ? null : c.id; renderPopover(); } }, "＋") : null) : null;
    const reactRow = S.reactFor === c.id && c.canReact ? h("div.collab-reactrow", {}, EMOTES.map(e => h("button", { title: e, onclick: () => { S.reactFor = null; const has = rv.find(r => r.emoji === e)?.mine; recordOp(has ? "unreact" : "react", { do: "react", id: c.id, emoji: e, on: !has }); } }, e))) : null;
    return h(`div.msg${c.pending ? ".pending" : ""}`, {}, av(c.by, c.name),
      h("div.mbody", {},
        h("div.who", {}, c.name, h("span", {}, ago(c.at, C.now())), c.edited ? h("span", {}, "edited") : null, c.pending ? h("span.sending", {}, "sending…") : null,
          c.canDelete ? h("button.del", { title: "Delete this comment", onclick: () => recordOp("deleteComment", { do: "delete", id: c.id }) }, "delete") : null),
        c.deleted ? h("p.deleted", {}, "Comment deleted") : h("p", {}, c.text), chips, reactRow));
  }

  let pop = null;   // the open thread's popover: { id, el, head, body, foot, readFoot }, kept while it stays open
  function renderPopover(rv = records()) {
    if (S.compose) return renderCompose();
    const t = S.open && rv.threads.find(x => x.id === S.open);
    if (!t) { S.open = null; pop = null; replace(popHost); return; }
    if (!pop || pop.id !== t.id) {
      const field = h("textarea.field", { rows: 2, placeholder: "Reply…", "aria-label": "Reply",
        oninput: e => S.drafts.set(t.id, e.currentTarget.value),
        onkeydown: e => { e.stopPropagation?.(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } });
      field.value = S.drafts.get(t.id) ?? "";
      const send = () => {
        const text = field.value.trim(), id = idGen();
        if (recordOp("reply", { do: "reply", id, thread: t.id, text })) { field.value = ""; S.drafts.delete(t.id); }
      };
      const foot = h("div.reply", {}, field, h("button.btn.primary", { onclick: send }, "Send"));
      pop = { id: t.id, head: h("header"), body: h("div.body"), foot, field, readFoot: h("div.reply.hint"), el: null };
      pop.el = h("div.pop.collab-pop", { role: "dialog", "aria-label": "Comment thread" }, pop.head, pop.body, pop.foot, pop.readFoot);
      delete sigs.pop;
    }
    // Rebuild the head and messages only when what they show changed (a click mid-rebuild is lost).
    if (changed("pop", JSON.stringify([t, S.reactFor, port.role, Math.floor(C.now() / 30_000)]))) {
      replace(pop.head,
        t.resolved ? [h("span", {}, "✓"), h("b", {}, `Resolved by ${t.resolved.name}`)] : h("span.anchor", {}, anchorText(t)),
        h("span.spacer"),
        t.canResolve ? h("button.btn", { disabled: t.statePending, onclick: () => recordOp(t.resolved ? "reopen" : "resolve", { do: t.resolved ? "reopen" : "resolve", id: t.id }) }, t.resolved ? "Reopen" : "✓ Resolve") : null,
        h("button.tb", { title: "Close", onclick: () => openThread(null) }, "✕"));
      replace(pop.body, t.resolved || t.detached ? h("div.anchor.muted", {}, anchorText(t)) : null, t.comments.map(c => message(t, c)));
      pop.foot.hidden = !t.canReply;
      pop.readFoot.hidden = t.canReply;
      replace(pop.readFoot, port.role === "viewer" ? "Viewers read comments; they can't reply or react." : "Read-only: you can't reply or react.");
    }
    place(pop.el, t);
    mount(pop.el);
  }

  // The compose box lives from startComment until it is sent or cancelled; renders only place it.
  function openCompose(c) {
    const field = h("textarea.field", { rows: 3, placeholder: "Add a comment…", "aria-label": "Comment",
      onkeydown: e => { e.stopPropagation?.(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === "Escape") { S.compose = null; renderAll(); } } });
    const go = () => {
      const id = idGen(), anchor = c.on ? { stream: c.on.stream, element: c.on.element, x: c.x, y: c.y } : { point: { x: c.x, y: c.y } };
      if (recordOp("thread", { do: "thread", id, anchor, text: field.value.trim() })) { S.compose = null; S.open = id; renderAll(); }
    };
    c.field = field;
    c.el = h("div.pop.collab-pop.compose", { role: "dialog", "aria-label": "New comment" },
      h("header", {}, h("span.anchor", {}, c.on ? "New comment on this element" : "New comment here"), h("span.spacer"), h("button.tb", { title: "Cancel", onclick: () => { S.compose = null; renderAll(); } }, "✕")),
      h("div.reply", {}, field, h("button.btn.primary", { onclick: go }, "Comment")));
    S.compose = c; S.open = null; pop = null;
  }
  function renderCompose() {
    const c = S.compose;
    place(c.el, c);
    if (c.el.parentNode !== popHost) { mount(c.el); c.field.focus?.(); }
  }

  /** Check, then send one records action through the port. False (and a message) when it would be refused. */
  function recordOp(method, op) {
    const p = recordProblem(port.role, port.me.user, op, port.records().threads);
    if (p) { say(p.message); return false; }
    const { do: _, on: __, ...fields } = op;
    port[method](method === "thread" || method === "reply" ? fields : { id: op.id, ...(op.emoji ? { emoji: op.emoji } : {}) });
    return true;
  }
  function say(text) {
    S.toast = text; toast.hidden = false; replace(toast, text);
    if (S.toastTimer) C.clearTimer(S.toastTimer);
    S.toastTimer = C.setTimer(() => { toast.hidden = true; S.toast = null; S.toastTimer = null; }, 4000);
  }

  // ── drawer: header, tabs and the scroller are kept; only the rows are rebuilt, and only when they changed ──
  const tabNotes = h("button", { onclick: () => showDrawer("notes") }), tabComments = h("button", { onclick: () => showDrawer("comments") });
  const tabOpen = h("button", { onclick: () => { S.list = "open"; renderDrawer(); } }), tabResolved = h("button", { onclick: () => { S.list = "resolved"; renderDrawer(); } });
  const listTabs = h("div.collab-listtabs", {}, h("span.seg", {}, tabOpen, tabResolved));
  const scroller = h("div.notes-list");
  parts.drawer.append(h("header", {}, h("h3", {}, "Annotations"), h("span.seg", {}, tabNotes, tabComments)), listTabs, scroller);
  const label = (el, text, on) => { if (el.textContent !== text) replace(el, text); el.classList.toggle("on", on); };
  function renderDrawer(rv = records()) {
    const nv = notesView(port.notes(), { me: port.me, role: port.role, noteAuthor: port.noteAuthor, nameOf, canEdit: typeof port.editNote === "function", canDelete: typeof port.deleteNote === "function" });
    label(tabNotes, `Notes ${fmt(nv.total)}`, S.drawer === "notes"); label(tabComments, `Comments ${fmt(rv.open.length)}`, S.drawer === "comments");
    label(tabOpen, `Open ${rv.open.length}`, S.list === "open"); label(tabResolved, `Resolved ${rv.resolved.length}`, S.list === "resolved");
    listTabs.hidden = S.drawer !== "comments";
    if (S.drawer === "notes") {
      if (!changed("drawer", JSON.stringify(["notes", nv]))) return;
      replace(scroller, nv.rows.length ? nv.rows.map(n => h("div.note-row", { "data-note": n.id },
        h("span.sw", { style: { background: safeColor(n.color), width: "10px", height: "10px" } }),
        h("div.txt", {}, h("div", {}, n.text),
          h("div.meta", {}, h("span.author", { style: { color: n.by ? colorOf(n.by) : "var(--muted)" } }, n.author), n.kind === "highlight" ? h("span", {}, "highlight") : null),
          h("div.acts", {},
            port.jumpTo ? h("button", { onclick: () => port.jumpTo(n.at) }, "jump to") : null,
            n.canEdit ? h("button", { onclick: () => port.editNote(n.id) }, "edit") : null,
            n.canDelete ? h("button", { onclick: () => port.deleteNote(n.id) }, "delete") : null,
            n.locked ? h("span.lock", {}, `🔒 ${n.author}'s`) : null)))) : h("div.hint", {}, "No notes yet."),
        nv.more ? h("div.hint", {}, `${fmt(nv.more)} more`) : null);
    } else {
      const list = S.list === "open" ? rv.open : rv.resolved;
      if (!changed("drawer", JSON.stringify(["comments", S.list, S.open, list.map(t => [t.id, t.name, t.count, t.pending, t.detached, t.point, t.comments.find(c => !c.deleted)?.text])]))) return;
      replace(scroller, list.length ? list.map(t => {
        const first = t.comments.find(c => !c.deleted);
        const go = () => { openThread(t.id); port.jumpTo?.({ x: t.x, y: t.y }); };
        return h(`div.note-row.thread-row${t.resolved ? ".done" : ""}${S.open === t.id ? ".on" : ""}`, { "data-thread": t.id, role: "button", tabindex: "0",
          onclick: go, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } },
          av(t.by, t.name), h("div.txt", {}, h("div", {}, first?.text ?? ""),
            h("div.meta", {}, h("span", {}, t.name), h("span", {}, anchorText(t))),
            h("div.acts", {}, h("span", {}, `${t.count} ${t.count === 1 ? "message" : "messages"}`), t.resolved ? h("span", {}, "✓ resolved") : null, t.pending ? h("span.sending", {}, "sending…") : null)));
      }) : h("div.hint", {}, S.list === "open" ? (rv.canWrite ? "No open comments. Pick the comment tool, or right-click the board." : "No open comments.") : "Nothing resolved yet."));
    }
  }

  // ── overlay paint ──
  let painting = false;
  function draw(ctx) {
    const pv = presence.view();
    const previews = [];
    if (live()) for (const stream of ["board", "notes"]) for (const p of port.previews(stream)) if (presence.shows(p.user)) previews.push({ ...p, name: nameOf(p.user) ?? "Someone" });
    return drawPresence(ctx, pv, view, { element: port.element, previews, colorFor: colorOf, theme: S.theme });
  }
  function paint() {
    if (!canvasOverlay || painting) return;
    painting = true;
    raf(() => {
      painting = false;
      const dpr = globalThis.devicePixelRatio || 1, w = canvasOverlay.clientWidth, hh = canvasOverlay.clientHeight;
      if (canvasOverlay.width !== Math.round(w * dpr) || canvasOverlay.height !== Math.round(hh * dpr)) { canvasOverlay.width = Math.round(w * dpr); canvasOverlay.height = Math.round(hh * dpr); }
      const ctx = canvasOverlay.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hh);
      if (draw(ctx) || (live() && (port.previews("board").length || port.previews("notes").length))) paint();
    });
  }

  function renderAll() {
    const rv = records();
    renderAvatars(); renderEmotes(); renderPins(rv); renderPopover(rv); renderDrawer(rv); renderFloats(); paint();
  }
  function openThread(id) { S.open = id; S.compose = null; S.reactFor = null; renderAll(); }
  function showDrawer(which) { if (which === "notes" || which === "comments") S.drawer = which; renderDrawer(); }

  // ── port events ──
  const offs = [
    // Presence is live only: anything arriving while not live is stale (rule 11 drops it server-side too).
    port.onPresence(batch => { if (!live()) return; presence.ingest(batch); if (batch.some?.(m => m.k === "emote")) renderFloats(); paint(); }),
    port.onLeave((u, c) => { presence.leave(u, c); paint(); }),
    port.onHere(msg => { presence.here(msg); renderAvatars(); renderDrawer(); paint(); }),
    port.onEmotes(msg => { presence.emotes(msg); renderEmotes(); }),
    port.onRecords(() => { const rv = records(); renderPins(rv); renderPopover(rv); renderDrawer(rv); }),
    port.onRefused(r => { say(`Not saved: ${r.message || r.code}`); }),
    port.onStatus((status, role) => {
      presence.setRole(role ?? port.role);
      if (status !== "live") { presence.clear(); outbox.reset(); S.picker = false; } else outbox.resume();
      renderAll();
    }),
  ];
  // A slow tick: counts and floaters age out, silent peers expire.
  let tickTimer = null;
  const tick = () => { tickTimer = C.setTimer(tick, 1000); presence.prune(); renderEmotes(); renderFloats(); paint(); };
  tick();
  renderAll();

  return {
    parts, layer, presence, outbox,
    records,
    pointer: w => outbox.cursor(w.x, w.y),
    selection: (stream, ids) => outbox.select(stream, ids),
    laser: w => outbox.laser(w.x, w.y),
    emote: sendEmote,
    /** Start a comment at a world point, or on an element (`on` = { stream, element }): opens the compose box. */
    startComment(world, on = null) {
      if (!canWrite(port.role, "records")) { say(port.role === "viewer" ? "Viewers read comments; they can't write them." : "You can't comment here."); return false; }
      const b = on && port.element(on.stream, on.element), at = b ? cornerOf(b) : world;
      openCompose({ x: at.x, y: at.y, on: b ? on : null }); renderAll(); return true;
    },
    openThread, showDrawer,
    layout() { const rv = records(); renderPins(rv); renderPopover(rv); paint(); },
    draw,
    setTheme(t) { S.theme = t === "dark" ? "dark" : "light"; paint(); },
    get state() { return { open: S.open, compose: S.compose && { x: S.compose.x, y: S.compose.y, on: S.compose.on }, drawer: S.drawer, list: S.list, picker: S.picker, toast: S.toast }; },
    destroy() { for (const off of offs) off?.(); outbox.close(); if (tickTimer) C.clearTimer(tickTimer); if (S.toastTimer) C.clearTimer(S.toastTimer); layer.remove(); },
  };
}
