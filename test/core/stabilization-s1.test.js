// Stabilization S1 regression tests:
//   H1: Op chunking for large imports/pastes/undos + single-element >1 MB rejection
//   H2: Undo/redo of shape move re-settles bound arrows without clobbering concurrent style edits
//   H3: Mid-drag Cmd+Z / Cmd+Shift+Z cancels active gesture cleanly without corrupting history
//   M4: collabPort.element() passes real Doc (with rev & _elbow cache) so elbow routes hit cache
//   M5: Arbitrary imported rectangles with GitHub/Linear/Jira links are NOT hijacked as rich link cards
//   LOW: excalidraw link scheme sanitization, link-card quote/angle-bracket rejection, blob-http !ok guards
import { describe, test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement, clone } from "../../packages/core/model.js";
import { parseExcalidraw, exportToExcalidraw, MAX_EXCALIDRAW_POINTS_PER_EL } from "../../packages/core/excalidraw.js";
import { parseLinkCardUrl, parseLinkCardFromElement, isLinkCard, buildLinkCard } from "../../packages/core/link-card.js";
import { paintScene } from "../../packages/core/render.js";
import { LIGHT } from "../../packages/core/export.js";
import { MAX_OP_BYTES, opProblem, utf8Bytes } from "../../packages/protocol/envelope.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { bindEditor } from "../../web/core/sync.js";
import { createSession } from "../../web/core/session.js";
import { collabPort } from "../../web/core/collab/port.js";
import { blobRoutes } from "../../server/adapters/driving/blob-http.js";

describe("H1: op chunking and single-element size guard", () => {
  test("insertElements and undo chunk 3,500+ elements into <=512 KB ops that all pass opProblem and sync cleanly", () => {
    const ops = [];
    const ed = new Editor({ onOp: op => ops.push(op) });
    ed.setSize(800, 600);

    // 3,500 rectangles easily exceed 1 MB as a single op (~1.5 MB JSON)
    const batch = Array.from({ length: 3500 }, (_, i) =>
      makeElement("rectangle", {
        id: `bulk-${i}`,
        x: (i % 50) * 30,
        y: Math.floor(i / 50) * 30,
        width: 24,
        height: 20,
      })
    );
    const ids = ed.insertElements(batch);
    expect(ids.length).toBe(3500);
    expect(ed.doc.live().length).toBe(3500);
    expect(ops.length).toBeGreaterThan(1);

    let totalEmitted = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const bytes = utf8Bytes(JSON.stringify({ elements: op.elements }));
      expect(bytes).toBeLessThanOrEqual(512 * 1024);
      expect(bytes).toBeLessThan(MAX_OP_BYTES);
      expect(opProblem({ t: "op", stream: "board", id: `c1:${i + 1}`, sentAt: 0, op: { elements: op.elements } })).toBeNull();
      totalEmitted += op.elements.length;
    }
    expect(totalEmitted).toBe(3500);

    // Single undo step removes all 3,500 elements and ALSO chunks its ops under 512 KB
    ops.length = 0;
    ed.undo();
    expect(ed.doc.live().length).toBe(0);
    expect(ops.length).toBeGreaterThan(1);
    for (let i = 0; i < ops.length; i++) {
      const bytes = utf8Bytes(JSON.stringify({ elements: ops[i].elements }));
      expect(bytes).toBeLessThanOrEqual(512 * 1024);
      expect(bytes).toBeLessThan(MAX_OP_BYTES);
    }
  });

  test("single element exceeding 1 MB is rejected cleanly before committing without mutating doc or undoStack", () => {
    const ops = [];
    const ed = new Editor({ onOp: op => ops.push(op) });
    const huge = makeElement("text", {
      id: "huge-1",
      text: "x".repeat(1_050_000),
      originalText: "x".repeat(1_050_000),
    });

    const ids = ed.insertElements([huge]);
    expect(ids).toEqual([]);
    expect(ed.doc.live().length).toBe(0);
    expect(ed.undoStack.length).toBe(0);
    expect(ops.length).toBe(0);
    expect(ed.flash).toContain("too large");
  });

  test("parseExcalidraw enforces tightened point cap and rejects single elements exceeding wire limit", () => {
    expect(MAX_EXCALIDRAW_POINTS_PER_EL).toBeLessThanOrEqual(20_000);
    const hugeText = parseExcalidraw({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "t1", type: "text", x: 0, y: 0, width: 100, height: 20, text: "a".repeat(1_000_000) }],
    });
    expect(hugeText.ok).toBe(false);
    expect(hugeText.error).toContain("1 MB");
  });

  test("sync.js chunks large bulk ops cleanly over localRoom without too-large refusal or replica reset", () => {
    const net = localRoom({ board: "chunk-board", users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
    const ed = new Editor();
    const handle = bindEditor(ed, { transport: net.join(), token: "t-ada", board: "chunk-board", client: "ada", clock: net.clock });
    while (net.step());
    expect(handle.status).toBe("live");
    const resetsBefore = handle.resets;

    const batch = Array.from({ length: 3200 }, (_, i) =>
      makeElement("rectangle", { id: `r-${i}`, x: (i % 64) * 20, y: Math.floor(i / 64) * 20, width: 16, height: 16 })
    );
    ed.insertElements(batch);
    for (let i = 0; i < 40; i++) {
      while (net.step());
      net.advance(100);
    }
    while (net.step());

    expect(handle.resets).toBe(resetsBefore);
    expect(handle.state().elements.length).toBe(3200);
    expect(handle.diff()).toEqual([]);
    handle.close();
  });
});

describe("H2: undo/redo does not clobber concurrent arrow style edits", () => {
  test("Bob undoing a shape move re-settles bound arrow geometry while preserving Alice's concurrent color/width edit", () => {
    const rectA = makeElement("rectangle", { id: "rect-a", x: 0, y: 0, width: 100, height: 60 });
    const rectB = makeElement("rectangle", { id: "rect-b", x: 300, y: 0, width: 100, height: 60 });
    const arrow = makeElement("arrow", {
      id: "arrow-1",
      x: 100, y: 30,
      points: [[0, 0], [200, 0]],
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
      startBinding: { elementId: "rect-a", focus: 0, gap: 6 },
      endBinding: { elementId: "rect-b", focus: 0, gap: 6 },
    });
    const bob = new Editor({ scene: { elements: [rectA, rectB, arrow] } });

    // Bob moves rect-a down by 120px
    bob.select(["rect-a"]);
    bob.nudge(0, 120);
    expect(bob.doc.get("rect-a").y).toBe(120);
    const arrowAfterMove = bob.doc.get("arrow-1");
    expect(arrowAfterMove.y).toBeGreaterThan(80);

    // Alice concurrently changes arrow-1's color and strokeWidth
    const aliceArrow = clone(bob.doc.get("arrow-1"));
    aliceArrow.strokeColor = "#e03131";
    aliceArrow.strokeWidth = 4;
    aliceArrow.version += 1;
    bob.receive({ elements: [aliceArrow] });
    expect(bob.doc.get("arrow-1").strokeColor).toBe("#e03131");
    expect(bob.doc.get("arrow-1").strokeWidth).toBe(4);

    // Bob undoes his shape move
    bob.undo();
    expect(bob.doc.get("rect-a").y).toBe(0);
    const arrowAfterUndo = bob.doc.get("arrow-1");
    // Geometry snapped back to rect-a at y=0...
    expect(arrowAfterUndo.y).toBeLessThan(60);
    // ...while Alice's style edits are preserved!
    expect(arrowAfterUndo.strokeColor).toBe("#e03131");
    expect(arrowAfterUndo.strokeWidth).toBe(4);

    // Bob redoes his shape move: geometry follows rect-a back down AND Alice's style is STILL preserved!
    bob.redo();
    expect(bob.doc.get("rect-a").y).toBe(120);
    const arrowAfterRedo = bob.doc.get("arrow-1");
    expect(arrowAfterRedo.y).toBeGreaterThan(80);
    expect(arrowAfterRedo.strokeColor).toBe("#e03131");
    expect(arrowAfterRedo.strokeWidth).toBe(4);
  });
});

describe("H3: mid-drag Cmd+Z / Cmd+Shift+Z safety", () => {
  test("Cmd+Z mid-drag cancels the active drag cleanly and preserves undo/redo integrity after pointer release", () => {
    const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 80, height: 60 });
    const ed = new Editor({ scene: { elements: [rect] } });
    ed.view = { x: 0, y: 0, scale: 1 };

    // Step 1: commit a clean move from (100, 100) to (140, 100)
    ed.select(["r1"]);
    ed.nudge(40, 0);
    expect(ed.doc.get("r1").x).toBe(140);
    expect(ed.undoStack.length).toBe(1);

    // Step 2: start dragging r1 to (340, 260), do NOT release
    ed.pointerDown({ x: 160, y: 120 }, { pointerId: 1 });
    ed.pointerMove({ x: 360, y: 280 }, { pointerId: 1 });
    expect(ed.g?.kind).toBe("move");
    expect(ed.doc.get("r1").x).toBe(340);

    // Step 3: press Cmd+Z mid-drag
    expect(ed.key("z", { cmd: true })).toBe(true);
    expect(ed.g).toBeNull();
    // Active drag was cancelled (restored to 140), then undo reverted step 1 back to 100
    expect(ed.doc.get("r1").x).toBe(100);
    expect(ed.doc.get("r1").y).toBe(100);

    // Step 4: continuing to move & releasing the pointer must NOT commit a corrupt half-step
    ed.pointerMove({ x: 400, y: 300 }, { pointerId: 1 });
    ed.pointerUp({ x: 400, y: 300 }, { pointerId: 1 });
    expect(ed.doc.get("r1").x).toBe(100);
    expect(ed.doc.get("r1").y).toBe(100);
    expect(ed.undoStack.length).toBe(0);
    expect(ed.redoStack.length).toBe(1);

    // Step 5: redo cleanly restores (140, 100), NOT the aborted (340, 260)
    ed.redo();
    expect(ed.doc.get("r1").x).toBe(140);
    expect(ed.doc.get("r1").y).toBe(100);
  });

  test("Cmd+Z mid-create on an empty board cancels the creation without leaving a ghost element", () => {
    const ed = new Editor();
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.setTool("rectangle");
    ed.pointerDown({ x: 50, y: 50 }, { pointerId: 1 });
    ed.pointerMove({ x: 150, y: 120 }, { pointerId: 1 });
    expect(ed.g?.kind).toBe("create");
    expect(ed.doc.live().length).toBe(1);

    ed.key("z", { cmd: true });
    expect(ed.g).toBeNull();
    expect(ed.doc.live().length).toBe(0);

    ed.pointerUp({ x: 150, y: 120 }, { pointerId: 1 });
    expect(ed.doc.live().length).toBe(0);
    expect(ed.undoStack.length).toBe(0);
  });
});

describe("M4: collabPort.element() uses real Doc so elbow route cache hits", () => {
  test("repeated element() bounds lookups on an elbow arrow reuse doc._elbow cache and invalidate on doc rev change", () => {
    const net = localRoom({ board: "elbow-board", users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
    const session = createSession({
      join: () => net.join(),
      token: "t-ada",
      board: "elbow-board",
      client: "ada",
      user: "ada",
      clock: net.clock,
    });
    const port = collabPort(session, { name: "Ada", frame: fn => fn() });
    while (net.step());

    const rectA = makeElement("rectangle", { id: "s1", x: 0, y: 0, width: 100, height: 60 });
    const rectB = makeElement("rectangle", { id: "s2", x: 300, y: 200, width: 100, height: 60 });
    const elbow = makeElement("arrow", {
      id: "e1",
      x: 100, y: 30,
      points: [[0, 0], [200, 170]],
      elbowed: true,
      startBinding: { elementId: "s1", focus: 0, gap: 6, side: "right" },
      endBinding: { elementId: "s2", focus: 0, gap: 6, side: "left" },
    });
    session.eds.board.transact(tx => { tx.add(rectA); tx.add(rectB); tx.add(elbow); });
    while (net.step());

    const realDoc = session.connection.streamDoc("board");
    expect(realDoc).not.toBeNull();
    expect(Number.isFinite(realDoc.rev)).toBe(true);

    const b1 = port.element("board", "e1");
    expect(b1).not.toBeNull();
    const cached1 = realDoc._elbow?.get("e1");
    expect(cached1).toBeDefined();
    expect(cached1.key).toStartWith(`${realDoc.rev}|e1|`);

    // Second lookup on the same rev hits the exact same cache entry (object identity preserved)
    const b2 = port.element("board", "e1");
    expect(b2).toEqual(b1);
    expect(realDoc._elbow.get("e1")).toBe(cached1);

    // Moving s2 bumps realDoc.rev, invalidating and refreshing the cache
    session.eds.board.select(["s2"]);
    session.eds.board.nudge(100, 0);
    while (net.step());

    const b3 = port.element("board", "e1");
    expect(b3.width).toBeGreaterThan(b1.width);
    expect(realDoc._elbow.get("e1")).not.toBe(cached1);
    expect(realDoc._elbow.get("e1").key).toStartWith(`${realDoc.rev}|e1|`);

    port.destroy();
    session.connection.close();
  });
});

describe("M5: link-card scoping prevents hijacking imported rectangles", () => {
  test("imported rectangle with GitHub/Jira/Linear link but no customData.linkCard keeps its colors, label, and double-click-to-edit", () => {
    const imported = parseExcalidraw({
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "plain-rect",
          type: "rectangle",
          x: 40, y: 40, width: 220, height: 100,
          backgroundColor: "#ffec99",
          strokeColor: "#1971c2",
          link: "https://github.com/acme/plenary/issues/30",
          boundElements: [{ id: "lbl-1", type: "text" }],
        },
        {
          id: "lbl-1",
          type: "text",
          x: 60, y: 75, width: 180, height: 25,
          text: "Design Box",
          containerId: "plain-rect",
        },
      ],
    });
    expect(imported.ok).toBe(true);
    const rect = imported.elements.find(e => e.id === "plain-rect");
    expect(rect.link).toBe("https://github.com/acme/plenary/issues/30");
    expect(parseLinkCardFromElement(rect)).toBeNull();
    expect(isLinkCard(rect)).toBe(false);

    // Rendering paints it as a regular rectangle with its #ffec99 fill, NOT link-card chrome
    const doc = new Doc({ elements: imported.elements });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    expect(items.some(it => it.t === "path" && it.fill === "#ffec99")).toBe(true);
    expect(items.some(it => it.t === "text" && it.text === "Issue #30")).toBe(false);

    // Double-clicking enters text editing instead of opening the link
    const opened = [];
    const ed = new Editor({ scene: { elements: imported.elements }, onOpenLink: u => opened.push(u) });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.pointerDown({ x: 150, y: 90 }, { clickCount: 2, button: "left" });
    expect(opened).toEqual([]);
    expect(ed.text).not.toBeNull();
  });

  test("Plenary link card with customData.linkCard survives export -> import round-trip", () => {
    const card = buildLinkCard("https://github.com/acme/plenary/pull/30", { x: 10, y: 20 });
    const exported = exportToExcalidraw(new Doc({ elements: [card] }));
    const reimported = parseExcalidraw(exported);
    expect(reimported.ok).toBe(true);
    expect(reimported.elements.length).toBe(1);
    expect(isLinkCard(reimported.elements[0])).toBe(true);
    expect(parseLinkCardFromElement(reimported.elements[0])?.key).toBe("acme/plenary#30");
  });
});

describe("LOW hygiene: link schemes, unsafe URL chars, and blob-http !ok guards", () => {
  test("parseExcalidraw strips non-http/https schemes from raw.link", () => {
    const res = parseExcalidraw({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 50, height: 50, link: "javascript:alert(1)" },
        { id: "r2", type: "rectangle", x: 60, y: 0, width: 50, height: 50, link: "data:text/html,<script>1</script>" },
        { id: "r3", type: "rectangle", x: 120, y: 0, width: 50, height: 50, link: "file:///etc/passwd" },
        { id: "r4", type: "rectangle", x: 180, y: 0, width: 50, height: 50, link: "https://example.com/docs" },
        { id: "r5", type: "rectangle", x: 240, y: 0, width: 50, height: 50, link: "http://example.com/ok" },
      ],
    });
    expect(res.ok).toBe(true);
    const byId = new Map(res.elements.map(e => [e.id, e]));
    expect(byId.get("r1").link).toBeNull();
    expect(byId.get("r2").link).toBeNull();
    expect(byId.get("r3").link).toBeNull();
    expect(byId.get("r4").link).toBe("https://example.com/docs");
    expect(byId.get("r5").link).toBe("http://example.com/ok");
  });

  test("parseLinkCardUrl rejects URLs containing quotes or angle brackets in query/hash", () => {
    expect(parseLinkCardUrl('https://github.com/acme/plenary/issues/30?q="xss"')).toBeNull();
    expect(parseLinkCardUrl("https://github.com/acme/plenary/issues/30?q=<script>")).toBeNull();
    expect(parseLinkCardUrl("https://github.com/acme/plenary/issues/30#<tag>")).toBeNull();
    expect(parseLinkCardUrl('https://linear.app/plenary/issue/ENG-1#"bad"')).toBeNull();
  });

  test("blobRoutes handles { ok: false } responses without a code field defensively", async () => {
    const fakeAccess = /** @type {any} */ ({
      async get() { return { ok: false }; },
      async verify() { return { ok: false }; },
      async put() { return { ok: false }; },
    });
    const routes = blobRoutes({ access: fakeAccess });

    const rGet = await routes.handle(new Request("http://localhost/blobs/tok1", { method: "GET" }), new URL("http://localhost/blobs/tok1"));
    expect(rGet.status).toBe(503);

    const rPutVerify = await routes.handle(new Request("http://localhost/blobs/tok1", { method: "PUT", headers: { "content-length": "3" }, body: "abc" }), new URL("http://localhost/blobs/tok1"));
    expect(rPutVerify.status).toBe(401);

    const fakeAccessPutFail = /** @type {any} */ ({
      async get() { return { ok: false }; },
      async verify() { return { ok: true, tenant: "t1", board: "b1", sha1: "a".repeat(40), user: "u1" }; },
      async put() { return { ok: false }; },
    });
    const routes2 = blobRoutes({ access: fakeAccessPutFail });
    const rPut = await routes2.handle(new Request("http://localhost/blobs/tok2", { method: "PUT", headers: { "content-length": "3" }, body: "abc" }), new URL("http://localhost/blobs/tok2"));
    expect(rPut.status).toBe(503);
  });
});
