// What the canvas page does for the collab UI once per animation frame (web/adapters/dom/app.js's loop), kept apart so
// it is tested without a DOM:
//   - my selection goes out as presence whenever it changed, whatever changed it (a click, Escape, select-all, a tool
//     switch, a delete), so peers never keep a ghost selection (the outbox paces it; an unchanged one is not resent);
//   - pins and the open popover are re-placed when the view moved or the board changed (they follow pan, zoom and
//     the elements they anchor to): layout({ board }) says which, so a pan alone never re-resolves anchors.
// Per frame this is O(1) while nothing changed, and never O(selected) (p7-perf C-15): the selection is read only when
// the Editor's version, the Set or its size moved, and then only its first MAX_SELECT_IDS ids (all the outbox ever
// sends: gate.js), compared exactly with what was last sent. A send the outbox refused (not live, or a role that
// sends no selection) is retried when collab's status changes (collab.statusRev), not on every frame.

// Also here, because they are the DOM group's to own (web/ports/clock.js: animation frames belong to the DOM
// adapters): the defaults mountCollab falls back to when its root passes no clock or frame scheduler.

import { MAX_SELECT_IDS } from "../../../core/collab/limits.js";

/**
 * @param {{ active: string, eds: Record<string, { sel: Set<string>, view: { x: number, y: number, scale: number }, version?: number }>, version(): number }} S
 * @param {{ selection(stream: string, ids: string[]): boolean, layout(o?: { board?: boolean }): void, statusRev?: number }} collab
 * @returns {() => void} call once per frame
 */
export function collabFrame(S, collab) {
  let sent = null, seen = null, refused = null, layoutKey = "", boardSeen = null, docSeen = [];
  return function tick() {
    const stream = S.active, ed = S.eds[stream], sel = ed.sel, view = S.eds.board.view;
    // A refused send waits for a status change; a collab without statusRev (older stubs) is retried every frame.
    const retry = refused !== null && (collab.statusRev === undefined || collab.statusRev !== refused);
    if (retry || !seen || seen.stream !== stream || seen.sel !== sel || seen.size !== sel.size || seen.version !== ed.version) {
      seen = { stream, sel, size: sel.size, version: ed.version };
      const ids = headIds(sel, MAX_SELECT_IDS);
      if (retry || !sent || sent.stream !== stream || !sameIds(sent.ids, ids)) {
        if (collab.selection(stream, ids)) { sent = { stream, ids }; refused = null; }
        else { refused = collab.statusRev ?? 0; if (!sent || sent.stream !== stream || !sameIds(sent.ids, ids)) sent = null; }
      }
    }
    // Anchors may have moved when either stream's doc (or its rev) changed: threads anchor to board and notes
    // elements. Without docs (tests), when S.version() did.
    const bd = S.eds.board.doc, nd = S.eds.notes?.doc, k = `${view.x}|${view.y}|${view.scale}|${S.version()}`;
    if (k !== layoutKey) {
      layoutKey = k;
      const board = bd || nd ? `${bd?.rev}|${nd?.rev}` : S.version();
      const moved = board !== boardSeen || bd !== docSeen[0] || nd !== docSeen[1]; boardSeen = board; docSeen = [bd, nd];
      collab.layout({ board: moved });
    }
  };
}

/** The first `n` ids of a selection, in its order: O(n), never the whole Set. */
export function headIds(sel, n) {
  const out = [];
  if (n <= 0) return out;
  for (const id of sel) { out.push(id); if (out.length >= n) break; }
  return out;
}
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The clock the collab UI uses when its root passes none: the browser's, in the clock port's shape
 * ({ now, mono, set, clear, random }; web/ports/clock.js). The root should pass its own (app.js: p7-chrome); this
 * default keeps the page working until it does. Same behaviour as web/adapters/clock/browser.js, which this DOM
 * adapter may not import (adapters never import each other: test/web/architecture.test.js).
 */
export function domClock() {
  const perf = globalThis.performance;
  let last = -Infinity;
  return {
    now: () => Date.now(),
    mono: typeof perf?.now === "function" ? () => perf.now() : () => (last = Math.max(last, Date.now())),
    set: (fn, ms) => setTimeout(fn, Number.isFinite(ms) && ms > 0 ? ms : 0),
    clear: h => { if (h != null) clearTimeout(h); },
    random: () => Math.random(),
  };
}

/** The frame scheduler: requestAnimationFrame, or a 16 ms timer on the given clock where there is none. */
export function domFrame(clock) {
  return typeof requestAnimationFrame === "function" ? fn => requestAnimationFrame(fn) : fn => clock.set(fn, 16);
}
