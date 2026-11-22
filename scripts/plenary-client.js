// @ts-check
// Shared Plenary HTTP Admin API + Protocol v1.1 WebSocket client for AI agents (CLI & MCP).
// Zero extra dependencies: only Bun/Node built-ins and workspace packages.

import { Replica } from "../packages/protocol/replica.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { ELEMENT_STREAMS, MAX_ID_CHARS } from "../packages/protocol/envelope.js";
import { makeElement, newId } from "../packages/core/model.js";
import { mermaidToElements } from "../packages/core/mermaid.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
const NOTE_DEFAULTS = { width: 200, height: 140, backgroundColor: "#fef08a", strokeColor: "#1e1e1e" };
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_ELEMENT_TYPES = new Set([
  "rectangle", "ellipse", "diamond", "frame", "arrow", "line", "freedraw", "text",
]);
const BOXY_TYPES = new Set(["rectangle", "ellipse", "diamond", "frame"]);
const LINEAR_TYPES = new Set(["arrow", "line", "freedraw"]);

export class PlenaryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, details?: unknown }} [opts]
   */
  constructor(message, { code = "plenary-error", status, details } = {}) {
    super(message);
    this.name = "PlenaryError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** Redact credentials, query strings, and fragments from a URL before placing it in an error message. */
export function redactUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return String(rawUrl).replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
  }
}

/** Validate a board ID (alphanumeric, `_`, `-`, 1..64 chars; rejects `.` and `..`). */
export function assertBoardId(board) {
  if (typeof board !== "string" || !BOARD_ID_RE.test(board.trim())) {
    throw new PlenaryError("board id must match /^[A-Za-z0-9_-]{1,64}$/", { code: "bad-request" });
  }
  return board.trim();
}

/** Normalize base HTTP(S) URL (strips query, hash, and trailing slashes). */
export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new PlenaryError("PLENARY_URL (or --url) is required", { code: "config-error" });
  }
  let u;
  try { u = new URL(rawUrl.trim()); }
  catch { throw new PlenaryError(`invalid PLENARY_URL: ${redactUrl(rawUrl)}`, { code: "config-error" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new PlenaryError(`PLENARY_URL must use http:// or https:// (got ${u.protocol})`, { code: "config-error" });
  }
  u.search = "";
  u.hash = "";
  return u.href.replace(/\/+$/, "");
}

/** Derive the Protocol v1.1 WebSocket URL (`/ws`) from an HTTP(S) base URL. */
export function toWsUrl(baseUrl) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/ws";
  u.search = "";
  u.hash = "";
  return u.href;
}

function assertFiniteNum(val, name) {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new PlenaryError(`${name} must be a finite number`, { code: "bad-request" });
  }
  return val;
}

function assertString(val, name, { allowNull = false } = {}) {
  if (allowNull && val === null) return null;
  if (typeof val !== "string") {
    throw new PlenaryError(`${name} must be a string`, { code: "bad-request" });
  }
  return val;
}

function assertBoolean(val, name) {
  if (typeof val !== "boolean") {
    throw new PlenaryError(`${name} must be a boolean`, { code: "bad-request" });
  }
  return val;
}

function assertPoints(val, name = "points") {
  if (!Array.isArray(val) || val.length === 0) {
    throw new PlenaryError(`${name} must be a non-empty array of [x, y] pairs`, { code: "bad-request" });
  }
  return val.map((pt, idx) => {
    if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number"
      || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new PlenaryError(`${name}[${idx}] must be a [finiteNumber, finiteNumber] pair`, { code: "bad-request" });
    }
    return [pt[0], pt[1]];
  });
}

/**
 * Validate and normalize a caller-supplied element spec into a complete Plenary element.
 * Copies only allowlisted fields per element type and strips protocol-internal fields
 * (`isDeleted`, `version`, `versionNonce`, `customData`, `boundElements`, etc.).
 */
export function normalizeElement(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlenaryError("each element must be an object", { code: "bad-request" });
  }
  let type = "rectangle";
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !ALLOWED_ELEMENT_TYPES.has(raw.type)) {
      throw new PlenaryError(`unsupported element type: ${String(raw.type)}`, { code: "bad-request" });
    }
    type = raw.type;
  }

  const fields = {};

  // Optional caller-supplied id (validated against MAX_ID_CHARS)
  if (raw.id !== undefined) {
    const id = assertString(raw.id, "id");
    if (!id.length || id.length > MAX_ID_CHARS) {
      throw new PlenaryError(`id must be 1..${MAX_ID_CHARS} characters`, { code: "bad-request" });
    }
    fields.id = id;
  }

  // Common numeric fields
  for (const k of ["x", "y", "width", "height", "angle", "strokeWidth", "roughness", "opacity"]) {
    if (raw[k] !== undefined) fields[k] = assertFiniteNum(raw[k], k);
  }
  // Common string fields
  for (const k of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"]) {
    if (raw[k] !== undefined) fields[k] = assertString(raw[k], k);
  }
  if (raw.link !== undefined) fields.link = assertString(raw.link, "link", { allowNull: true });
  if (raw.locked !== undefined) fields.locked = assertBoolean(raw.locked, "locked");
  if (raw.roundness !== undefined) {
    if (raw.roundness === null) {
      fields.roundness = null;
    } else if (typeof raw.roundness === "object" && !Array.isArray(raw.roundness)
      && typeof raw.roundness.type === "number" && Number.isFinite(raw.roundness.type)) {
      fields.roundness = {
        type: raw.roundness.type,
        ...(raw.roundness.value !== undefined ? { value: assertFiniteNum(raw.roundness.value, "roundness.value") } : {}),
      };
    } else {
      throw new PlenaryError("roundness must be null or { type: number }", { code: "bad-request" });
    }
  }

  // Type-specific allowlisted fields
  if (type === "text") {
    if (raw.text !== undefined) fields.text = assertString(raw.text, "text");
    if (raw.originalText !== undefined) fields.originalText = assertString(raw.originalText, "originalText");
    else if (fields.text !== undefined) fields.originalText = fields.text;
    if (raw.fontSize !== undefined) fields.fontSize = assertFiniteNum(raw.fontSize, "fontSize");
    if (raw.lineHeight !== undefined) fields.lineHeight = assertFiniteNum(raw.lineHeight, "lineHeight");
    if (raw.fontFamily !== undefined) {
      if (typeof raw.fontFamily === "number" && Number.isFinite(raw.fontFamily)) fields.fontFamily = raw.fontFamily;
      else if (typeof raw.fontFamily === "string" && raw.fontFamily.length) fields.fontFamily = raw.fontFamily;
      else throw new PlenaryError("fontFamily must be a finite number or non-empty string", { code: "bad-request" });
    }
    if (raw.textAlign !== undefined) fields.textAlign = assertString(raw.textAlign, "textAlign");
    if (raw.verticalAlign !== undefined) fields.verticalAlign = assertString(raw.verticalAlign, "verticalAlign");
    if (raw.autoResize !== undefined) fields.autoResize = assertBoolean(raw.autoResize, "autoResize");
  }

  if (type === "frame" && raw.name !== undefined) {
    fields.name = assertString(raw.name, "name", { allowNull: true });
  }

  if (LINEAR_TYPES.has(type)) {
    if (raw.points !== undefined) fields.points = assertPoints(raw.points, "points");
    if (type === "arrow" || type === "line") {
      if (raw.startArrowhead !== undefined) fields.startArrowhead = assertString(raw.startArrowhead, "startArrowhead", { allowNull: true });
      if (raw.endArrowhead !== undefined) fields.endArrowhead = assertString(raw.endArrowhead, "endArrowhead", { allowNull: true });
      if (raw.elbowed !== undefined) fields.elbowed = assertBoolean(raw.elbowed, "elbowed");
    }
    if (type === "freedraw") {
      if (raw.pressures !== undefined) {
        if (!Array.isArray(raw.pressures) || !raw.pressures.every(p => typeof p === "number" && Number.isFinite(p))) {
          throw new PlenaryError("pressures must be an array of finite numbers", { code: "bad-request" });
        }
        fields.pressures = [...raw.pressures];
      }
      if (raw.simulatePressure !== undefined) fields.simulatePressure = assertBoolean(raw.simulatePressure, "simulatePressure");
    }
  }

  if (BOXY_TYPES.has(type)) {
    if (fields.width === undefined) fields.width = 160;
    if (fields.height === undefined) fields.height = 80;
  }

  return makeElement(type, fields);
}

/**
 * Create a Plenary client speaking both the HTTP Admin API and Protocol v1.1 WebSockets.
 * @param {{ url?: string, token?: string, timeoutMs?: number, clientName?: string }} opts
 */
export function createPlenaryClient({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS, clientName = "plenary-agent" } = {}) {
  const baseUrl = normalizeBaseUrl(url);
  if (typeof token !== "string" || !token.trim()) {
    throw new PlenaryError("PLENARY_TOKEN (or --token) is required", { code: "config-error" });
  }
  const authToken = token.trim();
  const wsUrl = toWsUrl(baseUrl);
  const safeWsUrl = redactUrl(wsUrl);

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, any>, body?: any, signal?: AbortSignal }} [opts]
   */
  async function requestJson(method, path, { query, body, signal } = {}) {
    if (signal?.aborted) {
      throw new PlenaryError("request cancelled", { code: "cancelled" });
    }
    const target = new URL(baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") target.searchParams.set(k, String(v));
      }
    }
    const headers = { authorization: `Bearer ${authToken}` };
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSig, signal]) : timeoutSig;
    const init = { method, headers, signal: combinedSignal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(target.href, init);
    } catch (err) {
      if (signal?.aborted) {
        throw new PlenaryError("request cancelled", { code: "cancelled" });
      }
      throw new PlenaryError(`HTTP ${method} ${path} failed: ${err?.message ?? err}`, { code: "network-error" });
    }
    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
      const code = typeof parsed?.error === "string" ? parsed.error : `http-${res.status}`;
      const msg = typeof parsed?.message === "string"
        ? `${code}: ${parsed.message}`
        : `HTTP ${res.status} ${method} ${path} (${code})`;
      throw new PlenaryError(msg, { code, status: res.status, details: parsed });
    }
    return parsed;
  }

  /**
   * Open a short-lived Protocol v1.1 WebSocket session on `board`, catch up via Replica,
   * run `fn(session)`, and always close the socket and clear timers cleanly.
   * @param {string} board
   * @param {(session: { replica: Replica, commitOp: (stream: string, op: any) => Promise<{ opId: string, seq: number }>, board: string }) => Promise<any>} fn
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function withBoardSession(board, fn, { signal } = {}) {
    const boardId = assertBoardId(board);
    if (signal?.aborted) {
      throw new PlenaryError("request cancelled", { code: "cancelled" });
    }

    const replica = new Replica({ client: clientName, tab: "agent" });
    const ws = new WebSocket(wsUrl);

    let closed = false;
    let pumpTimer = null;
    let deadlineTimer = null;
    let connectSettled = false;
    let resolveReady, rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

    /** @type {Map<string, { resolve: Function, reject: Function, ackSeq: number | null }>} */
    const waiters = new Map();

    const failAll = err => {
      if (!connectSettled) {
        connectSettled = true;
        rejectReady(err);
      }
      for (const [id, w] of waiters) {
        waiters.delete(id);
        w.reject(err);
      }
    };

    const onAbort = () => {
      failAll(new PlenaryError("request cancelled", { code: "cancelled" }));
      cleanup();
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (!closed) {
        closed = true;
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "done");
          }
        } catch { /* already closed */ }
      }
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const sendFrame = msg => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(/** @type {string | ArrayBufferView<ArrayBuffer>} */ (jsonCodec.encode(msg)));
    };

    const pump = () => {
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      if (closed) return;
      if (replica.stopped) {
        failAll(new PlenaryError(`protocol stopped: ${replica.stopped}`, { code: replica.stopped }));
        return;
      }
      if (replica.needAuth) {
        failAll(new PlenaryError("authentication failed", { code: "auth" }));
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const m of replica.outgoing()) sendFrame(m);
      if (replica.resync) {
        failAll(new PlenaryError("connection requires resync", { code: "resync" }));
        return;
      }
      const w = replica.wait();
      if (w !== null) {
        pumpTimer = setTimeout(pump, Math.max(1, w));
        pumpTimer.unref?.();
      }
    };

    const checkReady = () => {
      if (connectSettled) return;
      if (replica.welcomed && !replica.awaitingSnapshot && replica.applied >= replica.target) {
        connectSettled = true;
        resolveReady();
      }
    };

    deadlineTimer = setTimeout(() => {
      failAll(new PlenaryError(`timed out after ${timeoutMs}ms waiting for board ${boardId}`, { code: "timeout" }));
      cleanup();
    }, timeoutMs);
    deadlineTimer.unref?.();

    const closeDone = new Promise(resolve => {
      ws.onclose = e => {
        closed = true;
        if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
        failAll(new PlenaryError(`WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`, { code: "ws-closed" }));
        resolve(undefined);
      };
    });

    ws.onerror = () => {
      failAll(new PlenaryError(`WebSocket error connecting to ${safeWsUrl}`, { code: "ws-error" }));
    };

    ws.onopen = () => {
      for (const m of replica.connectMessages(authToken, boardId)) sendFrame(m);
      pump();
    };

    ws.onmessage = e => {
      let msg;
      try { msg = jsonCodec.decode(e.data); }
      catch { return; }

      if (msg.t === "error") {
        const err = new PlenaryError(msg.message ?? msg.code ?? "server error", { code: msg.code ?? "server-error" });
        if (msg.id && waiters.has(msg.id)) {
          const w = waiters.get(msg.id);
          waiters.delete(msg.id);
          replica.receive(msg);
          w.reject(err);
          pump();
          return;
        }
        replica.receive(msg);
        failAll(err);
        return;
      }

      if (msg.t === "ack" && msg.id && waiters.has(msg.id)) {
        waiters.get(msg.id).ackSeq = msg.seq;
      }

      const did = replica.receive(msg);
      checkReady();

      for (const settledId of did.settled) {
        const w = waiters.get(settledId);
        if (w) {
          waiters.delete(settledId);
          const entrySeq = did.entries.find(entry => entry.id === settledId)?.seq;
          w.resolve({ opId: settledId, seq: entrySeq ?? w.ackSeq ?? replica.applied });
        }
      }
      for (const droppedId of did.dropped) {
        const w = waiters.get(droppedId);
        if (w) {
          waiters.delete(droppedId);
          w.reject(new PlenaryError(`op ${droppedId} was dropped by server`, { code: "op-dropped" }));
        }
      }
      pump();
    };

    const commitOp = (stream, op) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PlenaryError("request cancelled", { code: "cancelled" }));
        return;
      }
      let msg;
      try { msg = replica.local(stream, op); }
      catch (err) { reject(new PlenaryError(err?.message ?? String(err), { code: "bad-op" })); return; }
      if (!msg?.id) {
        reject(new PlenaryError("op was held instead of queued", { code: "op-held" }));
        return;
      }
      waiters.set(msg.id, { resolve, reject, ackSeq: null });
      pump();
    });

    try {
      await readyPromise;
      return await fn({ replica, commitOp, board: boardId });
    } finally {
      cleanup();
      await Promise.race([closeDone, new Promise(r => { const t = setTimeout(r, 200); t.unref?.(); })]);
    }
  }

  return {
    baseUrl,
    wsUrl,

    /**
     * GET /boards
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async listBoards(opts = {}) {
      return requestJson("GET", "/boards", { signal: opts.signal });
    },

    /**
     * POST /boards
     * @param {{ title?: string, memberRole?: string, signal?: AbortSignal }} [opts]
     */
    async createBoard({ title, memberRole, signal } = {}) {
      const body = {};
      if (title !== undefined) body.title = title;
      if (memberRole !== undefined) body.memberRole = memberRole;
      return requestJson("POST", "/boards", { body, signal });
    },

    /**
     * POST /boards/:board/links
     * @param {{ board?: string, role?: string, expiresAt?: string | number | null, signal?: AbortSignal }} [opts]
     */
    async createShareLink({ board, role = "viewer", expiresAt, signal } = {}) {
      const boardId = assertBoardId(board);
      const body = { role };
      if (expiresAt !== undefined && expiresAt !== null) body.expiresAt = expiresAt;
      return requestJson("POST", `/boards/${encodeURIComponent(boardId)}/links`, { body, signal });
    },

    /**
     * GET /boards/:board/audit (board-scoped) or GET /admin/audit (tenant-scoped)
     * @param {{ board?: string, limit?: number, before?: string | number, scope?: "board" | "tenant" | string, signal?: AbortSignal }} [opts]
     */
    async getAudit({ board, limit, before, scope, signal } = {}) {
      if (scope !== undefined && scope !== "board" && scope !== "tenant") {
        throw new PlenaryError("scope must be 'board' or 'tenant'", { code: "bad-request" });
      }
      if (scope === "board" && !board) {
        throw new PlenaryError("board is required when scope is 'board'", { code: "bad-request" });
      }
      const boardId = board ? assertBoardId(board) : undefined;
      const useTenant = scope === "tenant" || !boardId;
      if (useTenant) {
        return requestJson("GET", "/admin/audit", { query: { board: boardId, limit, before }, signal });
      }
      return requestJson("GET", `/boards/${encodeURIComponent(boardId)}/audit`, { query: { limit, before }, signal });
    },

    /**
     * Connect via Protocol v1.1 WS, catch up via Replica, return full board state.
     * @param {{ board?: string, signal?: AbortSignal }} [opts]
     */
    async readBoard({ board, signal } = {}) {
      return withBoardSession(board, async ({ replica, board: boardId }) => {
        const elements = [...replica.streams.board.byId.values()]
          .filter(el => !el.isDeleted)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const notes = [...replica.streams.notes.byId.values()]
          .filter(el => !el.isDeleted)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const comments = replica.recordsState().threads;
        return {
          board: boardId,
          seq: replica.applied,
          role: replica.role,
          user: replica.user,
          elements,
          notes,
          comments,
          appState: replica.streams.board.appState.herdr,
        };
      }, { signal });
    },

    /**
     * Connect via Protocol v1.1 WS, push element ops, wait for ack/commit.
     * @param {{ board?: string, elements?: any[], stream?: string, signal?: AbortSignal }} [opts]
     */
    async addElements({ board, elements, stream = "board", signal } = {}) {
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      if (!Array.isArray(elements) || elements.length === 0) {
        throw new PlenaryError("elements must be a non-empty array", { code: "bad-request" });
      }
      const built = elements.map(normalizeElement);
      const seenIds = new Set();
      for (const el of built) {
        if (seenIds.has(el.id)) {
          throw new PlenaryError(`duplicate element id in batch: ${el.id}`, { code: "conflict" });
        }
        seenIds.add(el.id);
      }
      return withBoardSession(board, async ({ replica, commitOp, board: boardId }) => {
        const doc = replica.streams[stream];
        for (const el of built) {
          if (doc.getAny(el.id)) {
            throw new PlenaryError(`element id already exists: ${el.id}`, { code: "conflict" });
          }
        }
        const { opId, seq } = await commitOp(stream, { elements: built });
        return {
          board: boardId,
          stream,
          seq,
          opId,
          ids: built.map(e => e.id),
          count: built.length,
        };
      }, { signal });
    },

    /**
     * Parse Mermaid flowchart via packages/core/mermaid.js and push resulting elements over WS.
     * @param {{ board?: string, source?: string, origin?: { x?: number, y?: number }, layer?: string, elbow?: boolean, signal?: AbortSignal }} [opts]
     */
    async addMermaid({ board, source, origin, layer, elbow = false, signal } = {}) {
      if (typeof source !== "string" || !source.trim()) {
        throw new PlenaryError("source (Mermaid flowchart text) is required", { code: "bad-request" });
      }
      let normOrigin;
      if (origin !== undefined) {
        if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
          throw new PlenaryError("origin must be an object { x, y }", { code: "bad-request" });
        }
        normOrigin = {
          x: origin.x !== undefined ? assertFiniteNum(origin.x, "origin.x") : 0,
          y: origin.y !== undefined ? assertFiniteNum(origin.y, "origin.y") : 0,
        };
      }
      if (layer !== undefined) assertString(layer, "layer");

      let built;
      try {
        built = mermaidToElements(source, {
          ...(normOrigin ? { origin: normOrigin } : {}),
          ...(layer ? { layer } : {}),
          elbow: Boolean(elbow),
        });
      } catch (err) {
        throw new PlenaryError(`Mermaid parse error: ${err?.message ?? err}`, { code: "bad-mermaid" });
      }
      if (!built.elements.length) {
        throw new PlenaryError("Mermaid diagram produced no elements", { code: "bad-mermaid" });
      }
      return withBoardSession(board, async ({ commitOp, board: boardId }) => {
        const { opId, seq } = await commitOp("board", { elements: built.elements });
        return {
          board: boardId,
          seq,
          opId,
          ids: built.elements.map(e => e.id),
          count: built.elements.length,
          nodes: built.graph.nodes.size,
          edges: built.graph.edges.length,
        };
      }, { signal });
    },

    /**
     * Push a sticky note (rectangle + bound text) on the `notes` stream over WS.
     * @param {{ board?: string, text?: string, x?: number, y?: number, width?: number, height?: number, backgroundColor?: string, strokeColor?: string, signal?: AbortSignal }} [opts]
     */
    async addNote({
      board,
      text,
      x = 0,
      y = 0,
      width = NOTE_DEFAULTS.width,
      height = NOTE_DEFAULTS.height,
      backgroundColor = NOTE_DEFAULTS.backgroundColor,
      strokeColor = NOTE_DEFAULTS.strokeColor,
      signal,
    } = {}) {
      if (typeof text !== "string" || !text.trim()) {
        throw new PlenaryError("text is required for add_note", { code: "bad-request" });
      }
      const nx = assertFiniteNum(x, "x");
      const ny = assertFiniteNum(y, "y");
      const nw = assertFiniteNum(width, "width");
      const nh = assertFiniteNum(height, "height");
      if (nw <= 0 || nh <= 0) {
        throw new PlenaryError("width and height must be positive finite numbers", { code: "bad-request" });
      }
      const bg = assertString(backgroundColor, "backgroundColor");
      const sc = assertString(strokeColor, "strokeColor");

      const rect = makeElement("rectangle", {
        x: nx,
        y: ny,
        width: nw,
        height: nh,
        backgroundColor: bg,
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        strokeColor: sc,
      });
      const label = makeElement("text", {
        x: rect.x,
        y: rect.y,
        text,
        originalText: text,
        fontSize: 20,
        fontFamily: 2,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: rect.id,
      });
      rect.boundElements = [{ id: label.id, type: "text" }];

      return withBoardSession(board, async ({ commitOp, board: boardId }) => {
        const { opId, seq } = await commitOp("notes", { elements: [rect, label] });
        return {
          board: boardId,
          seq,
          opId,
          id: rect.id,
          textId: label.id,
          ids: [rect.id, label.id],
        };
      }, { signal });
    },

    /**
     * Push a comment thread (or reply to an existing thread) on the `records` stream over WS.
     * @param {{ board?: string, text?: string, x?: number, y?: number, thread?: string, element?: string, stream?: string, signal?: AbortSignal }} [opts]
     */
    async addComment({ board, text, x = 0, y = 0, thread, element, stream = "board", signal } = {}) {
      if (typeof text !== "string" || !text.length) {
        throw new PlenaryError("text is required for add_comment", { code: "bad-request" });
      }
      const nx = assertFiniteNum(x, "x");
      const ny = assertFiniteNum(y, "y");
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      const id = newId();
      let op;
      if (typeof thread === "string" && thread.trim()) {
        op = { do: "reply", id, thread: thread.trim(), text };
      } else {
        const anchor = typeof element === "string" && element.trim()
          ? { stream, element: element.trim(), x: nx, y: ny }
          : { point: { x: nx, y: ny } };
        op = { do: "thread", id, anchor, text };
      }

      return withBoardSession(board, async ({ commitOp, board: boardId }) => {
        const { opId, seq } = await commitOp("records", op);
        return {
          board: boardId,
          seq,
          opId,
          id,
          thread: op.do === "reply" ? op.thread : id,
          action: op.do,
        };
      }, { signal });
    },
  };
}
