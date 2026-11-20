// Trash as state with no DOM (web/adapters/dom/trash.js renders it; the data comes through web/ports/trash.js): the Undo of a Move to Trash, the Trash page's list with Restore, and
// the board-URL notice. The server decides everything (who may, what is listed, what is left to restore: PROTOCOL.md § Trash and restore); the models word it, keep one Idempotency-Key
// per submit (reused by its retries) and never invent a name. Copy follows design/orgs/JOURNEY.md J8.

import { UNDO_MS } from "./move.js";

export { UNDO_MS };
/** The Trash page's empty state (JOURNEY.md §5). */
export const EMPTY = Object.freeze({ title: "Trash is empty.", detail: "Deleted boards stay here for 30 days." });

const MSG = {
  forbidden: "You can't restore this.", notfound: "This is not available to you.", invalid: "The server did not accept that.",
  moved: "This board was moved by someone else. Reload and try again.",
  "would-escalate": "This board can't be restored into your personal space, because it would give you a higher role than you hold. Ask an owner to restore it.",
  "with-space": "This board went to Trash with its Space. Restore the Space to bring it back.",
  "space-in-trash": "This board's Space is in Trash. Restore the Space first.",
  purged: "This has been deleted for good and can't be restored.",
};
const MAYBE = " It may have worked. Trying again unchanged is safe.";
/** The sentence for a refused or failed call. */
export const failText = e => MSG[e] ?? (e === "unavailable" ? "The server did not answer in time." + MAYBE : e === "network" ? "No answer from the server." + MAYBE : e === "auth" ? "You are signed out. Sign in again." : "Something went wrong.");

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "28 days left", "1 day left", "Due to be deleted soon" once the 30 days are over and the purge has not run yet. */
export const daysText = n => (n > 0 ? `${plural(n, "day")} left` : "Due to be deleted soon");
/** The toast's sentence and the live region's. */
/** What a board is called on this page: its title, "Untitled" when it has none, or a placeholder when the server hid the title (the caller could not open the board). */
export const HIDDEN_BOARD = "a board you can't open";
/** `start`: the name opens a sentence or a heading, so only the placeholder is capitalised (a person's title is never touched). */
export const boardName = (title, { start = false } = {}) => (title === undefined ? (start ? "A" + HIDDEN_BOARD.slice(1) : HIDDEN_BOARD) : title || "Untitled");
export const trashedText = title => `Moved ${boardName(title)} to Trash.`;
export const trashedSpaceText = (name, boards) => `Moved ${name} to Trash${boards ? ` with ${plural(boards, "board")}` : ""}.`;
export const restoredText = (name, to = null) => `Restored ${name || "Untitled"}${to ? ` to ${to.personal ? "your personal space" : to.name}` : ""}.`;

/** Where a board was, as one line: "Product / Design", "Design", "Personal space" or a note that the place is not one the person can open (lower case: it always follows "Was in" or "from"). */
export function fromText(from) {
  if (!from) return "";
  const sp = from.space;
  if (!sp) return from.group ? `${from.group.name ?? "A Group"} / a Space you can't open` : "a Space you can't open";
  const name = sp.personal ? "Personal space" : sp.name;
  return from.group?.name ? `${from.group.name} / ${name}` : name;
}
/** Where a Space was: its Group, when the person can open it. */
export const groupText = g => (g?.name ? g.name : "");

/**
 * Undo of one Move to Trash: an ordinary Restore under its own key, once at a time. `kind`: "board" or "space"; `result` is the trash call's answer (its `undo` says whether to offer it).
 * `run()` resolves `{ ok, text }`: the sentence to show and say.
 * @param {{ api: import("../ports/trash.js").TrashPort, kind: "board"|"space", id: string, name: string, undo: object|null, newKey?: (() => string)|null }} o
 */
export function createTrashUndo({ api, kind, id, name, undo, newKey = null }) {
  let key = null, busy = false;
  return {
    available: !!undo,
    async run() {
      if (!undo || busy) return { ok: false, text: "" };
      busy = true;
      try { key ??= newKey ? newKey() : null; } catch { key = null; }
      const r = kind === "board" ? await api.restore(id, key) : await api.restoreSpace(id, key);
      busy = false;
      if (r.error) return { ok: false, text: failText(r.error) };
      return { ok: true, text: restoredText(name, r.result?.movedTo ?? null) };
    },
  };
}

/** @param {{ api: import("../ports/trash.js").TrashPort, newKey?: (() => string)|null }} o */
export function createTrashModel({ api, newKey = null }) {
  const S = { status: "loading", items: [], more: false, busy: null, notice: null, said: null };   // status: loading | ready | forbidden | signed-out | error; busy: the id being restored
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(S); };
  const keys = new Map();   // item id -> its restore key (one submit = one key, reused by retries)
  const keyFor = id => { if (!keys.has(id)) { let k = null; try { k = newKey ? newKey() : null; } catch { k = null; } keys.set(id, k); } return keys.get(id); };
  return {
    state: S,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async load() {
      const r = await api.list();
      if (r.error) { S.status = r.error === "auth" ? "signed-out" : r.error === "forbidden" ? "forbidden" : "error"; S.notice = S.status === "error" ? failText(r.error) : null; emit(); return; }
      S.items = r.list.items; S.more = r.list.more; S.status = "ready"; S.notice = null; emit();
    },
    /** Restore one row; it leaves the list on success, and `S.next` names the row that took its place (for focus). */
    async restore(item) {
      if (S.busy || !S.items.includes(item)) return false;
      S.busy = item.id; S.notice = null; emit();
      const r = item.type === "board" ? await api.restore(item.id, keyFor(item.id)) : await api.restoreSpace(item.id, keyFor(item.id));
      S.busy = null;
      if (r.error) {
        if (r.error === "auth") S.status = "signed-out"; else S.notice = failText(r.error);
        // A refusal that says the row can't be restored any more (deleted for good, or not ours to restore) drops it on the next load.
        S.said = S.notice; emit(); return false;
      }
      keys.delete(item.id);
      const at = S.items.indexOf(item);
      S.items = S.items.filter(i => i !== item);
      S.next = S.items[Math.min(at, S.items.length - 1)] ?? null;
      S.said = restoredText(item.type === "board" ? boardName(item.title) : item.name, r.result?.movedTo ?? null); emit();
      return true;
    },
  };
}

/**
 * The board-URL notice: one GET once the board refused the visit. `none` = nothing to say (the board is not in Trash, or the person has no say): the page keeps its own refusal.
 * @param {{ api: import("../ports/trash.js").TrashPort, board: string, newKey?: (() => string)|null }} o
 */
export function createNoticeModel({ api, board, newKey = null }) {
  const S = { status: "idle", notice: null, busy: false, message: null };   // idle | loading | ready | none | restored | error
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(S); };
  let key = null;
  return {
    state: S,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async load() {
      S.status = "loading"; emit();
      const r = await api.notice(board);
      if (r.error) { S.status = "none"; emit(); return; }   // any refusal or failure: the page's own message stands
      S.notice = r.notice; S.status = "ready"; emit();
    },
    /** Restore the board (its own Space's, when the board went with it). */
    async restore() {
      const n = S.notice;
      if (!n || S.busy) return false;
      const viaSpace = n.via && n.via.space && n.via.canRestore;
      if (!n.canRestore && !viaSpace) return false;
      S.busy = true; S.message = null; emit();
      try { key ??= newKey ? newKey() : null; } catch { key = null; }
      const r = viaSpace && !n.canRestore ? await api.restoreSpace(n.via.space.id, key) : await api.restore(board, key);
      S.busy = false;
      if (r.error) { S.message = failText(r.error); emit(); return false; }
      key = null; S.status = "restored"; S.message = restoredText(boardName(n.board.title), r.result?.movedTo ?? n.into ?? null); emit();
      return true;
    },
  };
}
