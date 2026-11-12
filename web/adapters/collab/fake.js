// A fake collab port (port.js) for tests and web/collab/dev.html: no network, no packages/protocol.
// It plays the room for `records` (a sequencer that applies actions in order, the same way § Records does,
// no-ops and dead targets included), and lets a test or the dev page push presence, `here` and `emotes` in.
// Records sent through it stay pending until `ackAll()` / `ack(n)` (or at once with `autoAck`), so the
// pending overlay can be seen and tested.

import { canWrite, canModerate, RECORDS } from "../../core/collab/limits.js";

const copy = v => JSON.parse(JSON.stringify(v));

/** Apply one accepted records action to snapshot-shaped `threads` (mutates). True if anything changed. */
export function applyRecord(threads, op, by, at, name = null) {
  if (!op || typeof op !== "object") return false;
  const find = id => { for (const t of threads) for (const c of t.comments) if (c.id === id) return { t, c }; return null; };
  const hidden = t => t.comments[0]?.deleted !== undefined;
  const thread = id => threads.find(t => t.id === id);
  if (op.do === "thread") {
    if (find(op.id) || thread(op.id)) return false;
    threads.push({ id: op.id, anchor: copy(op.anchor), by, name, at, comments: [{ id: op.id, by, name, at, text: op.text, reactions: {} }] });
    return true;
  }
  if (op.do === "reply") {
    const t = thread(op.thread);
    if (!t || hidden(t) || find(op.id)) return false;
    t.comments.push({ id: op.id, by, name, at, text: op.text, reactions: {} });
    return true;
  }
  if (op.do === "resolve" || op.do === "reopen" || op.do === "move") {
    const t = thread(op.id);
    if (!t || hidden(t)) return false;
    if (op.do === "move") { t.anchor = copy(op.anchor); return true; }
    if ((op.do === "resolve") === !!t.resolved) return false;
    if (op.do === "resolve") t.resolved = { by, name, at }; else delete t.resolved;
    return true;
  }
  const f = find(op.id);
  if (!f) return false;
  const c = f.c;
  if (op.do === "delete") {
    if (c.deleted !== undefined) return false;
    c.text = ""; c.reactions = {}; c.deleted = at;
    return true;
  }
  if (c.deleted !== undefined || hidden(f.t)) return false;
  if (op.do === "edit") { c.text = op.text; c.edited = at; return true; }
  if (op.do === "react") {
    const users = c.reactions[op.emoji] ?? [], has = users.includes(by);
    if (op.on === has) return false;
    if (op.on) { users.push(by); c.reactions[op.emoji] = users; }
    else { users.splice(users.indexOf(by), 1); if (!users.length) delete c.reactions[op.emoji]; }
    return true;
  }
  return false;
}

/** The room's refusal for an action, or null (role first, then target, then caps; a subset of the room's). */
function refusal(threads, op, by, role) {
  if (!canWrite(role, "records")) return { code: "forbidden", message: `${role} can't write records` };
  const find = id => { for (const t of threads) for (const c of t.comments) if (c.id === id) return { t, c }; return null; };
  const thread = id => threads.find(t => t.id === id);
  if (op.do === "thread" || op.do === "reply") {
    if (find(op.id)) return { code: "bad-op", message: "that record id is in use" };
    if (op.do === "reply" && !thread(op.thread)) return { code: "bad-op", message: "no such thread" };
    if (typeof op.text !== "string" || !op.text.length || op.text.length > RECORDS.text) return { code: "bad-op", message: "text is 1 to 10,000 characters" };
  } else if (op.do === "resolve" || op.do === "reopen") { if (!thread(op.id)) return { code: "bad-op", message: "no such thread" }; }
  else if (op.do === "delete") {
    const f = find(op.id);
    if (!f) return { code: "bad-op", message: "no such comment" };
    if (f.c.by !== by && !canModerate(role)) return { code: "forbidden", message: "that comment is someone else's" };
  } else if (op.do === "react") { if (!find(op.id)) return { code: "bad-op", message: "no such comment" }; }
  else return { code: "bad-op", message: "unknown record action" };
  return null;
}

/**
 * @param {{ role?: string, me?: { user: string, name: string, client: string }, status?: string, now?: () => number,
 *   autoAck?: boolean, threads?: object[], notes?: object[], noteAuthors?: Record<string, string>, elements?: Record<string, object> }} [o]
 */
export function createFakePort(o = {}) {
  const now = o.now ?? (() => Date.now());
  const subs = { status: new Set(), presence: new Set(), leave: new Set(), here: new Set(), emotes: new Set(), records: new Set(), refused: new Set() };
  const on = name => fn => { subs[name].add(fn); return () => subs[name].delete(fn); };
  const fire = (name, ...a) => { for (const fn of [...subs[name]]) fn(...a); };
  let confirmed = copy(o.threads ?? []), pending = [], shown = null;
  const elements = { board: new Map(), notes: new Map() };
  for (const [k, el] of Object.entries(o.elements ?? {})) { const [stream, id] = k.split(":"); elements[stream]?.set(id, el); }
  for (const n of o.notes ?? []) elements.notes.set(n.id, n);
  const noteAuthors = new Map(Object.entries(o.noteAuthors ?? {}));
  const previews = { board: [], notes: [] };

  const port = {
    role: o.role ?? "editor",
    me: o.me ?? { user: "me", name: "You", client: "me-tab" },
    status: o.status ?? "live",
    sent: [],                  // every presence message sent, for tests: { k, ...fields, at }
    log: [],                   // every records op sent: { op }
    onStatus: on("status"), onPresence: on("presence"), onLeave: on("leave"), onHere: on("here"), onEmotes: on("emotes"),
    onRecords: on("records"), onRefused: on("refused"),
    send(k, fields) { port.sent.push({ k, ...copy(fields), at: now() }); },
    previews: stream => previews[stream] ?? [],
    records() {
      if (!shown) {
        const threads = copy(confirmed);
        for (const p of pending) applyRecord(threads, p.op, port.me.user, now(), null);
        shown = { threads, pending: pending.map(p => ({ op: copy(p.op) })) };
      }
      return shown;
    },
    thread: ({ id, anchor, text }) => act({ do: "thread", id, anchor, text }),
    reply: ({ id, thread, text }) => act({ do: "reply", id, thread, text }),
    resolve: ({ id }) => act({ do: "resolve", id }),
    reopen: ({ id }) => act({ do: "reopen", id }),
    react: ({ id, emoji }) => act({ do: "react", id, emoji, on: true }),
    unreact: ({ id, emoji }) => act({ do: "react", id, emoji, on: false }),
    deleteComment: ({ id }) => act({ do: "delete", id }),
    noteAuthor: id => noteAuthors.get(id) ?? null,
    notes: () => [...elements.notes.values()].filter(e => !e.isDeleted),
    element(stream, id) {
      const el = elements[stream]?.get(id);
      return el && !el.isDeleted ? { x: el.x, y: el.y, width: el.width ?? 0, height: el.height ?? 0 } : null;
    },
    jumpTo(p) { port.jumps.push(p); },
    jumps: [],

    // ── controls (not part of the port) ──
    /** The room accepts the oldest `n` pending actions (or refuses them, if they'd be refused). */
    ack(n = 1) {
      for (let i = 0; i < n && pending.length; i++) {
        const p = pending.shift(), r = refusal(confirmed, p.op, port.me.user, port.role);
        if (r) fire("refused", { op: p.op, ...r });
        else applyRecord(confirmed, p.op, port.me.user, now(), port.me.name);
      }
      changed();
    },
    ackAll() { port.ack(pending.length); },
    /** The room refuses the oldest pending action with `code`. */
    refuseNext(code = "forbidden", message = "refused") { const p = pending.shift(); if (p) { fire("refused", { op: p.op, code, message }); changed(); } },
    /** Someone else's action reaches the room. */
    remote(op, by, name, role = "editor") {
      if (refusal(confirmed, op, by, role)) return false;
      applyRecord(confirmed, op, by, now(), name); changed(); return true;
    },
    presence(batch) { fire("presence", batch); },
    leave(user, client) { fire("leave", user, client); },
    here(msg) { fire("here", msg); },
    emotes(msg) { fire("emotes", msg); },
    setStatus(status, role = port.role) { port.status = status; port.role = role; fire("status", status, role); },
    setElement(stream, id, el) { if (el) elements[stream].set(id, el); else elements[stream].delete(id); },
    setNoteAuthor(id, user) { noteAuthors.set(id, user); },
    setPreviews(stream, list) { previews[stream] = list; },
    get pendingCount() { return pending.length; },
  };
  function changed() { shown = null; fire("records"); }
  function act(op) {
    port.log.push({ op: copy(op) });
    pending.push({ op: copy(op) });
    changed();
    if (o.autoAck) port.ack(1);
  }
  return port;
}
