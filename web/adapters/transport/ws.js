// Transport adapter: one board stream over a browser WebSocket. Implements web/ports/transport.js (contract test:
// test/web/contracts/transport-contract.js, run in test/web/adapters/transport-ws.test.js).
//
// Imports: its own port (web/ports/transport.js, for the limits) and packages/protocol/codec.js. The codec is the one
// protocol import a web adapter may make (the boundary test's allowlist: web/adapters/transport/ws.js →
// packages/protocol/codec.js). Nothing else from protocol, no other adapter, no core.
//
// Rules:
//   - One WebSocket per connection; each socket is a generation. reopen() detaches and closes the current socket
//     and opens a new one; from that moment nothing from an older socket (message, error, close) is delivered.
//   - send() before the socket is open queues on THAT socket (≤ maxQueued messages and ≤ maxQueuedBytes) and goes
//     out on open; a reopen drops the queue with the socket. Past either cap the link counts as dead: the socket is
//     closed at once and onDrop is reported on a later microtask (never on the caller's stack, p6-edgev LOW-2), and
//     only if that socket is still current by then (a reopen in between swallows it).
//   - Backpressure (the port's congested() and hard cap): backlog = queued bytes + ws.bufferedAmount. congested()
//     is backlog > watermark. Over hardCapBytes, a clock timer samples the backlog every sampleMs. Drain progress
//     between two samples = last backlog + bytes added since − backlog now (so a link that drains while the core
//     adds more still counts as moving). Over the cap with no progress for hardCapMs is a drop (closed, onDrop
//     once); any progress restarts the count, so a slow but moving link is never dropped (manager decision,
//     2026-11-12). The timer belongs to its socket and dies with it.
//   - onDrop: only the current socket's unasked close or error (connect refused, the server or a proxy closing, a
//     frame the codec rejects), at most once per socket. Never for reopen() or close().
//   - fail() (the dev hook dropConnection()): the current socket drops as an unasked close would (onDrop once).
//   - close() is final: the socket is closed, nothing more is delivered, send/reopen do nothing.
//   - No token here at all: the URL is used exactly as given and no subprotocol is passed (Sec-WebSocket-Protocol
//     is a header). The token travels only in the `hello` the core sends (PROTOCOL.md, Herdr refuses credential headers).
//   - Compressed catch-up (PROTOCOL.md § Joining): where the runtime can inflate (`inflate`: the root passes the browser's
//     DecompressionStream), the URL asks for it (`?z=deflate`; a capability, never a credential) and the
//     server then sends big catch-up texts as binary frames holding one zlib stream. Such a frame is inflated and
//     decoded like the text frame it stands for; frames are delivered in arrival order, so a text frame behind a
//     binary one waits for it. A frame that does not inflate is a bad frame: the socket drops, as for any the codec rejects.
//   - Never throws for a network reason; a frame it cannot decode never throws out of the socket's event handler (only
//     the core's own onMessage handler can, which is the core's bug to see). Retry and backoff live in
//     the core (Replica.reconnectWait), never here.

import { jsonCodec } from "../../../packages/protocol/codec.js";
import { CONGESTED_BYTES, HARD_CAP_BYTES, HARD_CAP_MS, HARD_CAP_SAMPLE_MS } from "../../ports/transport.js";

const CONNECTING = 0, OPEN = 1;

/** Bytes a frame takes on the wire: UTF-8 length of a text frame, byteLength of a binary one. */
export function frameBytes(data) {
  if (typeof data === "string") {
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  return data?.byteLength ?? data?.size ?? 0;
}

/** The browser's inflate (zlib stream → bytes), or null where there is no DecompressionStream (then the URL asks for nothing). */
export function browserInflate() {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Response !== "function") return null;
  return async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream("deflate"))).arrayBuffer());
}

/** `url` with `z=deflate` (§ Joining): this client can inflate catch-up. */
export function withDeflate(url) {
  const u = new URL(url);
  u.searchParams.set("z", "deflate");
  return u.toString();
}

/** The clock when the root passes none: the browser's timers (an adapter may touch globals). */
const globalClock = {
  mono: () => (globalThis.performance?.now?.() ?? Date.now()),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h),
};

/**
 * @param {{ url: string, WebSocket: new (url: string) => any,
 *           codec?: import("../../../packages/protocol/codec.js").Codec, maxQueued?: number, maxQueuedBytes?: number,
 *           clock?: Pick<import("../../ports/clock.js").Clock, "mono" | "set" | "clear">,
 *           inflate?: ((bytes: Uint8Array) => Promise<Uint8Array>) | null,
 *           watermark?: number, hardCapBytes?: number, hardCapMs?: number, sampleMs?: number }} o
 *   url: the gateway's ws(s)://…/ws URL (the composition root derives it from the page's origin).
 *   WebSocket: the constructor (the root passes globalThis.WebSocket; tests pass a fake). codec: default JSON.
 *   clock: the clock port (the root passes it; without one, the global timers). The limits default to the port's.
 *   inflate: how to inflate a compressed catch-up frame (the root passes browserInflate()); default none: the URL asks for no compression.
 *   Used with the JSON codec only (a binary codec's frames are its own).
 * @returns {import("../../ports/transport.js").Transport}
 */
export function wsTransport({ url, WebSocket: WS, codec = jsonCodec, maxQueued = 1024, maxQueuedBytes = HARD_CAP_BYTES,
  clock = globalClock, watermark = CONGESTED_BYTES, hardCapBytes = HARD_CAP_BYTES, hardCapMs = HARD_CAP_MS,
  sampleMs = HARD_CAP_SAMPLE_MS, inflate = null }) {
  if (typeof WS !== "function") throw new TypeError("wsTransport: WebSocket constructor is required");
  if (codec !== jsonCodec) inflate = null;
  const target = inflate ? withDeflate(url) : url;
  let done = false;
  let onMsg = () => {};
  /** @type {(() => void) | null} */
  let onDrop = null;
  /** @type {{ ws: any, queue: any[], queueBytes: number, dropped: boolean, overSince: number | null, timer: any,
   *            lastBacklog: number, added: number } | null} */
  let cur = null;

  /** Stop listening to a socket and close it (a close the client asked for: never reported). */
  function retire(c) {
    if (!c) return;
    c.dropped = true;
    c.queue = [];
    c.queueBytes = 0;
    if (c.timer !== null) { try { clock.clear(c.timer); } catch {} c.timer = null; }
    const ws = c.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(1000); } catch {}
  }

  /** The current socket died without the client asking: report it once, then let the core reopen. */
  function fail(c) {
    if (c !== cur || c.dropped || done) return;
    retire(c);
    try { onDrop?.(); } catch {}
  }

  /** A drop found inside send(): the socket is closed now, the report waits a microtask (and a reopen voids it). */
  function failLater(c) {
    if (c !== cur || c.dropped || done) return;
    retire(c);
    Promise.resolve().then(() => { if (c === cur && !done) { try { onDrop?.(); } catch {} } });
  }

  /** Outbound bytes not yet on the wire for this socket. */
  function backlog(c) {
    let b = 0;
    try { b = Number(c.ws?.bufferedAmount) || 0; } catch {}
    return c.queueBytes + b;
  }

  /** Hard cap: start sampling when the backlog passes the cap. A sample at or under it ends the hold; a sample that
   *  saw bytes leave restarts it; hardCapMs over the cap with nothing leaving is a drop. */
  function watchCap(c) {
    if (c.timer !== null || c.dropped || backlog(c) <= hardCapBytes) return;
    c.overSince = clock.mono();
    c.lastBacklog = backlog(c);
    c.added = 0;
    const sample = () => {
      c.timer = null;
      if (c !== cur || c.dropped || done) return;
      const b = backlog(c);
      if (b <= hardCapBytes) { c.overSince = null; return; }
      const drained = c.lastBacklog + c.added - b;
      c.lastBacklog = b; c.added = 0;
      if (drained > 0) c.overSince = clock.mono();
      else if (clock.mono() - c.overSince >= hardCapMs) { fail(c); return; }
      c.timer = clock.set(sample, sampleMs);
    };
    c.timer = clock.set(sample, sampleMs);
  }

  function open() {
    retire(cur);
    cur = null;
    if (done) return;
    const c = { ws: null, queue: [], queueBytes: 0, dropped: false, overSince: null, timer: null, lastBacklog: 0, added: 0, order: Promise.resolve(), behind: 0 };
    cur = c;
    try { c.ws = new WS(target); } catch {
      Promise.resolve().then(() => fail(c));            // a bad URL: a drop like any other, never a throw
      return;
    }
    const ws = c.ws;
    try { ws.binaryType = "arraybuffer"; } catch {}
    ws.onopen = () => {
      if (c !== cur || c.dropped) return;
      const q = c.queue;
      c.queue = [];
      c.queueBytes = 0;
      for (const data of q) {
        try { ws.send(data); } catch { fail(c); return; }
      }
      watchCap(c);
    };
    const deliver = data => {
      if (c !== cur || c.dropped || done) return;
      let msg;
      try { msg = codec.decode(data); } catch { fail(c); return; }
      onMsg(msg);
    };
    ws.onmessage = e => {
      if (c !== cur || c.dropped || done) return;
      if (!inflate || (typeof e.data === "string" && c.behind === 0)) { deliver(e.data); return; }
      // Behind a frame still inflating, or itself compressed: in arrival order, through the chain.
      c.behind++;
      c.order = c.order.then(async () => {
        let data = e.data;
        try {   // only the inflate step is a "bad frame"; what deliver (the core's handler) throws is a bug, never a reconnect
          if (typeof data !== "string") {
            const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
            data = new TextDecoder().decode(await inflate(bytes));
          }
        } catch { c.behind--; fail(c); return; }
        c.behind--;
        try { deliver(data); } catch (err) { queueMicrotask(() => { throw err; }); }   // surfaces like the text path's throw; the chain lives on
      });
    };
    ws.onerror = () => fail(c);
    ws.onclose = () => fail(c);
  }

  open();

  return {
    send(msg) {
      const c = cur;
      if (done || !c || c.dropped || !c.ws) return;
      const data = codec.encode(msg);                    // a message the codec can't encode is a bug: it throws
      const state = c.ws.readyState;
      if (state === OPEN) {
        try { c.ws.send(data); } catch { failLater(c); return; }
        c.added += frameBytes(data);
        watchCap(c);
      } else if (state === CONNECTING) {
        c.queue.push(data);
        const n = frameBytes(data);
        c.queueBytes += n;
        c.added += n;
        if (c.queue.length > maxQueued || c.queueBytes > maxQueuedBytes) failLater(c);
        else watchCap(c);
      }
      // CLOSING / CLOSED: the close event reports the drop.
    },
    onMessage(fn) { onMsg = fn; },
    onDrop(fn) { onDrop = fn; },
    congested() {
      const c = cur;
      if (done || !c || c.dropped) return false;
      return backlog(c) > watermark;
    },
    /** The current connection's backlog in bytes (queued before open + bufferedAmount); 0 when closed or dropped. */
    backlogBytes() {
      const c = cur;
      if (done || !c || c.dropped) return 0;
      return backlog(c);
    },
    reopen() { if (!done) open(); },
    /** Dev/test hook (session.dropConnection): the current socket drops as if the network cut it: closed, and onDrop
     *  reported once, exactly like an unasked close (p8-one-linkv L6). Does nothing after close() or with no socket. */
    fail() { if (cur) fail(cur); },
    close() { done = true; retire(cur); cur = null; },
  };
}

const SHA1 = /^[0-9a-f]{40}$/;
const RASTER = /^image\/(png|jpeg|gif|webp)$/;
const RETRY_STATUS = new Set([401, 404, 408, 429, 500, 502, 503, 504]);   // 401: the 5-minute URL ran out; 404: a GET before the upload landed
const RETRY_CODES = new Set(["limit", "unavailable", "auth"]);             // a refused `blob` request that can pass (PROTOCOL.md § Blobs)
const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * HTTP snapshot fetch adapter (F9, implements web/ports/net.js's `fetchSnapshot`).
 * Resolves relative snapshot URLs against `origin` and refuses cross-origin URLs.
 * @param {{ origin?: string, fetch?: typeof globalThis.fetch }} [o]
 * @returns {import("../../ports/net.js").FetchSnapshot}
 */
export function httpSnapshotFetcher({ origin = null, fetch: fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  const base = origin ? new URL(origin) : null;
  return async function fetchSnapshot(url, { signal } = {}) {
    if (typeof url !== "string" || !url) throw new Error("fetchSnapshot: url is required");
    let target = url;
    if (base) {
      const resolved = new URL(url, base);
      if (resolved.origin !== base.origin) throw new Error("fetchSnapshot: cross-origin snapshot url refused");
      target = resolved.href;
    } else if (!url.startsWith("/") || url.startsWith("//")) {
      throw new Error("fetchSnapshot: relative path required without origin");
    }
    const res = await fetchFn(target, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res?.ok) throw new Error(`fetchSnapshot: HTTP ${res?.status ?? "error"}`);
    const snap = await res.json();
    if (
      !snap || typeof snap !== "object" || snap.t !== "snapshot" ||
      !Number.isInteger(snap.seq) ||
      !snap.streams || typeof snap.streams !== "object" ||
      !snap.streams.board || !Array.isArray(snap.streams.board.elements) ||
      !snap.streams.notes || !Array.isArray(snap.streams.notes.elements)
    ) throw new Error("fetchSnapshot: invalid snapshot payload");
    return snap;
  };
}

/**
 * HTTP blob upload/fetch adapter (PROTOCOL.md § Blobs, implements web/ports/net.js's `uploadBlob` and `fetchBlob`).
 * Resolves relative signed URLs against `origin` and refuses cross-origin URLs.
 * @param {{ origin?: string, fetch?: typeof globalThis.fetch }} [o]
 */
export function httpBlobClient({ origin = null, fetch: fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  const base = origin ? new URL(origin) : null;
  function resolveUrl(url, label) {
    if (typeof url !== "string" || !url) throw new Error(`${label}: url is required`);
    if (base) {
      const resolved = new URL(url, base);
      if (resolved.origin !== base.origin) throw new Error(`${label}: cross-origin blob url refused`);
      return resolved.href;
    }
    if (!url.startsWith("/") || url.startsWith("//")) throw new Error(`${label}: relative path required without origin`);
    return url;
  }
  return {
    /** @type {import("../../ports/net.js").UploadBlob} */
    async uploadBlob(url, bytes, mimeType, { signal } = {}) {
      const target = resolveUrl(url, "uploadBlob");
      const res = await fetchFn(target, {
        method: "PUT",
        headers: mimeType ? { "content-type": mimeType } : {},
        body: bytes,
        ...(signal ? { signal } : {}),
      });
      if (!res?.ok) throw new Error(`uploadBlob: HTTP ${res?.status ?? "error"}`);
    },
    /** @type {import("../../ports/net.js").FetchBlob} */
    async fetchBlob(url, { signal } = {}) {
      const target = resolveUrl(url, "fetchBlob");
      const res = await fetchFn(target, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!res?.ok) throw new Error(`fetchBlob: HTTP ${res?.status ?? "error"}`);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const mimeType = (res.headers?.get?.("content-type") || "application/octet-stream").split(";")[0].trim();
      const dataURL = mimeType.startsWith("video/") ? null : `data:${mimeType};base64,${b64(bytes)}`;
      return { bytes, mimeType, dataURL };
    },
  };
}

/**
 * The picture path of wsNet (PROTOCOL.md § Blobs, "Client rules"): bytes go to and from the server's blob store through
 * signed URLs, which the gateway hands out over the tab's ONE board connection (a second socket would eat one of the
 * tab's two connection slots). It wraps each transport join() makes: `welcome`, `blob` replies and `sha1`-tagged
 * `error`s are read here, everything else passes through untouched; the session never sees a blob message.
 *   - One `blob` request in flight, at least 120 ms apart (the gateway allows 10 a second). Transfers have their own
 *     slots: at most 2 PUTs (the server allows an account 2) and 4 GETs at once.
 *   - Nothing is asked before `welcome` and the asks are repeated after every reconnect.
 *   - A failure that can pass is tried again with backoff on a fresh URL, up to 6 tries; then the task rests (a download
 *     waits for want(), an upload wakes itself) and revives on the next welcome. A task has ONE timer (`t.timer`), and
 *     enqueue() clears it: a stale wake-up can never re-queue a task that moved on.
 *   - `limit` and a PUT's 503 `busy` / 409 `in-flight` are not failed tries: `limit` backs off past the put window,
 *     `busy` waits the server's Retry-After and sends the SAME URL again while it is still valid (no new ask).
 *   - A picture the server doesn't have (404) rests longer each round (30 s doubling to 10 min) until a want() brings a
 *     new `stamp` (a document change touching that file) or the connection is welcomed again.
 *   - A final failure of an upload (quota, forbidden, not an image, too large, …) is reported through onFail; so is the
 *     first wait for limit / busy / gave-up, with `retrying: true`.
 * @param {{ fetch: typeof fetch, clock: Pick<import("../../ports/clock.js").Clock, "mono" | "set" | "clear">, base: string }} o  base: the http(s) origin of the gateway
 */
function blobClient({ fetch: fetchFn, clock, base }) {
  const GAP_MS = 120, ASK_TIMEOUT_MS = 10_000, MAX_TRIES = 6, MAX_LIMITS = 20, MAX_BUSY = 60, REST_MS = 30_000, MAX_REST_MS = 600_000;
  const CAP = { PUT: 2, GET: 4 };                                  // transfers at once, per verb
  const XFER_TIMEOUT_MS = { PUT: 150_000, GET: 30_000 };           // a PUT may take the server's whole 120 s body deadline
  const URL_FRESH_MS = 240_000;                                    // a signed URL lasts 5 minutes: reuse it for 4
  /** key `${verb}:${sha1}` → { verb, id, file?, tries, limits, busies, rests, stamp, url, urlAt, state: "idle" | "asking" | "xfer" | "done" | "rest", timer, until } */
  const tasks = new Map();
  const queue = [];
  const slots = { PUT: 0, GET: 0 };
  const fileFns = new Set(), failFns = new Set();
  let link = null, live = false, inflight = null, lastAsk = -Infinity, gapTimer = null;

  /** The server may answer a path (no PUBLIC_URL): it is relative to where this client connected. */
  const resolve = u => { try { return new URL(u, base).href; } catch { return u; } };
  const emit = (fns, v) => { for (const fn of fns) { try { fn(v); } catch {} } };
  const clearTimer = t => { if (t.timer != null) { clock.clear(t.timer); t.timer = null; } };
  const tell = (t, code) => emit(failFns, { id: t.id, verb: t.verb, code, retrying: true });
  /** Put a task in line (any timer it still holds is stale: it is cleared here, in the one place every route goes through). */
  const enqueue = t => { if (t.state === "done") return; clearTimer(t); t.state = "idle"; if (!queue.includes(t)) queue.push(t); pump(); };
  const finish = t => { clearTimer(t); t.state = "done"; t.file = undefined; t.url = null; };
  /** Rest. An upload wakes itself after REST_MS (a picture someone placed must go up eventually); a download rests longer each round and waits for want(). */
  function rest(t, wake = false) {
    clearTimer(t); t.state = "rest"; t.url = null;
    if (t.verb === "GET") t.until = clock.mono() + Math.min(MAX_REST_MS, REST_MS * 2 ** (t.rests++));
    else t.until = clock.mono() + REST_MS;
    if (wake && t.verb === "PUT") t.timer = clock.set(() => { t.timer = null; if (t.state !== "rest") return; t.tries = t.limits = t.busies = 0; enqueue(t); }, REST_MS);
  }
  /**
   * A failure that can pass: ask again after a backoff. A `limit` (the gateway's rate, PROTOCOL.md § Blobs) is not a
   * failed try: it backs off past the put window instead (2, 4, 8, 16, then 30 s) and is told to the user once.
   */
  function retry(t, limited = false) {
    clearTimer(t); t.url = null;
    if (limited) {
      if (t.verb === "PUT" && !t.toldLimit) { t.toldLimit = true; tell(t, "limit"); }
      if (++t.limits > MAX_LIMITS) return rest(t, true);
    } else if (++t.tries >= MAX_TRIES) {
      if (t.verb === "PUT" && !t.toldGaveUp) { t.toldGaveUp = true; tell(t, "gave-up"); }
      return rest(t, true);
    }
    t.state = "idle";
    const wait = limited ? Math.min(30_000, 2000 * 2 ** Math.min(t.limits - 1, 4)) : Math.min(30_000, 1000 * 2 ** (t.tries - 1));
    t.timer = clock.set(() => { t.timer = null; enqueue(t); }, wait * (0.5 + Math.random() / 2));
  }
  /** The server was reachable but full (503 busy) or reading this token already (409): wait its Retry-After, then send the same URL again. Not a failed try. */
  function busy(t, retryAfter) {
    clearTimer(t);
    if (!t.toldBusy) { t.toldBusy = true; tell(t, "busy"); }
    if (++t.busies > MAX_BUSY) return rest(t, true);
    t.state = "idle";
    const secs = Number(retryAfter);
    t.timer = clock.set(() => { t.timer = null; enqueue(t); }, Math.min(30_000, Math.max(1000, (Number.isFinite(secs) ? secs : 2) * 1000)) * (1 + Math.random() / 2));
  }
  /** A failure that won't pass by asking again. */
  function fatal(t, code) { if (t.verb === "PUT") emit(failFns, { id: t.id, verb: t.verb, code }); rest(t); t.until = Infinity; }

  function pump() {
    for (;;) {
      const t = queue.find(x => slots[x.verb] < CAP[x.verb]);
      if (!t) return;
      if (t.url && clock.mono() - t.urlAt < URL_FRESH_MS) { queue.splice(queue.indexOf(t), 1); transfer(t, t.url); continue; }   // a URL still good: no new ask
      t.url = null;
      if (!live || inflight || gapTimer != null) return;
      const wait = lastAsk + GAP_MS - clock.mono();
      if (wait > 0) { gapTimer = clock.set(() => { gapTimer = null; pump(); }, wait); return; }
      queue.splice(queue.indexOf(t), 1);
      t.state = "asking"; inflight = t; lastAsk = clock.mono();
      link.send({ t: "blob", sha1: t.id, ...(t.verb === "PUT" ? { put: true } : {}) });
      t.timer = clock.set(() => { t.timer = null; if (inflight === t) { inflight = null; retry(t); pump(); } }, ASK_TIMEOUT_MS);
      return;
    }
  }

  async function transfer(t, url) {
    if (t.state === "done" || (t.verb === "PUT" && !t.file)) return;   // never run on a finished task
    slots[t.verb]++; t.state = "xfer"; clearTimer(t);
    const ctl = new AbortController();
    t.timer = clock.set(() => { t.timer = null; ctl.abort(); }, XFER_TIMEOUT_MS[t.verb]);
    try {
      if (t.verb === "PUT") {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(t.file.dataURL);
        if (!m) return fatal(t, "bad-file");
        const res = await fetchFn(url, { method: "PUT", body: Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)), headers: { "content-type": m[1] }, signal: ctl.signal });
        if (res.ok) return finish(t);
        const err = (await res.json().catch(() => null))?.error;
        if ((res.status === 503 && err === "busy") || (res.status === 409 && err === "in-flight")) return busy(t, res.headers.get("retry-after"));
        if (RETRY_STATUS.has(res.status)) return retry(t);
        return fatal(t, err ?? `http-${res.status}`);
      }
      const res = await fetchFn(url, { signal: ctl.signal });
      if (res.ok) {
        const type = res.headers.get("content-type") ?? "";
        if (!RASTER.test(type)) return fatal(t, "not-image");
        const file = { id: t.id, mimeType: type, dataURL: `data:${type};base64,${b64(new Uint8Array(await res.arrayBuffer()))}` };
        finish(t); emit(fileFns, file); return;
      }
      return RETRY_STATUS.has(res.status) ? retry(t) : fatal(t, `http-${res.status}`);
    } catch { retry(t); }          // a network error, or the abort of a transfer that took too long
    finally { slots[t.verb]--; pump(); }
  }

  /** The current connection ended (a drop, a reopen, a close): the request in flight is asked again at the next welcome. */
  const lost = which => {
    if (which !== link) return;
    live = false;
    const t = inflight; inflight = null;
    if (t) enqueue(t);
  };
  const fresh = (verb, id, stamp) => ({ verb, id, tries: 0, limits: 0, busies: 0, rests: 0, stamp, url: null, urlAt: 0, state: "idle", timer: null, until: 0 });

  return {
    /** Wrap a transport: read what is ours, pass the rest on. */
    attach(tr) {
      let handler = () => {};
      const self = { ...tr,
        onMessage(fn) { handler = fn; },
        onDrop: tr.onDrop ? fn => tr.onDrop(() => { lost(self); fn(); }) : undefined,
        reopen() { lost(self); return tr.reopen(); },
        close() { lost(self); if (link === self) link = null; return tr.close(); } };
      tr.onMessage(m => {
        if (self !== link) return handler(m);
        if (m?.t === "welcome") {
          live = true;
          for (const t of tasks.values()) if (t.state === "rest" && t.until !== Infinity) { t.tries = t.limits = t.busies = t.rests = 0; enqueue(t); }
          handler(m); pump(); return;
        }
        const t = inflight;
        const mine = m?.t === "blob" ? m.sha1 : m?.t === "error" && typeof m.sha1 === "string" && m.id === undefined ? m.sha1 : null;
        if (mine === null) return handler(m);
        if (!t || t.id !== mine) return handler(m);   // not our in-flight request: pass to session/sync (no-op there if stale)
        clearTimer(t); inflight = null;
        if (m.t === "blob") { t.url = resolve(m.url); t.urlAt = clock.mono(); queue.unshift(t); t.state = "idle"; }   // transfer as soon as its verb has a slot
        else if (RETRY_CODES.has(m.code)) retry(t, m.code === "limit");
        else fatal(t, m.code);
        pump();
      });
      lost(link); link = self; live = false;
      return self;
    },
    put(file) {
      if (!SHA1.test(file?.id) || typeof file.dataURL !== "string") return;
      const k = `PUT:${file.id}`;
      if (tasks.get(k)?.state === "done") tasks.delete(k);   // the session offers a picture again only when its last put is old (the server may have deleted it since): a finished upload is no reason to skip it
      const old = tasks.get(k);
      if (old) { if (old.state === "rest") { Object.assign(old, { file, tries: 0, limits: 0, busies: 0, toldLimit: false, toldGaveUp: false, toldBusy: false, until: 0 }); enqueue(old); } return; }   // the same picture again: only a rested (failed) upload is tried again
      const t = { ...fresh("PUT", file.id), file };
      tasks.set(k, t); enqueue(t);
    },
    /** @param {string} id @param {string} [stamp] what the document says about this picture (changes when an element showing it changes): a new stamp ends a rest */
    want(id, stamp) {
      if (!SHA1.test(id)) return;                              // a bad id would hold the one request slot for nothing
      const k = `GET:${id}`, t = tasks.get(k);
      if (!t) { const n = fresh("GET", id, stamp); tasks.set(k, n); return enqueue(n); }
      const changed = stamp !== undefined && t.stamp !== stamp;
      if (changed) t.stamp = stamp;
      const waiting = t.state === "rest" && t.until !== Infinity, backoff = t.state === "idle" && t.timer != null;   // resting, or between tries
      if ((waiting && (changed || t.until <= clock.mono())) || (backoff && changed)) { t.tries = t.limits = t.busies = 0; if (changed) t.rests = 0; enqueue(t); }
      else if (t.state === "done") { tasks.delete(k); this.want(id, stamp); }   // asked for again after it arrived: the Editor lost it, fetch again
    },
    onFile: fn => { fileFns.add(fn); },
    onFail: fn => { failFns.add(fn); },
  };
}

/**
 * The net (web/ports/net.js) over WebSockets: one wsTransport per join() to the same gateway URL, the picture path
 * (blobClient above: put, want, onFile, onFail), plus HTTP snapshot and signed blob upload/fetch adapters.
 * @param {{ url: string, WebSocket: new (url: string) => any, fetch?: typeof fetch,
 *           clock?: Pick<import("../../ports/clock.js").Clock, "mono" | "set" | "clear">,
 *           inflate?: ((bytes: Uint8Array) => Promise<Uint8Array>) | null }} o
 * @returns {import("../../ports/net.js").Net}
 */
export function wsNet({ url, WebSocket: WS, fetch: fetchFn = globalThis.fetch?.bind(globalThis), clock, inflate }) {
  if (typeof url !== "string" || !/^wss?:\/\//.test(url)) throw new TypeError("wsNet: a ws:// or wss:// url is required");
  const u = new URL(url);
  const origin = `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  const fetchOpt = fetchFn ? { fetch: (...a) => fetchFn(...a) } : {};
  const fetchSnapshot = httpSnapshotFetcher({ origin, ...fetchOpt });
  const { uploadBlob, fetchBlob } = httpBlobClient({ origin, ...fetchOpt });
  const blobs = blobClient({ fetch: (...a) => fetchFn(...a), clock: clock ?? globalClock, base: url.replace(/^ws/, "http") });
  return {
    kind: "ws",
    join: () => blobs.attach(wsTransport({ url, WebSocket: WS, ...(clock ? { clock } : {}), ...(inflate ? { inflate } : {}) })),
    fetchSnapshot,
    uploadBlob,
    fetchBlob,
    put: f => blobs.put(f),
    want: (id, stamp) => blobs.want(id, stamp),
    onFile: fn => blobs.onFile(fn),
    onFail: fn => blobs.onFail(fn),
  };
}

/** The gateway's URL for a page at `loc` (same origin, path /ws; wss on https). Never carries a token. */
export function sameOriginWsUrl(loc) {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}
