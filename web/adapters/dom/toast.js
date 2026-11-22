// The Undo toast, shared by Move and Move to Trash (web/adapters/dom/move.js, trash.js). A sentence announced once through the page's polite live region (the toast is not a live region
// itself), an Undo button, Dismiss; never traps focus; lasts UNDO_MS, counted on clock.mono(), and the countdown HOLDS whenever focus is inside the toast or the pointer is over it (a person
// reading or aiming at Undo is never cut off) and resumes with what was left. Escape or Dismiss end it; Tab off either end of it leaves it; when it goes away while focus was inside it,
// focus goes back to the page (`restoreFocus`). After an Undo the toast shows the outcome for a few seconds.

import { h } from "./dom.js";
import { announce } from "./focus.js";
import { UNDO_MS } from "../../core/move.js";
import { createTrashUndo, trashedText, trashedSpaceText } from "../../core/trash.js";

/**
 * @param {{ host: HTMLElement, text: string, label: string, className?: string, undoFk?: string, undo: { available: boolean, run(): Promise<{ ok: boolean, text: string }> },
 *   clock: import("../../ports/clock.js").Clock, onChange?(): void, restoreFocus?(): void }} o
 * @returns {{ dismiss(restore?: boolean): void, el: HTMLElement }}
 */
export function showUndoToast({ host, text: sentence, label, className = "move-toast", undoFk = "move-undo", undo, clock, onChange = () => {}, restoreFocus = () => {} }) {
  const text = h("span", {}, sentence);
  const undoBtn = undo.available ? h("button.btn", { type: "button", "data-fk": undoFk, onclick: () => run() }, "Undo") : null;
  const close = h("button.btn.ghost", { type: "button", "aria-label": "Dismiss", onclick: () => dismiss() }, "Dismiss");
  const el = h(`div.${className.split(" ").join(".")}`, { role: "group", "aria-label": label,
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

/**
 * The Undo toast after a Move to Trash. `result` is the trash call's answer (its `undo` says whether Undo is offered). Returns `{ dismiss, el }`.
 * @param {{ host: HTMLElement, api: import("../../ports/trash.js").TrashPort, kind: "board"|"space", result: object, clock: import("../../ports/clock.js").Clock,
 *   newKey?: (() => string)|null, onChange?(): void, restoreFocus?(): void }} o
 */
export function showTrashToast({ host, api, kind, result, clock, newKey = null, onChange = () => {}, restoreFocus = () => {} }) {
  const board = kind === "board";
  const name = board ? result.board.title : result.space.name;
  const id = board ? result.board.id : result.space.id;
  const undo = createTrashUndo({ api, kind, id, name, undo: result.undo ?? null, newKey });
  const text = board ? trashedText(name) : trashedSpaceText(name, result.boards ?? 0);
  return showUndoToast({ host, text, label: board ? "Board moved to Trash" : "Space moved to Trash", className: "move-toast trash-toast", undoFk: "trash-undo", undo, clock, onChange, restoreFocus });
}
