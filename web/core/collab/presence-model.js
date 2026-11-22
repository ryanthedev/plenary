// @ts-check
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
/** Exponential smoothing time constant (ms): 1 - exp(-dt / tau) turns 50–100 ms server ticks into smooth 60–120 fps motion. */
export const SMOOTH_TAU_MS = 45;
/** Settle threshold (screen px): snap to target and stop requesting rAF once within this distance. */
export const SETTLE_EPSILON = 0.25;
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
 * @param {{ now: () => number, me: { user: string, client: string }, role: string, flags?: { viewersSeePresentersOnly?: boolean },
 *           tauMs?: number, settleEps?: number }} o
 */
export function createPresence({ now, me, role, flags = FLAGS, tauMs = SMOOTH_TAU_MS, settleEps = SETTLE_EPSILON }) {
  const peers = new Map();     // "user\nclient" → { user, client, at, cursor?, cursorTarget?, select?, lasers: [] }
  const previews = new Map();  // "user\nclient\nstream\nid" → { key, entry, target, display }
  let here = { writers: [], writerCount: 0, viewers: 0 }, writerBy = new Map();
  let floaters = [], windows = [], seq = 0;
  let lastStepAt = now(), lastScale = 1;
  const key = (u, c) => `${u}\n${c}`;
  const isMe = (u, c) => u === me.user && c === me.client;
  const cursorDist = p => (p.cursor && p.cursorTarget ? Math.hypot(p.cursorTarget.x - p.cursor.x, p.cursorTarget.y - p.cursor.y) * lastScale : 0);
  const previewDist = pr => Math.max(
    Math.hypot(pr.target.x - pr.display.x, pr.target.y - pr.display.y),
    Math.hypot(pr.target.width - pr.display.width, pr.target.height - pr.display.height),
  ) * lastScale;

  function hasPendingMotion() {
    if (floaters.length > 0) return true;
    for (const p of peers.values()) {
      if (p.lasers.length > 0) return true;
      if (model.shows(p.user) && cursorDist(p) >= settleEps) return true;
    }
    for (const pr of previews.values()) {
      if (model.shows(pr.entry.user) && previewDist(pr) >= settleEps) return true;
    }
    return false;
  }

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
      const wasActive = hasPendingMotion();
      for (const m of Array.isArray(batch) ? batch : []) {
        if (!m || typeof m.user !== "string" || typeof m.client !== "string" || isMe(m.user, m.client)) continue;
        if (m.k === "leave") { model.leave(m.user, m.client); continue; }
        const k = key(m.user, m.client);
        const p = peers.get(k) ?? { user: m.user, client: m.client, at: t, lasers: [] };
        peers.set(k, p); p.at = t;
        if (m.k === "cursor" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
          p.cursorTarget = { x: m.x, y: m.y };
          // First cursor for this peer snaps immediately so it never flies in from (0, 0).
          if (!p.cursor) p.cursor = { x: m.x, y: m.y };
        } else if (m.k === "select" && Array.isArray(m.ids)) p.select = m.ids.length ? { stream: m.stream, ids: m.ids.filter(id => typeof id === "string") } : null;
        else if (m.k === "laser" && Array.isArray(m.pts) && m.pts.length) {
          const pts = m.pts.filter(q => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite));
          if (pts.length) p.lasers.push({ at: t, pts });
        } else if (m.k === "emote" && EMOTES.includes(m.e)) model.float(m.e, m.user);
        else if (m.k === "preview" && Array.isArray(m.elements)) {
          for (const el of m.elements) {
            if (!el || typeof el.id !== "string" || !Number.isFinite(el.x) || !Number.isFinite(el.y)) continue;
            const pk = `${m.user}\n${m.client}\n${m.stream ?? ""}\n${el.id}`;
            const target = { x: el.x, y: el.y, width: Number.isFinite(el.width) ? el.width : 0, height: Number.isFinite(el.height) ? el.height : 0 };
            const cur = previews.get(pk);
            const entry = { el, user: m.user, client: m.client, stream: m.stream ?? "board" };
            if (!cur) previews.set(pk, { key: pk, entry, target, display: { ...target } });
            else { cur.entry = entry; cur.target = target; }
          }
        }
      }
      if (!wasActive && hasPendingMotion()) lastStepAt = t;
    },

    /** Sync live preview targets (e.g. from port.previews) for exponential smoothing. Returns true if the set or any target changed. */
    setPreviews(entries) {
      const t = now();
      const wasActive = hasPendingMotion();
      const keep = new Set();
      let changed = false;
      for (const entry of Array.isArray(entries) ? entries : []) {
        const el = entry?.el;
        if (!el || typeof el.id !== "string" || !Number.isFinite(el.x) || !Number.isFinite(el.y)) continue;
        const pk = `${entry.user ?? ""}\n${entry.client ?? ""}\n${entry.stream ?? ""}\n${el.id}`;
        keep.add(pk);
        const target = { x: el.x, y: el.y, width: Number.isFinite(el.width) ? el.width : 0, height: Number.isFinite(el.height) ? el.height : 0 };
        const cur = previews.get(pk);
        if (!cur) {
          previews.set(pk, { key: pk, entry, target, display: { ...target } });
          changed = true;
        } else {
          if (cur.target.x !== target.x || cur.target.y !== target.y || cur.target.width !== target.width || cur.target.height !== target.height) changed = true;
          cur.entry = entry; cur.target = target;
        }
      }
      for (const pk of [...previews.keys()]) if (!keep.has(pk)) { previews.delete(pk); changed = true; }
      if (!wasActive && hasPendingMotion()) lastStepAt = t;
      return changed;
    },

    leave(user, client) {
      peers.delete(key(user, client));
      const pre = `${user}\n${client}\n`;
      for (const pk of [...previews.keys()]) if (pk.startsWith(pre)) previews.delete(pk);
    },

    /** A floating emote (a writer's, mine or another's). */
    float(e, user) {
      const t = now();
      if (!hasPendingMotion()) lastStepAt = t;
      floaters.push({ id: ++seq, e, user, at: t, lane: seq % 5 });
    },

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

    /**
     * Advance interpolated display state by `dtMs` (or elapsed mono time since last step when omitted) using
     * frame-rate-independent exponential smoothing `1 - Math.exp(-dtMs / tauMs)`. Snaps targets within `settleEps`
     * screen px so the overlay rAF loop stops cleanly when settled.
     * @returns {boolean} true while another animation frame is needed
     */
    step(dtMs, { scale = lastScale } = {}) {
      lastScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const t = now();
      const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : Math.max(0, Math.min(250, t - lastStepAt));
      lastStepAt = t;
      const alpha = dt > 0 && tauMs > 0 ? 1 - Math.exp(-dt / tauMs) : (dt > 0 ? 1 : 0);
      for (const p of peers.values()) {
        if (!p.cursor || !p.cursorTarget) continue;
        if (alpha > 0) {
          p.cursor.x += (p.cursorTarget.x - p.cursor.x) * alpha;
          p.cursor.y += (p.cursorTarget.y - p.cursor.y) * alpha;
        }
        if (cursorDist(p) < settleEps) { p.cursor.x = p.cursorTarget.x; p.cursor.y = p.cursorTarget.y; }
      }
      for (const pr of previews.values()) {
        const d = pr.display, tgt = pr.target;
        if (alpha > 0) {
          d.x += (tgt.x - d.x) * alpha;
          d.y += (tgt.y - d.y) * alpha;
          d.width += (tgt.width - d.width) * alpha;
          d.height += (tgt.height - d.height) * alpha;
        }
        if (previewDist(pr) < settleEps) { d.x = tgt.x; d.y = tgt.y; d.width = tgt.width; d.height = tgt.height; }
      }
      model.prune();
      return hasPendingMotion();
    },

    /** True while any interpolated target has not settled (< settleEps) or any laser/emote particle is active. */
    get needsFrame() {
      model.prune();
      return hasPendingMotion();
    },

    /** Drop the silent, the faded and the old. Returns true if anything expired. */
    prune() {
      const t = now();
      let changed = false;
      for (const [k, p] of peers) {
        if (t - p.at >= PRESENCE_SILENCE_MS) {
          peers.delete(k);
          const pre = `${p.user}\n${p.client}\n`;
          for (const pk of [...previews.keys()]) if (pk.startsWith(pre)) previews.delete(pk);
          changed = true;
          continue;
        }
        const before = p.lasers.length;
        p.lasers = p.lasers.filter(l => t - l.at < LASER_FADE_MS);
        if (p.lasers.length !== before) changed = true;
      }
      const fBefore = floaters.length;
      floaters = floaters.filter(f => t - f.at < FLOAT_MS);
      if (floaters.length !== fBefore) changed = true;
      const wBefore = windows.length;
      windows = windows.filter(w => t - w.at < COUNT_WINDOW_MS);
      if (windows.length !== wBefore) changed = true;
      return changed;
    },

    /** Forget everything others sent (the connection went down: presence is never cached). */
    clear() { peers.clear(); previews.clear(); floaters = []; windows = []; },

    /** What to draw now. */
    view() {
      model.prune();
      const t = now(), cursors = [], selections = [], lasers = [], smoothedPreviews = [];
      for (const p of peers.values()) {
        const name = model.nameOf(p.user) ?? "Someone", color = colorOf(p.user), show = model.shows(p.user);
        if (show && p.cursor) cursors.push({ user: p.user, client: p.client, name, color, x: p.cursor.x, y: p.cursor.y, targetX: p.cursorTarget.x, targetY: p.cursorTarget.y });
        if (show && p.select?.ids.length) selections.push({ user: p.user, client: p.client, name, color, stream: p.select.stream, ids: p.select.ids });
        for (const l of p.lasers) {
          // Points keep their spacing in time: the batch's last point arrived at `l.at`.
          const tLast = l.pts[l.pts.length - 1][2];
          lasers.push({
            user: p.user, name, color,
            pts: l.pts.map(([x, y, pt]) => {
              const age = t - l.at + (tLast - pt);
              return { x, y, age, alpha: Math.max(0, Math.min(1, 1 - age / LASER_FADE_MS)) };
            }),
          });
        }
      }
      for (const pr of previews.values()) {
        if (!model.shows(pr.entry.user)) continue;
        const name = pr.entry.name ?? model.nameOf(pr.entry.user) ?? "Someone";
        const d = pr.display;
        smoothedPreviews.push({ ...pr.entry, name, color: colorOf(pr.entry.user), el: { ...pr.entry.el, x: d.x, y: d.y, width: d.width, height: d.height } });
      }
      const counts = {};
      for (const w of windows) for (const [e, n] of Object.entries(w.counts)) counts[e] = (counts[e] ?? 0) + n;
      const floaterView = floaters.map(f => {
        const age = Math.max(0, t - f.at);
        const progress = Math.max(0, Math.min(1, age / FLOAT_MS));
        const alpha = progress < 0.15 ? progress / 0.15 : Math.max(0, 1 - (progress - 0.15) / 0.85);
        const yOffset = -progress * 110;
        const scale = 0.85 + 0.3 * Math.sin(Math.min(1, progress * 3) * Math.PI * 0.5);
        return { ...f, age, progress, alpha, yOffset, scale };
      });
      return { cursors, selections, previews: smoothedPreviews, lasers, floaters: floaterView, counts, here, needsFrame: hasPendingMotion() };
    },
  };
  return model;
}
