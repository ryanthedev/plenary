// @ts-check
// The collab port (web/ports/collab.js) over the live session (web/core/session.js): core policy, so it lives in core
// (p7-audit C-13). The production adapter (web/adapters/collab/sync.js) only supplies the browser's frame scheduler;
// the fake (web/adapters/collab/fake.js) is the test double. Both pass test/web/contracts/collab-contract.js. It never
// imports packages/protocol: every Replica read goes through the session's `connection` (web/core/sync.js's link
// members, the protocol seam). It never reaches into session.binds.
//
// One tab has ONE link (p8-one-link, C-3): both streams, presence, `here`, `emotes` and records ride it.
//   - me.client = the link's wire client id (hello.client), the id others' batches name me by. Presence from it is
//     this tab's own and is dropped here, never shown as a peer.
//   - status = the link's status (the status pill adds congestion and the browser's online flag; that is the chrome's).
//   - role = the link's welcome.role, or the last one it had while a resync runs (never null once seen), so records
//     ops still queue offline. onStatus fires on a status change and on a role change (a role changes only with a new
//     welcome, which always comes with a status change: connecting, then catching-up or live).
//   - me is ONE stable object whose fields update (me.user = welcome.user once known; rule 13 may change it): mount at
//     any time; readers read me.user live.
//   - `here` without `writers` (count-only, PROTOCOL.md § Presence) keeps the last writer list: onHere always gets the
//     full { writers, writerCount, viewers }.
//   - onRecords is coalesced to at most one call per frame (p7-collabv M4): a busy room's entries cost one
//     records()/render per frame, not one per entry. records() is cached per Replica records revision.
//   - Notes (notes(), noteAuthor, element(...)) come from the same link, which shows my own unacked ops.

import { bounds as geomBounds } from "../../../packages/core/geometry.js";

/**
 * @param {ReturnType<typeof import("../session.js").createSession>} session
 * @param {{ name: string, frame: (fn: () => void) => any, jumpTo?: (p: { x: number, y: number }) => void }} o
 *   name: the signed-in display name (welcome carries none). frame: schedules one call (required: core reads no
 *   browser timer; the adapter passes requestAnimationFrame). jumpTo: optional, centers the view on a world point.
 */
export function collabPort(session, { name, frame, jumpTo = null }) {
  if (typeof frame !== "function") throw new TypeError("collabPort: pass frame (a one-shot scheduler)");
  const C = session.connection;
  const subs = { status: new Set(), presence: new Set(), leave: new Set(), here: new Set(), emotes: new Set(), records: new Set(), refused: new Set() };
  const on = k => fn => { subs[k].add(fn); return () => subs[k].delete(fn); };
  const fire = (k, ...a) => { for (const fn of [...subs[k]]) fn(...a); };
  const mine = c => c === C.client;
  const roleNow = () => C.role ?? C.lastRole ?? null;
  const me = { user: C.user ?? session.roomUser(), name: name || "You", client: C.client };
  let here = { writers: [], writerCount: 0, viewers: 0 };
  let shown = { st: C.status, role: roleNow() };
  let cache = null, scheduled = false;

  const notify = () => {
    if (C.user) me.user = C.user;
    const st = C.status, role = roleNow();
    if (st === shown.st && role === shown.role) return;
    shown = { st, role };
    fire("status", st, role);
  };
  const recordsSoon = () => {
    cache = null;
    if (scheduled) return;
    scheduled = true;
    frame(() => { scheduled = false; fire("records"); });   // after destroy() no one is subscribed: nothing runs
  };

  const offs = [
    session.onStatus(() => notify()),
    session.onRoom((_stream, ev) => {
      if (ev.type === "presence") {
        const batch = ev.batch.filter(m => m && !mine(m.client));
        if (batch.length) fire("presence", batch);
        for (const m of batch) if (m.k === "leave") fire("leave", m.user, m.client);
      } else if (ev.type === "here") {
        const m = ev.msg, writers = Array.isArray(m.writers) ? m.writers : here.writers;
        here = { writers, writerCount: Number.isFinite(m.writerCount) ? m.writerCount : here.writerCount, viewers: Number.isFinite(m.viewers) ? m.viewers : here.viewers };
        fire("here", { writers: [...here.writers], writerCount: here.writerCount, viewers: here.viewers });
      } else if (ev.type === "emotes") fire("emotes", { counts: { ...(ev.msg.counts ?? {}) } });
      else if (ev.type === "records") recordsSoon();
      else if (ev.type === "refused") { cache = null; fire("refused", { op: ev.op, code: ev.code, message: ev.message }); }
    }),
  ];

  const op = o => { C.record(o); };
  const elementBounds = (stream, el) => {
    if (!el) return null;
    const realDoc = C.streamDoc?.(stream);
    const doc = realDoc ?? {
      rev: C.streamRev?.(stream),
      get: id => C.element(stream, id),
      visible: () => (C.elements ? C.elements(stream).filter(e => e && !e.isDeleted) : []),
    };
    const b = geomBounds(el, doc);
    return { x: b.x, y: b.y, width: b.w, height: b.h };
  };
  const port = {
    get role() { return roleNow(); },
    me,
    get status() { return C.status; },
    onStatus: on("status"), onPresence: on("presence"), onLeave: on("leave"), onHere: on("here"), onEmotes: on("emotes"),
    onRecords: on("records"), onRefused: on("refused"),
    send: (k, fields) => C.sendPresence(k, fields),
    previews: stream => C.previewEntries(stream).filter(p => !mine(p.client)),
    records() {
      const rev = C.recordsRev;
      if (!cache || cache.rev !== rev) cache = { rev, data: { threads: C.recordsState().threads, pending: C.pendingRecords() } };
      return cache.data;
    },
    thread: ({ id, anchor, text }) => op({ do: "thread", id, anchor, text }),
    reply: ({ id, thread, text }) => op({ do: "reply", id, thread, text }),
    resolve: ({ id }) => op({ do: "resolve", id }),
    reopen: ({ id }) => op({ do: "reopen", id }),
    react: ({ id, emoji }) => op({ do: "react", id, emoji, on: true }),
    unreact: ({ id, emoji }) => op({ do: "react", id, emoji, on: false }),
    deleteComment: ({ id }) => op({ do: "delete", id }),
    noteAuthor: id => C.noteAuthor(id),
    notes: () => C.elements("notes"),
    element: (stream, id) => elementBounds(stream, C.element(stream, id)),
    /** Release: no more callbacks, including a records frame already queued. mountCollab's destroy() calls it. */
    destroy() { for (const off of offs) off(); for (const k in subs) subs[k].clear(); },
  };
  if (jumpTo) port.jumpTo = jumpTo;
  return port;
}
