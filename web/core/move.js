// The Move dialog and its Undo as state with no DOM (web/adapters/dom/move.js renders them; the data comes through web/ports/move.js). The server decides everything: who may
// move (a 403 is the whole answer), which Spaces are valid destinations (`options`), who gains, keeps and loses (`preview`, the enforcing code's own answer) and whether Undo is
// possible (`undo`). The model words it, keeps one Idempotency-Key per submit (reused by its retries), and drops a preview that a later choice has outdated.
// Copy follows design/orgs/JOURNEY.md J3.

import { errorText } from "./spaces.js";

/** How long the Undo toast stays, a UI affordance only (PROTOCOL.md § Move board, "Undo"). */
export const UNDO_MS = 10_000;
export const HIDDEN_NOTE = "Some access comes from places you can't open.";

const MSG = {
  forbidden: "You can't move this board there.", moved: "This board was moved by someone else. Close this and open Move again.",
  invalid: "The server did not accept that.", notfound: "This board is not available to you.",
};
const failText = e => MSG[e] ?? errorText(e);
const MAYBE = " It may have been moved. Trying again unchanged is safe.";
const failMove = e => (e === "unavailable" ? "The server did not answer in time." + MAYBE : e === "network" ? "No answer from the server." + MAYBE : failText(e));

const roleOf = r => r?.name ?? "";
const entryText = e => {
  const who = e.self ? "you" : e.subject.name || "Someone";
  const role = e.after && e.before && e.after.id !== e.before.id ? `${roleOf(e.before)} to ${roleOf(e.after)}` : roleOf(e.after ?? e.before);
  return `${who} (${role})`;
};
/** One list as a sentence: "Gains access: Design team (Editor), Everyone in the organization (Viewer)." and "nobody" when empty. */
export const listText = (label, entries, extra = []) => `${label}: ${[...entries.map(entryText), ...extra].join(", ") || "nobody"}.`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The diff as the three lines the dialog shows (and the live region says): `{ gains, keeps, loses, notes }`, text only. */
export function diffText(d) {
  const travel = [d.invites ? plural(d.invites, "invite") : null, d.links ? plural(d.links, "link") : null].filter(Boolean);
  return {
    gains: listText("Gains access", d.gains), keeps: listText("Keeps access", d.keeps, travel), loses: listText("Loses access", d.loses),
    notes: [...(d.hidden ? [HIDDEN_NOTE] : []), ...(d.more ? ["More people than listed are affected."] : [])],
  };
}
export const destinationText = s => (s.group ? `${s.group.name} / ${s.name}` : s.name);
/** The sentence the toast shows and the live region says. */
export const movedText = (title, name) => `Moved ${title || "Untitled"} to ${name}.`;

/**
 * @param {{ move: import("../ports/move.js").MovePort, board: string, newKey?: (() => string)|null }} o
 */
export function createMoveModel({ move, board, newKey = null }) {
  const S = {
    status: "loading",       // loading | ready | forbidden | notfound | signed-out | error
    options: null, to: null, diff: { status: "idle", data: null },   // diff.status: idle | loading | ready | error
    busy: false, notice: null, said: null, result: null,
  };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(S); };
  let seq = 0, frozen = null;      // frozen: { sig, key } — one submit = one key
  const keyFor = sig => { if (frozen?.sig !== sig) { let key = null; try { key = newKey ? newKey() : null; } catch { key = null; } frozen = { sig, key }; } return frozen.key; };

  return {
    state: S,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },

    async load() {
      const r = await move.options(board);
      if (r.error) { S.status = r.error === "auth" ? "signed-out" : r.error === "forbidden" ? "forbidden" : r.error === "notfound" ? "notfound" : "error"; S.notice = S.status === "error" ? failText(r.error) : null; emit(); return; }
      S.options = r.options; S.status = "ready"; emit();
    },

    /** Pick a destination: its access diff loads; a slower answer for an earlier pick is dropped. */
    async choose(id) {
      if (!S.options?.destinations.some(d => d.id === id) || S.busy) return;
      const mine = ++seq;
      S.to = id; S.diff = { status: "loading", data: null }; S.notice = null; S.said = null; emit();
      const r = await move.preview(board, id);
      if (mine !== seq) return;
      if (r.error) {
        if (r.error === "auth") S.status = "signed-out";
        S.diff = { status: "error", data: null }; S.notice = failText(r.error); S.said = S.notice;
      } else { S.diff = { status: "ready", data: r.diff }; const t = diffText(r.diff); S.said = [t.gains, t.keeps, t.loses, ...t.notes].join(" "); }
      emit();
    },

    /** Move is possible once the diff of the chosen Space has loaded (the person has seen who gains and loses). */
    canMove: () => S.status === "ready" && S.to !== null && S.diff.status === "ready" && S.diff.data?.to.id === S.to && !S.busy,

    /** @returns {Promise<boolean>} */
    async submit() {
      if (!this.canMove()) return false;
      const from = S.options.from && !S.options.from.hidden ? S.options.from.id : undefined;
      if (from === undefined) { S.notice = "This board's current Space is not one you can open, so it cannot be moved from here."; S.said = S.notice; emit(); return false; }
      const to = S.to;
      S.busy = true; S.notice = null; emit();
      const r = await move.move(board, { from, to }, keyFor(JSON.stringify([from, to])));
      S.busy = false;
      if (r.error) {
        if (r.error === "auth") S.status = "signed-out"; else S.notice = failMove(r.error);
        S.said = S.notice; emit(); return false;
      }
      frozen = null; S.result = r.result; S.said = movedText(r.result.board.title, r.result.board.space.name); emit();
      return true;
    },
  };
}

/**
 * Undo of one move: an ordinary move back under its own key, once at a time. `result` is the move's answer (its `undo` says where, or is null: nothing to offer).
 * `done()` resolves `{ ok, text }`: the sentence to show and say.
 * @param {{ move: import("../ports/move.js").MovePort, board: string, result: import("../ports/move.js").MoveResult, newKey?: (() => string)|null }} o
 */
export function createUndo({ move, board, result, newKey = null }) {
  let key = null, busy = false;
  const back = result.undo?.space ?? null;
  return {
    available: !!back,
    async run() {
      if (!back || busy) return { ok: false, text: "" };
      busy = true;
      try { key ??= newKey ? newKey() : null; } catch { key = null; }
      const r = await move.move(board, { from: result.board.space.id, to: back.id }, key);
      busy = false;
      if (r.error === "moved") return { ok: false, text: "Can't undo: the board has been moved again." };
      if (r.error === "forbidden") return { ok: false, text: `You can no longer put this board back in ${back.name}.` };
      if (r.error) return { ok: false, text: r.error === "auth" ? "You are signed out. Sign in again." : failMove(r.error) };
      return { ok: true, text: `Moved ${result.board.title || "Untitled"} back to ${back.name}.` };
    },
  };
}
