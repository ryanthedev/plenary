// The Move dialog and the Undo toast over the DOM, rendering web/core/move.js's model. Rules this file keeps: a real modal (openDialog: role="dialog", aria-modal, labelled
// by its heading, focus moves in, Tab stays inside, Escape closes, focus returns to the opener on cancel); destinations are a radio group; choosing one loads the access diff,
// whose three lists are headed, plain-text lists (no colour-only meaning) and are said once through the page's polite live region; Move stays off until that diff has loaded;
// names and titles are other people's words (textContent only). After a move the dialog closes and focus goes to the toast's Undo button (the card that opened the dialog is
// gone). The toast is ./toast.js's (shared with Move to Trash).

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { openDialog } from "./dialogs.js";
import { diffText, destinationText, createUndo, movedText, createMoveModel } from "../../core/move.js";
import { showUndoToast } from "./toast.js";

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
 * The Undo toast. `result` is the move's answer; with no `undo` in it the toast is a plain notice. Returns `{ dismiss, el }`. (The toast itself is ./toast.js, shared with Move to Trash.)
 * @param {{ host: HTMLElement, move: import("../../ports/move.js").MovePort, board: string, result: import("../../ports/move.js").MoveResult, clock: import("../../ports/clock.js").Clock,
 *   newKey?: (() => string)|null, onChange?(): void, restoreFocus?(): void }} o
 */
export function showMoveToast({ host, move, board, result, clock, newKey = null, onChange = () => {}, restoreFocus = () => {} }) {
  return showUndoToast({ host, text: movedText(result.board.title, result.board.space.name), label: "Board moved", undo: createUndo({ move, board, result, newKey }), clock, onChange, restoreFocus });
}

/**
 * The whole Move flow behind one call, shared by every entry point (a Space page card, a Home card, the board page's menu): the dialog, then on success `reload()` (the page refreshes
 * what it shows) and the Undo toast, whose own `onChange` (an Undo that worked) calls `reload()` again. `restoreFocus` is where focus goes when the toast ends with focus inside it.
 * @param {{ host: HTMLElement, move: { port: import("../../ports/move.js").MovePort, clock: import("../../ports/clock.js").Clock, newKey?: (() => string)|null }, board: string,
 *   opener?: { focus?: () => void }|null, reload(): unknown, restoreFocus?(): void, toastHost?: HTMLElement }} o
 */
export function startMove({ host, move, board, opener = null, reload, restoreFocus = () => {}, toastHost = globalThis.document.body }) {
  const model = createMoveModel({ move: move.port, board, newKey: move.newKey });
  return openMove({ host, model, opener, onMoved: result => {
    Promise.resolve(reload()).catch(() => {}).then(() => showMoveToast({ host: toastHost, move: move.port, board, result, clock: move.clock, newKey: move.newKey, onChange: reload, restoreFocus }));
  } });
}
