// @ts-check
/**
 * @module web/adapters/dom/version-restore
 * Board version-history snapshot parsing and restoration.
 * Extracted from `app.js` so snapshot validation and CRDT-safe monotonic version updates
 * can be verified independently.
 */

import { BASE_LAYER } from "../../../packages/core/model.js";

/**
 * Validate and normalize `snapshot.appState.herdr` (`layers`, `views`, `timeline`, `grid`).
 * Returns `null` if any field is structurally invalid so malformed snapshots never corrupt board state.
 * @param {any} snap
 * @returns {{ layers: Array<{ id: string, name: string, visible: boolean, locked: boolean }>, views: any[], timeline: any, grid: number } | null}
 */
export function parseSnapshotHerdr(snap) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return null;
  const rawApp = snap.appState;
  if (rawApp !== undefined && (!rawApp || typeof rawApp !== "object" || Array.isArray(rawApp))) return null;
  const rawHerdr = rawApp?.herdr;
  if (rawHerdr !== undefined && (!rawHerdr || typeof rawHerdr !== "object" || Array.isArray(rawHerdr))) return null;
  const herdr = rawHerdr ?? {};

  let layers = [{ id: BASE_LAYER, name: "Layer 1", visible: true, locked: false }];
  if (herdr.layers !== undefined) {
    if (!Array.isArray(herdr.layers) || herdr.layers.length === 0) return null;
    const seenIds = new Set();
    const validLayers = [];
    for (const l of herdr.layers) {
      if (!l || typeof l !== "object" || Array.isArray(l) || typeof l.id !== "string" || !l.id.trim() || l.id.length > 64) return null;
      if (seenIds.has(l.id)) continue;
      seenIds.add(l.id);
      validLayers.push({
        id: l.id,
        name: typeof l.name === "string" ? l.name.slice(0, 80) : "",
        visible: l.visible !== false,
        locked: Boolean(l.locked),
      });
    }
    if (!validLayers.length) return null;
    layers = validLayers;
  }

  let views = [];
  if (herdr.views !== undefined) {
    if (!Array.isArray(herdr.views) || herdr.views.some(v => !v || typeof v !== "object" || Array.isArray(v))) return null;
    views = JSON.parse(JSON.stringify(herdr.views));
  }

  let timeline = null;
  if (herdr.timeline !== undefined && herdr.timeline !== null) {
    if (typeof herdr.timeline !== "object" || Array.isArray(herdr.timeline)) return null;
    timeline = JSON.parse(JSON.stringify(herdr.timeline));
  }

  let grid = 0;
  if (herdr.grid !== undefined) {
    if (typeof herdr.grid !== "number" || !Number.isFinite(herdr.grid) || herdr.grid < 0) return null;
    grid = herdr.grid;
  }

  return { layers, views, timeline, grid };
}

/**
 * Restore a saved board version snapshot into the board stream.
 * @param {any} version
 * @param {{ S: any, toast: (text: string, ms?: number) => void, onDirty: () => void }} deps
 * @returns {boolean}
 */
export function restoreVersionSnapshot(version, { S, toast, onDirty }) {
  if (S.role !== "presenter" || !S.may()) return false;
  const snap = version?.snapshot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap) || !Array.isArray(snap.elements)) return false;
  const herdrPatch = parseSnapshotHerdr(snap);
  if (!herdrPatch) return false;
  const restoredById = new Map();
  for (const raw of snap.elements) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.type !== "string" || raw.isDeleted) continue;
    restoredById.set(raw.id, raw);
  }
  const files = snap.files && typeof snap.files === "object" && !Array.isArray(snap.files) && Object.keys(snap.files).length
    ? snap.files
    : undefined;
  let applied = false;
  S.act("board", ed => {
    const ok = Boolean(ed.transact(tx => {
      for (const liveEl of ed.doc.live()) {
        if (!restoredById.has(liveEl.id)) {
          const c = tx.get(liveEl.id);
          if (c) c.isDeleted = true;
        }
      }
      for (const [id, raw] of restoredById) {
        const existing = ed.doc.getAny(id);
        if (existing) {
          const c = tx.get(id);
          if (!c) continue;
          // Why: keep element `version` monotonic (`Math.max`) so LWW reconciliation never drops the restore against peers.
          const maxVer = Math.max(c.version ?? 0, Number.isFinite(raw.version) ? raw.version : 0);
          for (const k of Object.keys(c)) delete c[k];
          Object.assign(c, JSON.parse(JSON.stringify(raw)));
          c.isDeleted = false;
          c.version = maxVer;
        } else {
          const next = JSON.parse(JSON.stringify(raw));
          next.isDeleted = false;
          tx.add(next);
        }
      }
      return true;
    }, files ? { files } : undefined));
    if (ok) {
      applied = true;
    }
  });
  if (!applied) return false;
  S.act("board", ed => {
    ed.setAppState(herdrPatch);
    ed.fixLayer();
    ed.select([]);
  }, { settings: true });
  onDirty();
  toast(`Restored version: ${version.label}`, 2200);
  return true;
}
