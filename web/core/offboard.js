// The leaver screen as state with no DOM (web/adapters/dom/offboard.js renders it; the data comes through web/ports/offboard.js). The server decides everything (who may, what the person solely
// owns, the default recipient: PROTOCOL.md § Leaver offboarding); the model words it, keeps one Idempotency-Key per item and per removal (reused by retries), applies the reviewed plan ONE item at a time
// and never hides a failure. Copy follows design/orgs/JOURNEY.md J7.

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MSG = {
  forbidden: "You can't do that. Only a Unit admin, or an owner of the item, can hand it on.", notfound: "This person is not available.", invalid: "The server did not accept that.",
  "bad-recipient": "The new owner must be another member of the Unit who has not been removed.",
  "still-owns": "This person still solely owns something. Reassign it first.", "is-admin": "A Unit admin can't be removed here.",
};
const MAYBE = " It may have worked. Trying again unchanged is safe.";
/** The sentence for a refused or failed call. */
export function failText(error, code) {
  return MSG[code] ?? (error === "unavailable" ? "The server did not answer in time." + MAYBE : error === "network" ? "No answer from the server." + MAYBE : error === "auth" ? "You are signed out. Sign in again to continue." : MSG[error] ?? "That did not work.");
}
/** "Sam's space (14 boards)", "Field notes (1 board)", "Research". */
export function itemLabel(i) {
  const n = i.boards ?? null;
  return `${i.name}${n === null ? "" : ` (${plural(n, "board")}${i.boardsCapped ? " or more" : ""})`}`;
}
/** One line of the review: exactly what moves where. */
export function planLine(i, to) {
  return i.personal ? `${itemLabel(i)} will be owned by ${to.name}, as an archived Space.` : `${itemLabel(i)} will be owned by ${to.name}.`;
}
/** What the removal does, as the confirm step words it. */
export const removeLines = name => [
  `${name} loses everything the Unit gave them: general access, their Space, Group and Team access, and their own grants on boards.`,
  "Boards, their addresses, and guests' access stay. Invites and share links they made stay until they expire.",
  "This can't be undone here.",
];

/**
 * @param {{ api: import("../ports/offboard.js").OffboardPort, newKey?: (() => string)|null }} o
 */
export function createOffboardModel({ api, newKey = null }) {
  const S = {
    status: "pick",            // pick | loading | ready | forbidden | notfound | signed-out | error
    found: [], foundOwner: [], searching: false, member: null, defaults: null, items: [], next: null, blocked: null, canRemove: false,
    known: [],                 // other people the admin searched for: offered in every row's picker
    choice: new Map(),         // item key -> the person chosen for it (absent = the default)
    results: new Map(),        // item key -> { ok, text } after an apply
    confirm: null,             // null | "items" | "remove"
    busy: false, progress: null, notice: null, said: null,
  };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(S); };
  const keys = new Map();
  const keyFor = k => { if (!keys.has(k)) { let v = null; try { v = newKey ? newKey() : null; } catch { v = null; } keys.set(k, v); } return keys.get(k); };
  const ik = i => `${i.type}\n${i.id}`;
  const fail = r => { if (r.error === "auth") S.status = "signed-out"; S.notice = failText(r.error, r.code); S.said = S.notice; };
  const self = {
    state: S,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    itemKey: ik,
    /** The person this item will go to: the admin's choice, else the default. */
    recipientOf(i) { return S.choice.get(ik(i)) ?? S.defaults?.recipient ?? null; },
    /** The items the screen can act on now (the server says which). */
    actionable() { return S.items.filter(i => i.can.reassign); },
    /** Look a person up for the leaver picker. */
    async search(term, into = "found") {
      S.searching = true; emit();
      const r = await api.people(term);
      S.searching = false;
      if (r.error) { fail(r); S[into] = []; } else { S[into] = r.people; S.said = r.people.length ? `${plural(r.people.length, "person")} found.` : "Nobody found."; }
      emit();
    },
    /** Open a person: the first page of what they solely own. */
    async open(user) {
      S.status = "loading"; S.notice = null; S.member = null; S.choice = new Map(); S.results = new Map(); S.items = []; S.confirm = null; S.known = []; emit();
      return self.loadFor(user);
    },
    async loadFor(user) {
      const r = await api.list(user);
      if (r.error) { S.status = r.error === "auth" ? "signed-out" : r.error === "forbidden" ? "forbidden" : r.error === "notfound" ? "notfound" : "error"; S.notice = S.status === "error" ? failText(r.error, r.code) : null; emit(); return false; }
      const p = r.page;
      S.member = p.member; S.defaults = p.defaults; S.items = p.items; S.next = p.next; S.blocked = p.blocked; S.canRemove = p.canRemove; S.status = "ready"; emit();
      return true;
    },
    /** The next page, appended. */
    async more() {
      if (!S.next || S.busy) return;
      const r = await api.list(S.member.id, S.next);
      if (r.error) { fail(r); emit(); return; }
      S.items = [...S.items, ...r.page.items.filter(i => !S.items.some(x => ik(x) === ik(i)))]; S.next = r.page.next; emit();
    },
    /** Offer another person in every row's picker. */
    addKnown(p) { if (p && !S.known.some(x => x.id === p.id) && p.id !== S.defaults?.recipient.id && p.id !== S.member?.id) { S.known = [...S.known, p]; S.said = `${p.name} added as a choice.`; emit(); } },
    choose(item, person) { S.choice.set(ik(item), person); emit(); },
    /** Everyone a row's picker may name: the default, the others found, never the leaver. */
    people() { return [S.defaults.recipient, ...S.known]; },
    openConfirm(kind) { if (S.busy) return false; if (kind === "items" ? !self.actionable().length : !S.canRemove) return false; S.confirm = kind; S.notice = null; emit(); return true; },
    closeConfirm() { if (S.busy) return; S.confirm = null; emit(); },
    /** Apply the reviewed plan, one item at a time; each result is kept and said. A refusal stops nothing else: the rest is still tried. */
    async apply() {
      if (S.busy || S.confirm !== "items") return false;
      const todo = self.actionable();
      S.busy = true; S.notice = null; emit();
      let ok = 0, same = 0, failed = 0;
      for (let n = 0; n < todo.length; n++) {
        const i = todo[n], to = self.recipientOf(i);
        S.progress = `Reassigning ${n + 1} of ${todo.length}: ${i.name}…`; emit();
        const r = await api.reassign(S.member.id, { type: i.type, id: i.id, to: to.id }, keyFor(ik(i) + "\n" + to.id));
        if (r.error) {
          failed++; S.results.set(ik(i), { ok: false, text: failText(r.error, r.code) });
          if (r.error === "auth") { S.status = "signed-out"; break; }
        } else {
          keys.delete(ik(i) + "\n" + to.id);
          if (r.result.done) { ok++; S.results.set(ik(i), { ok: true, text: `Now owned by ${r.result.to.name}${r.result.item.archived ? ", as an archived Space" : ""}.` }); }
          else { same++; S.results.set(ik(i), { ok: true, text: "Nothing changed: it already has another owner." }); }
        }
      }
      S.progress = null; S.confirm = null;
      S.said = `${plural(ok, "item")} reassigned${same ? `, ${same} already handled` : ""}${failed ? `, ${failed} failed` : ""}.`;
      S.busy = false; emit();
      await self.loadFor(S.member.id);
      return failed === 0;
    },
    /** The last step: remove the person (the server refuses while anything is left). */
    async remove() {
      if (S.busy || S.confirm !== "remove") return false;
      S.busy = true; S.notice = null; S.progress = `Removing ${S.member.name}…`; emit();
      const r = await api.remove(S.member.id, keyFor("remove"));
      S.busy = false; S.progress = null;
      if (r.error) { fail(r); S.confirm = null; emit(); if (r.code === "still-owns") await self.loadFor(S.member.id); return false; }
      keys.delete("remove"); S.confirm = null;
      S.said = `${S.member.name} was removed from the Unit.`;
      emit();
      await self.loadFor(S.member.id);
      return true;
    },
    dismissNotice() { S.notice = null; emit(); },
  };
  return self;
}
