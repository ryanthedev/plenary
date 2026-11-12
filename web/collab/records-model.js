// Comment threads as something to show (PROTOCOL.md § Records). Pure: reads port.records() and an element
// locator, never the DOM or the port's ops.
// - Order: threads in creation order, comments in thread order (the room's `seq` order; this client's pending
//   actions were applied on top, so they come last).
// - Pending: a thread, comment, resolve/reopen, reaction or delete this client sent and the room hasn't
//   acknowledged is marked `pending` (shown dimmed until acked; dropped on refusal).
// - Anchors: `{ point: {x, y} }` stays put. `{ stream, element, x, y }` follows the element: the pin sits at the
//   element's top-right corner while it exists; when it is deleted (or absent) the thread is `detached` and
//   shown at the anchor's own x, y, which the UI sets to that corner when the thread is made.
// - A thread whose first comment is deleted is hidden (§ Records). A deleted reply shows as "Comment deleted".
// - Rights: owner, editor, annotator, commenter write (thread, reply, resolve, reopen, react); deleting is the
//   author's or an owner's or editor's; nobody edits another's comment (and edit isn't built). Viewers read.

import { canWrite, canModerate } from "./limits.js";

/** A fresh record id (≤ 64 chars). `rand` is injectable for tests. */
export function newRecordId(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 14; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)];
  return `c${s}`;
}

/** "now", "3 min", "2 h", "4 d". */
export function ago(at, t) {
  const s = Math.max(0, (t - at) / 1000);
  return s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}

/** Where a new thread on an element goes: its top-right corner. */
export const cornerOf = b => ({ x: b.x + b.width, y: b.y });

/**
 * @param {{ threads: object[], pending?: { op: object }[] }} records port.records()
 * @param {{ me: { user: string, name: string }, role: string, element: (stream: string, id: string) => null | { x: number, y: number, width: number, height: number } }} o
 */
export function recordsView(records, { me, role, element }) {
  const pend = { record: new Set(), thread: new Set(), comment: new Set(), react: new Set() };
  for (const { op } of records?.pending ?? []) {
    if (!op) continue;
    if (op.do === "thread" || op.do === "reply") pend.record.add(op.id);
    else if (op.do === "resolve" || op.do === "reopen") pend.thread.add(op.id);
    else if (op.do === "delete") pend.comment.add(op.id);
    else if (op.do === "react") pend.react.add(`${op.id}\n${op.emoji}`);
  }
  const writer = canWrite(role, "records"), mod = canModerate(role);
  const nameFor = (by, name, pending) => name ?? (by === me.user && pending ? me.name : null) ?? (by === me.user ? me.name : "Someone");
  const threads = [];
  for (const t of records?.threads ?? []) {
    const first = t.comments?.[0];
    if (!first || first.deleted !== undefined) continue;    // hidden
    const a = t.anchor ?? {};
    let at, detached = false, on = null;
    if (a.point) at = { x: a.point.x, y: a.point.y };
    else {
      const b = element(a.stream, a.element);
      on = { stream: a.stream, element: a.element };
      if (b) at = cornerOf(b); else { at = { x: a.x, y: a.y }; detached = true; }
    }
    if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) continue;
    const pending = pend.record.has(t.id);
    const comments = t.comments.map(c => {
      const deleted = c.deleted !== undefined, cp = pend.record.has(c.id);
      const reactions = deleted ? [] : Object.entries(c.reactions ?? {}).map(([emoji, users]) => ({
        emoji, n: users.length, mine: users.includes(me.user), pending: pend.react.has(`${c.id}\n${emoji}`),
      }));
      // A pending un-react leaves no chip behind in the shown state; keep nothing for it.
      return {
        id: c.id, by: c.by, name: nameFor(c.by, c.name, cp), at: c.at, text: deleted ? "" : c.text, deleted,
        edited: c.edited !== undefined, pending: cp || pend.comment.has(c.id), mine: c.by === me.user,
        canDelete: !deleted && (c.by === me.user || mod) && (writer || mod), canReact: writer && !deleted, reactions,
      };
    });
    threads.push({
      id: t.id, by: t.by, name: nameFor(t.by, t.name, pending), at: t.at, x: at.x, y: at.y, detached, on,
      point: !!a.point, resolved: t.resolved ? { by: t.resolved.by, name: nameFor(t.resolved.by, t.resolved.name, pend.thread.has(t.id)), at: t.resolved.at } : null,
      pending, statePending: pend.thread.has(t.id), comments, count: comments.filter(c => !c.deleted).length,
      canReply: writer, canResolve: writer,
    });
  }
  return {
    threads,
    open: threads.filter(t => !t.resolved),
    resolved: threads.filter(t => t.resolved),
    canWrite: writer,
  };
}
