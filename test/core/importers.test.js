// @ts-check
// Tests for Issue #21: Visio (.vsdx / XML), Miro (JSON/CSV), Lucidchart (JSON/CSV)
// importers with explicit unsupported-feature reporting & hostile input safety.

import { describe, test, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  isVisio,
  parseVisio,
  readZipEntries,
  isMiro,
  parseMiro,
  isLucidchart,
  parseLucidchart,
  importExternalDiagram,
} from "../../packages/core/importers.js";
import { opProblem } from "../../packages/protocol/envelope.js";

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

/**
 * Build a minimal valid ZIP archive in memory (supports method 0 stored or method 8 deflate).
 * @param {Array<{ name: string, content: string, deflate?: boolean }>} files
 * @returns {Uint8Array}
 */
function buildTestZip(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const rawBytes = enc.encode(f.content);
    const compBytes = f.deflate ? new Uint8Array(deflateRawSync(rawBytes)) : rawBytes;
    const method = f.deflate ? 8 : 0;

    // Local File Header (30 bytes + name + data)
    const lh = new Uint8Array(30 + nameBytes.length + compBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, compBytes.length, true);
    lv.setUint32(22, rawBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    lh.set(compBytes, 30 + nameBytes.length);
    localParts.push(lh);

    // Central Directory Header (46 bytes + name)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, compBytes.length, true);
    cv.setUint32(24, rawBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length;
  }

  const cdStart = offset;
  const cdSize = cdParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const total = cdStart + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...cdParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

const SAMPLE_VISIO_PAGE_XML = `<?xml version="1.0" encoding="utf-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <PageSheet>
    <Cell N="PageHeight" V="11"/>
    <Section N="Layer">
      <Row IX="0"><Cell N="Name" V="Flowchart"/></Row>
    </Section>
  </PageSheet>
  <Shapes>
    <Shape ID="1" NameU="Process" Type="Shape">
      <Cell N="PinX" V="2"/>
      <Cell N="PinY" V="8"/>
      <Cell N="Width" V="1.5"/>
      <Cell N="Height" V="0.75"/>
      <Cell N="FillForegnd" V="#dae8fc"/>
      <Cell N="LineColor" V="#6c8ebf"/>
      <Cell N="FillPattern" V="25"/>
      <Cell N="ShdwPattern" V="1"/>
      <Text><cp IX="0"/>Ingest Data</Text>
    </Shape>
    <Shape ID="2" NameU="Decision" Type="Shape">
      <Cell N="PinX" V="5"/>
      <Cell N="PinY" V="8"/>
      <Cell N="Width" V="1.4"/>
      <Cell N="Height" V="1.0"/>
      <Cell N="FillForegnd" V="#fff2cc"/>
      <Text>Valid?</Text>
    </Shape>
    <Shape ID="3" NameU="Dynamic connector" Type="Shape">
      <Cell N="BeginX" V="2.75"/>
      <Cell N="BeginY" V="8"/>
      <Cell N="EndX" V="4.3"/>
      <Cell N="EndY" V="8"/>
      <Cell N="EndArrow" V="4"/>
      <Text>check</Text>
    </Shape>
    <Shape ID="4" NameU="EmbeddedImg" Type="Foreign">
      <ForeignData ForeignType="Bitmap">AAAA</ForeignData>
    </Shape>
  </Shapes>
  <Connects>
    <Connect FromSheet="3" FromCell="BeginX" ToSheet="1"/>
    <Connect FromSheet="3" FromCell="EndX" ToSheet="2"/>
  </Connects>
</PageContents>`;

describe("packages/core/importers.js — Visio (.vsdx & XML)", () => {
  test("parses extracted Visio PageContents XML with shapes, bound arrows, and unsupported reporting", () => {
    expect(isVisio(SAMPLE_VISIO_PAGE_XML)).toBe(true);
    const res = parseVisio(SAMPLE_VISIO_PAGE_XML);
    expect(res.ok).toBe(true);
    expect(res.format).toBe("visio");
    assertValidProtocol(res.elements);

    const rects = res.elements.filter(e => e.type === "rectangle");
    const diamonds = res.elements.filter(e => e.type === "diamond");
    const arrows = res.elements.filter(e => e.type === "arrow");
    expect(rects.length).toBe(1);
    expect(diamonds.length).toBe(1);
    expect(arrows.length).toBe(1);

    expect(rects[0].backgroundColor).toBe("#dae8fc");
    expect(arrows[0].startBinding?.elementId).toBe(rects[0].id);
    expect(arrows[0].endBinding?.elementId).toBe(diamonds[0].id);

    const labels = res.elements.filter(e => e.type === "text").map(t => t.text);
    expect(labels).toContain("Ingest Data");
    expect(labels).toContain("Valid?");
    expect(labels).toContain("check");

    // Unsupported features explicitly reported (never silently dropped)
    const feats = res.unsupported.map(u => u.feature);
    expect(feats).toContain("visio:layers");
    expect(feats).toContain("visio:fill-pattern");
    expect(feats).toContain("visio:shadow");
    expect(feats).toContain("visio:foreign-data");
    expect(feats).toContain("visio:foreign-shape");
  });

  test("reads both Stored (method 0) and DEFLATE-compressed (method 8) .vsdx ZIP archives in pure JS", () => {
    const zipStored = buildTestZip([
      { name: "visio/pages/page1.xml", content: SAMPLE_VISIO_PAGE_XML, deflate: false },
      { name: "visio/pages/page2.xml", content: "<PageContents><Shapes/></PageContents>", deflate: false },
      { name: "visio/media/image1.png", content: "PNGDATA", deflate: false },
      { name: "visio/comments.xml", content: "<Comments/>", deflate: false },
    ]);
    expect(isVisio(zipStored)).toBe(true);
    const rStored = importExternalDiagram(zipStored);
    expect(rStored.ok).toBe(true);
    expect(rStored.format).toBe("visio");
    assertValidProtocol(rStored.elements);
    expect(rStored.warnings.length).toBeGreaterThan(0);
    expect(rStored.unsupported.some(u => u.feature === "visio:multi-page" && u.count === 1)).toBe(true);
    expect(rStored.unsupported.some(u => u.feature === "visio:embedded-media")).toBe(true);
    expect(rStored.unsupported.some(u => u.feature === "visio:comments")).toBe(true);

    // Real DEFLATE-compressed .vsdx archive!
    const zipDeflated = buildTestZip([
      { name: "visio/pages/page1.xml", content: SAMPLE_VISIO_PAGE_XML, deflate: true },
    ]);
    const rDeflated = parseVisio(zipDeflated);
    expect(rDeflated.ok).toBe(true);
    assertValidProtocol(rDeflated.elements);
    expect(rDeflated.elements.filter(e => e.type === "rectangle").length).toBe(1);
    expect(rDeflated.elements.filter(e => e.type === "diamond").length).toBe(1);
    expect(rDeflated.elements.filter(e => e.type === "arrow").length).toBe(1);
  });

  test("rejects XXE DOCTYPE/ENTITY in Visio XML and corrupt ZIPs safely", () => {
    const xxe = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><PageContents><Shapes/></PageContents>`;
    const r1 = parseVisio(xxe);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/DOCTYPE|ENTITY/i);

    const badZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(readZipEntries(badZip).ok).toBe(false);
    expect(parseVisio(badZip).ok).toBe(false);
  });
});

describe("packages/core/importers.js — Miro (JSON & CSV)", () => {
  test("parses Miro board JSON with stickies, shapes, text, frames, connectors, and unsupported reporting", () => {
    const miro = {
      comments: [{ id: "c1", text: "Needs review" }],
      layers: [{ id: "l1", name: "Default" }],
      items: [
        {
          id: "f1", type: "frame",
          data: { title: "Sprint Board" },
          position: { x: 250, y: 200 },
          geometry: { width: 500, height: 350 },
        },
        {
          id: "s1", type: "sticky_note",
          data: { content: "<p>Ship <b>v2</b></p>" },
          style: { fillColor: "light_yellow" },
          position: { x: 150, y: 180 },
          geometry: { width: 160, height: 160 },
          parent: { id: "f1" },
        },
        {
          id: "sh1", type: "shape",
          data: { shape: "rhombus", content: "Approved?" },
          style: { fillColor: "#d0ebff", borderColor: "#1971c2", borderStyle: "dashed", shadow: true },
          position: { x: 400, y: 180 },
          geometry: { width: 140, height: 100 },
          parent: { id: "f1" },
        },
        {
          id: "t1", type: "text",
          data: { content: "Q4 Goals" },
          position: { x: 250, y: 40 },
          geometry: { width: 120, height: 30 },
        },
        {
          id: "cn1", type: "connector",
          startItem: { id: "s1" },
          endItem: { id: "sh1" },
          captions: [{ content: "review" }],
          style: { endStrokeCap: "stealth" },
        },
        { id: "emb1", type: "embed", data: { url: "https://figma.com/file/1" } },
        { id: "card1", type: "app_card", data: { title: "JIRA-123" } },
      ],
    };

    expect(isMiro(miro)).toBe(true);
    const res = importExternalDiagram(miro);
    expect(res.ok).toBe(true);
    expect(res.format).toBe("miro-json");
    assertValidProtocol(res.elements);

    const frame = res.elements.find(e => e.type === "frame");
    expect(frame?.name).toBe("Sprint Board");
    const sticky = res.elements.find(e => e.type === "rectangle");
    expect(sticky?.backgroundColor).toBe("#fff3bf");
    expect(sticky?.frameId).toBe(frame.id);
    const diamond = res.elements.find(e => e.type === "diamond");
    expect(diamond?.strokeStyle).toBe("dashed");
    const arrow = res.elements.find(e => e.type === "arrow");
    expect(arrow?.startBinding?.elementId).toBe(sticky.id);
    expect(arrow?.endBinding?.elementId).toBe(diamond.id);
    const labels = res.elements.filter(e => e.type === "text").map(t => t.text);
    expect(labels).toContain("Ship v2");
    expect(labels).toContain("Q4 Goals");
    expect(labels).toContain("review");

    const feats = res.unsupported.map(u => u.feature);
    expect(feats).toContain("miro:embed");
    expect(feats).toContain("miro:app_card");
    expect(feats).toContain("miro:comments");
    expect(feats).toContain("miro:layers");
    expect(feats).toContain("miro:custom-style");
  });

  test("parses Miro CSV sticky export with frames, quoted fields, and unsupported columns", () => {
    const csv = `Sticky,Color,Frame,Comment,Type
"Fix ""login"" bug, asap",light_pink,Bugs,Assigned to Alice,sticky_note
"Add dark mode",light_blue,Ideas,,sticky_note
"Embedded video",gray,Ideas,,embed`;
    expect(isMiro(csv)).toBe(true);
    const res = parseMiro(csv);
    expect(res.ok).toBe(true);
    expect(res.format).toBe("miro-csv");
    assertValidProtocol(res.elements);

    expect(res.elements.filter(e => e.type === "frame").length).toBe(2);
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(2);
    const texts = res.elements.filter(e => e.type === "text").map(t => t.text);
    expect(texts).toContain('Fix "login" bug, asap');
    expect(res.unsupported.some(u => u.feature === "miro-csv:comments")).toBe(true);
    expect(res.unsupported.some(u => u.feature === "miro-csv:embed")).toBe(true);
  });
});

describe("packages/core/importers.js — Lucidchart (JSON & CSV)", () => {
  test("parses Lucidchart JSON with pages, containers, shapes, lines, and unsupported reporting", () => {
    const lucid = {
      pages: [
        {
          id: "p1",
          title: "Architecture",
          layers: [{ id: "layer1", name: "Infra" }],
          comments: [{ id: "cm1", text: "Check SLA" }],
          embeds: [{ id: "em1" }],
          containers: [
            { id: "c1", title: "VPC", boundingBox: { x: 40, y: 40, w: 460, h: 240 } },
          ],
          shapes: [
            { id: "n1", type: "Process", text: "Ingress", containerId: "c1", boundingBox: { x: 70, y: 100, w: 130, h: 60 }, style: { fillColor: "#e7f5ff", gradient: true } },
            { id: "n2", type: "Decision", text: "Auth OK?", containerId: "c1", boundingBox: { x: 280, y: 95, w: 120, h: 70 } },
            { id: "n3", type: "table", text: "Metrics", boundingBox: { x: 600, y: 100, w: 200, h: 120 } },
          ],
          lines: [
            { id: "l1", endpoint1: { connectedTo: "n1" }, endpoint2: { connectedTo: "n2", style: "arrow" }, text: "verify" },
          ],
        },
        { id: "p2", title: "Page 2", shapes: [], lines: [] },
      ],
    };

    expect(isLucidchart(lucid)).toBe(true);
    const res = importExternalDiagram(lucid);
    expect(res.ok).toBe(true);
    expect(res.format).toBe("lucidchart-json");
    assertValidProtocol(res.elements);

    expect(res.elements.filter(e => e.type === "frame").length).toBe(1);
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(1);
    expect(res.elements.filter(e => e.type === "diamond").length).toBe(1);
    expect(res.elements.filter(e => e.type === "arrow").length).toBe(1);

    const feats = res.unsupported.map(u => u.feature);
    expect(feats).toContain("lucidchart:multi-page");
    expect(feats).toContain("lucidchart:layers");
    expect(feats).toContain("lucidchart:comments");
    expect(feats).toContain("lucidchart:embeds");
    expect(feats).toContain("lucidchart:table");
    expect(feats).toContain("lucidchart:custom-style");
  });

  test("parses Lucidchart CSV export with auto-layout, containers, and bound lines", () => {
    const csv = `Id,Name,Shape Library,Page ID,Contained By,Group,Line Source,Line Destination,Source Arrow,Destination Arrow,Status,Text Area 1
1,Document,,1,,,,,,,,My Flow
2,Swimlane,Flowchart,1,,,,,,,,Checkout
3,Terminator,Flowchart,1,2,,,,,,,Start
4,Decision,Flowchart,1,2,,,,,,,In Stock?
5,Line,,1,,,3,4,None,Arrow,,next
6,Comment,,1,,,,,,,,Review copy
7,Process,Flowchart,2,,,,,,,,Other Page Shape`;

    expect(isLucidchart(csv)).toBe(true);
    const res = importExternalDiagram(csv);
    expect(res.ok).toBe(true);
    expect(res.format).toBe("lucidchart-csv");
    assertValidProtocol(res.elements);

    expect(res.elements.filter(e => e.type === "frame").length).toBe(1);
    expect(res.elements.filter(e => e.type === "ellipse").length).toBe(1); // Terminator
    expect(res.elements.filter(e => e.type === "diamond").length).toBe(1); // Decision
    expect(res.elements.filter(e => e.type === "arrow").length).toBe(1);

    expect(res.unsupported.some(u => u.feature === "lucidchart-csv:comment")).toBe(true);
    expect(res.unsupported.some(u => u.feature === "lucidchart-csv:multi-page")).toBe(true);
  });
});

describe("packages/core/importers.js — hostile & malformed input safety", () => {
  test("sanitizes XSS, NaN/Infinity coords, prototype pollution, and invalid payloads without throwing", () => {
    const hostileMiro = JSON.stringify({
      items: [
        {
          id: "x1", type: "sticky_note",
          data: { content: "<script>alert(1)</script><p>Safe text</p>" },
          position: { x: "NaN", y: "Infinity" },
          geometry: { width: -50, height: "Infinity" },
          style: { fillColor: "javascript:evil", __proto__: { polluted: true } },
        },
      ],
    });
    const res = parseMiro(hostileMiro);
    expect(res.ok).toBe(true);
    assertValidProtocol(res.elements);
    const lbl = res.elements.find(e => e.type === "text");
    expect(lbl?.text).toBe("Safe text");
    expect(({})["polluted"]).toBeUndefined();

    expect(importExternalDiagram(null).ok).toBe(false);
    expect(importExternalDiagram("{broken json").ok).toBe(false);
    expect(parseLucidchart("not valid").ok).toBe(false);
  });
});
