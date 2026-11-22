#!/usr/bin/env bun
// Plenary MCP Server (JSON-RPC 2.0 over stdio).
// Exposes Plenary HTTP Admin API & Protocol v1.1 board operations as MCP tools.
// Never writes non-JSON-RPC output to stdout; diagnostics go to stderr only.

import { createPlenaryClient, PlenaryError } from "./plenary-client.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
export const SERVER_INFO = { name: "plenary-mcp", version: "0.1.0" };
export const MAX_LINE_BYTES = 16 * 1024 * 1024; // 16 MiB cap on a single JSON-RPC line

export const TOOLS = [
  {
    name: "list_boards",
    description: "List all Plenary boards accessible to the authenticated user in their tenant.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_board",
    description: "Create a new Plenary board in the authenticated user's tenant (requires tenant admin).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional board title (max 200 chars)." },
        memberRole: {
          type: ["string", "null"],
          enum: ["editor", "annotator", "commenter", "viewer", null],
          description: "Default role for workspace members (default 'viewer'; null for no automatic access).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_share_link",
    description: "Create a share link for a Plenary board with a specified role and optional expiry.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Target board ID." },
        role: {
          type: "string",
          enum: ["editor", "annotator", "viewer"],
          description: "Role granted by the share link (default 'viewer').",
        },
        expiresAt: {
          type: ["number", "null"],
          description: "Optional expiry timestamp in Unix epoch milliseconds.",
        },
      },
      required: ["board"],
      additionalProperties: false,
    },
  },
  {
    name: "get_audit",
    description: "Retrieve audit log events for a specific board or for the whole tenant (tenant admin).",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to query. Omit (or set scope='tenant') for tenant-wide audit." },
        scope: { type: "string", enum: ["board", "tenant"], description: "Query /boards/:board/audit or /admin/audit." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max events to return (default 50, max 200)." },
        before: { type: "string", description: "Pagination cursor (nextBefore from a previous response)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_board",
    description: "Connect to a Plenary board over Protocol v1.1 WebSocket, sync its state, and return elements, notes, and comment threads.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to read." },
      },
      required: ["board"],
      additionalProperties: false,
    },
  },
  {
    name: "add_elements",
    description: "Add one or more canvas elements (rectangle, ellipse, diamond, text, arrow, line, frame, etc.) to a board via Protocol v1.1 WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to modify." },
        stream: { type: "string", enum: ["board", "notes"], description: "Target element stream (default 'board')." },
        elements: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string", description: "Element type: rectangle, ellipse, diamond, text, arrow, line, frame, freedraw." },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              text: { type: "string" },
              strokeColor: { type: "string" },
              backgroundColor: { type: "string" },
            },
          },
          description: "Array of element specifications to create.",
        },
      },
      required: ["board", "elements"],
      additionalProperties: false,
    },
  },
  {
    name: "add_mermaid",
    description: "Parse a Mermaid flowchart (graph/flowchart TD|LR|BT|RL) into laid-out board elements and add them to a Plenary board over Protocol v1.1 WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to add the diagram to." },
        source: { type: "string", description: "Mermaid flowchart source (e.g. 'flowchart LR\\n  A[Start] --> B[End]')." },
        origin: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          description: "Optional top-left scene coordinates { x, y } for placing the diagram.",
        },
        layer: { type: "string", description: "Optional target layer id (default 'base')." },
        elbow: { type: "boolean", description: "Use orthogonal elbow arrows when true." },
      },
      required: ["board", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "add_note",
    description: "Add a sticky note (filled rectangle with bound text) to a board's notes stream via Protocol v1.1 WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to annotate." },
        text: { type: "string", description: "Sticky note text content." },
        x: { type: "number", description: "X coordinate on the canvas (default 0)." },
        y: { type: "number", description: "Y coordinate on the canvas (default 0)." },
        width: { type: "number", description: "Sticky note width (default 200)." },
        height: { type: "number", description: "Sticky note height (default 140)." },
        backgroundColor: { type: "string", description: "Fill color hex (default '#fef08a')." },
        strokeColor: { type: "string", description: "Stroke color hex (default '#1e1e1e')." },
      },
      required: ["board", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "add_comment",
    description: "Create a new comment thread (anchored to a point or element) or reply to an existing thread on a board's records stream via Protocol v1.1 WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to comment on." },
        text: { type: "string", description: "Comment text." },
        x: { type: "number", description: "Anchor X coordinate (default 0)." },
        y: { type: "number", description: "Anchor Y coordinate (default 0)." },
        thread: { type: "string", description: "Existing thread ID to reply to. Omit to start a new thread." },
        element: { type: "string", description: "Optional element ID to anchor a new thread to." },
        stream: { type: "string", enum: ["board", "notes"], description: "Stream of the anchored element (default 'board')." },
      },
      required: ["board", "text"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

/** Dispatch one MCP tool call against a Plenary client instance. */
export async function executeTool(client, name, args = {}, { signal } = {}) {
  const withSig = { ...(args ?? {}), ...(signal ? { signal } : {}) };
  switch (name) {
    case "list_boards": return client.listBoards(withSig);
    case "create_board": return client.createBoard(withSig);
    case "create_share_link": return client.createShareLink(withSig);
    case "get_audit": return client.getAudit(withSig);
    case "read_board": return client.readBoard(withSig);
    case "add_elements": return client.addElements(withSig);
    case "add_mermaid": return client.addMermaid(withSig);
    case "add_note": return client.addNote(withSig);
    case "add_comment": return client.addComment(withSig);
    default: throw new PlenaryError(`Unknown tool: ${name}`, { code: "unknown-tool" });
  }
}

const okResp = (id, result) => ({ jsonrpc: "2.0", id, result });
const errResp = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

/**
 * Create a JSON-RPC 2.0 request handler for the Plenary MCP server.
 * Supports concurrent dispatch and `notifications/cancelled` via per-request AbortControllers.
 * Returns `null` for notifications, client responses, and cancelled requests.
 */
export function createMcpHandler({ env = process.env, clientFactory } = {}) {
  /** @type {Map<string|number, AbortController>} */
  const active = new Map();

  const getClient = () => {
    if (clientFactory) return clientFactory();
    return createPlenaryClient({
      url: env.PLENARY_URL,
      token: env.PLENARY_TOKEN,
      clientName: "plenary-mcp",
    });
  };

  return async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return errResp(null, -32600, "Invalid Request");
    }

    // L13: Ignore JSON-RPC responses sent by the client (result/error without method).
    if (msg.jsonrpc === "2.0" && !Object.prototype.hasOwnProperty.call(msg, "method")
      && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error"))) {
      return null;
    }

    const isNotification = !Object.prototype.hasOwnProperty.call(msg, "id");
    const id = isNotification ? null : msg.id;

    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isNotification ? null : errResp(id, -32600, "Invalid Request");
    }

    const { method, params } = msg;

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "notifications/cancelled") {
      const reqId = params?.requestId;
      if (reqId !== undefined && active.has(reqId)) {
        const ac = active.get(reqId);
        active.delete(reqId);
        ac.abort(params?.reason ?? "cancelled");
      }
      return null;
    }

    if (method === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      return isNotification ? null : okResp(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === "ping") {
      return isNotification ? null : okResp(id, {});
    }

    if (method === "tools/list") {
      return isNotification ? null : okResp(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      if (!params || typeof params !== "object" || typeof params.name !== "string") {
        return isNotification ? null : errResp(id, -32602, "Invalid params: expected { name, arguments? }");
      }
      const { name, arguments: toolArgs = {} } = params;
      if (!TOOL_NAMES.has(name)) {
        return isNotification ? null : errResp(id, -32602, `Unknown tool: ${name}`);
      }
      if (toolArgs !== null && (typeof toolArgs !== "object" || Array.isArray(toolArgs))) {
        return isNotification ? null : errResp(id, -32602, "Invalid params: arguments must be an object");
      }
      const ac = new AbortController();
      if (!isNotification) active.set(id, ac);
      try {
        const client = getClient();
        const result = await executeTool(client, name, toolArgs ?? {}, { signal: ac.signal });
        if (isNotification || ac.signal.aborted) return null;
        return okResp(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        if (isNotification || ac.signal.aborted) return null;
        const payload = {
          error: err?.message ?? String(err),
          code: err?.code ?? "tool-error",
          ...(err?.status !== undefined ? { status: err.status } : {}),
        };
        return okResp(id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        });
      } finally {
        if (!isNotification && active.get(id) === ac) active.delete(id);
      }
    }

    return isNotification ? null : errResp(id, -32601, `Method not found: ${method}`);
  };
}

/** Run the line-delimited JSON-RPC 2.0 stdio transport loop with concurrent dispatch and line-size cap. */
export async function runStdioServer({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  clientFactory,
  maxLineBytes = MAX_LINE_BYTES,
} = {}) {
  const handle = createMcpHandler({ env, clientFactory });
  const writeLine = obj => {
    if (obj === null || obj === undefined) return;
    stdout.write(JSON.stringify(obj) + "\n");
  };

  let buffer = "";
  let droppingOversized = false;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  const dispatchLine = rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    const task = (async () => {
      let parsed;
      try { parsed = JSON.parse(line); }
      catch {
        writeLine(errResp(null, -32700, "Parse error"));
        return;
      }
      try {
        const resp = await handle(parsed);
        writeLine(resp);
      } catch (err) {
        stderr.write(`[plenary-mcp] internal error: ${err?.message ?? err}\n`);
        const id = parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "id") ? parsed.id : null;
        if (id !== null) writeLine(errResp(id, -32603, "Internal error"));
      }
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  };

  await new Promise((resolve, reject) => {
    stdin.setEncoding?.("utf8");
    stdin.on("data", chunk => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      buffer += text;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) {
          if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
            if (!droppingOversized) {
              droppingOversized = true;
              stderr.write(`[plenary-mcp] line exceeded ${maxLineBytes} bytes; dropping\n`);
              writeLine(errResp(null, -32700, "Parse error: message exceeds maximum line size"));
            }
            buffer = "";
          }
          break;
        }
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (droppingOversized) {
          droppingOversized = false;
          continue;
        }
        if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
          stderr.write(`[plenary-mcp] line exceeded ${maxLineBytes} bytes; dropping\n`);
          writeLine(errResp(null, -32700, "Parse error: message exceeds maximum line size"));
          continue;
        }
        dispatchLine(line);
      }
    });
    stdin.on("end", () => {
      if (!droppingOversized && buffer.trim()) {
        if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
          writeLine(errResp(null, -32700, "Parse error: message exceeds maximum line size"));
        } else {
          dispatchLine(buffer);
        }
      }
      buffer = "";
      Promise.allSettled([...inFlight]).then(() => resolve(), reject);
    });
    stdin.on("error", reject);
  });
}

if (import.meta.main) {
  runStdioServer().catch(err => {
    process.stderr.write(`[plenary-mcp] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
