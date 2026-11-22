// Tests for Wave 3 Track 2 — Plenary Agent Tools (CLI & stdio MCP server).
// Covers:
//   1. Unit tests for CLI arg parsing, URL helpers, and MCP JSON-RPC dispatch.
//   2. Live E2E tests against a real local createServer + httpRoutes + SQLite store/registry
//      verifying HTTP Admin API, Protocol v1.1 WebSocket ops, CLI subcommands, and
//      a real spawned `bun scripts/plenary-mcp.js` stdio round-trip.

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

import { createPlenaryClient, normalizeBaseUrl, toWsUrl, normalizeElement, assertBoardId, PlenaryError } from "../../scripts/plenary-client.js";
import { parseCliArgs, runCli, USAGE } from "../../scripts/plenary-cli.js";
import { createMcpHandler, runStdioServer, TOOLS, MCP_PROTOCOL_VERSION, SERVER_INFO } from "../../scripts/plenary-mcp.js";
import { PassThrough } from "node:stream";

const MCP_SCRIPT = new URL("../../scripts/plenary-mcp.js", import.meta.url).pathname;

// ── Unit tests ───────────────────────────────────────────────────────────────

describe("plenary-client helpers", () => {
  test("normalizeBaseUrl and toWsUrl handle http/https, strip query/hash/slashes, and redact credentials", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8080/?foo=1#frag")).toBe("http://127.0.0.1:8080");
    expect(toWsUrl("http://127.0.0.1:8080/")).toBe("ws://127.0.0.1:8080/ws");
    expect(toWsUrl("https://plenary.example.com/base/?x=1#y")).toBe("wss://plenary.example.com/base/ws");
    expect(() => normalizeBaseUrl("")).toThrow(PlenaryError);
    expect(() => normalizeBaseUrl("ftp://example.com")).toThrow(PlenaryError);
    try {
      normalizeBaseUrl("http://user:s3cr3t@bad host/");
    } catch (err) {
      expect(err).toBeInstanceOf(PlenaryError);
      expect(err.message).not.toContain("s3cr3t");
    }
  });

  test("L6/L7: assertBoardId rejects traversal/invalid IDs and getAudit rejects scope='board' without board", async () => {
    expect(assertBoardId("b-abc_123")).toBe("b-abc_123");
    for (const bad of ["", ".", "..", "../etc", "a/b", "has space", "a".repeat(65)]) {
      expect(() => assertBoardId(bad)).toThrow(PlenaryError);
      try { assertBoardId(bad); } catch (e) { expect(e.code).toBe("bad-request"); }
    }
    const client = createPlenaryClient({ url: "http://127.0.0.1:1", token: "t" });
    await expect(client.getAudit({ scope: "board" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.readBoard({ board: ".." })).rejects.toMatchObject({ code: "bad-request" });
  });

  test("M1/M2: normalizeElement validates fields, rejects NaN/bad values, and strips internal properties", () => {
    const clean = normalizeElement({
      type: "rectangle",
      id: "el-1",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      isDeleted: true,
      version: 999,
      versionNonce: 42,
      customData: { evil: true },
      boundElements: [{ id: "x", type: "text" }],
    });
    expect(clean.id).toBe("el-1");
    expect(clean.isDeleted).toBe(false);
    expect(clean.version).toBe(1);
    expect(clean.customData).toEqual({ layer: "base", z: 0 });
    expect(clean.boundElements).toBeNull();

    // M1: NaN, Infinity, non-numeric, invalid points, unsupported type rejected with bad-request
    const badSpecs = [
      { type: "rectangle", x: Number.NaN },
      { type: "rectangle", width: Infinity },
      { type: "rectangle", opacity: "100" },
      { type: "text", text: 123 },
      { type: "text", fontSize: Number.NaN },
      { type: "arrow", points: [[0, 0], [Number.NaN, 10]] },
      { type: "arrow", points: "not-an-array" },
      { type: "image" },
      { type: "rectangle", strokeColor: 42 },
    ];
    for (const spec of badSpecs) {
      expect(() => normalizeElement(spec)).toThrow(PlenaryError);
      try { normalizeElement(spec); } catch (e) { expect(e.code).toBe("bad-request"); }
    }
  });

  test("M1: addNote rejects NaN / non-positive dimensions / bad color types with bad-request", async () => {
    const client = createPlenaryClient({ url: "http://127.0.0.1:1", token: "t" });
    await expect(client.addNote({ board: "b-1", text: "ok", x: Number.NaN })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.addNote({ board: "b-1", text: "ok", width: -10 })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.addNote({ board: "b-1", text: "ok", backgroundColor: 123 })).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("plenary-cli argument parsing", () => {
  test("parses commands, aliases, flags, inline values, and positional board", () => {
    expect(parseCliArgs(["--help"])).toMatchObject({ help: true });
    expect(parseCliArgs(["-h"])).toMatchObject({ help: true });
    expect(parseCliArgs(["list-boards", "--json"])).toEqual({
      help: false,
      command: "list_boards",
      flags: { json: true },
      positional: [],
    });
    expect(parseCliArgs(["read_board", "b-123", "--url=http://localhost:8080", "--token", "tok"])).toEqual({
      help: false,
      command: "read_board",
      flags: { url: "http://localhost:8080", token: "tok" },
      positional: ["b-123"],
    });
    expect(parseCliArgs(["add-mermaid", "--board", "b-1", "--source", "graph TD\nA-->B", "--elbow"])).toMatchObject({
      command: "add_mermaid",
      flags: { board: "b-1", source: "graph TD\nA-->B", elbow: true },
    });
  });

  test("rejects missing/unknown commands and malformed flags", () => {
    expect(() => parseCliArgs([])).toThrow(/command is required/);
    expect(() => parseCliArgs(["bogus-cmd"])).toThrow(/unknown command/);
    expect(() => parseCliArgs(["read-board", "--board"])).toThrow(/requires a value/);
    expect(() => parseCliArgs(["list-boards", "--json=maybe"])).toThrow(/takes no value/);
    expect(() => parseCliArgs(["list-boards", "-z"])).toThrow(/unknown flag/);
  });

  test("runCli prints usage on --help (exit 0) and on usage error (exit 2)", async () => {
    const out = [];
    const err = [];
    const codeHelp = await runCli(["--help"], {}, { out: s => out.push(s), err: s => err.push(s) });
    expect(codeHelp).toBe(0);
    expect(out.join("\n")).toBe(USAGE);
    expect(err).toEqual([]);

    const codeBad = await runCli(["read-board"], { PLENARY_URL: "http://127.0.0.1:1", PLENARY_TOKEN: "t" }, {
      out: s => out.push(s),
      err: s => err.push(s),
    });
    expect(codeBad).toBe(2);
    expect(err.join("\n")).toContain("read-board requires --board");
  });
});

describe("plenary-mcp JSON-RPC handler", () => {
  const mockClient = {
    listBoards: async () => ({ boards: [{ id: "b1", title: "Demo" }], isAdmin: true }),
    readBoard: async () => { throw new PlenaryError("not allowed", { code: "forbidden", status: 403 }); },
  };
  const handle = createMcpHandler({ clientFactory: () => mockClient });

  test("handles initialize, notifications/initialized, ping, and tools/list", async () => {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });

    const notif = await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notif).toBeNull();

    const ping = await handle({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(ping).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const list = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(list.result.tools.map(t => t.name)).toEqual([
      "list_boards",
      "create_board",
      "create_share_link",
      "get_audit",
      "read_board",
      "add_elements",
      "add_mermaid",
      "add_note",
      "add_comment",
    ]);
    for (const t of TOOLS) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("dispatches tools/call and formats tool errors with isError: true", async () => {
    const ok = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_boards", arguments: {} } });
    expect(ok.result.isError).toBeUndefined();
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ boards: [{ id: "b1", title: "Demo" }], isAdmin: true });

    const fail = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_board", arguments: { board: "x" } } });
    expect(fail.result.isError).toBe(true);
    expect(JSON.parse(fail.result.content[0].text)).toEqual({ error: "not allowed", code: "forbidden", status: 403 });
  });

  test("returns JSON-RPC protocol errors for invalid requests, unknown methods, and unknown tools", async () => {
    expect((await handle(null)).error.code).toBe(-32600);
    expect((await handle({ jsonrpc: "1.0", id: 6, method: "ping" })).error.code).toBe(-32600);
    expect((await handle({ jsonrpc: "2.0", id: 7, method: "nope/method" })).error.code).toBe(-32601);
    expect((await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope_tool" } })).error.code).toBe(-32602);
    expect((await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {} })).error.code).toBe(-32602);
    // L13: client JSON-RPC response (result/error without method) is ignored, and supported protocolVersion is echoed
    expect(await handle({ jsonrpc: "2.0", id: 10, result: {} })).toBeNull();
    const initNew = await handle({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(initNew.result.protocolVersion).toBe("2025-03-26");
  });

  test("M3: concurrent ping does not block behind slow tools/call, and notifications/cancelled aborts it", async () => {
    let seenSignal = null;
    let aborted = false;
    const slowClient = {
      readBoard: ({ signal }) => new Promise((resolve, reject) => {
        seenSignal = signal;
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new PlenaryError("cancelled", { code: "cancelled" }));
        }, { once: true });
      }),
    };

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outLines = [];
    stdout.on("data", chunk => {
      for (const l of chunk.toString("utf8").split("\n").filter(Boolean)) outLines.push(JSON.parse(l));
    });

    const serverDone = runStdioServer({ stdin, stdout, stderr, clientFactory: () => slowClient });

    // Start a slow read_board (id 100), then immediately send ping (id 101)
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "read_board", arguments: { board: "b-1" } } }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping" }) + "\n");

    // Wait briefly for ping to complete while id 100 is still blocked
    await new Promise(r => setTimeout(r, 30));
    expect(outLines.some(m => m.id === 101 && m.result && Object.keys(m.result).length === 0)).toBe(true);
    expect(seenSignal).not.toBeNull();
    expect(aborted).toBe(false);

    // Cancel id 100 via notifications/cancelled
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 100, reason: "user abort" } }) + "\n");
    stdin.end();
    await serverDone;

    expect(aborted).toBe(true);
    expect(seenSignal.aborted).toBe(true);
    // Cancelled request suppresses its response
    expect(outLines.some(m => m.id === 100)).toBe(false);
  });
});

// ── Live E2E tests against a real local Plenary server ───────────────────────

describe("live E2E against real Plenary server (HTTP Admin API + Protocol v1.1 WS + CLI + stdio MCP)", () => {
  const ADMIN_TOKEN = "agent-e2e-admin-token";
  let dir, store, registry, bus, server;
  let boardId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "plenary-agent-tools-"));
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
    const sessions = {
      async issue() { return ""; },
      async verify() { return null; },
    };

    // Start server on ephemeral port; wire httpRoutes with matching origin dynamically.
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
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (bus) await bus.close();
    if (store) await store.close();
    if (registry) await registry.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP Admin API: create_board, list_boards, create_share_link, get_audit", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const created = await client.createBoard({ title: "Agent E2E Board", memberRole: "viewer" });
    expect(created.board.title).toBe("Agent E2E Board");
    expect(typeof created.board.id).toBe("string");
    boardId = created.board.id;

    const listed = await client.listBoards();
    expect(listed.isAdmin).toBe(true);
    expect(listed.boards.some(b => b.id === boardId && b.title === "Agent E2E Board")).toBe(true);

    const linked = await client.createShareLink({ board: boardId, role: "editor" });
    expect(linked.link.board).toBe(boardId);
    expect(linked.link.role).toBe("editor");
    expect(linked.url).toContain(`/links/${linked.link.id}`);

    const boardAudit = await client.getAudit({ board: boardId, limit: 20 });
    const actions = boardAudit.events.map(e => e.action);
    expect(actions).toContain("board.create");
    expect(actions).toContain("link.create");

    const tenantAudit = await client.getAudit({ scope: "tenant", limit: 20 });
    expect(tenantAudit.events.some(e => e.board === boardId && e.action === "board.create")).toBe(true);
  });

  test("Protocol v1.1 WS: read_board, add_elements, add_mermaid, add_note, add_comment & persistence", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const initial = await client.readBoard({ board: boardId });
    expect(initial.board).toBe(boardId);
    expect(initial.seq).toBe(0);
    expect(initial.elements).toEqual([]);
    expect(initial.notes).toEqual([]);
    expect(initial.comments).toEqual([]);

    // 1. add_elements (also verify isDeleted is stripped and duplicate id is rejected with conflict)
    const addedEls = await client.addElements({
      board: boardId,
      elements: [
        { id: "fixed-rect-1", type: "rectangle", x: 10, y: 20, width: 180, height: 90, strokeColor: "#2563eb", isDeleted: true },
        { type: "text", x: 30, y: 45, text: "Hello Plenary" },
      ],
    });
    expect(addedEls.ids.length).toBe(2);
    expect(addedEls.ids[0]).toBe("fixed-rect-1");
    expect(addedEls.seq).toBeGreaterThan(0);

    // M2: attempting to add an element with an existing id fails with conflict
    await expect(client.addElements({
      board: boardId,
      elements: [{ id: "fixed-rect-1", type: "rectangle", x: 0, y: 0, width: 50, height: 50 }],
    })).rejects.toMatchObject({ code: "conflict" });

    // 2. add_mermaid
    const addedMermaid = await client.addMermaid({
      board: boardId,
      source: "flowchart LR\n  A[Client] --> B[Gateway]\n  B -->|persist| C[(Store)]",
      origin: { x: 300, y: 50 },
    });
    expect(addedMermaid.nodes).toBe(3);
    expect(addedMermaid.edges).toBe(2);
    expect(addedMermaid.ids.length).toBeGreaterThanOrEqual(8); // 3 nodes + 3 labels + 2 arrows + 1 edge label
    expect(addedMermaid.seq).toBeGreaterThan(addedEls.seq);

    // 3. add_note
    const addedNote = await client.addNote({
      board: boardId,
      text: "Review architecture diagram",
      x: 50,
      y: 260,
    });
    expect(addedNote.ids.length).toBe(2);
    expect(addedNote.seq).toBeGreaterThan(addedMermaid.seq);

    // 4. add_comment (new thread + reply)
    const threadRes = await client.addComment({
      board: boardId,
      text: "Looks great! Should we add a cache?",
      x: 320,
      y: 80,
    });
    expect(threadRes.action).toBe("thread");
    expect(threadRes.thread).toBe(threadRes.id);

    const replyRes = await client.addComment({
      board: boardId,
      thread: threadRes.thread,
      text: "Yes, let's add Redis in v2.",
    });
    expect(replyRes.action).toBe("reply");
    expect(replyRes.thread).toBe(threadRes.thread);

    // 5. read_board confirms everything persisted in a brand-new WS session
    const synced = await client.readBoard({ board: boardId });
    expect(synced.seq).toBe(replyRes.seq);

    const elIds = new Set(synced.elements.map(e => e.id));
    for (const id of addedEls.ids) expect(elIds.has(id)).toBe(true);
    for (const id of addedMermaid.ids) expect(elIds.has(id)).toBe(true);
    expect(synced.elements.some(e => e.type === "arrow")).toBe(true);
    expect(synced.elements.some(e => e.type === "text" && e.text === "Gateway")).toBe(true);

    const noteIds = new Set(synced.notes.map(n => n.id));
    expect(noteIds.has(addedNote.id)).toBe(true);
    expect(noteIds.has(addedNote.textId)).toBe(true);
    expect(synced.notes.some(n => n.type === "text" && n.text === "Review architecture diagram")).toBe(true);

    expect(synced.comments.length).toBe(1);
    expect(synced.comments[0].id).toBe(threadRes.thread);
    expect(synced.comments[0].comments.map(c => c.text)).toEqual([
      "Looks great! Should we add a cache?",
      "Yes, let's add Redis in v2.",
    ]);
  });

  test("CLI runCli executes list-boards and add-note against live server", async () => {
    const env = { PLENARY_URL: server.url, PLENARY_TOKEN: ADMIN_TOKEN };
    const out1 = [];
    const err1 = [];
    const code1 = await runCli(["list-boards"], env, { out: s => out1.push(s), err: s => err1.push(s) });
    expect(code1).toBe(0);
    expect(err1).toEqual([]);
    const boardsJson = JSON.parse(out1.join("\n"));
    expect(boardsJson.boards.some(b => b.id === boardId)).toBe(true);

    const out2 = [];
    const err2 = [];
    const code2 = await runCli(
      ["add-note", "--board", boardId, "--text", "CLI sticky note", "--x", "120", "--y", "320"],
      env,
      { out: s => out2.push(s), err: s => err2.push(s) },
    );
    expect(code2).toBe(0);
    expect(err2).toEqual([]);
    const noteJson = JSON.parse(out2.join("\n"));
    expect(typeof noteJson.id).toBe("string");
    expect(noteJson.seq).toBeGreaterThan(0);
  });

  test("real stdio MCP server subprocess round-trip (initialize, tools/list, tools/call)", async () => {
    const child = Bun.spawn([process.execPath, MCP_SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PLENARY_URL: server.url,
        PLENARY_TOKEN: ADMIN_TOKEN,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "test", version: "1.0" }, capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_boards", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "add_note", arguments: { board: boardId, text: "MCP note", x: 10, y: 10 } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_board", arguments: { board: boardId } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_board", arguments: { board: "nonexistent-board" } } },
    ];

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
    child.stdin.end();

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderrText).toBe("");

    const lines = stdoutText.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(7); // 7 requests with ids; 1 notification produced no response
    const byId = new Map(lines.map(l => { const r = JSON.parse(l); return [r.id, r]; }));

    // id 1: initialize
    expect(byId.get(1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: SERVER_INFO },
    });
    // id 2: ping
    expect(byId.get(2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    // id 3: tools/list
    expect(byId.get(3).result.tools.length).toBe(9);
    // id 4: list_boards
    const listed = JSON.parse(byId.get(4).result.content[0].text);
    expect(listed.boards.some(b => b.id === boardId)).toBe(true);
    // id 5: add_note
    const addedNote = JSON.parse(byId.get(5).result.content[0].text);
    expect(typeof addedNote.id).toBe("string");
    // id 6: read_board (valid board state)
    const boardState = JSON.parse(byId.get(6).result.content[0].text);
    expect(boardState.board).toBe(boardId);
    expect(Array.isArray(boardState.notes)).toBe(true);
    // id 7: read_board on nonexistent board returns MCP tool error with isError: true
    expect(byId.get(7).result.isError).toBe(true);
    const errPayload = JSON.parse(byId.get(7).result.content[0].text);
    expect(errPayload.code).toBe("auth");
  }, 20_000);
});
