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

/** A fresh record id (≤ 64 chars). `rand`: the clock port's random (core code never reads Math.random itself). */
export function newRecordId(rand) {
  if (typeof rand !== "function") throw new TypeError("newRecordId: pass a random source (clock.random)");
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
      ...(on ? { home: { x: a.x, y: a.y } } : {}),
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

/**
 * Re-resolve element anchors of a recordsView in place (the board changed, the records didn't): a pin follows its
 * element, or falls back to the anchor's own point when the element is gone. O(element-anchored threads), no
 * allocation for a thread that didn't move. Returns true if any thread moved or (de)tached. A thread whose element
 * is gone and whose own point isn't finite keeps its last place (recordsView would have dropped it).
 */
export function reanchor(rv, element) {
  let moved = false;
  for (const t of rv.threads) {
    if (!t.on) continue;
    const b = element(t.on.stream, t.on.element);
    const x = b ? b.x + b.width : t.home?.x, y = b ? b.y : t.home?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x !== t.x || y !== t.y || t.detached !== !b) { t.x = x; t.y = y; t.detached = !b; moved = true; }
  }
  return moved;
}

/**
 * A user → display name index over the records, first match wins in the same order a scan would find it (each
 * thread, then its comments, in order). Build once per records change; looking a name up is then O(1).
 */
export function nameIndex(records) {
  const names = new Map();
  for (const t of records?.threads ?? []) {
    if (t.name && !names.has(t.by)) names.set(t.by, t.name);
    for (const c of t.comments ?? []) if (c.name && !names.has(c.by)) names.set(c.by, c.name);
  }
  return names;
}

/**
 * Which pins go in the DOM: the threads inside `box` (world coords: the viewport plus a margin), at most `cap` of
 * them as pins; past the cap, the rest are grouped into clusters on a `cell`-sized world grid, each with a count.
 * `keep` (a thread id, e.g. the open one) is always a pin when it is in the box. At most `maxClusters` clusters: the
 * grid coarsens (cell × 2) until they fit. Pure; O(threads) arithmetic per grid tried.
 * @param {{ id: string, x: number, y: number }[]} threads
 * @param {{ box: { x0: number, y0: number, x1: number, y1: number }, cap: number, cell: number, keep?: string | null, maxClusters?: number }} o
 * @returns {{ pins: object[], clusters: { key: string, x: number, y: number, n: number, ids: string[], bounds: { x0: number, y0: number, x1: number, y1: number } }[], inBox: number }}
 */
export function layoutPins(threads, { box, cap, cell, keep = null, maxClusters = Infinity }) {
  const inside = [];
  for (const t of threads) if (t.x >= box.x0 && t.x <= box.x1 && t.y >= box.y0 && t.y <= box.y1) inside.push(t);
  if (inside.length <= cap) return { pins: inside, clusters: [], inBox: inside.length };
  for (let size = cell; ; size *= 2) {
    const out = clusterInto(inside, size, cap, keep);
    if (out.clusters.length <= maxClusters || !(size < 1e12)) return { ...out, inBox: inside.length };
  }
}
function clusterInto(inside, cell, cap, keep) {
  // Over the cap: the open thread stays a pin; the rest cluster by grid cell. Lone threads in a cell stay pins
  // while room remains under the cap; every other cell becomes one cluster at its members' mean position.
  const cells = new Map(), pins = [];
  for (const t of inside) {
    if (t.id === keep) { pins.push(t); continue; }
    const key = `${Math.floor(t.x / cell)},${Math.floor(t.y / cell)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { key, sx: 0, sy: 0, members: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
    c.sx += t.x; c.sy += t.y; c.members.push(t);
    if (t.x < c.x0) c.x0 = t.x; if (t.y < c.y0) c.y0 = t.y; if (t.x > c.x1) c.x1 = t.x; if (t.y > c.y1) c.y1 = t.y;
  }
  const clusters = [];
  for (const c of cells.values()) {
    if (c.members.length === 1 && pins.length < cap) pins.push(c.members[0]);
    else clusters.push({ key: c.key, x: c.sx / c.members.length, y: c.sy / c.members.length, n: c.members.length, ids: c.members.map(t => t.id), bounds: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 } });
  }
  return { pins, clusters };
}

/**
 * Where a cluster click goes: the centre of its members' bounds, at the scale that fits them in `fit` of the
 * viewport (w × h px), at least `minStep` × the current scale (each click zooms in) and at most `maxScale` (the page
 * passes its own zoom limit: 8 in app.js). `list: true` when zooming can't split the cluster: its members share one
 * point (the fit is infinite) or the view is already at `maxScale`. The click then lists them (the drawer) instead.
 */
export function zoomToFit(bounds, { w, h, scale, fit = 0.8, minStep = 2, maxScale = 4 }) {
  const bw = Math.max(0, bounds.x1 - bounds.x0), bh = Math.max(0, bounds.y1 - bounds.y0);
  const fitScale = Math.min(bw ? (w * fit) / bw : Infinity, bh ? (h * fit) / bh : Infinity);
  const target = Math.min(Math.max(fitScale, scale * minStep), Math.max(maxScale, scale));
  const list = fitScale === Infinity || scale >= maxScale;
  return { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2, scale: target, ...(list ? { list: true } : {}) };
}
