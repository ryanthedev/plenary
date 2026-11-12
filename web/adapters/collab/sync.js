// The collab port (web/ports/collab.js) over the live session (web/core/session.js): the second adapter of the port,
// next to the fake (./fake.js); both pass test/web/contracts/collab-contract.js. It never imports packages/protocol:
// every Replica read goes through web/core/sync.js's handle (the protocol seam).
//
// One tab has two connections (one per stream: `board` and `notes`). Decisions (p7-wire, closing p7-collabv M1):
//   - The BOARD connection carries presence (in and out), `here`, `emotes` and records (ops, records(), pending,
//     onRecords, onRefused). One Replica, so records and their pending overlay always agree, and nothing arrives twice.
//   - me.client = the board connection's wire client id (hello.client), the id others' batches name me by.
//   - This tab's notes connection is a peer to the gateway, so its presence (a notes drag's preview) comes back on
//     the board connection: everything from EITHER of my two client ids is dropped here, never shown as a peer.
//   - status = the board connection's status (presence and records live and die with it). The status pill shows the
//     session's merged status (the worse of the two) and congestion; that is the chrome's, not this port's.
//   - role = the board connection's welcome.role, or the last one it had while a resync runs (never null once seen),
//     so records ops still queue offline. onStatus fires on a status change and on a role change (a role changes
//     only with a new welcome, which always comes with a status change: connecting, then catching-up or live).
//   - me is ONE stable object whose fields update (me.user = welcome.user once known; rule 13 may change it): mount
//     at any time; readers read me.user live.
//   - `here` without `writers` (count-only, PROTOCOL.md § Presence) keeps the last writer list: onHere always gets
//     the full { writers, writerCount, viewers }.
//   - onRecords is coalesced to at most one call per animation frame (p7-collabv M4): a busy room's entries cost one
//     records()/render per frame, not one per entry. records() is cached per Replica records revision.
//   - Notes (notes(), noteAuthor, element("notes")) come from the notes connection, which shows my own unacked note
//     ops; element("board") from the board connection.

/**
 * @param {ReturnType<typeof import("../../core/session.js").createSession>} session
 * @param {{ name: string, frame?: (fn: () => void) => any, jumpTo?: (p: { x: number, y: number }) => void }} o
 *   name: the signed-in display name (welcome carries none). frame: schedules one call (default requestAnimationFrame).
 *   jumpTo: optional, centers the view on a world point.
 */
export function syncCollabPort(session, { name, frame = null, jumpTo = null }) {
  const B = session.binds.board, N = session.binds.notes;
  const next = frame ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : fn => setTimeout(fn, 16));
  const subs = { status: new Set(), presence: new Set(), leave: new Set(), here: new Set(), emotes: new Set(), records: new Set(), refused: new Set() };
  const on = k => fn => { subs[k].add(fn); return () => subs[k].delete(fn); };
  const fire = (k, ...a) => { for (const fn of [...subs[k]]) fn(...a); };
  const mine = c => c === B.client || c === N.client;
  const me = { user: B.user ?? session.roomUser(), name: name || "You", client: B.client };
  let here = { writers: [], writerCount: 0, viewers: 0 };
  let shown = { st: B.status, role: B.role ?? B.lastRole ?? null };
  let cache = null, scheduled = false;

  const notify = () => {
    if (B.user) me.user = B.user;
    const st = B.status, role = B.role ?? B.lastRole ?? null;
    if (st === shown.st && role === shown.role) return;
    shown = { st, role };
    fire("status", st, role);
  };
  const recordsSoon = () => {
    cache = null;
    if (scheduled) return;
    scheduled = true;
    next(() => { scheduled = false; fire("records"); });
  };

  const offs = [
    session.onStatus(stream => { if (stream === "board") notify(); }),
    session.onRoom((stream, ev) => {
      if (stream !== "board") return;               // one connection only: the board's (see the header)
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

  const op = o => { B.record(o); };
  const bounds = el => (el ? { x: el.x, y: el.y, width: el.width ?? 0, height: el.height ?? 0 } : null);
  const port = {
    get role() { return B.role ?? B.lastRole ?? null; },
    me,
    get status() { return B.status; },
    onStatus: on("status"), onPresence: on("presence"), onLeave: on("leave"), onHere: on("here"), onEmotes: on("emotes"),
    onRecords: on("records"), onRefused: on("refused"),
    send: (k, fields) => B.sendPresence(k, fields),
    previews: stream => B.previewEntries(stream).filter(p => !mine(p.client)),
    records() {
      const rev = B.recordsRev;
      if (!cache || cache.rev !== rev) cache = { rev, data: { threads: B.recordsState().threads, pending: B.pendingRecords() } };
      return cache.data;
    },
    thread: ({ id, anchor, text }) => op({ do: "thread", id, anchor, text }),
    reply: ({ id, thread, text }) => op({ do: "reply", id, thread, text }),
    resolve: ({ id }) => op({ do: "resolve", id }),
    reopen: ({ id }) => op({ do: "reopen", id }),
    react: ({ id, emoji }) => op({ do: "react", id, emoji, on: true }),
    unreact: ({ id, emoji }) => op({ do: "react", id, emoji, on: false }),
    deleteComment: ({ id }) => op({ do: "delete", id }),
    noteAuthor: id => N.noteAuthor(id) ?? B.noteAuthor(id),
    notes: () => N.elements("notes"),
    element: (stream, id) => bounds((stream === "notes" ? N : B).element(stream, id)),
    destroy() { for (const off of offs) off(); },
  };
  if (jumpTo) port.jumpTo = jumpTo;
  return port;
}
