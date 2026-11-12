// Structured logs: one JSON object per line on stdout: { time, level, msg, ...fields }.
// Never pass a frame, a hello, a token or a decode error's text (JSON.parse echoes its input) as a field.
// As a second line of defence, fields whose key looks like a credential are replaced with "[redacted]".

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|api[-_]?key/i;
const MAX_STRING = 2000;

function clean(v, depth) {
  if (v instanceof Error) return { name: v.name, message: clip(v.message), ...(v.code ? { code: String(v.code) } : {}), ...(v.stack ? { stack: clip(v.stack) } : {}) };
  if (typeof v === "string") return clip(v);
  if (typeof v === "bigint") return String(v);
  if (typeof v === "function" || typeof v === "symbol") return undefined;
  if (!v || typeof v !== "object") return v;
  if (depth >= 4) return "[deep]";
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[${v.byteLength} bytes]`;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clean(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : clean(x, depth + 1);
  return out;
}
const clip = s => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…" : s);

/**
 * @param {{ write?: (line: string) => void, level?: "debug"|"info"|"warn"|"error", now?: () => number, base?: object }} [o]
 * `write` gets one line with its newline; default stdout. `base` fields go on every line.
 */
export function createLogger({ write = line => { process.stdout.write(line); }, level = "info", now = Date.now, base = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    let line;
    try {
      line = JSON.stringify({ ...clean({ ...base, ...fields }, 0), time: new Date(now()).toISOString(), level: lvl, msg: String(msg) });
    } catch {
      line = JSON.stringify({ time: new Date(now()).toISOString(), level: lvl, msg: String(msg), logError: "fields could not be serialised" });
    }
    try { write(line + "\n"); } catch { /* a broken stdout must not take the server down */ }
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    /** A logger that adds `fields` to every line. */
    child: fields => createLogger({ write, level, now, base: { ...base, ...fields } }),
  };
}

/** A logger that writes nowhere (a default for parts built without one). */
export const quietLogger = createLogger({ write: () => {} });
