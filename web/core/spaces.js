// The Space page, the Group page and the New board / New space / General access dialogs, as state with no DOM (web/adapters/dom/spaces.js
// renders them; the data comes through web/ports/spaces.js). Copy follows design/orgs/JOURNEY.md §5. The server decides every permission
// (`can.*` in the page); the models only ask, show and refuse nonsense early.

/** @typedef {import("../ports/spaces.js").SpacesPort} SpacesPort */

export const TITLE_MAX = 200, NAME_MAX = 200;
/** The general-access choices the pages offer, in the order shown: [value, label]. null = only people added. */
export const GENERAL_CHOICES = Object.freeze([["viewer", "Everyone can view"], ["commenter", "Everyone can comment"], ["annotator", "Everyone can annotate"], ["editor", "Everyone can edit"], [null, "Only people added"]]);
/** "Everyone in the Unit can view" / "Only people added" for a Space's or Group's `general`. */
export const generalText = g => (GENERAL_CHOICES.find(([v]) => v === (g ?? null)) ?? GENERAL_CHOICES[4])[1];

const ERR = {
  "in-progress": "It is still being created. Give it a moment, then try again.",
  forbidden: "You can't do that here.", notfound: "That is not available to you.", invalid: "The server did not accept that.",
  auth: "You are signed out. Sign in again.", network: "No answer from the server. Try again.", unavailable: "The server could not do that. Try again in a moment.",
};
export const errorText = e => ERR[e] ?? ERR.unavailable;
/** A create that got no clear answer may have been made: say so, and that trying again is safe (the retry carries the same Idempotency-Key). */
const MAYBE = " It may have been created. Trying again unchanged is safe.";
export const createErrorText = e => (e === "unavailable" ? "The server did not answer in time." + MAYBE : e === "network" ? "No answer from the server." + MAYBE : errorText(e));
// One Idempotency-Key per submit, reused by every retry of it (PROTOCOL.md "Idempotent creates"); a changed input starts a new one. The
/** The key of one submit: made on first use, kept for its retries, forgotten on a change or a success. `get` may throw (no random source). */
const keyer = newKey => { let key = null; return { reset() { key = null; }, get() { return newKey ? (key ??= newKey()) : null; } }; };
// maker (`newKey`) comes from the root through the dialogs (core reads no global); with none, a create is sent without a key.

/** Empty-state copy for a Space page (JOURNEY §5). */
export function spaceEmpty(page) {
  if (page.space.personal) return { title: "Only you can see what's here until you share it.", detail: page.can.createBoard ? "Start a board to fill it." : "" };
  return page.can.createBoard ? { title: "No boards yet.", detail: "" } : { title: "No boards yet.", detail: "You can't add boards here; ask an owner to add you as an editor." };
}
export const groupEmpty = (page, name) => ({ title: `No Spaces in ${name} yet.`, detail: page.can.createSpace ? "" : "Group editors can add Spaces here." });

/**
 * A Space or Group page. `kind` "space" | "group".
 * @param {{ api: SpacesPort, kind: "space"|"group", id: string }} o
 */
export function createPageModel({ api, kind, id }) {
  /** @type {{ status: "loading"|"ready"|"error"|"notfound"|"signed-out", error: string|null, page: any, notice: string|null, busy: boolean }} */
  const state = { status: "loading", error: null, page: null, notice: null, busy: false };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  let seq = 0;
  const fail = e => {
    if (e === "auth") { state.status = "signed-out"; state.error = e; }
    else state.notice = errorText(e);
  };

  async function load() {
    const mine = ++seq;
    state.status = state.page ? state.status : "loading"; state.error = null; emit();
    const r = await (kind === "space" ? api.space(id) : api.group(id));
    if (mine !== seq) return;
    if (r.page) { state.page = r.page; state.status = "ready"; }
    else if (r.error === "notfound" || r.error === "forbidden") { state.status = "notfound"; state.page = null; }
    else if (r.error === "auth") { state.status = "signed-out"; state.error = "auth"; }
    else { state.error = r.error; if (!state.page) state.status = "error"; else state.notice = "Could not refresh this page."; }
    emit();
  }

  async function change(run, apply) {
    state.busy = true; state.notice = null; emit();
    const r = await run();
    state.busy = false;
    if (r.error) { fail(r.error); emit(); return false; }
    apply(r);
    emit();
    return true;
  }

  return {
    state, kind, id,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    load,
    /** Group page: the next page of Spaces. */
    async loadMore() {
      if (kind !== "group" || !state.page?.next || state.busy) return;
      state.busy = true; emit();
      const r = await api.group(id, state.page.next);
      state.busy = false;
      if (r.page) state.page = { ...state.page, spaces: [...state.page.spaces, ...r.page.spaces], next: r.page.next };
      else fail(r.error);
      emit();
    },
    /** Rename the page's Space or Group. A blank or too-long name is refused before any request. @returns {Promise<boolean>} */
    async rename(name) {
      const n = String(name ?? "").trim();
      if (!n || n.length > NAME_MAX) { state.notice = n ? `Names are at most ${NAME_MAX} characters.` : "A name can't be empty."; emit(); return false; }
      if (n === (kind === "space" ? state.page.space.name : state.page.group.name)) return true;
      return change(() => (kind === "space" ? api.updateSpace(id, { name: n }) : api.updateGroup(id, { name: n })),
        r => { if (kind === "space") state.page.space.name = r.space.name; else state.page.group.name = r.group.name; });
    },
    /** Change who in the Unit gets access (a role name below owner, or null). @returns {Promise<boolean>} */
    async setGeneral(role) {
      return change(() => (kind === "space" ? api.updateSpace(id, { general: role }) : api.updateGroup(id, { general: role })),
        r => { const g = kind === "space" ? r.space.general : r.group.general; if (kind === "space") state.page.space.general = g; else state.page.group.general = g; });
    },
    /** Rename one board card in place (Space page). @returns {Promise<boolean>} */
    async renameBoard(boardId, title) {
      const t = String(title ?? "").trim();
      if (t.length > TITLE_MAX) { state.notice = `Titles are at most ${TITLE_MAX} characters.`; emit(); return false; }
      const card = state.page?.boards?.find(c => c.id === boardId);
      if (!card) return false;
      if (t === card.title) return true;
      return change(() => api.renameBoard(boardId, t), r => { card.title = r.board.title; });
    },
    notify(text) { state.notice = text; emit(); },
    dismissNotice() { state.notice = null; emit(); },
  };
}

/**
 * The New board dialog: a title and a location (only Spaces where the person can create; their personal space first and the default).
 * @param {{ api: SpacesPort, space?: string|null, newKey?: () => string }} o   `newKey`: the Idempotency-Key maker (one per submit, reused on retry); `space`: the Space to preselect (when opened from a Space page)
 */
export function createNewBoardModel({ api, space = null, newKey = null }) {
  const kk = keyer(newKey);
  /** The submit's key made BEFORE the dialog goes busy; `undefined` (with the error shown) when none can be made. */
  const keyFor = () => { try { return kk.get(); } catch { state.error = "Could not start that. Reload the page and try again."; emit(); return undefined; } };
  const state = { status: "loading", spaces: [], more: false, title: "", space: null, busy: false, error: null, created: null };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  return {
    state,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async load() {
      const r = await api.boardSpaces();
      if (r.error) { state.status = "error"; state.error = errorText(r.error); }
      else { state.spaces = r.spaces; state.more = r.more; state.status = "ready"; state.space = r.spaces.some(s => s.id === space) ? space : (r.spaces[0]?.id ?? null); }
      emit();
    },
    setTitle(t) { kk.reset(); state.title = String(t ?? ""); state.error = null; emit(); },
    choose(id) { if (state.spaces.some(s => s.id === id)) { kk.reset(); state.space = id; emit(); } },
    /** Hint under the list: what the new board will inherit. */
    hint() {
      const s = state.spaces.find(x => x.id === state.space);
      if (!s) return "";
      return s.personal ? "Only you will see it until you share it." : "It gets the Space's access; you'll be its owner.";
    },
    /** @returns {Promise<boolean>} true once created (`state.created = { id }`) */
    async submit() {
      if (state.busy || state.status !== "ready" || !state.space) return false;
      const title = state.title.trim();
      if (title.length > TITLE_MAX) { state.error = `Titles are at most ${TITLE_MAX} characters.`; emit(); return false; }
      const k = keyFor(); if (k === undefined) return false;
      const s = state.spaces.find(x => x.id === state.space);
      state.busy = true; state.error = null; emit();
      let r;
      try { r = await api.createBoard({ title, ...(s.personal ? {} : { space: s.id }), ...(k ? { key: k } : {}) }); } finally { state.busy = false; }
      if (r.error) state.error = createErrorText(r.error); else { state.created = r.board; kk.reset(); }
      emit();
      return !r.error;
    },
  };
}

/**
 * The New group dialog (a Unit-level permission, decided by the server: Home only offers it when `can.createGroup`): a name and general access.
 * @param {{ api: SpacesPort }} o
 */
export function createNewGroupModel({ api, newKey = null }) {
  const kk = keyer(newKey);
  /** The submit's key made BEFORE the dialog goes busy; `undefined` (with the error shown) when none can be made. */
  const keyFor = () => { try { return kk.get(); } catch { state.error = "Could not start that. Reload the page and try again."; emit(); return undefined; } };
  const state = { name: "", general: null, busy: false, error: null, created: null };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  return {
    state,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    setName(n) { kk.reset(); state.name = String(n ?? ""); state.error = null; emit(); },
    setGeneral(g) { kk.reset(); state.general = g === "none" || g == null ? null : g; emit(); },
    async submit() {
      if (state.busy) return false;
      const name = state.name.trim();
      if (!name) { state.error = "Give the Group a name."; emit(); return false; }
      if (name.length > NAME_MAX) { state.error = `Names are at most ${NAME_MAX} characters.`; emit(); return false; }
      const k = keyFor(); if (k === undefined) return false;
      state.busy = true; state.error = null; emit();
      let r;
      try { r = await api.createGroup({ name, general: state.general, ...(k ? { key: k } : {}) }); } finally { state.busy = false; }
      if (r.error) state.error = createErrorText(r.error); else { state.created = r.group; kk.reset(); }
      emit();
      return !r.error;
    },
  };
}

/**
 * The New space dialog: a name, a Group (only where the person is an editor, or none), and general access.
 * @param {{ api: SpacesPort, group?: string|null }} o
 */
export function createNewSpaceModel({ api, group = null, newKey = null }) {
  const kk = keyer(newKey);
  /** The submit's key made BEFORE the dialog goes busy; `undefined` (with the error shown) when none can be made. */
  const keyFor = () => { try { return kk.get(); } catch { state.error = "Could not start that. Reload the page and try again."; emit(); return undefined; } };
  const state = { status: "loading", root: false, groups: [], more: false, name: "", group: null, general: "viewer", busy: false, error: null, created: null };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  return {
    state,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async load() {
      const r = await api.spaceGroups();
      if (r.error) { state.status = "error"; state.error = errorText(r.error); }
      else {
        Object.assign(state, { root: r.root, groups: r.groups, more: r.more, status: "ready" });
        state.group = r.groups.some(g => g.id === group) ? group : (r.root ? null : (r.groups[0]?.id ?? null));
      }
      emit();
    },
    /** Can this person make a Space anywhere at all? */
    canCreate() { return state.root || state.groups.length > 0; },
    setName(n) { kk.reset(); state.name = String(n ?? ""); state.error = null; emit(); },
    setGroup(id) { kk.reset(); state.group = id || null; emit(); },
    setGeneral(g) { kk.reset(); state.general = g === "none" || g == null ? null : g; emit(); },
    async submit() {
      if (state.busy || state.status !== "ready") return false;
      const name = state.name.trim();
      if (!name) { state.error = "Give the Space a name."; emit(); return false; }
      if (name.length > NAME_MAX) { state.error = `Names are at most ${NAME_MAX} characters.`; emit(); return false; }
      if (state.group === null && !state.root) { state.error = "Pick a Group: you can't add Spaces outside one."; emit(); return false; }
      const k = keyFor(); if (k === undefined) return false;
      state.busy = true; state.error = null; emit();
      let r;
      try { r = await api.createSpace({ name, group: state.group, general: state.general, ...(k ? { key: k } : {}) }); } finally { state.busy = false; }
      if (r.error) state.error = createErrorText(r.error); else { state.created = r.space; kk.reset(); }
      emit();
      return !r.error;
    },
  };
}
