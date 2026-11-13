// The rules every message obeys (PROTOCOL.md v1.1): streams, roles, what an op may hold, the limits.
// Pure: imports nothing, so a room, a browser, a phone and a Herdr pane all check the same way.

export const PROTOCOL_VERSION = 1;
export const RULES_VERSION = 1;

// `board` and `notes` hold elements (one Doc each); `records` holds comment threads and reactions.
export const ELEMENT_STREAMS = ["board", "notes"];
export const STREAMS = [...ELEMENT_STREAMS, "records"];
export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
const WRITERS = {
  board: ["owner", "editor"],
  notes: ["owner", "editor", "annotator"],
  records: ["owner", "editor", "annotator", "commenter"],
};

/** May a person with `role` write to `stream`? */
export const canWrite = (role, stream) => (WRITERS[stream] ?? []).includes(role);
/** Owners and editors change or delete anyone's work, and set a stream's settings. */
export const canModerate = role => canWrite(role, "board");

// One op, as UTF-8 bytes of its JSON; bigger ones are refused ("too-large"). Bytes, not chars: 1M CJK chars
// are 3 MB, which no 2 MB bus message carries (§ Limits). Counted by hand (utf8Bytes): no TextEncoder here.
export const MAX_OP_BYTES = 1_000_000;
// How far one op may raise an element's version past the room's copy (an absent element counts as 0).
// Unbounded, one client could send version 2^53 and no one could ever change that element again.
export const MAX_VERSION_JUMP = 1000;
export const MAX_CLIENT_CHARS = 128;
export const MAX_ID_CHARS = 64;

// Op-id table (§ Op ids), fixed per rules version: a room replays old entries under the rules they were
// accepted with. W = pairs kept per client, H = entries a client may stay silent before it is forgotten,
// `every` = the seq period of an eviction tick.
export const RULES = { 1: { W: 256, H: 100_000, every: 1024 } };
export const W = RULES[1].W, H = RULES[1].H, EVICT_EVERY = RULES[1].every;

// Content caps (§ Limits, § Records). Over one → "limit".
export const CAPS = {
  board: { ids: 100_000, chars: 50_000_000 },
  notes: { ids: 200_000, chars: 50_000_000 },
  records: { chars: 20_000_000, threads: 10_000, comments: 500, emoji: 20, emojiChars: 32, text: 10_000 },
};
// The op rate (§ Limits): a client paces every send to it; over-rate is backpressure, never a refusal.
export const OP_RATE = { perSecond: 20, burst: 100 };
export const OP_TIMEOUT_MS = 10_000;     // rule 2: an op with no answer this long makes the connection suspect
export const CONNECT_TIMEOUT_MS = 10_000; // rule 12: no welcome, or no catch-up progress, for this long
export const BACKOFF = { baseMs: 500, maxMs: 30_000 };   // rule 12: min(max, base × 2^k) × a random factor in [0.5, 1)
export const APPEND_TIMEOUT_MS = 4000;   // § Recovery: two appends (8 s) fit inside the client's 10 s
export const MAX_WRITER_CONNS = 8;       // § Messages, hello.tab: distinct writer tabs per (user, board) per gateway; a ninth tab gets "limit"
export const MAX_TAB_CONNS = 2;          // § Messages, hello.tab: writer connections per (user, board, tab) per gateway; a third gets "limit"
// § Messages, hello.tab: an optional tab id, client-chosen (the web client mints 16 base-36 characters).
export const TAB_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const isTab = v => typeof v === "string" && TAB_RE.test(v);
export const PING_IDLE_MS = 10_000;      // § Pacing: a gateway pings a connection that sent nothing this long
export const CONN_SILENCE_MS = 30_000;   // § Pacing: and closes one it heard nothing from (no frame, no pong) this long
export const GATEWAY_SILENCE_MS = 30_000; // rule 6: a gateway not heard from this long has lost its connections
export const MAX_NAME_CHARS = 200;
export const CHECKPOINT_EVERY = 1000;    // § Recovery, "When"

/** A blob's key and an image's `fileId`: a SHA-1 as exactly 40 lowercase hex characters (§ Blobs). */
export const isSha1 = v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);

/** `client:counter` → { client, counter }, or null. The counter is a positive safe integer in plain digits. */
export function parseOpId(id) {
  if (typeof id !== "string") return null;
  const at = id.lastIndexOf(":");
  if (at < 1 || id.indexOf(":") !== at) return null;
  const digits = id.slice(at + 1);
  if (!/^[1-9][0-9]{0,15}$/.test(digits)) return null;
  const counter = Number(digits);
  if (!Number.isSafeInteger(counter)) return null;
  return { client: id.slice(0, at), counter };
}

const bad = message => ({ code: "bad-op", message });
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const isId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
const isNum = v => typeof v === "number" && Number.isFinite(v);

// Objects and arrays inside one op (the op object is level 1); deeper is refused ("bad-op"). A client →
// server frame may be 64 deep (the gateway checks it), so an op fits in its frame (+1) and a bus message (+2).
export const MAX_OP_DEPTH = 62;
export const MAX_FRAME_DEPTH = 64;

/**
 * The UTF-8 length of a string, counted by hand (the pure package can't use TextEncoder). A surrogate pair
 * is one 4-byte character; a lone surrogate counts 3 (what an encoder writes for it, U+FFFD).
 */
export function utf8Bytes(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Is `value` nested deeper than `max` levels (the value itself is level 1)? A loop, never recursion. */
export function deeperThan(value, max) {
  const values = [value], depths = [1];
  while (values.length) {
    const v = values.pop(), d = depths.pop();
    if (!v || typeof v !== "object") continue;
    if (d > max) return true;
    for (const k in v) { const inner = v[k]; if (inner && typeof inner === "object") { values.push(inner); depths.push(d + 1); } }
  }
  return false;
}

/**
 * What's wrong with an op message, or null. Shape first (`bad-op`, `no-files`, `too-large`), then the id
 * and `sentAt` (§ Limits, order of checks), so a bad id never hides a shape error. Roles are the room's job.
 * @param {object} msg
 * @param {number} [bytes] the op's JSON size in UTF-8 bytes, when the caller already has it (v1.1: bytes, no longer chars)
 * @returns {null | { code: string, message: string }}
 */
export function opProblem(msg, bytes) {
  if (!STREAMS.includes(msg.stream)) return bad(`unknown stream ${JSON.stringify(msg.stream)}`);
  const op = msg.op;
  if (!isObj(op)) return bad("op must be an object");
  // Before anything walks or encodes the op: a very deep one would overflow the stack of whatever does.
  if (deeperThan(op, MAX_OP_DEPTH)) return bad(`an op nests at most ${MAX_OP_DEPTH} levels deep`);
  if (op.files) return { code: "no-files", message: "pictures go through the blob port, not in ops" };
  if (msg.stream === "records") { const why = recordProblem(op); if (why) return why; }
  else {
    if (op.elements !== undefined) {
      if (!Array.isArray(op.elements)) return bad("elements must be an array");
      for (const el of op.elements) {
        if (!el || !isId(el.id)) return bad("every element needs a string id (at most 64 characters)");
        // A tie on version is broken by versionNonce on every copy alike; without one, copies disagree.
        if (!Number.isSafeInteger(el.version) || el.version < 0 || !Number.isSafeInteger(el.versionNonce)) return bad("every element needs integer version and versionNonce");
        if (el.type === "image" && el.fileId != null && !isSha1(el.fileId)) return bad("an image's fileId is 40 lowercase hex characters");
      }
    }
    if (op.appState !== undefined) { const why = appStateProblem(op.appState); if (why) return bad(why); }
    // § Settings: a settings op stands alone and names the appSeq each key was based on.
    if (op.appState !== undefined && op.elements !== undefined) return bad("a settings op carries no elements: send them as two ops");
    if (op.appState !== undefined || op.appBase !== undefined) { const why = appBaseProblem(op.appState, op.appBase); if (why) return bad(why); }
    if (!op.elements?.length && !op.appState) return bad("empty op");
  }
  if ((bytes ?? utf8Bytes(JSON.stringify(op))) > MAX_OP_BYTES) return { code: "too-large", message: `an op is limited to ${MAX_OP_BYTES} bytes of UTF-8 JSON` };
  if (!parseOpId(msg.id)) return bad("op ids are client:counter, the counter a positive integer");
  if (!Number.isSafeInteger(msg.sentAt) || msg.sentAt < 0) return bad("op needs sentAt (the seq you had applied when you first sent it)");
  return null;
}

const RECORD_ACTIONS = ["thread", "reply", "edit", "delete", "resolve", "reopen", "move", "react"];

function anchorProblem(a) {
  if (!isObj(a)) return "anchor must be an object";
  if (a.point !== undefined) return isObj(a.point) && isNum(a.point.x) && isNum(a.point.y) && Object.keys(a).length === 1 ? null : "a point anchor is { point: { x, y } }";
  if (!ELEMENT_STREAMS.includes(a.stream) || !isId(a.element) || !isNum(a.x) || !isNum(a.y)) return "an element anchor is { stream, element, x, y }";
  return null;
}

/**
 * What's wrong with the shape of one `records` action, or null. Whether its target exists and who may do
 * it depend on the board, so the room checks those (records.js).
 * @returns {null | { code: string, message: string }}
 */
export function recordProblem(op) {
  if (!isObj(op) || !RECORD_ACTIONS.includes(op.do)) return bad(`unknown record action ${JSON.stringify(op?.do)}`);
  if (!isId(op.id)) return bad("a record action needs an id (at most 64 characters)");
  if (op.do === "thread" || op.do === "reply" || op.do === "edit") {
    if (typeof op.text !== "string" || !op.text.length) return bad("a comment needs text");
    if (op.text.length > CAPS.records.text) return { code: "limit", message: `a comment is limited to ${CAPS.records.text} characters` };
  }
  if (op.do === "reply" && !isId(op.thread)) return bad("a reply names its thread");
  if (op.do === "thread" || op.do === "move") { const why = anchorProblem(op.anchor); if (why) return bad(why); }
  if (op.do === "react") {
    if (typeof op.emoji !== "string" || !op.emoji.length || op.emoji.length > CAPS.records.emojiChars) return bad(`an emoji is 1 to ${CAPS.records.emojiChars} characters`);
    if (typeof op.on !== "boolean") return bad("react needs on: true or false");
  }
  return null;
}

// Board settings a patch may set (appState.herdr), each checked, so a patch can't put junk in front of
// every client. Unknown keys are refused.
const APP_KEYS = {
  layers: v => Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(l => isObj(l) && typeof l.id === "string" && l.id.length <= 64 &&
    typeof l.name === "string" && l.name.length <= 200 && typeof l.visible === "boolean" && typeof l.locked === "boolean" &&
    typeof l.opacity === "number" && l.opacity >= 0 && l.opacity <= 100),
  grid: v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000,
  snap: v => typeof v === "boolean",
  timeline: v => isObj(v) && typeof v.duration === "number" && Number.isFinite(v.duration) && v.duration >= 0 && v.duration <= 3_600_000,
};
export function appStateProblem(patch) {
  if (!isObj(patch)) return "appState must be an object";
  for (const [k, v] of Object.entries(patch)) {
    // Own keys only: "__proto__" or "constructor" would otherwise find Object.prototype's members.
    if (!Object.prototype.hasOwnProperty.call(APP_KEYS, k)) return `unknown board setting ${JSON.stringify(k)}`;
    if (!APP_KEYS[k](v)) return `bad value for ${k}`;
  }
  return null;
}

/**
 * § Settings (compare-and-set): `appBase` has exactly the keys of `appState`, each an integer ≥ 0 (the
 * appSeq that key's value was based on). Missing, extra or non-integer keys, or a base with no settings → a reason.
 */
export function appBaseProblem(appState, appBase) {
  if (appState === undefined) return "appBase goes only with appState";
  if (!isObj(appBase)) return "a settings op names its base: appBase { key: appSeq }";
  const keys = Object.keys(appState), bases = Object.keys(appBase);
  if (bases.length !== keys.length) return "appBase names exactly the keys appState sets";
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(appBase, k)) return `appBase is missing ${k}`;
    if (!Number.isSafeInteger(appBase[k]) || appBase[k] < 0) return `appBase.${k} must be an integer ≥ 0`;
  }
  return null;
}

/** appState patch keys win by seq: the value from the highest-seq op that set each key. */
export function mergeAppState(state, seqs, patch, seq) {
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(APP_KEYS, k)) continue;   // never a prototype key, whoever sent it
    if (seq > (seqs[k] ?? 0)) { state[k] = v; seqs[k] = seq; }
  }
}
