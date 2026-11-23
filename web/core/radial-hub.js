// @ts-check
// Pure Concepts-inspired circular radial hub layout & state math (ZERO browser globals).

export const RADIAL_SWATCHES = Object.freeze([
  "#1e1e1e",
  "#3B48E8",
  "#e03131",
  "#2f9e44",
  "#f08c00",
  "#7048e8",
]);

export const RADIAL_WIDTHS = Object.freeze([
  { id: "thin", label: "S", value: 1 },
  { id: "bold", label: "M", value: 2 },
  { id: "extra", label: "L", value: 4 },
]);

export const RADIAL_SLOTS = Object.freeze([
  { id: "properties", label: "Style", icon: "palette", title: "Toggle floating Style inspector" },
  { id: "layers", label: "Layers", icon: "layers", title: "Open Layers" },
  { id: "views", label: "Views", icon: "frame", title: "Jump to frame or view (⌘J)" },
  { id: "library", label: "Library", icon: "library", title: "Open Library & Icon Packs" },
  { id: "animate", label: "Animate", icon: "play", title: "Switch to Animate mode" },
  { id: "settings", label: "Settings", icon: "settings", title: "Open Settings & Keybindings" },
]);

/**
 * Compute Cartesian (x, y) offsets for `count` items distributed along a circular arc.
 * Angles are in standard screen degrees (0 = right, -90 = up, -180 = left).
 * @param {number} count
 * @param {{ radius?: number, startDeg?: number, endDeg?: number }} [opts]
 * @returns {Array<{ index: number, angleDeg: number, x: number, y: number }>}
 */
export function computeRadialPositions(count, { radius = 92, startDeg = -180, endDeg = -90 } = {}) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const r = Number.isFinite(radius) && radius > 0 ? radius : 92;
  if (n === 1) {
    const mid = (startDeg + endDeg) / 2;
    const rad = (mid * Math.PI) / 180;
    return [{ index: 0, angleDeg: mid, x: Math.round(Math.cos(rad) * r) || 0, y: Math.round(Math.sin(rad) * r) || 0 }];
  }
  const span = endDeg - startDeg;
  const fullCircle = Math.abs(span) >= 360;
  const denom = fullCircle ? n : n - 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const angleDeg = startDeg + (span * i) / denom;
    const rad = (angleDeg * Math.PI) / 180;
    out.push({
      index: i,
      angleDeg,
      x: Math.round(Math.cos(rad) * r) || 0,
      y: Math.round(Math.sin(rad) * r) || 0,
    });
  }
  return out;
}

/**
 * Filter radial slots by user role (viewers only see read-only navigation/settings).
 * @param {string} role
 */
export function radialSlotsForRole(role) {
  if (role === "viewer") {
    return RADIAL_SLOTS.filter(s => s.id === "views" || s.id === "settings");
  }
  if (role === "annotator") {
    return RADIAL_SLOTS.filter(s => s.id === "properties" || s.id === "views" || s.id === "settings");
  }
  return [...RADIAL_SLOTS];
}
