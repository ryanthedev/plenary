// Others' presence, as something to draw (PROTOCOL.md § Presence). Pure: the clock is passed in, nothing here
// touches the DOM or the port. Feed it `presence` batches, `leave`, `here` and `emotes`; read `view()`.
// - A (user, client) is dropped on `leave` or after 30 s of silence. My own echo is ignored.
// - Names and roles come from `here` (cursors carry neither). A sender `here` doesn't list (it holds ≤ 50) is
//   "Someone", of unknown role.
// - Viewers see only owners' and editors' cursors, selections and previews while FLAGS.viewersSeePresentersOnly
//   holds; an unknown role counts as not a presenter.
// - Writers' emotes float (they arrive as presence); viewers' emotes are only ever counts (`emotes`).

import { EMOTES, PRESENCE_SILENCE_MS, HERE_MAX_WRITERS } from "./limits.js";
import { FLAGS } from "./flags.js";

export const LASER_FADE_MS = 1200, FLOAT_MS = 2400, COUNT_WINDOW_MS = 10_000;
// Readable with white text on both themes' canvases.
export const PALETTE = ["#c2410c", "#0b7285", "#9c36b5", "#237032", "#1971c2", "#c2255c", "#5f3dc4", "#8f5b00"];
const PRESENTER = ["owner", "editor"];

/** A stable color for a user id. */
export function colorOf(user) {
  let h = 2166136261;
  for (const ch of String(user)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length];
}
/** Up to two initials from a display name ("Dev K." → "DK"). */
export function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = s => [...s.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "";
  return ((first(parts[0] ?? "") + (parts.length > 1 ? first(parts[parts.length - 1]) : "")).toUpperCase()) || "?";
}

/**
 * @param {{ now: () => number, me: { user: string, client: string }, role: string, flags?: object }} o
 */
export function createPresence({ now, me, role, flags = FLAGS }) {
  const peers = new Map();     // "user\nclient" → { user, client, at, cursor?, select?, lasers: [] }
  let here = { writers: [], writerCount: 0, viewers: 0 }, writerBy = new Map();
  let floaters = [], windows = [], seq = 0;
  const key = (u, c) => `${u}\n${c}`;
  const isMe = (u, c) => u === me.user && c === me.client;

  const model = {
    get role() { return role; },
    setRole(r) { role = r; },
    roleOf: user => writerBy.get(user)?.role ?? null,
    nameOf: user => writerBy.get(user)?.name || null,
    /** Should I see this user's cursor, selection and previews? */
    shows(user) {
      if (role !== "viewer" || !flags.viewersSeePresentersOnly) return true;
      return PRESENTER.includes(model.roleOf(user));
    },

    /** One `presence` batch. */
    ingest(batch) {
      const t = now();
      for (const m of Array.isArray(batch) ? batch : []) {
        if (!m || typeof m.user !== "string" || typeof m.client !== "string" || isMe(m.user, m.client)) continue;
        if (m.k === "leave") { model.leave(m.user, m.client); continue; }
        const k = key(m.user, m.client);
        const p = peers.get(k) ?? { user: m.user, client: m.client, at: t, lasers: [] };
        peers.set(k, p); p.at = t;
        if (m.k === "cursor" && Number.isFinite(m.x) && Number.isFinite(m.y)) p.cursor = { x: m.x, y: m.y };
        else if (m.k === "select" && Array.isArray(m.ids)) p.select = m.ids.length ? { stream: m.stream, ids: m.ids.filter(id => typeof id === "string") } : null;
        else if (m.k === "laser" && Array.isArray(m.pts) && m.pts.length) {
          const pts = m.pts.filter(q => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite));
          if (pts.length) p.lasers.push({ at: t, pts });
        } else if (m.k === "emote" && EMOTES.includes(m.e)) model.float(m.e, m.user);
      }
    },
    leave(user, client) { peers.delete(key(user, client)); },
    /** A floating emote (a writer's, mine or another's). */
    float(e, user) { floaters.push({ id: ++seq, e, user, at: now(), lane: seq % 5 }); },
    // A count-only `here` (no `writers` field: PROTOCOL.md § Presence, sent when only a count changed) keeps the last
    // list and names; only an explicit list (even []) replaces them.
    here(msg) {
      const listed = Array.isArray(msg?.writers);
      const writers = listed ? msg.writers.slice(0, HERE_MAX_WRITERS)
        .filter(w => w && typeof w.user === "string").map(w => ({ user: w.user, name: typeof w.name === "string" ? w.name : null, role: w.role })) : here.writers;
      const count = v => (Number.isFinite(Number(v)) && v !== undefined && v !== null ? Math.max(0, Number(v)) : null);
      here = { writers, writerCount: Math.max(count(msg?.writerCount) ?? here.writerCount, writers.length), viewers: count(msg?.viewers) ?? here.viewers };
      writerBy = new Map(writers.map(w => [w.user, w]));
    },
    /** One `emotes` window: viewers' emotes per emoji. */
    emotes(msg) {
      const counts = {};
      for (const e of EMOTES) { const n = Number(msg?.counts?.[e]); if (n > 0) counts[e] = Math.floor(n); }
      windows.push({ at: now(), counts });
    },
    /** Drop the silent, the faded and the old. */
    prune() {
      const t = now();
      for (const [k, p] of peers) {
        if (t - p.at >= PRESENCE_SILENCE_MS) { peers.delete(k); continue; }
        p.lasers = p.lasers.filter(l => t - l.at < LASER_FADE_MS);
      }
      floaters = floaters.filter(f => t - f.at < FLOAT_MS);
      windows = windows.filter(w => t - w.at < COUNT_WINDOW_MS);
    },
    /** Forget everything others sent (the connection went down: presence is never cached). */
    clear() { peers.clear(); floaters = []; windows = []; },

    /** What to draw now. */
    view() {
      model.prune();
      const t = now(), cursors = [], selections = [], lasers = [];
      for (const p of peers.values()) {
        const name = model.nameOf(p.user) ?? "Someone", color = colorOf(p.user), show = model.shows(p.user);
        if (show && p.cursor) cursors.push({ user: p.user, client: p.client, name, color, x: p.cursor.x, y: p.cursor.y });
        if (show && p.select?.ids.length) selections.push({ user: p.user, client: p.client, name, color, stream: p.select.stream, ids: p.select.ids });
        for (const l of p.lasers) {
          // Points keep their spacing in time: the batch's last point arrived at `l.at`.
          const tLast = l.pts[l.pts.length - 1][2];
          lasers.push({ user: p.user, name, color, pts: l.pts.map(([x, y, pt]) => ({ x, y, age: t - l.at + (tLast - pt) })) });
        }
      }
      const counts = {};
      for (const w of windows) for (const [e, n] of Object.entries(w.counts)) counts[e] = (counts[e] ?? 0) + n;
      return { cursors, selections, lasers, floaters: floaters.map(f => ({ ...f, age: t - f.at })), counts, here };
    },
  };
  return model;
}
