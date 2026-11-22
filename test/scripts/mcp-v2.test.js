// Tests for Wave 6D (#7) — Plenary MCP Server v2 & CLI v2.
// Covers:
//   1. Enhanced normalizeElement (layer, anim, startBinding/endBinding, crop).
//   2. H1 Op Chunking (≤512 KB UTF-8 JSON ops, multibyte UTF-8, single-element wire cap rejection, live bulk write).
//   3. H2 baseVersion Optimistic Concurrency Guard (update_elements & delete_elements, atomic conflict rejection).
//   4. All 7 new tools: update_elements, delete_elements, set_animation, manage_layers, add_link_card, list_frames, manage_views.
//   5. CLI v2 argument parsing & execution, MCP v2 schema & JSON-RPC dispatch.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../../server/server.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { memoryBus } from "../../server/bus/memory.js";
import { devAuth } from "../../server/auth/dev.js";
import { authPort } from "../../server/auth/port.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { httpRoutes } from "../../server/auth/http.js";
import { utf8Bytes } from "../../packages/protocol/envelope.js";

import {
  createPlenaryClient,
  normalizeElement,
  chunkElementsForOps,
  validateAnim,
  validateBinding,
  validateCrop,
  MAX_CHUNK_BYTES,
  PlenaryError,
} from "../../scripts/plenary-client.js";
import { parseCliArgs, runCli } from "../../scripts/plenary-cli.js";
import { createMcpHandler, TOOLS, SERVER_INFO } from "../../scripts/plenary-mcp.js";

// ── Unit tests: normalizeElement v2, validators, and H1 op chunking ──────────

describe("plenary-client v2 validators & normalizeElement", () => {
  test("normalizeElement allows layer, anim, startBinding/endBinding, and crop while stripping internal fields", () => {
    const rect = normalizeElement({
      id: "r1",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      layer: "diagram",
      anim: { preset: "fade", start: 200, duration: 500, easing: "ease-out", loop: false },
      crop: { x: 0, y: 0, width: 100, height: 80, naturalWidth: 200, naturalHeight: 160 },
      customData: { evil: true },
      isDeleted: true,
      version: 99,
    });
    expect(rect.customData).toEqual({
      layer: "diagram",
      z: 0,
      anim: { preset: "fade", start: 200, duration: 500, easing: "ease-out", loop: false },
    });
    expect(rect.crop).toEqual({ x: 0, y: 0, width: 100, height: 80, naturalWidth: 200, naturalHeight: 160 });
    expect(rect.isDeleted).toBe(false);
    expect(rect.version).toBe(1);

    const arrow = normalizeElement({
      id: "a1",
      type: "arrow",
      points: [[0, 0], [100, 50]],
      startBinding: { elementId: "r1", focus: 0.25, gap: 8, fixedPoint: [0.5, 1] },
      endBinding: { elementId: "r2", fixedPoint: [0, 0.5], side: "left" },
    });
    expect(arrow.startBinding).toEqual({ elementId: "r1", focus: 0.25, gap: 8, fixedPoint: [0.5, 1] });
    expect(arrow.endBinding).toEqual({ elementId: "r2", focus: 0, gap: 6, fixedPoint: [0, 0.5], side: "left" });
  });

  test("rejects invalid layer, anim, bindings, and crop with bad-request", () => {
    const badSpecs = [
      { type: "rectangle", layer: "" },
      { type: "rectangle", layer: "a".repeat(65) },
      { type: "rectangle", layer: 123 },
      { type: "rectangle", anim: { preset: "not-a-preset", start: 0, duration: 500 } },
      { type: "rectangle", anim: { preset: "fade", start: -10, duration: 500 } },
      { type: "rectangle", anim: { preset: "fade", start: 0, duration: 0 } },
      { type: "rectangle", anim: { preset: "fade", start: 0, duration: 500, easing: "nope" } },
      { type: "rectangle", anim: { preset: "fade", start: 0, duration: 500, loop: "yes" } },
      { type: "arrow", startBinding: { elementId: "" } },
      { type: "arrow", startBinding: { elementId: "r1", gap: -1 } },
      { type: "arrow", endBinding: { elementId: "r1", fixedPoint: [0.5] } },
      { type: "arrow", endBinding: { elementId: "r1", side: "diagonal" } },
      { type: "rectangle", crop: { x: -1, y: 0, width: 10, height: 10 } },
      { type: "rectangle", crop: { x: 0, y: 0, width: 0, height: 10 } },
      { type: "rectangle", crop: { x: 0, y: 0, width: 10, height: 10, naturalWidth: -5 } },
    ];
    for (const spec of badSpecs) {
      expect(() => normalizeElement(spec)).toThrow(PlenaryError);
      try { normalizeElement(spec); } catch (e) { expect(e.code).toBe("bad-request"); }
    }
    expect(validateAnim(null, { allowNull: true })).toBeNull();
    expect(validateBinding(null)).toBeNull();
    expect(validateCrop(null)).toBeNull();
  });
});

describe("H1: chunkElementsForOps (≤512 KB UTF-8 JSON op chunking)", () => {
  test("splits large element batches into chunks strictly ≤ maxBytes (UTF-8 aware)", () => {
    expect(MAX_CHUNK_BYTES).toBe(512 * 1024);
    // Multibyte CJK text: 3 bytes per char in UTF-8
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `el-${i}`,
      type: "text",
      text: "漢".repeat(120), // 360 UTF-8 bytes per element
      version: 1,
      versionNonce: i + 1,
    }));
    const cap = 1500;
    const chunks = chunkElementsForOps(items, cap);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.flat().map(e => e.id)).toEqual(items.map(e => e.id));
    for (const ch of chunks) {
      const bytes = utf8Bytes(JSON.stringify({ elements: ch }));
      expect(bytes).toBeLessThanOrEqual(cap);
    }
  });

  test("cleanly rejects a single element exceeding maxBytes with code 'too-large'", () => {
    const giant = { id: "too-big", type: "text", text: "x".repeat(MAX_CHUNK_BYTES) };
    expect(() => chunkElementsForOps([giant])).toThrow(PlenaryError);
    try {
      chunkElementsForOps([giant]);
    } catch (err) {
      expect(err.code).toBe("too-large");
      expect(err.details.id).toBe("too-big");
      expect(err.details.maxBytes).toBe(MAX_CHUNK_BYTES);
    }
  });
});

// ── Unit tests: CLI v2 & MCP v2 ──────────────────────────────────────────────

describe("CLI v2 argument parsing & dispatch", () => {
  test("parses all 7 new commands (kebab-case and snake_case)", () => {
    const pairs = [
      ["update-elements", "update_elements"],
      ["delete-elements", "delete_elements"],
      ["set-animation", "set_animation"],
      ["manage-layers", "manage_layers"],
      ["add-link-card", "add_link_card"],
      ["list-frames", "list_frames"],
      ["manage-views", "manage_views"],
    ];
    for (const [kebab, snake] of pairs) {
      expect(parseCliArgs([kebab, "--board", "b1"]).command).toBe(snake);
      expect(parseCliArgs([snake, "--board", "b1"]).command).toBe(snake);
    }
  });

  test("runCli dispatches v2 commands cleanly to clientFactory", async () => {
    /** @type {Array<{ fn: string, args: any }>} */
    const calls = [];
    const mockClient = {
      updateElements: async a => { calls.push({ fn: "updateElements", args: a }); return { ok: true }; },
      deleteElements: async a => { calls.push({ fn: "deleteElements", args: a }); return { ok: true }; },
      setAnimation: async a => { calls.push({ fn: "setAnimation", args: a }); return { ok: true }; },
      manageLayers: async a => { calls.push({ fn: "manageLayers", args: a }); return { ok: true }; },
      addLinkCard: async a => { calls.push({ fn: "addLinkCard", args: a }); return { ok: true }; },
      listFrames: async a => { calls.push({ fn: "listFrames", args: a }); return { ok: true }; },
      manageViews: async a => { calls.push({ fn: "manageViews", args: a }); return { ok: true }; },
    };
    const env = { PLENARY_URL: "http://127.0.0.1:1", PLENARY_TOKEN: "tok" };
    const run = argv => runCli(argv, env, { out: () => {}, err: () => {}, clientFactory: () => mockClient });

    expect(await run(["update-elements", "--board", "b1", "--updates", '[{"id":"e1","x":50,"baseVersion":1}]'])).toBe(0);
    expect(await run(["delete-elements", "--board", "b1", "--ids", "e1,e2", "--base-versions", '{"e1":2}'])).toBe(0);
    expect(await run(["set-animation", "--board", "b1", "--ids", "e1", "--preset", "pop", "--start", "100", "--duration", "400", "--loop=false"])).toBe(0);
    expect(await run(["set-animation", "--board", "b1", "--ids", "e1", "--clear"])).toBe(0);
    expect(await run(["manage-layers", "--board", "b1", "--action", "create", "--name", "Overlay", "--visible", "false", "--opacity", "80"])).toBe(0);
    expect(await run(["add-link-card", "--board", "b1", "--link", "https://github.com/org/repo/issues/42", "--x", "10", "--y", "20"])).toBe(0);
    expect(await run(["list-frames", "--board", "b1"])).toBe(0);
    expect(await run(["manage-views", "--board", "b1", "--action", "create", "--name", "Intro", "--frame-id", "f1", "--visible-layers", "base,overlay"])).toBe(0);

    expect(calls).toEqual([
      { fn: "updateElements", args: { board: "b1", updates: [{ id: "e1", x: 50, baseVersion: 1 }], stream: "board" } },
      { fn: "deleteElements", args: { board: "b1", ids: ["e1", "e2"], baseVersions: { e1: 2 }, stream: "board" } },
      { fn: "setAnimation", args: { board: "b1", ids: ["e1"], anim: { preset: "pop", start: 100, duration: 400, loop: false }, stream: "board" } },
      { fn: "setAnimation", args: { board: "b1", ids: ["e1"], anim: null, stream: "board" } },
      { fn: "manageLayers", args: { board: "b1", action: "create", name: "Overlay", visible: false, opacity: 80 } },
      { fn: "addLinkCard", args: { board: "b1", url: "https://github.com/org/repo/issues/42", x: 10, y: 20 } },
      { fn: "listFrames", args: { board: "b1" } },
      { fn: "manageViews", args: { board: "b1", action: "create", name: "Intro", frameId: "f1", visibleLayers: ["base", "overlay"] } },
    ]);
  });
});

describe("MCP v2 handler", () => {
  test("exposes 16 tools with version 0.2.0 and preserves structured version-conflict details", async () => {
    expect(SERVER_INFO.version).toBe("0.2.0");
    expect(TOOLS.length).toBe(16);

    const handle = createMcpHandler({
      clientFactory: () => ({
        updateElements: async () => {
          throw new PlenaryError("version conflict on element r1 (expected 1, actual 2)", {
            code: "version-conflict",
            details: { conflicts: [{ id: "r1", expectedVersion: 1, actualVersion: 2 }] },
          });
        },
      }),
    });

    const resp = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "update_elements", arguments: { board: "b1", updates: [{ id: "r1", baseVersion: 1, x: 10 }] } },
    });
    expect(resp.result.isError).toBe(true);
    const payload = JSON.parse(resp.result.content[0].text);
    expect(payload.code).toBe("version-conflict");
    expect(payload.details).toEqual({ conflicts: [{ id: "r1", expectedVersion: 1, actualVersion: 2 }] });
  });
});

// ── Live E2E tests against real Plenary server ───────────────────────────────

describe("live E2E: MCP v2 & CLI v2 against real Plenary server", () => {
  const ADMIN_TOKEN = "mcp-v2-e2e-admin-token";
  let dir, store, registry, bus, server, boardId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "plenary-mcp-v2-"));
    store = sqliteStore({ path: join(dir, "plenary.db") });
    registry = sqliteRegistry({ path: join(dir, "registry.db") });
    bus = memoryBus();

    await registry.createTenant({ domain: "acme.test", admins: ["dev:admin"] });
    const dev = devAuth({
      enabled: true,
      tokens: {
        [ADMIN_TOKEN]: { name: "admin", email: "admin@acme.test", domain: "acme.test" },
      },
    });
    const ten = makeTenancy({ registry });
    const auth = authPort({ dev, tenancy: ten });
    const sessions = { async issue() { return ""; }, async verify() { return null; } };

    let httpHandler = null;
    server = createServer({
      auth,
      registry,
      store,
      bus,
      port: 0,
      static: false,
      http: (req, url) => httpHandler(req, url),
    });
    httpHandler = httpRoutes({
      registry,
      sessions,
      tenancy: ten,
      dev,
      config: {
        postLoginUrl: `${server.url}/`,
        boardUrl: `${server.url}/?board={board}`,
        publicUrl: server.url,
      },
    });

    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    const created = await client.createBoard({ title: "MCP v2 E2E Board", memberRole: "editor" });
    boardId = created.board.id;
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (bus) await bus.close();
    if (store) await store.close();
    if (registry) await registry.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("update_elements & delete_elements with H2 baseVersion optimistic concurrency guard", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    await client.addElements({
      board: boardId,
      elements: [
        { id: "box-1", type: "rectangle", x: 10, y: 20, width: 100, height: 60 },
        { id: "box-2", type: "rectangle", x: 200, y: 20, width: 100, height: 60 },
      ],
    });

    // Update with matching baseVersion: 1 succeeds -> bumps to version 2
    const up1 = await client.updateElements({
      board: boardId,
      updates: [{ id: "box-1", baseVersion: 1, x: 50, strokeColor: "#dc2626", layer: "base" }],
    });
    expect(up1.versions["box-1"]).toBe(2);

    // Concurrent/stale baseVersion: 1 fails atomically with version-conflict (box-2 untouched too!)
    let err;
    try {
      await client.updateElements({
        board: boardId,
        updates: [
          { id: "box-1", baseVersion: 1, x: 999 },
          { id: "box-2", baseVersion: 1, x: 999 },
        ],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PlenaryError);
    expect(err.code).toBe("version-conflict");
    expect(err.details.conflicts).toEqual([{ id: "box-1", expectedVersion: 1, actualVersion: 2 }]);

    const afterConflict = await client.readBoard({ board: boardId });
    expect(afterConflict.elements.find(e => e.id === "box-1").x).toBe(50);
    expect(afterConflict.elements.find(e => e.id === "box-2").x).toBe(200);

    // delete_elements with stale baseVersion fails with version-conflict
    let delErr;
    try {
      await client.deleteElements({
        board: boardId,
        ids: [{ id: "box-1", baseVersion: 1 }],
      });
    } catch (e) { delErr = e; }
    expect(delErr.code).toBe("version-conflict");
    expect(delErr.details.conflicts).toEqual([{ id: "box-1", expectedVersion: 1, actualVersion: 2 }]);

    // delete_elements with matching baseVersion succeeds
    const delOk = await client.deleteElements({
      board: boardId,
      ids: ["box-1"],
      baseVersions: { "box-1": 2 },
    });
    expect(delOk.ids).toEqual(["box-1"]);

    const afterDelete = await client.readBoard({ board: boardId });
    expect(afterDelete.elements.some(e => e.id === "box-1")).toBe(false);
    expect(afterDelete.elements.some(e => e.id === "box-2")).toBe(true);
  });

  test("Opus review fixes: update_elements moves/re-layers bound labels and delete_elements cascades labels + unbinds arrows", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    // Create a labelled Mermaid pair (A --> B) so shapes have bound text labels and an arrow bound to both
    const m = await client.addMermaid({ board: boardId, source: "flowchart LR\n  S1[Alpha] --> S2[Beta]" });
    const before = await client.readBoard({ board: boardId });
    const mEls = before.elements.filter(e => m.ids.includes(e.id));
    const labelA = mEls.find(e => e.type === "text" && e.text === "Alpha");
    const shapeA = mEls.find(e => e.id === labelA.containerId);
    const arrow = mEls.find(e => e.type === "arrow");
    expect(shapeA).toBeTruthy();
    expect(arrow.startBinding?.elementId).toBe(shapeA.id);

    // Move & re-layer shapeA -> bound labelA moves by same delta and moves to new layer
    const origLabelX = labelA.x;
    const origLabelY = labelA.y;
    await client.updateElements({
      board: boardId,
      updates: [{ id: shapeA.id, x: shapeA.x + 50, y: shapeA.y + 30, layer: "diagram" }],
    });
    const afterMove = await client.readBoard({ board: boardId });
    const movedLabelA = afterMove.elements.find(e => e.id === labelA.id);
    expect(movedLabelA.x).toBe(origLabelX + 50);
    expect(movedLabelA.y).toBe(origLabelY + 30);
    expect(movedLabelA.customData.layer).toBe("diagram");

    // Delete shapeA -> bound labelA is also deleted and arrow.startBinding is cleared to null
    const delRes = await client.deleteElements({ board: boardId, ids: [shapeA.id] });
    expect(delRes.deletedIds).toContain(shapeA.id);
    expect(delRes.deletedIds).toContain(labelA.id);
    expect(delRes.unboundArrowIds).toContain(arrow.id);

    const afterDel = await client.readBoard({ board: boardId });
    expect(afterDel.elements.some(e => e.id === shapeA.id)).toBe(false);
    expect(afterDel.elements.some(e => e.id === labelA.id)).toBe(false);
    const updatedArrow = afterDel.elements.find(e => e.id === arrow.id);
    expect(updatedArrow.startBinding).toBeNull();
    expect(updatedArrow.endBinding?.elementId).toBeTruthy();
  });

  test("set_animation sets and clears customData.anim", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const setRes = await client.setAnimation({
      board: boardId,
      ids: ["box-2"],
      anim: { preset: "bounce-in", start: 150, duration: 700, easing: "bounce", loop: false },
    });
    expect(setRes.count).toBe(1);
    expect(setRes.anim).toEqual({ preset: "bounce-in", start: 150, duration: 700, easing: "bounce", loop: false });

    const read1 = await client.readBoard({ board: boardId });
    expect(read1.elements.find(e => e.id === "box-2").customData.anim).toEqual({
      preset: "bounce-in", start: 150, duration: 700, easing: "bounce", loop: false,
    });

    // Clear animation
    const clearRes = await client.setAnimation({ board: boardId, ids: ["box-2"], anim: null });
    expect(clearRes.anim).toBeNull();

    const read2 = await client.readBoard({ board: boardId });
    expect(read2.elements.find(e => e.id === "box-2").customData.anim).toBeUndefined();
  });

  test("manage_layers: list, create, rename, toggle_visible, toggle_locked, reorder", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const l0 = await client.manageLayers({ board: boardId, action: "list" });
    expect(l0.layers.length).toBe(1);
    expect(l0.layers[0].id).toBe("base");

    const l1 = await client.manageLayers({ board: boardId, action: "create", id: "notes-layer", name: "Annotations", opacity: 85 });
    expect(l1.layer).toEqual({ id: "notes-layer", name: "Annotations", visible: true, locked: false, opacity: 85 });

    const l2 = await client.manageLayers({ board: boardId, action: "rename", id: "notes-layer", name: "Review Layer" });
    expect(l2.layer.name).toBe("Review Layer");

    const l3 = await client.manageLayers({ board: boardId, action: "toggle_visible", id: "notes-layer" });
    expect(l3.layer.visible).toBe(false);

    const l4 = await client.manageLayers({ board: boardId, action: "toggle_locked", id: "notes-layer" });
    expect(l4.layer.locked).toBe(true);

    const l5 = await client.manageLayers({ board: boardId, action: "reorder", order: ["notes-layer", "base"] });
    expect(l5.layers.map(l => l.id)).toEqual(["notes-layer", "base"]);

    // Verify persisted in readBoard
    const synced = await client.readBoard({ board: boardId });
    expect(synced.appState.layers.map(l => l.id)).toEqual(["notes-layer", "base"]);
    expect(synced.appState.layers[0]).toEqual({ id: "notes-layer", name: "Review Layer", visible: false, locked: true, opacity: 85 });

    // Invalid reorder (missing layer) rejected
    await expect(client.manageLayers({ board: boardId, action: "reorder", order: ["base"] }))
      .rejects.toMatchObject({ code: "bad-request" });
  });

  test("add_link_card creates validated GitHub, Linear, and Jira cards and rejects unsafe URLs", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const gh = await client.addLinkCard({
      board: boardId,
      url: "https://github.com/acme/plenary/pull/42",
      x: 100,
      y: 200,
      title: "MCP v2 PR",
      id: "card-gh",
    });
    expect(gh.provider).toBe("github");
    expect(gh.kind).toBe("PR");
    expect(gh.key).toBe("acme/plenary#42");
    expect(gh.title).toBe("MCP v2 PR");

    const lin = await client.addLinkCard({
      board: boardId,
      url: "https://linear.app/acme/issue/ENG-108/add-mcp-v2",
      x: 500,
      y: 200,
    });
    expect(lin.provider).toBe("linear");
    expect(lin.key).toBe("ENG-108");

    const jira = await client.addLinkCard({
      board: boardId,
      url: "https://acme.atlassian.net/browse/PLAT-7",
      x: 900,
      y: 200,
    });
    expect(jira.provider).toBe("jira");
    expect(jira.key).toBe("PLAT-7");

    // Unsafe / unsupported URLs rejected with bad-request
    for (const bad of ["javascript:alert(1)", "http://github.com/a/b/issues/1", "https://evil.example.com/x"]) {
      await expect(client.addLinkCard({ board: boardId, url: bad })).rejects.toMatchObject({ code: "bad-request" });
    }

    const synced = await client.readBoard({ board: boardId });
    const cardEl = synced.elements.find(e => e.id === "card-gh");
    expect(cardEl.link).toBe("https://github.com/acme/plenary/pull/42");
    expect(cardEl.customData.linkCard.provider).toBe("github");
  });

  test("list_frames returns only live frames with { id, name, x, y, width, height, layer }", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    await client.addElements({
      board: boardId,
      elements: [
        { id: "frame-1", type: "frame", name: "Slide 1", x: 0, y: 0, width: 1280, height: 720, layer: "base" },
        { id: "frame-2", type: "frame", name: "Slide 2", x: 1400, y: 0, width: 1280, height: 720, layer: "notes-layer" },
      ],
    });
    await client.deleteElements({ board: boardId, ids: ["frame-2"] });

    const res = await client.listFrames({ board: boardId });
    expect(res.count).toBe(1);
    expect(res.frames).toEqual([
      { id: "frame-1", name: "Slide 1", x: 0, y: 0, width: 1280, height: 720, layer: "base" },
    ]);
  });

  test("H1 live E2E: bulk addElements >512 KB chunks cleanly into multiple ops and persists all elements", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    // Create 60 text elements of ~10 KB each (~600 KB total > 512 KB MAX_CHUNK_BYTES)
    const bigBatch = Array.from({ length: 60 }, (_, i) => ({
      id: `bulk-${i}`,
      type: "text",
      x: i * 10,
      y: 500,
      text: `item-${i}-` + "A".repeat(10_000),
    }));
    const res = await client.addElements({ board: boardId, elements: bigBatch });
    expect(res.count).toBe(60);
    expect(res.chunks).toBeGreaterThanOrEqual(2);

    const synced = await client.readBoard({ board: boardId });
    const ids = new Set(synced.elements.map(e => e.id));
    expect(ids.has("bulk-0")).toBe(true);
    expect(ids.has("bulk-59")).toBe(true);
  });

  test("manage_views: list works on live server, and create/list/delete round-trip over Protocol v1.1 WS", async () => {
    const liveClient = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    const liveList = await liveClient.manageViews({ board: boardId, action: "list" });
    expect(liveList.views).toEqual([]);
    expect(liveList.count).toBe(0);

    // Full Protocol v1.1 WS round-trip with a lightweight WS server accepting appState.views (matching #115)
    /** @type {any[]} */
    let storedViews = [];
    let seq = 0;
    const viewsServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("ok");
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.t === "hello") {
            ws.send(JSON.stringify({
              t: "welcome",
              v: 1,
              rv: 1,
              seq,
              horizon: 0,
              high: 0,
              hb: 10_000,
              user: "u:admin",
              role: "owner",
              room: { board: msg.board, epoch: 1 },
            }));
            if (storedViews.length) {
              ws.send(JSON.stringify({
                t: "snapshot",
                seq,
                streams: {
                  board: {
                    elements: [],
                    appState: {
                      viewBackgroundColor: "#ffffff",
                      herdr: {
                        layers: [{ id: "base", name: "Layer 1", visible: true, locked: false, opacity: 100 }],
                        views: storedViews,
                      },
                    },
                  },
                  notes: { elements: [], appState: { herdr: { layers: [{ id: "base", name: "Layer 1", visible: true, locked: false, opacity: 100 }] } } },
                },
                appSeq: { board: { views: seq }, notes: {} },
                records: { threads: [] },
              }));
            }
          } else if (msg.t === "op") {
            seq++;
            if (msg.op?.appState?.views) storedViews = msg.op.appState.views;
            ws.send(JSON.stringify({ t: "ack", id: msg.id, seq }));
            ws.send(JSON.stringify({
              t: "entries",
              entries: [{ seq, id: msg.id, stream: msg.stream, op: msg.op, by: "u:admin", at: Date.now() }],
            }));
          }
        },
      },
    });

    try {
      const vc = createPlenaryClient({ url: viewsServer.url.toString(), token: "tok" });
      const created = await vc.manageViews({
        board: "views-board",
        action: "create",
        id: "v-intro",
        name: "Architecture Overview",
        frameId: "frame-1",
        visibleLayers: ["base", "notes-layer"],
      });
      expect(created.view).toEqual({
        id: "v-intro",
        name: "Architecture Overview",
        frameId: "frame-1",
        visibleLayers: ["base", "notes-layer"],
      });
      expect(storedViews).toEqual([created.view]);

      const listed = await vc.manageViews({ board: "views-board", action: "list" });
      expect(listed.count).toBe(1);
      expect(listed.views[0]).toEqual(created.view);

      const deleted = await vc.manageViews({ board: "views-board", action: "delete", id: "v-intro" });
      expect(deleted.id).toBe("v-intro");
      expect(deleted.views).toEqual([]);
      expect(storedViews).toEqual([]);
    } finally {
      viewsServer.stop(true);
    }
  });
});
