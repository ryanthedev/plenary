// The access explanation as DOM (part of the dom group): the why-card that stands in for a disabled control, the Ask for access control, and the canvas pill's popover.
// Rules this file keeps: other people's words (names) go in through textContent only (h()); an explanation is ALWAYS visible text, never only a hover title, so keyboard and
// screen-reader users get it (a disabled control is `aria-disabled` + `aria-describedby` this card, and stays in the tab order); the Ask button is a real button outside any
// tooltip; after a request is sent focus moves to its confirmation (the button is gone), and every outcome is said in the polite live region.

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { createAskModel, whyLines, pillLine, sourceText, ownersText, waitText, needText } from "../../core/explain.js";

/**
 * Ask for access at a scope: a role to ask for (when the server offers more than one), the button, and the outcome. Built once, repainted in place on every change.
 * @param {{ api: { ask(type: string, id: string, role: string, key?: string|null): Promise<any> }, type: string, id: string, why: import("../../core/explain.js").Explain, newKey?: (() => string)|null, setTimer?: Function, clearTimer?: Function }} o
 */
export function askView({ api, type, id, why, newKey = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const model = createAskModel({ api, type, id, why, newKey, onChange: () => paint() });
  const S = model.state;
  const select = h("select.field", { "aria-label": "Role to ask for", onchange: e => model.choose(e.target.value) },
    why.ask.roles.map(r => h("option", { value: r.id, selected: r.id === S.role }, r.name)));
  const button = h("button.btn.primary", { type: "button", "data-fk": "ask", onclick: async () => {
    if (button.getAttribute("aria-disabled") === "true") return;
    const ok = await model.submit();
    if (ok) status.focus?.();                       // the button is hidden now: focus goes to the confirmation, which is read out
    if (S.said) announce(S.said);
  } }, "Ask for access");
  const status = h("p.muted", { role: "status", tabindex: "-1", "data-fk": "ask-status" });
  const el = h("div.ask", {}, h("label.l", {}, "Role", select), button, status);
  let timer = null;
  function paint() {
    if (timer != null) { clearTimer(timer); timer = null; }
    const sent = S.status === "sent", wait = S.status === "limited" || (S.retryAfterMs != null && S.retryAfterMs > 0 && !sent);
    button.hidden = sent; select.parentNode.hidden = sent || why.ask.roles.length < 2;
    button.setAttribute("aria-disabled", S.status === "busy" || wait ? "true" : "false");
    status.textContent = sent
      ? `You asked for ${S.pending?.roleName ?? "access"}. The owners will see your request on the Access page; you will have it when one of them adds you.`
      : S.status === "busy" ? "Sending…" : S.message ?? (wait ? `You asked recently and the request was closed. You can ask again ${S.retryAfterMs ? waitText(S.retryAfterMs) : "later"}.` : "");
    if (sent) { button.setAttribute("aria-hidden", "true"); }
    // The wait was told to us: when it elapses the button works again without a reload (a 2^31 ms cap keeps setTimeout sane).
    else if (wait && S.retryAfterMs > 0) timer = setTimer(() => { timer = null; model.clearLimit(); }, Math.min(S.retryAfterMs, 2 ** 31 - 1));
  }
  paint();
  return { el, model, focus: () => (S.status === "sent" ? status : button).focus?.() };
}

/**
 * The card that explains a disabled control: who you are here and through what, what the control needs, who to ask, and Ask for access.
 * `describes` is the card's id: the control's `aria-describedby`.
 * @param {{ why: import("../../core/explain.js").Explain, here: { type: string, id: string }, what: string, permission: string, id: string, access?: any, newKey?: (() => string)|null, hereName?: string|null }} o
 */
export function whyCard({ why, here, what, permission, id, access = null, newKey = null, hereName = null }) {
  const lines = whyLines(why, here, what, permission, hereName);
  const ask = access && (why.ask.can || why.ask.pending) ? askView({ api: access, type: here.type, id: here.id, why, newKey }) : null;
  const el = h("section.why", { id, tabindex: "-1", "aria-label": "Why you can't do this" }, lines.map(l => h("p", {}, l)), ask?.el);
  return { el, ask };
}

/** A sentence per source for the "Your access" list: "Commenter · via the Infra team on Space Platform". */
export const sourceRow = (s, here) => ({ text: `${s.roleName} · ${sourceText(s, here)}`, strongest: s.strongest });

/**
 * The canvas pill's popover: loads the explanation when opened (never cached: the role may have changed), shows it as text with the sources, and offers Ask for access.
 * @param {{ pill: HTMLElement, explain: (() => Promise<{ why?: import("../../core/explain.js").Explain, error?: string }>)|null, board: string, access?: any, newKey?: (() => string)|null }} o
 */
export function pillPopover({ pill, explain, board, access = null, newKey = null }) {
  let pop = null, token = 0;
  const here = { type: "board", id: board };
  const close = (refocus = true) => {
    token++;
    if (pop) { pop.remove(); pop = null; }
    pill.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    if (refocus) pill.focus?.();
  };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  // Tabbing out of the popover (it is non-modal) closes it, as a click outside does. Tabbing past its last control lands on nothing (relatedTarget null), which only
  // counts as leaving while the page still has focus; a window blur (the document lost focus) leaves it open so coming back finds it.
  const onOut = e => {
    const to = e.relatedTarget;
    if (!pop || (to && (pop.contains(to) || pill.contains(to)))) return;
    if (to || document.hasFocus?.() !== false) close(false);
  };
  const onDown = e => { if (pop && !pop.contains(e.target) && !pill.contains(e.target)) close(false); };
  async function open() {
    if (pop || !explain) return;
    const mine = ++token;
    pop = h("div.pill-pop", { role: "dialog", "aria-label": "Why this board is view only", "aria-describedby": "pill-pop-body" });
    const body = h("div", { id: "pill-pop-body" }, h("p", { role: "status" }, "Looking up why…"));
    pop.append(body, h("button.btn", { type: "button", onclick: () => close() }, "Close"));
    pop.addEventListener("focusout", onOut);
    document.body.append(pop);
    const r = pill.getBoundingClientRect?.();
    if (r) Object.assign(pop.style, { top: `${Math.round(r.bottom + 6)}px`, right: "12px" });
    pill.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    const res = await explain();
    if (mine !== token || !pop) return;
    if (!res.why) { replace(body, h("p", { role: "status" }, "Could not look that up right now. Try again in a moment.")); return; }
    const w = res.why;
    const card = access && (w.ask.can || w.ask.pending) ? askView({ api: access, type: "board", id: board, why: w, newKey }) : null;
    replace(body, h("p", {}, pillLine(w.mine) + "."),
      w.mine.sources.length ? h("ul.rows", { "aria-label": "Where your access comes from" }, w.mine.sources.map(s => { const x = sourceRow(s, here); return h("li.row", {}, x.text, x.strongest ? h("span.badge", {}, "grants the most") : null); })) : null,
      w.needs["board.edit"] ? h("p", {}, `${needText(w.needs["board.edit"], "Editing", w.mine.role?.name)} ${ownersText(w.owners, w.guest)}`) : h("p", {}, ownersText(w.owners, w.guest)),
      card?.el);
    (card ? pop.querySelector?.("[data-fk=ask]") : pop.querySelector?.("button"))?.focus?.();
  }
  return { toggle: () => (pop ? close() : open()), close, isOpen: () => !!pop };
}
