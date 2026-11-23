// @ts-check
// Pure contextual visibility and auto-expand state for the top horizontal control ribbon (#panel).
// Zero browser globals — imported by web/adapters/dom/panel.js and web/adapters/dom/app.js.

/** Every property group key rendered in the Properties tab of the top ribbon. */
export const ALL_PROP_KEYS = Object.freeze([
  "strokeColor",
  "backgroundColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "fillStyle",
  "roundness",
  "fontFamily",
  "fontSize",
  "effects",
  "meta",
  "arrow",
  "heads",
  "bends",
]);

const TEXT_PROP_KEYS = Object.freeze([
  "strokeColor",
  "opacity",
  "fontFamily",
  "fontSize",
]);

const ARROW_PROP_KEYS = Object.freeze([
  "strokeColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "arrow",
  "heads",
  "bends",
]);

const SHAPE_PROP_KEYS = Object.freeze([
  "strokeColor",
  "backgroundColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "fillStyle",
  "roundness",
  "fontFamily",
  "fontSize",
  "effects",
  "meta",
]);

const isArrowType = t => t === "arrow" || t === "line";

/**
 * Determine which property groups are visible in the contextual Properties ribbon.
 * @param {{ selectionTypes?: readonly string[], tool?: string, showAll?: boolean }} [opts]
 * @returns {string[]}
 */
export function contextualPropKeys({ selectionTypes = [], tool = "select", showAll = false } = {}) {
  if (showAll) return [...ALL_PROP_KEYS];
  const types = Array.isArray(selectionTypes) ? selectionTypes.filter(Boolean) : [];
  const arrowTool = isArrowType(tool);
  const hasArrow = types.some(isArrowType);
  const onlyArrow = types.length > 0 && types.every(isArrowType);
  const onlyText = types.length > 0 && types.every(t => t === "text");

  if (onlyArrow || (types.length === 0 && arrowTool)) {
    return [...ARROW_PROP_KEYS];
  }
  if (onlyText && !arrowTool) {
    return [...TEXT_PROP_KEYS];
  }
  if (hasArrow || arrowTool) {
    return [...ALL_PROP_KEYS];
  }
  return [...SHAPE_PROP_KEYS];
}

/**
 * Determine whether the top horizontal ribbon should be expanded (showing controls)
 * or collapsed (slim 34px tab strip only).
 * @param {{ selectionCount?: number, pinnedOpen?: boolean, manualCollapsed?: boolean, activeTab?: string }} [opts]
 * @returns {boolean}
 */
export function shouldExpandRibbon({
  selectionCount = 0,
  pinnedOpen = false,
  manualCollapsed = false,
  activeTab = "properties",
} = {}) {
  if (pinnedOpen) return true;
  if (manualCollapsed) return false;
  if (selectionCount > 0) return true;
  if (activeTab && activeTab !== "properties") return true;
  return false;
}
