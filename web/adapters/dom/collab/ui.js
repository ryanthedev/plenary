// mountCollab: the collaboration UI over a collab port (port.js). p7-wire mounts it in app.js; dev.html mounts
// it over the fake port. DOM is built with dom.js (text only, never HTML); canvas overlays come from draw.js.
//
//   const collab = mountCollab({ root, canvasOverlay, port, view, theme, clock, frame })
//   root           the board's container (positioned): pins, the thread popover, floating emotes and the
//                  emote picker go in a layer appended to it; screen coords = view.toScreen(world) inside it
//   canvasOverlay  optional <canvas> over the board, sized like it; others' cursors, selections, previews and
//                  lasers are painted there. Without it, call collab.draw(ctx) from your own paint.
//   view           { toScreen, toWorld, scale | view.scale }: the board Editor works as is
//   clock          the clock port (web/ports/clock.js: { now, mono, set, clear, random }); the root passes its own.
//                  mono: presence expiry, floats and outbox pacing; now: "3 min ago" stamps; random: record ids.
//                  Without one, frame.js's domClock() (the browser's). The old test shape { now, setTimer,
//                  clearTimer, raf } is still read (mono = now) until test/web/collab moves to the port shape.
//   frame          frame scheduler fn(cb): the overlay repaints on it (default: frame.js's domFrame)
//   pinCap         at most this many pins in the DOM; past it, threads in view cluster into counted bubbles
//   view.maxScale  optional: the page's zoom limit (app.js: 8); a cluster click zooms up to it (default 4)
//   onList         optional fn("comments"): a cluster click that can't zoom apart (members on one point, or the
//                  view at maxScale) lists them in the comments drawer; the host shows its drawer then
//   collab.parts   { avatars, emotes, emoteButton, drawer }: elements for the top bar, the bottom bar (desktop),
//                  the bottom-right corner (phones: one 👏 that opens the picker) and the drawer
//   collab.pointer(world) · collab.selection(stream, ids) · collab.laser(world)   → presence out (paced)
//   collab.statusRev  bumps on every port status/role change (collabFrame retries a refused selection then)
//   collab.startComment(world, on?) · collab.openThread(id) · collab.showDrawer("notes" | "comments")
//   collab.layout({ board }?)  the view moved (and, with board: true or no argument, the board changed too): pins
//                  follow with one transform on their layer while the view stays inside the placed region at the
//                  same zoom; otherwise only the pins in the viewport plus a margin are re-placed (p7-perf C-1)
//   collab.setTheme(theme) · collab.destroy()
//   collab.setBottomInset(px)  reserve the visible bottom-sheet / dock area when positioning comment popovers

import { captureFocus, restoreFocus } from "../focus.js";
import { h, replace } from "./dom.js";
import { EMOTES, PRESENCE, canWrite } from "../../../core/collab/limits.js";
import { FLAGS } from "../../../core/collab/flags.js";
import { createOutbox, recordProblem, mayPresence } from "../../../core/collab/gate.js";
import { createPresence, colorOf, initials, FLOAT_MS } from "../../../core/collab/presence-model.js";
import { recordsView, newRecordId, ago, cornerOf, reanchor, nameIndex, layoutPins, zoomToFit } from "../../../core/collab/records-model.js";
import { notesView, notesCount, safeColor } from "../../../core/collab/notes-model.js";
import { drawPresence, scaleOf } from "./draw.js";
import { domClock, domFrame } from "./frame.js";
import { missingFromPort } from "../../../ports/collab.js";

const BAR = EMOTES.slice(0, 6);
/** Avatars a phone shows (collab.css hides the rest). */
export const PHONE_AVATARS = 2;
const fmt = n => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const watching = n => n.toLocaleString("en-US");
/** Pins in the DOM at most; the margin (a fraction of the viewport, each side) placed beyond the view; cluster grid. */
export const PIN_CAP = 300, PIN_MARGIN = 0.5, CLUSTER_PX = 56, MAX_CLUSTERS = 200;

/** The clock port, from a port-shaped clock, the old test shape, or nothing (the browser's, via frame.js). */
function clockPort(clock) {
  if (clock && typeof clock.set === "function" && typeof clock.mono === "function") return clock;
  const dom = domClock();
  if (!clock) return dom;
  return { now: clock.now, mono: clock.mono ?? clock.now, set: clock.set ?? clock.setTimer, clear: clock.clear ?? clock.clearTimer, random: clock.random ?? dom.random };
}

export function mountCollab({ root, canvasOverlay = null, port, view, theme = "light", clock = null, frame = null, flags = FLAGS, idGen = null, maxAvatars = 5, pinCap = PIN_CAP, onList = null }) {
  const missing = missingFromPort(port);
  if (missing.length) throw new Error(`collab port lacks ${missing.join(", ")}`);
  const C = clockPort(clock);
  const raf = frame ?? clock?.raf ?? domFrame(C);
  const newId = idGen ?? (() => newRecordId(C.random));
  // Deadlines and ages run on mono (a wall jump neither expires peers nor keeps them): presence, floats, pacing.
  const presence = createPresence({ now: C.mono, me: port.me, role: port.role, flags });
  const outbox = createOutbox(port, { now: C.mono, setTimer: C.set, clearTimer: C.clear });
  const S = { drawer: "comments", list: "open", only: null, open: null, compose: null, picker: false, reactFor: null, drafts: new Map(), toast: null, toastTimer: null, theme };
  const live = () => port.status === "live";
  // recordsView once per records change (port.records() identity, an onRecords call, role or me), not per frame.
  // A board change only re-resolves element anchors (reanchor). `rvRev` bumps whenever what it shows changed.
  let rvc = null, rvRev = 0, recEvents = 0, statusRev = 0;
  function records({ reanchor: board = false } = {}) {
    const r = port.records(), role = port.role, me = port.me;
    if (!rvc || rvc.r !== r || rvc.ev !== recEvents || rvc.role !== role || rvc.user !== me.user || rvc.name !== me.name) {
      rvc = { r, ev: recEvents, role, user: me.user, name: me.name, rv: recordsView(r, { me, role, element: port.element }), names: null };
      rvRev++;
    } else if (board && reanchor(rvc.rv, port.element)) rvRev++;
    return rvc.rv;
  }
  // A user's name: who's here, else what their comments were signed with (an index built once per records change).
  const nameOf = user => {
    const n = presence.nameOf(user);
    if (n) return n;
    records();
    return (rvc.names ??= nameIndex(rvc.r)).get(user) ?? null;
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
    // Phones show the first PHONE_AVATARS (collab.css), desktops maxAvatars: each gets its own +N (p7-collabv M3).
    const shown = writers.slice(0, maxAvatars), more = writerCount - shown.length, phoneMore = writerCount - Math.min(shown.length, PHONE_AVATARS);
    if (!changed("avatars", JSON.stringify([shown, more, phoneMore, viewers]))) return;
    const badge = (cls, n) => (n > 0 ? h(`span.av.more.${cls}`, { title: `${watching(writerCount)} people can write` }, `+${fmt(n)}`) : null);
    replace(parts.avatars,
      h("span.stack", {}, shown.map(w => av(w.user, w.name ?? "Someone", ".live")), badge("desk-more", more), badge("phone-more", phoneMore)),
      // A count of VIEWERS only (view-only tabs, PROTOCOL.md `here.viewers`); people who can draw are the avatars beside it.
      h("span.watching", { title: `${watching(viewers)} view-only ${viewers === 1 ? "tab" : "tabs"} watching (people who can draw show as avatars)` },
        h("span.eye", {}, "👁 "), h("b", {}, watching(viewers)), h("span.wtxt", {}, viewers === 1 ? " viewer" : " viewers")));
  }

  // ── emote bar and picker ──
  // Emotes go out at most PRESENCE.emote.rate a second (PROTOCOL.md § Pacing; the outbox drops the rest). A click is
  // never lost silently (p7-wirev LOW-3): after each send the whole control shows it is cooling down (class
  // `cooling`, aria-disabled, the title says why) until the gap has passed, so a click in that window lands on a
  // control that visibly isn't taking emotes. Not coalesced: a held emote would arrive late and mean nothing.
  const EMOTE_GAP_MS = 1000 / PRESENCE.emote.rate;
  let emoteAt = -Infinity, coolTimer = null;
  const cooling = () => C.mono() - emoteAt < EMOTE_GAP_MS;
  function sendEmote(e) {
    if (!outbox.emote(e)) return false;
    emoteAt = C.mono();
    if (coolTimer != null) C.clear(coolTimer);
    coolTimer = C.set(() => { coolTimer = null; renderEmotes(); }, EMOTE_GAP_MS);
    renderEmotes();
    // Writers' emotes float for everyone (presence); a viewer's is only ever counted (`emotes`).
    if (port.role !== "viewer") { presence.float(e, port.me.user); renderFloats(); }
    return true;
  }
  const reactionLabels = ["React with thumbs up", "React with heart", "React with laughing", "React with party popper", "React with clapping hands", "React with surprised face"];
  const bar = BAR.map((e, i) => { const n = h("b"); return { e, n, btn: h("button.tb", { "aria-label": reactionLabels[i], onclick: () => sendEmote(e) }, e, n) }; });
  const more = h("button.tb", { title: "More emotes", "aria-label": "More emotes", onclick: togglePicker }, "✨");
  const one = h("button.tb", { title: "Emotes", "aria-label": "Emotes", onclick: togglePicker }, "👏");   // phones: one button opens the picker
  parts.emotes.append(...bar.map(b => b.btn), h("span.sep"), more);
  parts.emoteButton.append(one);
  const pickerLabels = ["React with thumbs up", "React with heart", "React with laughing", "React with party popper", "React with clapping hands", "React with surprised face", "React with folded hands", "React with fire"];
  const pickerEl = h("div.emote-picker.collab-picker", { role: "menu", hidden: true }, EMOTES.map((e, i) => h("button", { title: e, "aria-label": pickerLabels[i], onclick: () => sendEmote(e) }, e)));
  pickHost.append(pickerEl);
  function renderEmotes() {
    const counts = presence.view().counts, on = live() && mayPresence(port.role, "emote"), cool = on && cooling();
    if (!on) S.picker = false;
    const coolTitle = `Cooling down: emotes go out at most ${PRESENCE.emote.rate} a second`;
    for (const el of [parts.emotes, parts.emoteButton, pickerEl]) el.classList.toggle("cooling", cool);
    for (const b of [...bar.map(x => x.btn), ...pickerEl.childNodes]) b.setAttribute("aria-disabled", String(cool));
    for (const b of pickerEl.childNodes) b.setAttribute("title", cool ? coolTitle : b.textContent);
    for (const b of bar) {
      b.btn.disabled = !on;
      b.btn.setAttribute("title", cool ? coolTitle : on ? `Send ${b.e}: never saved. Writers' emotes float up live; viewers' are counted every 500 ms.` : "Emotes need a live connection");
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
    const now = C.mono(), keep = new Set();
    for (const f of presence.view().floaters) {
      if (now - f.at >= FLOAT_MS) continue;
      keep.add(f.id);
      if (!floatEls.has(f.id)) { const el = h("span.emote.collab-float", { style: { left: `calc(50% + ${(f.lane - 2) * 44}px)` } }, f.e); floatEls.set(f.id, el); floats.append(el); }
    }
    for (const [id, el] of floatEls) if (!keep.has(id)) { el.remove(); floatEls.delete(id); }
  }

  // ── pins and the popover ──
  const screen = p => view.toScreen(p);
  // Pins sit in one layer. While the zoom is unchanged and the viewport stays inside the region placed last time
  // (viewport + PIN_MARGIN), a pan moves only that layer's transform: O(1) DOM writes. Otherwise the threads in the
  // region are re-placed, at most pinCap as pins, the rest clustered (layoutPins). Each pin writes only what changed.
  const pinEls = new Map();     // thread id → { el, at: { left, top, cls, bg, title, label } }
  const clusterEls = new Map(); // cluster key → { el, at }
  let placed = null;            // { ox, oy, scale, box, rev, open, cap }: what the pins were placed for
  let shift = "";
  const setShift = v => { if (v !== shift) { shift = v; pins.style.setProperty("transform", v); } };
  const viewBox = () => {
    const w = root.clientWidth || 1200, hh = root.clientHeight || 800, a = view.toWorld({ x: 0, y: 0 }), b = view.toWorld({ x: w, y: hh });
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  };
  const within = (v, box) => v.x0 >= box.x0 && v.y0 >= box.y0 && v.x1 <= box.x1 && v.y1 <= box.y1;
  /** Write a style/attr/class only when it differs from what this element was last given. */
  function put(rec, key, value, write) { if (rec.at[key] !== value) { rec.at[key] = value; write(value); } }
  function renderPins(rv = records()) {
    const o = screen({ x: 0, y: 0 }), sc = scaleOf(view), vb = viewBox();
    if (placed && placed.rev === rvRev && placed.scale === sc && placed.open === S.open && placed.cap === pinCap && within(vb, placed.box)) {
      setShift(o.x === placed.ox && o.y === placed.oy ? "" : `translate(${o.x - placed.ox}px, ${o.y - placed.oy}px)`);
      return;
    }
    const mx = (vb.x1 - vb.x0) * PIN_MARGIN, my = (vb.y1 - vb.y0) * PIN_MARGIN;
    const box = { x0: vb.x0 - mx, y0: vb.y0 - my, x1: vb.x1 + mx, y1: vb.y1 + my };
    const lay = layoutPins(rv.threads, { box, cap: pinCap, cell: CLUSTER_PX / (sc || 1), keep: S.open, maxClusters: MAX_CLUSTERS });
    placed = { ox: o.x, oy: o.y, scale: sc, box, rev: rvRev, open: S.open, cap: pinCap };
    setShift("");
    const keep = new Set();
    for (const t of lay.pins) {
      keep.add(t.id);
      let rec = pinEls.get(t.id);
      if (!rec) { rec = { el: h("button.pin", { "data-thread": t.id, onclick: ev => { ev.stopPropagation?.(); openThread(S.open === t.id ? null : t.id); } }), at: {} }; pinEls.set(t.id, rec); pins.append(rec.el); }
      const el = rec.el, p = screen(t), first = t.comments.find(c => !c.deleted);
      const cls = `${+!!t.resolved}${+(S.open === t.id)}${+t.pending}${+t.detached}`;
      put(rec, "cls", cls, () => { for (const [c, on] of [["resolved", !!t.resolved], ["active", S.open === t.id], ["pending", t.pending], ["detached", t.detached]]) el.classList.toggle(c, on); });
      put(rec, "bg", colorOf(t.by), v => el.style.setProperty("background", v));
      put(rec, "left", `${p.x}px`, v => el.style.setProperty("left", v));
      put(rec, "top", `${p.y - 28}px`, v => el.style.setProperty("top", v));
      put(rec, "title", `${t.name ?? "Someone"}: ${first?.text ?? ""}`, v => el.setAttribute("title", v));
      put(rec, "label", t.resolved ? "✓" : String(t.count), v => replace(el, v));
    }
    for (const [id, rec] of pinEls) if (!keep.has(id)) { rec.el.remove(); pinEls.delete(id); }
    const keepC = new Set();
    for (const c of lay.clusters) {
      keepC.add(c.key);
      let rec = clusterEls.get(c.key);
      if (!rec) {
        // A click zooms to fit the cluster's members (port.jumpTo's optional scale), so it opens into its pins. When
        // zooming can't split it (members on one point, or the view at its max scale), it lists them instead.
        rec = { el: h("button.pin.cluster", { "data-cluster": c.key, onclick: ev => { ev.stopPropagation?.(); if (rec.where.list) listThreads(rec.ids); else port.jumpTo?.(rec.where); } }), at: {}, where: null, ids: [] };
        clusterEls.set(c.key, rec); pins.append(rec.el);
      }
      rec.ids = c.ids;
      rec.where = zoomToFit(c.bounds, { w: root.clientWidth || 1200, h: root.clientHeight || 800, scale: sc, ...(Number.isFinite(view.maxScale) ? { maxScale: view.maxScale } : {}) });
      const p = screen(c);
      put(rec, "left", `${p.x}px`, v => rec.el.style.setProperty("left", v));
      put(rec, "top", `${p.y - 28}px`, v => rec.el.style.setProperty("top", v));
      put(rec, "title", `${c.n} comment threads here: click to ${rec.where.list ? "list them" : "zoom in"}`, v => rec.el.setAttribute("title", v));
      put(rec, "label", fmt(c.n), v => replace(rec.el, v));
    }
    for (const [key, rec] of clusterEls) if (!keepC.has(key)) { rec.el.remove(); clusterEls.delete(key); }
  }
  let bottomInset = 0;
  function place(pop, world) {
    const p = screen(world), w = root.clientWidth || 1200, hgt = Math.max(0, (root.clientHeight || 800) - bottomInset);
    const width = Math.max(0, Math.min(300, w - 16));
    let left = Math.max(8, Math.min(p.x + 20, w - width - 8)), top = p.y - 30;
    pop.style.setProperty("width", `${width}px`);
    const height = Math.min(pop.offsetHeight || 340, Math.max(0, hgt - 16));
    top = Math.max(8, Math.min(top, hgt - height - 8));
    pop.style.setProperty("left", `${left}px`); pop.style.setProperty("top", `${top}px`);
  }
  const mount = el => { if (el.parentNode !== popHost) replace(popHost, el); };
  const anchorText = t => (t.point ? "On a spot on the board" : t.detached ? "Detached: its element was deleted" : t.on.stream === "notes" ? "On a note" : "On an element of the board");

  function message(t, c) {
    const rv = c.reactions, canReact = c.canReact;
    const chips = (rv.length || canReact) && !c.deleted ? h("div.react-chips.collab-chips", {},
      rv.map(r => h(`button.chip-r${r.mine ? ".mine" : ""}${r.pending ? ".pending" : ""}`, {
        "data-fk": `msg:${c.id}:react:${r.emoji}`, disabled: !c.canReact, title: c.canReact ? (r.mine ? `Remove your ${r.emoji}` : `React ${r.emoji}`) : `${r.n} reacted ${r.emoji}`,
        onclick: () => recordOp(r.mine ? "unreact" : "react", { do: "react", id: c.id, emoji: r.emoji, on: !r.mine }) }, `${r.emoji} `, h("b", {}, String(r.n)))),
      c.canReact ? h("button.chip-r.add", { "data-fk": `msg:${c.id}:react-add`, title: "React", onclick: () => { S.reactFor = S.reactFor === c.id ? null : c.id; renderPopover(); } }, "＋") : null) : null;
    const reactRow = S.reactFor === c.id && c.canReact ? h("div.collab-reactrow", {}, EMOTES.map(e => h("button", { "data-fk": `msg:${c.id}:pick:${e}`, title: e, onclick: () => { S.reactFor = null; const has = rv.find(r => r.emoji === e)?.mine; recordOp(has ? "unreact" : "react", { do: "react", id: c.id, emoji: e, on: !has }); } }, e))) : null;
    return h(`div.msg${c.pending ? ".pending" : ""}`, {}, av(c.by, c.name),
      h("div.mbody", {},
        h("div.who", {}, c.name, h("span", {}, ago(c.at, C.now())), c.edited ? h("span", {}, "edited") : null, c.pending ? h("span.sending", {}, "sending…") : null,
          c.canDelete ? h("button.del", { "data-fk": `msg:${c.id}:delete`, title: "Delete this comment", onclick: () => recordOp("deleteComment", { do: "delete", id: c.id }) }, "delete") : null),
        c.deleted ? h("p.deleted", {}, "Comment deleted") : h("p", {}, c.text), chips, reactRow));
  }

  let pop = null;   // the open thread's popover: { id, el, head, body, foot, readFoot }, kept while it stays open
  function renderPopover(rv = records()) {
    if (S.compose) return renderCompose();
    const t = S.open && rv.threads.find(x => x.id === S.open);
    if (!t) { S.open = null; pop = null; if (popHost.childNodes.length) replace(popHost); return; }
    if (!pop || pop.id !== t.id) {
      const field = h("textarea.field", { rows: 2, placeholder: "Reply…", "aria-label": "Reply",
        oninput: e => S.drafts.set(t.id, e.currentTarget.value),
        onkeydown: e => { e.stopPropagation?.(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } });
      field.value = S.drafts.get(t.id) ?? "";
      const send = () => {
        const text = field.value.trim(), id = newId();
        if (recordOp("reply", { do: "reply", id, thread: t.id, text })) { field.value = ""; S.drafts.delete(t.id); }
      };
      const foot = h("div.reply", {}, field, h("button.btn.primary", { onclick: send }, "Send"));
      pop = { id: t.id, head: h("header", { "data-fk": "heading", tabindex: "-1" }), body: h("div.body"), foot, field, readFoot: h("div.reply.hint"), el: null };
      pop.el = h("div.pop.collab-pop", { role: "dialog", "aria-label": "Comment thread" }, pop.head, pop.body, pop.foot, pop.readFoot);
      delete sigs.pop;
    }
    // Rebuild the head and messages only when what they show changed (a click mid-rebuild is lost).
    if (changed("pop", JSON.stringify([t, S.reactFor, port.role, Math.floor(C.now() / 30_000)]))) {
      const held = captureFocus([pop.el]);       // a Resolve or reaction button that was just used keeps focus
      replace(pop.head,
        t.resolved ? [h("span", {}, "✓"), h("b", {}, `Resolved by ${t.resolved.name ?? "someone"}`)] : h("span.anchor", {}, anchorText(t)),
        h("span.spacer"),
        t.canResolve ? h("button.btn", { "data-fk": `thread:${t.id}:resolve`, disabled: t.statePending, onclick: () => recordOp(t.resolved ? "reopen" : "resolve", { do: t.resolved ? "reopen" : "resolve", id: t.id }) }, t.resolved ? "Reopen" : "✓ Resolve") : null,
        h("button.tb", { title: "Close", onclick: () => openThread(null) }, "✕"));
      replace(pop.body, t.resolved || t.detached ? h("div.anchor.muted", {}, anchorText(t)) : null, t.comments.map(c => message(t, c)));
      restoreFocus(held);
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
      const id = newId(), anchor = c.on ? { stream: c.on.stream, element: c.on.element, x: c.x, y: c.y } : { point: { x: c.x, y: c.y } };
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
    if (S.toastTimer) C.clear(S.toastTimer);
    S.toastTimer = C.set(() => { toast.hidden = true; S.toast = null; S.toastTimer = null; }, 4000);
  }

  // ── drawer: header, tabs and the scroller are kept; only the rows are rebuilt, and only when they changed ──
  const tabNotes = h("button", { onclick: () => showDrawer("notes") }), tabComments = h("button", { onclick: () => showDrawer("comments") });
  const tabOpen = h("button", { onclick: () => { S.list = "open"; S.only = null; renderDrawer(); } }), tabResolved = h("button", { onclick: () => { S.list = "resolved"; S.only = null; renderDrawer(); } });
  const listTabs = h("div.collab-listtabs", {}, h("span.seg", {}, tabOpen, tabResolved));
  // A cluster's own list (listThreads): only its threads, until "Show all" or a list tab.
  const onlyText = h("span"), onlyBar = h("div.collab-only", { hidden: true }, onlyText, " ", h("button", { onclick: () => { S.only = null; renderDrawer(); } }, "Show all"));
  const scroller = h("div.notes-list");
  /** Rebuild the drawer rows, keeping focus on the control that had it (a row, a jump / edit / delete button). */
  const swapRows = (...kids) => { const held = captureFocus([scroller]); replace(scroller, ...kids); restoreFocus(held); };
  parts.drawer.append(h("header", {}, h("h3", {}, "Annotations"), h("span.seg", {}, tabNotes, tabComments)), listTabs, onlyBar, scroller);
  const label = (el, text, on) => { if (el.textContent !== text) replace(el, text); el.classList.toggle("on", on); };
  // The notes rows are built only while the notes tab shows (C-7); the comments tab's "Notes N" label is a count
  // refreshed on the 1 s tick (the port has no notes-changed signal to key it on).
  let notesTotal = null;
  const countNotes = () => { notesTotal = notesCount(port.notes()); };
  function renderDrawer(rv = records()) {
    const nv = S.drawer === "notes" ? notesView(port.notes(), { me: port.me, role: port.role, noteAuthor: port.noteAuthor, nameOf, canEdit: typeof port.editNote === "function", canDelete: typeof port.deleteNote === "function" }) : null;
    if (nv) notesTotal = nv.total; else if (notesTotal === null) countNotes();
    label(tabNotes, `Notes ${fmt(notesTotal)}`, S.drawer === "notes"); label(tabComments, `Comments ${fmt(rv.open.length)}`, S.drawer === "comments");
    label(tabOpen, `Open ${rv.open.length}`, S.list === "open"); label(tabResolved, `Resolved ${rv.resolved.length}`, S.list === "resolved");
    listTabs.hidden = S.drawer !== "comments";
    const only = S.drawer === "comments" && S.only ? rv.threads.filter(t => S.only.has(t.id)) : null;
    onlyBar.hidden = !only;
    if (only) { const text = `${only.length} ${only.length === 1 ? "thread" : "threads"} here`; if (onlyText.textContent !== text) replace(onlyText, text); }
    if (S.drawer === "notes") {
      sigs.drawerRev = null;     // the comments rows must be rebuilt on the way back
      if (!changed("drawer", JSON.stringify(["notes", nv]))) return;
      swapRows(nv.rows.length ? nv.rows.map(n => h("div.note-row", { "data-note": n.id, "data-fk": `note:${n.id}:row`, tabindex: "-1" },
        h("span.sw", { style: { background: safeColor(n.color), width: "10px", height: "10px" } }),
        h("div.txt", {}, h("div", {}, n.text),
          h("div.meta", {}, h("span.author", { style: { color: n.by ? colorOf(n.by) : "var(--muted)" } }, n.author), n.kind === "highlight" ? h("span", {}, "highlight") : null),
          h("div.acts", {},
            port.jumpTo ? h("button", { "data-fk": `note:${n.id}:jump`, onclick: () => port.jumpTo(n.at) }, "jump to") : null,
            n.canEdit ? h("button", { "data-fk": `note:${n.id}:edit`, onclick: () => port.editNote(n.id) }, "edit") : null,
            n.canDelete ? h("button", { "data-fk": `note:${n.id}:delete`, onclick: () => port.deleteNote(n.id) }, "delete") : null,
            n.locked ? h("span.lock", {}, `🔒 ${n.author}'s`) : null)))) : h("div.hint", {}, "No notes yet."),
        nv.more ? h("div.hint", {}, `${fmt(nv.more)} more`) : null);
    } else {
      const list = only ?? (S.list === "open" ? rv.open : rv.resolved);
      const which = only ? `only:${[...S.only].join(",")}` : S.list;
      // Keyed on what the rows show, so a reaction or a here doesn't rebuild every row; built only when the
      // records view changed (rvRev), else the last key stands.
      if (sigs.drawerRev === `${which}|${S.open}|${rvRev}`) return;
      sigs.drawerRev = `${which}|${S.open}|${rvRev}`;
      if (!changed("drawer", JSON.stringify(["comments", which, S.open, list.map(t => [t.id, t.name, t.count, t.pending, t.detached, t.point, t.comments.find(c => !c.deleted)?.text])]))) return;
      swapRows(list.length ? list.map(t => {
        const first = t.comments.find(c => !c.deleted);
        const go = () => { openThread(t.id); port.jumpTo?.({ x: t.x, y: t.y }); };
        return h(`div.note-row.thread-row${t.resolved ? ".done" : ""}${S.open === t.id ? ".on" : ""}`, { "data-thread": t.id, "data-fk": `thread:${t.id}`, role: "button", tabindex: "0",
          onclick: go, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } },
          av(t.by, t.name), h("div.txt", {}, h("div", {}, first?.text ?? ""),
            h("div.meta", {}, h("span", {}, t.name ?? "Someone"), h("span", {}, anchorText(t))),
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
  /** List these threads (a cluster zoom can't split) in the comments drawer, and ask the host to show it. */
  function listThreads(ids) { S.only = new Set(ids); S.drawer = "comments"; renderDrawer(); onList?.("comments"); }

  // ── port events ──
  const offs = [
    // Presence is live only: anything arriving while not live is stale (rule 11 drops it server-side too).
    port.onPresence(batch => { if (!live()) return; presence.ingest(batch); if (batch.some?.(m => m.k === "emote")) renderFloats(); paint(); }),
    port.onLeave((u, c) => { presence.leave(u, c); paint(); }),
    port.onHere(msg => { presence.here(msg); renderAvatars(); renderDrawer(); paint(); }),
    port.onEmotes(msg => { presence.emotes(msg); renderEmotes(); }),
    port.onRecords(() => { recEvents++; const rv = records(); renderPins(rv); renderPopover(rv); renderDrawer(rv); }),
    port.onRefused(r => { say(`Not saved: ${r.message || r.code}`); }),
    port.onStatus((status, role) => {
      statusRev++;
      presence.setRole(role ?? port.role);
      if (status !== "live") { presence.clear(); outbox.reset(); S.picker = false; } else outbox.resume();
      renderAll();
    }),
  ];
  // A slow tick: counts and floaters age out, silent peers expire.
  let tickTimer = null;
  const tick = () => {
    tickTimer = C.set(tick, 1000); presence.prune(); renderEmotes(); renderFloats(); paint();
    if (S.drawer !== "notes") { const before = notesTotal; countNotes(); if (before !== notesTotal) label(tabNotes, `Notes ${fmt(notesTotal)}`, false); }
  };
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
    setBottomInset(value) {
      const inset = Number.isFinite(value) ? Math.max(0, value) : 0;
      if (inset === bottomInset) return;
      bottomInset = inset;
      popHost.style.setProperty("bottom", `${inset}px`);
      renderPopover();
    },
    layout({ board = true } = {}) { const rv = records({ reanchor: board }); renderPins(rv); renderPopover(rv); paint(); },
    draw,
    setTheme(t) { S.theme = t === "dark" ? "dark" : "light"; paint(); },
    /** Bumps on every onStatus: collabFrame retries a refused selection when it moves. */
    get statusRev() { return statusRev; },
    get state() { return { open: S.open, compose: S.compose && { x: S.compose.x, y: S.compose.y, on: S.compose.on }, drawer: S.drawer, list: S.list, picker: S.picker, toast: S.toast }; },
    /** Unmount: unsubscribe, stop timers, remove the layer, and release the port (port.destroy, when it has one). */
    destroy() { for (const off of offs) off?.(); outbox.close(); if (tickTimer) C.clear(tickTimer); if (S.toastTimer) C.clear(S.toastTimer); if (coolTimer != null) C.clear(coolTimer); layer.remove(); port.destroy?.(); },
  };
}
