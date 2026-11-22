// @ts-check
// What this client may send, and when. Pure (clock and timers injected).
// - mayPresence / recordProblem: the role table and caps, checked before anything reaches the port, so the UI
//   never sends what the role can't (the gateway and room check again; this only spares the round trip).
// - createOutbox: presence pacing. Cursor, select and laser coalesce to the latest and go out on a trailing
//   edge at no more than the § Presence rate (one per 1000/rate ms, so the gateway's bucket never drops one);
//   cursor and select repeat every 10 s while live (§ Presence, "Everything expires"); emotes over the rate
//   are dropped (a held emote would arrive late and mean nothing).

import { PRESENCE, EMOTES, MAX_SELECT_IDS, MAX_LASER_POINTS, PRESENCE_REPEAT_MS, RECORDS, MAX_ID_CHARS, canWrite, canModerate } from "./limits.js";

/** May `role` send presence of `kind` (wire name)? */
export const mayPresence = (role, kind) => Object.hasOwn(PRESENCE, kind) && PRESENCE[kind].roles.includes(role);

const isNum = v => typeof v === "number" && Number.isFinite(v);
const isId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
const textProblem = t => (typeof t !== "string" || !t.trim() ? "write something first"
  : t.length > RECORDS.text ? `a comment holds at most ${RECORDS.text.toLocaleString("en-US")} characters` : null);

/**
 * Would this records action be refused? null = send it. Mirrors the room's checks that the client can know:
 * role (canWrite records; delete = author or owner/editor), shape, text and emoji caps, and the per-thread,
 * per-board and per-comment caps against the state shown. A no-op on a dead target is allowed (the room
 * accepts it too). `state` = port.records().threads.
 * @param {string} role  @param {string} me user id
 * @param {{ do: string, id?: string, anchor?: any, text?: string, thread?: string, emoji?: string, on?: boolean }} op
 * @param {Record<string, any>[]} threads
 * @returns {null | { code: string, message: string }}
 */
export function recordProblem(role, me, op, threads = []) {
  const forbidden = message => ({ code: "forbidden", message }), bad = message => ({ code: "bad-op", message }), limit = message => ({ code: "limit", message });
  if (!canWrite(role, "records")) return forbidden(`a ${role} reads comments but can't write them`);
  if (!op || typeof op !== "object") return bad("no action");
  const thread = id => threads.find(t => t.id === id);
  const comment = id => { for (const t of threads) { const c = t.comments.find(c => c.id === id); if (c) return { t, c }; } return null; };
  const used = id => !!thread(id) || !!comment(id);
  switch (op.do) {
    case "thread": {
      if (!isId(op.id)) return bad("a record id is 1 to 64 characters");
      if (used(op.id)) return bad("that record id is in use");
      const a = op.anchor, okPoint = a?.point && isNum(a.point.x) && isNum(a.point.y);
      const okEl = (a?.stream === "board" || a?.stream === "notes") && isId(a.element) && isNum(a.x) && isNum(a.y);
      if (!okPoint && !okEl) return bad("a thread needs a point or an element anchor");
      if (threads.length >= RECORDS.threads) return limit(`a board holds at most ${RECORDS.threads.toLocaleString("en-US")} threads`);
      const p = textProblem(op.text); return p && (p.startsWith("a comment") ? limit(p) : bad(p));
    }
    case "reply": {
      if (!isId(op.id)) return bad("a record id is 1 to 64 characters");
      if (used(op.id)) return bad("that record id is in use");
      const t = thread(op.thread);
      if (!t) return bad("no such thread");
      if (t.comments.length >= RECORDS.comments) return limit(`a thread holds at most ${RECORDS.comments} comments`);
      const p = textProblem(op.text); return p && (p.startsWith("a comment") ? limit(p) : bad(p));
    }
    case "resolve": case "reopen":
      return thread(op.id) ? null : bad("no such thread");
    case "delete": {
      const f = comment(op.id);
      if (!f) return bad("no such comment");
      return f.c.by === me || canModerate(role) ? null : forbidden("that comment is someone else's");
    }
    case "react": {
      const f = comment(op.id);
      if (!f) return bad("no such comment");
      if (typeof op.emoji !== "string" || !op.emoji || op.emoji.length > RECORDS.emojiChars) return bad(`an emoji is 1 to ${RECORDS.emojiChars} characters`);
      if (typeof op.on !== "boolean") return bad("react says on or off");
      const r = f.c.reactions ?? {};
      if (op.on && !Object.hasOwn(r, op.emoji) && Object.keys(r).length >= RECORDS.emoji) return limit(`a comment holds at most ${RECORDS.emoji} different emoji`);
      return null;
    }
    default: return bad("unknown record action");
  }
}

/**
 * Presence pacing over a port.
 * @param {{ role: string, status: string, send(kind: string, fields: object): void }} port read live each time
 * @param {{ now: () => number, setTimer: (fn: () => void, ms: number) => any, clearTimer: (h: any) => void }} clock
 */
export function createOutbox(port, { now, setTimer, clearTimer }) {
  const gap = k => 1000 / PRESENCE[k].rate;
  const last = {}, timers = {}, latest = {}, sticky = {}, repeats = {};
  let laserPts = [], closed = false;
  const live = () => port.status === "live" && !closed;

  function emit(k, fields) {
    last[k] = now(); port.send(k, fields);
    if (k === "cursor" || k === "select") { sticky[k] = fields; armRepeat(k); }
  }
  // Send `k`'s latest now if its gap has passed, else once, when it has.
  function flush(k) {
    if (timers[k] || latest[k] === undefined) return;
    const wait = (last[k] ?? -Infinity) + gap(k) - now();
    if (wait > 0) { timers[k] = setTimer(() => { timers[k] = null; flush(k); }, wait); return; }
    if (!live() || !mayPresence(port.role, k)) { delete latest[k]; return; }
    const fields = latest[k]; delete latest[k];
    emit(k, fields);
  }
  // The last cursor and selection go out again 10 s after their own last send, so receivers never go 10 s
  // without hearing a still user (§ Presence, "Everything expires").
  function armRepeat(k) {
    if (repeats[k]) clearTimer(repeats[k]);
    repeats[k] = setTimer(() => {
      repeats[k] = null;
      if (live() && sticky[k] && mayPresence(port.role, k)) emit(k, sticky[k]);
    }, PRESENCE_REPEAT_MS);
  }
  const clearAll = () => {
    for (const k in timers) if (timers[k]) { clearTimer(timers[k]); timers[k] = null; }
    for (const k in repeats) if (repeats[k]) { clearTimer(repeats[k]); repeats[k] = null; }
  };

  return {
    /** The pointer moved, in world units. */
    cursor(x, y) {
      if (!isNum(x) || !isNum(y) || !live() || !mayPresence(port.role, "cursor")) return false;
      latest.cursor = { x, y }; flush("cursor"); return true;
    },
    /** What I have selected on a stream (empty = nothing). More than 500 ids: the first 500 are shown. */
    select(stream, ids) {
      if (!live() || !mayPresence(port.role, "select") || (stream !== "board" && stream !== "notes")) return false;
      latest.select = { stream, ids: ids.filter(isId).slice(0, MAX_SELECT_IDS) }; flush("select"); return true;
    },
    /** One laser point at time `t` (ms, the sender's clock). Batched; at most 64 points a batch (the newest). */
    laser(x, y, t = now()) {
      if (!isNum(x) || !isNum(y) || !live() || !mayPresence(port.role, "laser")) return false;
      laserPts.push([x, y, t]);
      if (laserPts.length > MAX_LASER_POINTS) laserPts = laserPts.slice(-MAX_LASER_POINTS);
      if (!timers.laser) {
        const wait = (last.laser ?? -Infinity) + gap("laser") - now();
        const go = () => { timers.laser = null; if (!laserPts.length) return; if (!live() || !mayPresence(port.role, "laser")) { laserPts = []; return; } const pts = laserPts; laserPts = []; emit("laser", { pts }); };
        if (wait > 0) timers.laser = setTimer(go, wait); else go();
      }
      return true;
    },
    /** An emote from the fixed set. False = not sent (role, not live, unknown, or over 4/s). */
    emote(e) {
      if (!EMOTES.includes(e) || !live() || !mayPresence(port.role, "emote")) return false;
      if (now() - (last.emote ?? -Infinity) < gap("emote")) return false;
      emit("emote", { e }); return true;
    },
    /** Stop: no more sends, timers cleared. */
    close() { closed = true; clearAll(); },
    /** The connection went down: drop what was waiting (nothing stale goes out later); keep my last cursor and selection for resume(). */
    reset() { clearAll(); for (const k in latest) delete latest[k]; laserPts = []; },
    /** Live again: send my last cursor and selection, so a still user shows up again after a reconnect. */
    resume() { for (const k of ["cursor", "select"]) if (sticky[k] && latest[k] === undefined) { latest[k] = sticky[k]; flush(k); } },
  };
}
