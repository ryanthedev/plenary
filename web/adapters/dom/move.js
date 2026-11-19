// The Move dialog and the Undo toast over the DOM, rendering web/core/move.js's model. Rules this file keeps: a real modal (openDialog: role="dialog", aria-modal, labelled
// by its heading, focus moves in, Tab stays inside, Escape closes, focus returns to the opener on cancel); destinations are a radio group; choosing one loads the access diff,
// whose three lists are headed, plain-text lists (no colour-only meaning) and are said once through the page's polite live region; Move stays off until that diff has loaded;
// names and titles are other people's words (textContent only). After a move the dialog closes and focus goes to the toast's Undo button (the card that opened the dialog is
// gone). The toast is not a live region itself (its sentence is announced once, through `announce`), never traps focus, lasts UNDO_MS, and gives focus back to the page when it
// goes away while focus was inside it.

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { openDialog } from "./dialogs.js";
import { diffText, destinationText, createUndo, movedText, UNDO_MS } from "../../core/move.js";

let seq = 0;
const NOTES = {
  forbidden: "Only people who can move this board can do it. Ask one of its owners.", notfound: "This board is not available to you.", "signed-out": "You are signed out. Sign in again to move this board.",
};

/**
 * @param {{ host: HTMLElement, model: ReturnType<typeof import("../../core/move.js").createMoveModel>, opener?: { focus?: () => void }|null, onMoved(result: object): void }} o
 */
export function openMove({ host, model, opener = null, onMoved }) {
  const S = model.state, id = ++seq;
  const status = h("p.share-status", { tabindex: "-1", "data-fk": "move-status" });
  const where = h("div.pick", { role: "radiogroup", "aria-label": "Move to", "aria-describedby": `move-diff-${id}` });
  const diffBox = h("div.move-diff", { id: `move-diff-${id}` });
  const note = h("p", {}, "Loading…");
  const move = h("button.btn.primary", { type: "submit", "aria-disabled": "true", "data-fk": "move-go" }, "Move");
  const cancel = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
  const body = h("div.share-body", {}, h("p.from", {}, "Direct grants, invites and links travel with the board, and its address does not change."), where, diffBox);
  const slot = h("div", {});
  const d = openDialog({ host, title: "Move board", opener: null, onClose: () => { if (!S.result) opener?.focus?.(); },
    onSubmit: async () => { if (model.canMove() && await model.submit()) { d.close(); onMoved(S.result); } else if (S.notice) status.focus?.(); },
    body: [note, status, slot], footer: [cancel, move] });
  cancel.focus?.();
  let radios = null;

  const list = (heading, text, entries) => h("section", { "aria-label": heading }, h("h3", {}, heading), entries.length ? h("ul.rows", {}, entries.map(e => h("li.row", {}, text(e)))) : h("p.muted", {}, "Nobody."));
  const paintDiff = () => {
    const D = S.diff;
    if (D.status === "idle") return replace(diffBox, h("p.muted", {}, "Pick a Space to see who gains and loses access."));
    if (D.status === "loading") return replace(diffBox, h("p.muted", {}, "Checking who gains and loses access…"));
    if (D.status === "error") return replace(diffBox, h("p.muted", {}, "Could not check who would gain or lose access. Pick the Space again."));
    const t = diffText(D.data);
    const line = e => `${e.self ? "You" : e.subject.name || "Someone"} · ${e.before && e.after && e.before.id !== e.after.id ? `${e.before.name} to ${e.after.name}` : (e.after ?? e.before)?.name ?? ""}`;
    replace(diffBox, list("Gains access", line, D.data.gains), list("Keeps access", line, D.data.keeps),
      D.data.invites || D.data.links ? h("p.from", {}, [D.data.invites ? `${D.data.invites} invite${D.data.invites === 1 ? "" : "s"}` : null, D.data.links ? `${D.data.links} link${D.data.links === 1 ? "" : "s"}` : null].filter(Boolean).join(", ") + " keep working.") : null,
      list("Loses access", line, D.data.loses), ...t.notes.map(n => h("p.from", {}, n)));
  };

  function paint() {
    if (S.status !== "ready") {
      replace(slot); note.hidden = false;
      note.textContent = S.status === "loading" ? "Loading…" : NOTES[S.status] ?? S.notice ?? "Could not load. Close this and try again.";
      if (S.status !== "loading" && !S.said) announce(note.textContent);
      return;
    }
    note.hidden = true; if (!body.parentNode) slot.append(body);
    if (!radios) {
      const dests = S.options.destinations;
      radios = dests.map(s => ({ s, input: h("input", { type: "radio", name: `move-to-${id}`, value: s.id, onchange: () => model.choose(s.id) }) }));
      replace(where, dests.length ? radios.map(({ s, input }) => h("label.opt", {}, input, h("span", {}, s.personal ? "◐ " : "▢ ", destinationText(s)), h("span.from", {}, s.personal ? "only you" : s.general ? "Everyone can see it" : "Only people added")))
        : h("p.muted", {}, "There is no Space you can move this board into."));
      if (S.options.more) where.append(h("p.muted", {}, "More Spaces exist than are listed."));
      radios[0]?.input.focus?.();
    }
    if (radios) for (const { s, input } of radios) { input.checked = s.id === S.to; input.disabled = S.busy; }
    paintDiff();
    move.setAttribute("aria-disabled", model.canMove() ? "false" : "true");
  }
  model.subscribe(() => {
    paint();
    if (S.busy) { status.textContent = "Moving…"; return; }
    status.textContent = S.notice ?? "";
    if (S.said) { announce(S.said); S.said = null; }
  });
  paint();
  model.load();
  return d;
}

/**
 * The Undo toast. `result` is the move's answer; with no `undo` in it the toast is a plain notice. Returns `{ dismiss, el }`.
 * @param {{ host: HTMLElement, move: import("../../ports/move.js").MovePort, board: string, result: import("../../ports/move.js").MoveResult, clock: import("../../ports/clock.js").Clock,
 *   newKey?: (() => string)|null, onChange?(): void, restoreFocus?(): void }} o
 */
export function showMoveToast({ host, move, board, result, clock, newKey = null, onChange = () => {}, restoreFocus = () => {} }) {
  const undo = createUndo({ move, board, result, newKey });
  const text = h("span", {}, movedText(result.board.title, result.board.space.name));
  const undoBtn = undo.available ? h("button.btn", { type: "button", "data-fk": "move-undo", onclick: () => run() }, "Undo") : null;
  const close = h("button.btn.ghost", { type: "button", "aria-label": "Dismiss", onclick: () => dismiss() }, "Dismiss");
  const el = h("div.move-toast", { role: "group", "aria-label": "Board moved",
    onkeydown: e => {
      if (e.key === "Escape") { e.preventDefault?.(); dismiss(); return; }
      // Tab off either end of the toast leaves it (the toast is the last thing in the page, so the browser's own focus move has no element to name in `relatedTarget`): it goes, and focus goes on where Tab takes it.
      const at = globalThis.document?.activeElement, first = undoBtn ?? close;
      if (e.key === "Tab" && ((!e.shiftKey && at === close) || (e.shiftKey && at === first))) dismiss(false);
    },
    onfocusin: () => { inFocus = true; sync(); },
    // Focus moving to something outside the toast dismisses it (the person has gone on); focus lost to nowhere (a click on the page, a window switch) only resumes the countdown.
    onfocusout: e => { inFocus = false; if (e.relatedTarget && !el.contains?.(e.relatedTarget)) dismiss(false); else sync(); },
    onmouseenter: () => { over = true; sync(); }, onmouseleave: () => { over = false; sync(); } }, text, " ", undoBtn, close);
  host.append(el);
  announce(text.textContent + (undoBtn ? " Undo is available for 10 seconds." : ""));
  // The countdown pauses while focus is inside the toast or the pointer is over it (a person reading or aiming at Undo is never cut off), and resumes with what was left.
  let timer = null, left = UNDO_MS, startedAt = 0, inFocus = false, over = false, gone = false, working = false;
  const arm = () => { startedAt = clock.mono(); timer = clock.set(() => dismiss(), left); };
  const hold = () => { if (timer !== null) { clock.clear(timer); timer = null; left = Math.max(0, left - (clock.mono() - startedAt)); } };
  const sync = () => { if (gone) return; if (inFocus || over) hold(); else if (timer === null && !working) arm(); };
  const schedule = ms => { hold(); left = ms; sync(); };
  // The countdown holds whenever focus is inside the toast, whatever put it there (the page's own focus on Undo included: a person on Undo is never cut off). Focus moving out, Escape or
  // Dismiss end it; a pointer user who never focuses it gets the 10 s.
  (undoBtn ?? close).focus?.();
  inFocus = !!el.contains?.(globalThis.document?.activeElement);
  sync();
  function dismiss(restore = true) {
    if (gone) return;
    gone = true; if (timer !== null) clock.clear(timer);
    const had = !!el.contains?.(globalThis.document?.activeElement);
    el.remove();
    if (had && restore) restoreFocus();
  }
  async function run() {
    if (working || gone) return;
    working = true; hold();
    undoBtn?.setAttribute("aria-disabled", "true");
    const r = await undo.run();
    working = false;
    if (gone) return;
    text.textContent = r.text; undoBtn?.remove(); announce(r.text);
    schedule(r.ok ? 4000 : UNDO_MS);
    if (r.ok) onChange();
    close.focus?.();                                        // the page moves focus off the Undo it just removed
    inFocus = !!el.contains?.(globalThis.document?.activeElement);
    sync();
  }
  return { dismiss, el };
}
