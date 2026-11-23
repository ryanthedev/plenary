import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRadialPositions, radialSlotsForRole, RADIAL_SLOTS, RADIAL_SWATCHES } from "../../web/core/radial-hub.js";
import { createRadialHub } from "../../web/adapters/dom/radial-hub.js";
import { installPage, restoreGlobals } from "./stub-page.js";

describe("Concepts-inspired Radial Hub & Zero-Overlap HUD Rail", () => {
  beforeEach(() => { installPage(); });
  afterEach(() => { restoreGlobals(); });

  test("computeRadialPositions distributes slices evenly on an arc with finite coords", () => {
    const pts = computeRadialPositions(6, { radius: 100, startDeg: -180, endDeg: -90 });
    expect(pts.length).toBe(6);
    expect(pts[0]).toEqual({ index: 0, angleDeg: -180, x: -100, y: 0 });
    expect(pts[5]).toEqual({ index: 5, angleDeg: -90, x: 0, y: -100 });
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(computeRadialPositions(0)).toEqual([]);
  });

  test("radialSlotsForRole gates editing slots for viewers and annotators", () => {
    expect(radialSlotsForRole("presenter").length).toBe(RADIAL_SLOTS.length);
    expect(radialSlotsForRole("viewer").map(s => s.id)).toEqual(["views", "settings"]);
    expect(radialSlotsForRole("annotator").map(s => s.id)).toEqual(["properties", "views", "settings"]);
  });

  test("createRadialHub opens wheel, dispatches slot actions, updates quick style, and closes on Escape", () => {
    const picked = [];
    const patches = [];
    let style = { strokeColor: "#3B48E8", strokeWidth: 2 };
    const hub = createRadialHub({
      getRole: () => "presenter",
      getStyle: () => style,
      canEdit: () => true,
      onSelectSlot: id => picked.push(id),
      onStylePatch: patch => { patches.push(patch); style = { ...style, ...patch }; },
    });

    expect(hub.isOpen()).toBe(false);
    const trigger = hub.el.all().find(n => n.attrs?.["data-radial-trigger"] === "1");
    expect(trigger).toBeDefined();

    // Open wheel
    trigger.click();
    expect(hub.isOpen()).toBe(true);
    const slices = hub.el.all().filter(n => n.attrs?.["data-radial-slot"]);
    expect(slices.length).toBe(6);

    // Quick color swatch updates style without closing wheel
    const redSwatch = hub.el.all().find(n => n.attrs?.["data-radial-color"] === RADIAL_SWATCHES[2]);
    expect(redSwatch).toBeDefined();
    redSwatch.click();
    expect(patches).toContainEqual({ strokeColor: RADIAL_SWATCHES[2] });
    expect(hub.isOpen()).toBe(true);

    // Quick stroke width updates style
    const boldW = hub.el.all().find(n => n.attrs?.["data-radial-width"] === "4");
    boldW.click();
    expect(patches).toContainEqual({ strokeWidth: 4 });

    // Clicking a slot invokes handler and closes wheel
    const layersSlice = hub.el.all().find(n => n.attrs?.["data-radial-slot"] === "layers");
    layersSlice.click();
    expect(picked).toEqual(["layers"]);
    expect(hub.isOpen()).toBe(false);

    // Escape closes an open wheel
    hub.open();
    expect(hub.isOpen()).toBe(true);
    document.fire("keydown", { key: "Escape" });
    expect(hub.isOpen()).toBe(false);
    hub.destroy();
  });

  test("CSS uses flex .hud-rail (zero absolute left:50% overlap) and floating overlay #panel", () => {
    const css = readFileSync(join(import.meta.dir, "../../web/style.css"), "utf8");
    expect(css).toContain(".hud-rail");
    expect(css).toContain(".radial-hub-trigger");
    expect(css).toContain(".radial-wheel");
    // Ensure .hud-bc is no longer absolutely pinned at left: 50%
    expect(css).not.toMatch(/\.hud-bc\s*\{[^}]*left:\s*50%/);
  });
});
