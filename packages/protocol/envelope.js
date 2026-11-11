// The rules every message obeys (PROTOCOL.md): streams, roles, what an op may hold.
// Pure: imports nothing, so a room, a browser, a phone and a Herdr pane all check the same way.

export const STREAMS = ["board", "notes"];
export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
const WRITERS = { board: ["owner", "editor"], notes: ["owner", "editor", "annotator", "commenter"] };

/** May a person with `role` write to `stream`? */
export const canWrite = (role, stream) => (WRITERS[stream] ?? []).includes(role);

export const MAX_OP_CHARS = 1_000_000;   // one op, JSON-encoded; bigger ones are refused ("too-large")

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
    for (const el of op.elements)
      if (!el || typeof el.id !== "string" || typeof el.version !== "number") return bad("every element needs a string id and a numeric version");
  }
  if (op.appState !== undefined && (!op.appState || typeof op.appState !== "object" || Array.isArray(op.appState))) return bad("appState must be an object");
  if (!op.elements?.length && !op.appState) return bad("empty op");
  if (JSON.stringify(op).length > MAX_OP_CHARS) return { code: "too-large", message: `an op is limited to ${MAX_OP_CHARS} characters` };
  return null;
}

/** appState patch keys win by seq: the value from the highest-seq op that set each key. */
export function mergeAppState(state, seqs, patch, seq) {
  for (const [k, v] of Object.entries(patch)) if (seq > (seqs[k] ?? 0)) { state[k] = v; seqs[k] = seq; }
}
