// @ts-check
// Tests for #21 Safe, Zero-Dependency .drawio / mxGraph XML Importer (packages/core/drawio.js).

import { describe, test, expect } from "bun:test";
import {
  isDrawio,
  parseDrawio,
  chunkDrawioOps,
  MAX_DRAWIO_BYTES,
  MAX_DRAWIO_ELEMENTS,
} from "../../packages/core/drawio.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { DEFAULT_STROKE } from "../../packages/core/model.js";

function assertValidProtocol(elements) {
  expect(Array.isArray(elements)).toBe(true);
  if (elements.length === 0) return;
  const problem = opProblem({
    t: "op",
    stream: "board",
    id: "c1:1",
    sentAt: 0,
    op: { elements },
  });
  expect(problem).toBeNull();
}

describe("packages/core/drawio.js — isDrawio", () => {
  test("detects mxfile, mxGraphModel, and mxCell payloads", () => {
    expect(isDrawio(`<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>`)).toBe(true);
    expect(isDrawio(`<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net"></mxfile>`)).toBe(true);
    expect(isDrawio(`\uFEFF  <mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>`)).toBe(true);
    expect(isDrawio(`<mxCell id="2" value="Hi" vertex="1"/>`)).toBe(true);
  });

  test("rejects non-drawio payloads", () => {
    expect(isDrawio("")).toBe(false);
    expect(isDrawio(null)).toBe(false);
    expect(isDrawio(123)).toBe(false);
    expect(isDrawio(`{"type":"excalidraw","version":2}`)).toBe(false);
    expect(isDrawio(`graph TD\n  A --> B`)).toBe(false);
    expect(isDrawio(`<html><body>hello</body></html>`)).toBe(false);
    expect(isDrawio(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBe(false);
  });
});

describe("packages/core/drawio.js — parsing shapes, wrappers, and edges", () => {
  test("parses full mxfile with shapes, styles, object wrappers, frames, and bound edges with waypoints", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net">
  <diagram id="p1" name="System Architecture">
    <mxGraphModel dx="1000" dy="600" grid="1">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="lane1" value="Backend Zone" style="swimlane;fillColor=#f8f9fa;strokeColor=#495057;strokeWidth=2;" vertex="1" parent="1">
          <mxGeometry x="50" y="40" width="500" height="300" as="geometry"/>
        </mxCell>
        <object id="api" label="&lt;b&gt;API &amp;amp; Auth&lt;/b&gt;&lt;br&gt;v2" link="https://example.com/api">
          <mxCell style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;strokeWidth=3;opacity=85;" vertex="1" parent="lane1">
            <mxGeometry x="30" y="60" width="140" height="70" as="geometry"/>
          </mxCell>
        </object>
        <mxCell id="dec" value="Valid?" style="rhombus;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="lane1">
          <mxGeometry x="260" y="55" width="100" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="db" value="Primary DB" style="ellipse;fillColor=#d5e8d4;strokeColor=#82b366;dashed=1;" vertex="1" parent="1">
          <mxGeometry x="620" y="100" width="120" height="70" as="geometry"/>
        </mxCell>
        <mxCell id="note" value="Read-only replica" style="text;fontSize=14;fontColor=#868e96;" vertex="1" parent="1">
          <mxGeometry x="620" y="200" width="140" height="30" as="geometry"/>
        </mxCell>
        <mxCell id="e1" value="check" style="endArrow=classic;strokeColor=#333333;strokeWidth=2;" edge="1" parent="lane1" source="api" target="dec">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e2" style="endArrow=classic;rounded=1;strokeColor=#0284c7;" edge="1" parent="1" source="dec" target="db">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="500" y="135"/>
              <mxPoint x="560" y="135"/>
            </Array>
          </mxGeometry>
        </mxCell>
        <mxCell id="e2_lbl" value="yes" style="edgeLabel;fontSize=13;fontColor=#0284c7;" vertex="1" connectable="0" parent="e2">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e3" style="endArrow=none;startArrow=none;strokeColor=#adb5bd;" edge="1" parent="1" source="db" target="note">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="680" y="170" as="sourcePoint"/>
            <mxPoint x="680" y="200" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

    const res = parseDrawio(xml, { now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.pageName).toBe("System Architecture");
    expect(res.files).toEqual({});
    expect(res.warnings).toEqual([]);
    assertValidProtocol(res.elements);

    const frames = res.elements.filter(e => e.type === "frame");
    const rects = res.elements.filter(e => e.type === "rectangle");
    const diamonds = res.elements.filter(e => e.type === "diamond");
    const ellipses = res.elements.filter(e => e.type === "ellipse");
    const arrows = res.elements.filter(e => e.type === "arrow");
    const lines = res.elements.filter(e => e.type === "line");
    const standaloneTexts = res.elements.filter(e => e.type === "text" && !e.containerId);
    const boundTexts = res.elements.filter(e => e.type === "text" && e.containerId);

    expect(frames.length).toBe(1);
    expect(frames[0].name).toBe("Backend Zone");
    expect(frames[0].x).toBe(50);
    expect(frames[0].y).toBe(40);

    // Child inside swimlane gets absolute coordinates + frameId
    expect(rects.length).toBe(1);
    expect(rects[0].x).toBe(80);  // 50 + 30
    expect(rects[0].y).toBe(100); // 40 + 60
    expect(rects[0].width).toBe(140);
    expect(rects[0].height).toBe(70);
    expect(rects[0].backgroundColor).toBe("#dae8fc");
    expect(rects[0].strokeColor).toBe("#6c8ebf");
    expect(rects[0].strokeWidth).toBe(3);
    expect(rects[0].opacity).toBe(85);
    expect(rects[0].roundness).toEqual({ type: 3 });
    expect(rects[0].frameId).toBe(frames[0].id);
    expect(rects[0].link).toBe("https://example.com/api");

    // Attached label on API rectangle decoded HTML cleanly
    const apiLabel = boundTexts.find(t => t.containerId === rects[0].id);
    expect(apiLabel).toBeTruthy();
    expect(apiLabel.text).toBe("API & Auth\nv2");
    expect(rects[0].boundElements.some(b => b.id === apiLabel.id && b.type === "text")).toBe(true);

    expect(diamonds.length).toBe(1);
    expect(diamonds[0].x).toBe(310); // 50 + 260
    expect(diamonds[0].y).toBe(95);  // 40 + 55

    expect(ellipses.length).toBe(1);
    expect(ellipses[0].strokeStyle).toBe("dashed");

    expect(standaloneTexts.length).toBe(1);
    expect(standaloneTexts[0].text).toBe("Read-only replica");

    // Bound arrows: settled on perimeters and waypoints preserved
    expect(arrows.length).toBe(2);
    const e1 = arrows.find(a => a.startBinding?.elementId === rects[0].id && a.endBinding?.elementId === diamonds[0].id);
    expect(e1).toBeTruthy();
    expect(e1.points.length).toBe(2);
    // Settled start point should be on or near the right edge of rects[0] (x = 80 + 140 = 220), not center (150)
    expect(e1.x).toBeGreaterThan(215);
    const e1Label = boundTexts.find(t => t.containerId === e1.id);
    expect(e1Label?.text).toBe("check");

    // Edge with 2 waypoints + child edgeLabel
    const e2 = arrows.find(a => a.startBinding?.elementId === diamonds[0].id && a.endBinding?.elementId === ellipses[0].id);
    expect(e2).toBeTruthy();
    expect(e2.points.length).toBe(4); // start + 2 waypoints + end
    expect(e2.roundness).toEqual({ type: 2 });
    const e2Label = boundTexts.find(t => t.containerId === e2.id);
    expect(e2Label?.text).toBe("yes");

    // Line with endArrow=none;startArrow=none
    expect(lines.length).toBe(1);
    expect(lines[0].startArrowhead).toBeNull();
    expect(lines[0].endArrowhead).toBeNull();
  });

  test("parses bare <mxGraphModel> without <mxfile> wrapper", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" value="Solo Box" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="50" as="geometry"/></mxCell>
    </root></mxGraphModel>`;
    const res = parseDrawio(xml);
    expect(res.ok).toBe(true);
    expect(res.pageName).toBeNull();
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(1);
    assertValidProtocol(res.elements);
  });

  test("handles multi-page mxfile with warning and compressed diagram with clear error", () => {
    const multi = `<mxfile>
      <diagram name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="P1" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>
      <diagram name="Page 2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
    </mxfile>`;
    const res = parseDrawio(multi);
    expect(res.ok).toBe(true);
    expect(res.pageName).toBe("Page 1");
    expect(res.warnings.length).toBe(1);
    assertValidProtocol(res.elements);

    const compressed = `<mxfile><diagram name="Compressed">7ZBBTsMwEEX3yV1kJY5T04Q=</diagram></mxfile>`;
    const resComp = parseDrawio(compressed);
    expect(resComp.ok).toBe(false);
    expect(resComp.error).toMatch(/compressed/i);
    expect(resComp.pageName).toBe("Compressed");
  });
});

describe("packages/core/drawio.js — security & sanitization guards", () => {
  test("rejects DOCTYPE and ENTITY declarations (XXE prevention)", () => {
    const xxe1 = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>`;
    const res1 = parseDrawio(xxe1);
    expect(res1.ok).toBe(false);
    expect(res1.error).toMatch(/DOCTYPE|ENTITY/i);

    const xxe2 = `<!entity foo "bar"><mxGraphModel><root/></mxGraphModel>`;
    const res2 = parseDrawio(xxe2);
    expect(res2.ok).toBe(false);
  });

  test("enforces pre-parse byte cap (10 MB)", () => {
    const huge = `<mxGraphModel><root><mxCell id="2" value="${"A".repeat(MAX_DRAWIO_BYTES + 100)}" vertex="1"/></root></mxGraphModel>`;
    const res = parseDrawio(huge);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/maximum size/i);
  });

  test("enforces element cap (5000) with warning", () => {
    const cells = [];
    for (let i = 0; i < MAX_DRAWIO_ELEMENTS + 25; i++) {
      cells.push(`<mxCell id="c${i}" vertex="1" parent="1"><mxGeometry x="${i}" y="0" width="20" height="20" as="geometry"/></mxCell>`);
    }
    const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel>`;
    const res = parseDrawio(xml);
    expect(res.ok).toBe(true);
    expect(res.elements.length).toBe(MAX_DRAWIO_ELEMENTS);
    expect(res.warnings.some(w => w.includes(String(MAX_DRAWIO_ELEMENTS)))).toBe(true);
    // Validate ALL 5,000 capped elements via chunkDrawioOps against Protocol v1.1 opProblem
    const batches = chunkDrawioOps(res.elements);
    expect(batches.length).toBeGreaterThan(1);
    let totalValidated = 0;
    for (const batch of batches) {
      assertValidProtocol(batch);
      totalValidated += batch.length;
    }
    expect(totalValidated).toBe(MAX_DRAWIO_ELEMENTS);
  });

  test("strips HTML/script tags, decodes entities, and sanitizes NaN/Infinity coords, colors, and unsafe links", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <object id="bad1" label="&lt;script&gt;alert(1)&lt;/script&gt;&lt;div&gt;Safe &amp;amp; &amp;lt;Clean&amp;gt; &amp;quot;Text&amp;quot; &amp;#39;ok&amp;#39;&lt;/div&gt;&lt;div&gt;Line 2&lt;/div&gt;" link="javascript:alert(1)">
        <mxCell style="fillColor=url(evil);strokeColor=javascript:x;strokeWidth=NaN;opacity=Infinity;__proto__=polluted;" vertex="1" parent="1">
          <mxGeometry x="NaN" y="Infinity" width="-50" height="Infinity" as="geometry"/>
        </mxCell>
      </object>
    </root></mxGraphModel>`;

    const res = parseDrawio(xml);
    expect(res.ok).toBe(true);
    assertValidProtocol(res.elements);

    const rect = res.elements.find(e => e.type === "rectangle");
    const lbl = res.elements.find(e => e.type === "text");
    expect(rect).toBeTruthy();
    expect(Number.isFinite(rect.x)).toBe(true);
    expect(Number.isFinite(rect.y)).toBe(true);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.backgroundColor).toBe("transparent");
    expect(rect.strokeColor).toBe(DEFAULT_STROKE);
    expect(rect.strokeWidth).toBe(2);
    expect(rect.opacity).toBe(100);
    expect(rect.link).toBeNull();
    expect(lbl.text).toBe(`Safe & <Clean> "Text" 'ok'\nLine 2`);
  });
});
