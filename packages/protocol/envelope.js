// The rules every message obeys (PROTOCOL.md): streams, roles, what an op may hold.
// Pure: imports nothing, so a room, a browser, a phone and a Herdr pane all check the same way.

export const STREAMS = ["board", "notes"];
export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
const WRITERS = { board: ["owner", "editor"], notes: ["owner", "editor", "annotator", "commenter"] };

/** May a person with `role` write to `stream`? */
export const canWrite = (role, stream) => (WRITERS[stream] ?? []).includes(role);

export const MAX_OP_CHARS = 1_000_000;   // one op, JSON-encoded; bigger ones are refused ("too-large")
// How far one op may raise an element's version past the room's copy. Unbounded, one client could send
// version 2^53 and no one could ever change that element again.
export const MAX_VERSION_JUMP = 1000;
export const MAX_CLIENT_CHARS = 128;

/**
 * What's wrong with an op message, or null. Checks shape only; roles are the room's job.
 * @returns {null | { code: string, message: string }}
 */
export function opProblem(msg) {
  const bad = message => ({ code: "bad-op", message });
  if (typeof msg.id !== "string" || !msg.id) return bad("op needs an id");
  if (!STREAMS.includes(msg.stream)) return bad(`unknown stream ${JSON.stringify(msg.stream)}`);
  const op = msg.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) return bad("op must be an object");
  if (op.files) return { code: "no-files", message: "pictures go through the blob port, not in ops" };
  if (op.elements !== undefined) {
    if (!Array.isArray(op.elements)) return bad("elements must be an array");
    for (const el of op.elements) {
      if (!el || typeof el.id !== "string" || !el.id || el.id.length > 64) return bad("every element needs a string id (at most 64 characters)");
      // A tie on version is broken by versionNonce on every copy alike; without one, copies disagree.
      if (!Number.isSafeInteger(el.version) || el.version < 0 || !Number.isSafeInteger(el.versionNonce)) return bad("every element needs integer version and versionNonce");
    }
  }
  if (op.appState !== undefined) { const why = appStateProblem(op.appState); if (why) return bad(why); }
  if (!op.elements?.length && !op.appState) return bad("empty op");
  if (JSON.stringify(op).length > MAX_OP_CHARS) return { code: "too-large", message: `an op is limited to ${MAX_OP_CHARS} characters` };
  return null;
}

// Board settings a patch may set (appState.herdr), each checked, so a patch can't put junk in front of
// every client. Unknown keys are refused.
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
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
    if (!APP_KEYS[k]) return `unknown board setting ${JSON.stringify(k)}`;
    if (!APP_KEYS[k](v)) return `bad value for ${k}`;
  }
  return null;
}

/** appState patch keys win by seq: the value from the highest-seq op that set each key. */
export function mergeAppState(state, seqs, patch, seq) {
  for (const [k, v] of Object.entries(patch)) if (seq > (seqs[k] ?? 0)) { state[k] = v; seqs[k] = seq; }
}
