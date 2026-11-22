#!/usr/bin/env bun
// @ts-check
// Plenary MCP Server v2 (JSON-RPC 2.0 over stdio).
// Exposes Plenary HTTP Admin API & Protocol v1.1 board operations as 16 MCP tools.
// Never writes non-JSON-RPC output to stdout; diagnostics go to stderr only.

import { createPlenaryClient, PlenaryError } from "./plenary-client.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
export const SERVER_INFO = { name: "plenary-mcp", version: "0.2.0" };
export const MAX_LINE_BYTES = 16 * 1024 * 1024; // 16 MiB cap on a single JSON-RPC line

const ANIM_SCHEMA = {
  type: "object",
  properties: {
    preset: { type: "string", description: "Animation preset name (e.g. fade, pop, slide-up, draw, pulse, bounce-in)." },
    start: { type: "number", minimum: 0, description: "Start time in milliseconds (default 0)." },
    duration: { type: "number", exclusiveMinimum: 0, description: "Duration in milliseconds." },
    easing: { type: "string", description: "Optional easing name (linear, ease-in, ease-out, ease-in-out, back-out, spring, bounce)." },
    loop: { type: "boolean", description: "Optional loop flag." },
  },
  required: ["preset"],
};

const BINDING_SCHEMA = {
  type: ["object", "null"],
  properties: {
    elementId: { type: "string", description: "Target element ID to bind to." },
    focus: { type: "number", description: "Optional focus offset in [-100, 100] (default 0)." },
    gap: { type: "number", minimum: 0, description: "Optional gap in pixels (default 6)." },
    fixedPoint: {
      type: ["array", "null"],
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description: "Optional normalized anchor point [fx, fy].",
    },
    side: { type: "string", enum: ["top", "right", "bottom", "left"] },
  },
  required: ["elementId"],
};

const CROP_SCHEMA = {
  type: ["object", "null"],
  properties: {
    x: { type: "number", minimum: 0 },
    y: { type: "number", minimum: 0 },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
    naturalWidth: { type: "number", exclusiveMinimum: 0 },
    naturalHeight: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["x", "y", "width", "height"],
};

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
    description: "Add one or more canvas elements (rectangle, ellipse, diamond, text, arrow, line, frame, freedraw) to a board via Protocol v1.1 WebSocket. Supports layer, anim, startBinding/endBinding, and crop; automatically chunks large batches into ≤512 KB ops.",
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
              name: { type: ["string", "null"] },
              strokeColor: { type: "string" },
              backgroundColor: { type: "string" },
              layer: { type: "string", description: "Target layer ID stored in customData.layer (default 'base')." },
              anim: ANIM_SCHEMA,
              startBinding: BINDING_SCHEMA,
              endBinding: BINDING_SCHEMA,
              crop: CROP_SCHEMA,
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
  {
    name: "update_elements",
    description: "Patch existing elements on a board by id with optional per-element baseVersion optimistic concurrency guard (checks synced board version on connect and returns a structured version-conflict error on stale reads; also moves/re-layers bound text labels with their host shape).",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to modify." },
        stream: { type: "string", enum: ["board", "notes"], description: "Target element stream (default 'board')." },
        updates: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "ID of the existing element to patch." },
              baseVersion: { type: "integer", minimum: 0, description: "Optional expected element version for optimistic concurrency control." },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              angle: { type: "number" },
              strokeColor: { type: "string" },
              backgroundColor: { type: "string" },
              fillStyle: { type: "string" },
              strokeStyle: { type: "string" },
              strokeWidth: { type: "number" },
              roughness: { type: "number" },
              opacity: { type: "number" },
              locked: { type: "boolean" },
              link: { type: ["string", "null"] },
              frameId: { type: ["string", "null"] },
              text: { type: "string" },
              name: { type: ["string", "null"] },
              layer: { type: "string" },
              z: { type: "number" },
              anim: { oneOf: [ANIM_SCHEMA, { type: "null" }] },
              startBinding: BINDING_SCHEMA,
              endBinding: BINDING_SCHEMA,
              crop: CROP_SCHEMA,
            },
            required: ["id"],
          },
          description: "Array of element patch objects.",
        },
      },
      required: ["board", "updates"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_elements",
    description: "Soft-delete (isDeleted: true) one or more elements by id (cascading to bound text labels and clearing bindings on attached arrows) with optional per-element baseVersion optimistic concurrency guard against stale reads.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to modify." },
        stream: { type: "string", enum: ["board", "notes"], description: "Target element stream (default 'board')." },
        ids: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  id: { type: "string" },
                  baseVersion: { type: "integer", minimum: 0 },
                },
                required: ["id"],
              },
            ],
          },
          description: "Array of element IDs (or { id, baseVersion } objects) to soft-delete.",
        },
        baseVersions: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
          description: "Optional map of elementId -> expected version for optimistic concurrency control.",
        },
      },
      required: ["board", "ids"],
      additionalProperties: false,
    },
  },
  {
    name: "set_animation",
    description: "Set or clear customData.anim (preset, start, duration, easing, loop) on one or more elements on a board.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID to modify." },
        stream: { type: "string", enum: ["board", "notes"], description: "Target element stream (default 'board')." },
        ids: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Array of element IDs to animate (or clear animation from).",
        },
        anim: {
          oneOf: [ANIM_SCHEMA, { type: "null" }],
          description: "Animation spec { preset, start, duration, easing?, loop? }, or null to clear animation.",
        },
        baseVersions: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
          description: "Optional map of elementId -> expected version.",
        },
      },
      required: ["board", "ids", "anim"],
      additionalProperties: false,
    },
  },
  {
    name: "manage_layers",
    description: "List, create, rename, toggle visibility, toggle lock, or reorder board layers in appState.herdr.layers.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID." },
        action: {
          type: "string",
          enum: ["list", "create", "rename", "toggle_visible", "toggle_locked", "reorder"],
          description: "Layer management action to perform.",
        },
        id: { type: "string", description: "Layer ID (optional for create; required for rename, toggle_visible, toggle_locked)." },
        name: { type: "string", description: "Layer display name (required for create and rename, max 200 chars)." },
        visible: { type: "boolean", description: "Explicit visibility (optional for create and toggle_visible)." },
        locked: { type: "boolean", description: "Explicit lock state (optional for create and toggle_locked)." },
        opacity: { type: "number", minimum: 0, maximum: 100, description: "Layer opacity 0..100 (optional for create, default 100)." },
        order: {
          type: "array",
          items: { type: "string" },
          description: "Full permutation of existing layer IDs (required for reorder).",
        },
      },
      required: ["board", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "add_link_card",
    description: "Parse and add a validated GitHub, Linear, or Jira rich link card element to a board via Protocol v1.1 WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID." },
        url: { type: "string", description: "Strict https:// URL for a GitHub issue/PR/discussion, Linear issue, or Jira issue." },
        x: { type: "number", description: "X coordinate on the canvas (default 0)." },
        y: { type: "number", description: "Y coordinate on the canvas (default 0)." },
        width: { type: "number", exclusiveMinimum: 0, description: "Optional card width (default 340)." },
        height: { type: "number", exclusiveMinimum: 0, description: "Optional card height (default 112)." },
        title: { type: "string", description: "Optional display title override." },
        layer: { type: "string", description: "Optional target layer ID (default 'base')." },
        id: { type: "string", description: "Optional element ID." },
      },
      required: ["board", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "list_frames",
    description: "List all live frames on a board with { id, name, x, y, width, height, layer }.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID." },
      },
      required: ["board"],
      additionalProperties: false,
    },
  },
  {
    name: "manage_views",
    description: "List, create, or delete Named Presentation Views ({ id, name, frameId, visibleLayers }) in appState.herdr.views.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID." },
        action: {
          type: "string",
          enum: ["list", "create", "delete"],
          description: "View management action to perform.",
        },
        id: { type: "string", description: "View ID (optional for create; required for delete)." },
        name: { type: "string", description: "View display name (required for create, max 200 chars)." },
        frameId: { type: ["string", "null"], description: "Optional target frame ID (default null)." },
        visibleLayers: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of visible layer IDs (defaults to currently visible layers on create).",
        },
      },
      required: ["board", "action"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

/**
 * Dispatch one MCP tool call against a Plenary client instance.
 * @param {any} client
 * @param {string} name
 * @param {Record<string, any>} [args]
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function executeTool(client, name, args = {}, { signal } = {}) {
  const withSig = { ...(args ?? {}), ...(signal ? { signal } : {}) };
  switch (name) {
    case "list_boards": return client.listBoards(withSig);
    case "create_board": return client.createBoard(withSig);
    case "create_share_link": return client.createShareLink(withSig);
    case "get_audit": return client.getAudit(withSig);
    case "read_board": return client.readBoard(withSig);
    case "add_elements": return client.addElements(withSig);
    case "update_elements": return client.updateElements(withSig);
    case "delete_elements": return client.deleteElements(withSig);
    case "set_animation": return client.setAnimation(withSig);
    case "manage_layers": return client.manageLayers(withSig);
    case "add_link_card": return client.addLinkCard(withSig);
    case "list_frames": return client.listFrames(withSig);
    case "manage_views": return client.manageViews(withSig);
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
 * @param {{ env?: Record<string, string | undefined>, clientFactory?: () => any }} [opts]
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
          ...(err?.details !== undefined ? { details: err.details } : {}),
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

/**
 * Run the line-delimited JSON-RPC 2.0 stdio transport loop with concurrent dispatch and line-size cap.
 * @param {{ env?: Record<string, string | undefined>, stdin?: any, stdout?: any, stderr?: any, clientFactory?: () => any, maxLineBytes?: number }} [opts]
 */
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
      Promise.allSettled([...inFlight]).then(() => resolve(undefined), reject);
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
