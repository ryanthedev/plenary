// Runtime check that web/core reads no ambient global (p7-audit C-14). architecture.test.js's token scan reads source
// text, so an alias (`const D = Date; D.now()`), a computed member (`Math["random"]()`) or a global reached through
// `Function("return this")()` slips past it. This file imports every web/core module and drives sessions with the
// globals below trapped: each is an accessor whose getter records and throws when the ACCESSING frame is a web/core
// file (round 2, p7-archtestv H2: trapping the read, not the call, also catches core aliasing a global and handing it
// to packages/core or packages/protocol, e.g. `new Editor({ clock: D_.now })`). Any other accessor (packages/core,
// packages/protocol, the adapters, bun itself) gets the real value: only the accessing frame is judged, never "a
// web/core frame anywhere on the stack", which would flag packages/core's own defaults. A hit is recorded before the
// throw, so core code that swallows it (try {} catch {}) is still caught.
//
// Trapped: Date, Date.now, Math.random, Intl, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval,
// clearImmediate, queueMicrotask, requestAnimationFrame, cancelAnimationFrame, document, window, location, history,
// navigator, localStorage, sessionStorage, indexedDB, crypto, performance, fetch, WebSocket, Worker, SharedWorker.
//
// Positive controls (round 2, p7-archtestv H1): the same child, rooted at a temp tree <tmp>/web/core/probe.js that reads
// Date, Math.random, setTimeout, Intl and setImmediate, must record exactly those; and with an unparseable stack the
// stubs must record "<unparsed stack>" hits, never pass silently. A bun stack-format change, a wrong CORE path or a
// missing trap fails a control instead of turning the real check off.
//
// It runs in a child bun process (this same file with PLENARY_CORE_GLOBALS_CHILD=drive|probe), because stubbing the timers and
// Date in the test runner's own process would break the runner and leak into other test files, and because bun
// shares one module cache across test files: a module another test already imported would never re-evaluate under
// the stubs. The child prints one JSON line: { hits, imported, drove } (probe: { hits, error }).
//
// What the drive covers (every web/core module is imported with the stubs in place, so module-level code is covered):
//   session.js + sync.js: two createSession()s (owner, annotator) and one viewer on a localRoom (virtual clock):
//     welcome, a shape, a note, an edit, presence, a records thread, a refused op + resync, a dropped connection with
//     backoff (clock.random) and reconnect, a compaction + snapshot catch-up, close.
//   signin.js: readStored, devSignIn, takeSignIn (with the 503-then-retry jitter path), pageSignIn, signOut, signInNotice.
//   roles.js: every export. collab/*: createPresence (ingest, here, emotes, expiry), createOutbox (pacing timers),
//     recordProblem, recordsView, newRecordId, notesView, the limits and flags tables.

const CHILD = process.env.PLENARY_CORE_GLOBALS_CHILD;          // "drive" | "probe" in the child, unset in the test

if (CHILD) await child(CHILD);
else await parent();

/** Run this file as the child; returns its last JSON line, parsed. */
async function runChild(env) {
  const proc = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = out.trim().split("\n").filter(l => l.startsWith("{")).at(-1);
  if (code !== 0 || !line) throw new Error(`child failed (exit ${code}):\n${out}\n${err}`);
  return JSON.parse(line);
}

async function parent() {
  const { test, expect } = await import("bun:test");
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  test("web/core touches no ambient global at run time (every module imported, sessions driven, globals stubbed)", async () => {
    const r = await runChild({ PLENARY_CORE_GLOBALS_CHILD: "drive" });
    expect(r.drove.error).toBeUndefined();                           // a drive that died partway is a failure (p7-archtestv MED-1)
    expect(r.hits).toEqual([]);
    expect(r.imported.length).toBeGreaterThan(10);
    expect(r.imported).toContain("web/core/sync.js");
    expect(r.imported).toContain("web/core/collab/gate.js");
    // The drive really ran (a vacuous pass would show here).
    expect(r.drove).toMatchObject({ live: true, converged: true, resynced: true, reconnected: true, signedIn: "signed-in", outboxSent: true, finished: true });
  }, 60_000);

  // Positive control (p7-archtestv H1): the same stubs and attribution, rooted at a temp tree whose web/core/probe.js
  // reads Date, Math.random and setTimeout (and Intl, setImmediate), must record exactly those. If bun's stack format
  // changes, CORE is built wrong, or a stub is not installed, this fails instead of the real check passing vacuously.
  const PROBE = `export function probe() {
  const got = [];
  try { got.push(Date.now()); } catch {}
  try { got.push(Math.random()); } catch {}
  try { setTimeout(() => {}, 0); } catch {}
  try { new Intl.DateTimeFormat().format(); } catch {}
  try { setImmediate(() => {}); } catch {}
  return got.length;
}
export const viaAlias = () => { try { const D = Date; return D; } catch { return null; } };
`;
  const probeRoot = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plenary-probe-")));
    mkdirSync(join(dir, "web", "core"), { recursive: true });
    writeFileSync(join(dir, "web", "core", "probe.js"), PROBE);
    return dir;
  };

  test("positive control: a probe under <tmp>/web/core records exactly the globals it reads", async () => {
    const dir = probeRoot();
    try {
      const r = await runChild({ PLENARY_CORE_GLOBALS_CHILD: "probe", PLENARY_CORE_GLOBALS_ROOT: dir });
      expect(r.error).toBeUndefined();
      expect(r.hits.map(h => `${h.global} ${h.file}`).sort()).toEqual(
        ["Date web/core/probe.js", "Intl web/core/probe.js", "Math.random web/core/probe.js", "setImmediate web/core/probe.js", "setTimeout web/core/probe.js"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test("positive control: a stub that cannot parse its stack records a failure, never a silent pass", async () => {
    const dir = probeRoot();
    try {
      const r = await runChild({ PLENARY_CORE_GLOBALS_CHILD: "probe", PLENARY_CORE_GLOBALS_ROOT: dir, PLENARY_CORE_GLOBALS_BREAK_STACK: "1" });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits.every(h => h.file === "<unparsed stack>")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
}

async function child(mode) {
  const { join } = await import("node:path");
  const ROOT = mode === "probe" ? process.env.PLENARY_CORE_GLOBALS_ROOT : join(import.meta.dir, "..", "..");
  const CORE = join(ROOT, "web", "core") + "/";
  const BREAK = process.env.PLENARY_CORE_GLOBALS_BREAK_STACK === "1";
  const hits = [];
  const hit = (global, file) => { if (!hits.some(h => h.global === global && h.file === file)) hits.push({ global, file }); };

  // The accessing frame: the first stack frame with a file path outside this file. Only that frame counts: never "any
  // web/core frame on the stack", which flags packages/core's own default reads (p7-archtestv H2). null when no frame
  // parses at all (bun changed its stack format): that is recorded as a hit, never treated as "not core".
  const SELF = import.meta.path;
  const FRAME = /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/;
  function callerFile() {
    const stack = BREAK ? "Error\n    at somewhere in a format we do not know" : (new Error().stack ?? "");
    let parsed = false;
    for (const l of stack.split("\n").slice(1)) {
      const m = l.match(FRAME);
      if (!m) continue;
      parsed = true;
      const f = m[1].replace(/^file:\/\//, "");
      if (f === SELF) continue;
      return f;
    }
    return parsed ? "" : null;
  }
  function check(name) {
    const f = callerFile();
    if (f === null) { hit(name, "<unparsed stack>"); return; }   // recorded, then the real value (the child keeps running)
    if (!f.startsWith(CORE)) return;
    const where = f.slice(ROOT.length + 1);
    hit(name, where);
    throw new Error(`web/core touched the global ${name} (${where})`);
  }

  // ── stubs: trap the READ, not the call (p7-archtestv H2) ──
  // Every name below is an accessor on its owner whose getter runs check(): a core file that reads it (to call it, or to
  // alias it and hand it to packages/core or packages/protocol: `const D = Date; new Editor({ clock: D.now })`) is
  // caught where it reads. Anyone else gets the real value.
  const trap = (owner, name, label = name) => {
    const real = owner[name];
    Object.defineProperty(owner, name, { configurable: true, get() { check(label); return real; }, set(v) { check(label); } });
  };
  const G = globalThis;
  trap(Date, "now", "Date.now");          // before Date itself is trapped: a Date reached some other way
  trap(Math, "random", "Math.random");
  for (const n of ["Date", "Intl", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate",
    "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame", "document", "window", "location", "history", "navigator",
    "localStorage", "sessionStorage", "indexedDB", "crypto", "performance", "fetch", "WebSocket", "Worker", "SharedWorker"]) trap(G, n);

  if (mode === "probe") {
    let error;
    try { const m = await import(join(CORE, "probe.js")); m.probe(); m.viaAlias(); } catch (e) { error = String(e); }
    console.log(JSON.stringify({ hits, error }));
    return;
  }

  const drove = {};
  const imported = [];
  try {
    // ── import every core module under the stubs (fresh: this process imported none of them yet) ──
    const { listFiles } = await import("../arch-scan.js");
    const mods = {};
    for (const f of listFiles(["web/core"], ROOT)) { mods[f] = await import(join(ROOT, f)); imported.push(f); }
    const { createSession } = mods["web/core/session.js"];
    const { localRoom } = await import(join(ROOT, "web/adapters/transport/local.js"));

    // ── sessions over the in-page room, virtual clock ──
    const USERS = { "t-o": { user: "o", name: "O", role: "owner" }, "t-a": { user: "a", name: "A", role: "annotator" }, "t-v": { user: "v", name: "V", role: "viewer" } };
    const net = localRoom({ users: USERS, clock: true });
    const mk = (token, client) => createSession({ join: () => net.join(), token, board: "b1", client, user: USERS[token].user, clock: net.clock });
    const o = mk("t-o", "o"), a = mk("t-a", "a"), v = mk("t-v", "v");
    net.settle();
    drove.live = [o, a, v].every(s => s.status === "live");
    const ed = o.eds.board;
    ed.setTool("rectangle"); ed.pointerDown({ x: 10, y: 10 }, {}); ed.pointerMove({ x: 90, y: 60 }, {}); ed.pointerUp({ x: 90, y: 60 }, {});
    net.settle();
    a.placeNote({ x: 100, y: 100 }, "a note");
    o.binds.board.sendPresence("cursor", { x: 1, y: 2 });
    o.binds.board.record?.({ k: "thread", id: "th1", anchor: { point: { x: 0, y: 0 } }, text: "hi" });
    net.settle();
    const id = ed.doc.live()[0]?.id;
    if (id) { ed.select([id]); ed.nudge(5, 0); }
    net.settle();
    const before = o.binds.board.resets;
    ed.setAppState({ bogus: 1 });                       // refused: resync
    net.settle();
    drove.resynced = o.binds.board.resets > before;
    o.dropConnection(); a.dropConnection();             // backoff (clock.random), reconnect
    net.settle();
    net.compact();
    v.dropConnection();                                 // catch-up by snapshot
    net.settle();
    drove.reconnected = [o, a, v].every(s => s.status === "live");
    drove.converged = JSON.stringify(o.binds.board.full()) === JSON.stringify(v.binds.board.full()) &&
      JSON.stringify(o.binds.notes.full()) === JSON.stringify(a.binds.notes.full());

    // ── sign-in over test adapters (a virtual clock, memory storage, the fake auth) ──
    const S = mods["web/core/signin.js"];
    const { virtualClock } = await import(join(ROOT, "web/adapters/clock/virtual.js"));
    const { memoryStore } = await import(join(ROOT, "web/adapters/storage/memory.js"));
    const clock = virtualClock({ t0: 1_700_000_000_000 });
    const storage = memoryStore();
    S.readStored({ storage, clock });
    S.devSignIn({ query: "?as=ada" });
    let calls = 0;
    const auth = {
      async exchange() {
        if (calls++ === 0) return { error: "unavailable" };
        return { token: "tok", user: "g:1", name: "Ada", email: "a@x.test", domain: "x.test", exp: clock.now() + 3_600_000 };
      },
    };
    const p = S.takeSignIn({ fragment: "#code=" + "c".repeat(20), replaceFragment: () => {}, storage, auth, clock });
    for (let i = 0; i < 20; i++) { await Promise.resolve(); clock.advance(500); }
    const got = await p;
    drove.signedIn = got.outcome;
    S.readStored({ storage, clock });
    await S.pageSignIn?.({ query: "", fragment: "", replaceFragment: () => {}, storage, auth, clock, devUsers: {} });
    S.signInNotice?.(got);
    S.signOut(storage);

    // ── roles ──
    const R = mods["web/core/roles.js"];
    for (const r of ["owner", "editor", "annotator", "commenter", "viewer"]) {
      R.uiRole(r); R.toolsFor(r); R.mayUseTool(r, "rectangle"); R.streamFor(r, "rectangle"); R.canEdit(r);
      R.pillFor({ status: "live", role: r }); R.connectionBanner({ status: "connecting" }); R.pillTitleFor({ cls: "live", status: "live" });
    }
    R.viewKey("ArrowLeft"); R.clipboardKey("c", { cmd: true }); R.settingsKey("'", { cmd: true });

    // ── settings (#116, #22) ──
    const St = mods["web/core/settings.js"];
    St.loadSettings(storage);
    St.saveSettings(storage, { defaultTheme: "dark", gridDefault: true, roughDefault: 2, keybinds: { "tool.rectangle": "b" }, frameBinds: { "Alt+1": "frame:f1" } });
    St.detectKeybindConflict({ "tool.rectangle": "b" }, "tool.ellipse", "b");
    St.normalizeCombo({ key: "j", metaKey: true });
    St.resolveKeybind(St.loadSettings(storage), { key: "b" });
    St.parseDeepLink({ hash: "#frame=f1", search: "" });
    St.buildDeepLink({ origin: "https://plenary.test", pathname: "/", search: "?board=b1", kind: "el", id: "e1" });
    St.resetSettings(storage);

    // ── collab models ──
    const P = mods["web/core/collab/presence-model.js"], Gt = mods["web/core/collab/gate.js"];
    const Rm = mods["web/core/collab/records-model.js"], Nm = mods["web/core/collab/notes-model.js"];
    const vc = virtualClock({ t0: 0, seed: 3 });
    const pres = P.createPresence({ now: vc.now, me: { user: "o", client: "o-1" }, role: "editor" });
    pres.ingest([{ user: "a", client: "a-1", k: "cursor", x: 1, y: 2 }, { user: "a", client: "a-1", k: "laser", pts: [[0, 0], [1, 1]] }]);
    pres.here?.({ writers: [{ user: "a", name: "A", role: "annotator" }], writerCount: 1, viewers: 3 });
    pres.emotes?.({ "👍": 2 });
    vc.advance(40_000);
    pres.float("👍", "a"); pres.view(); pres.prune(); pres.view(); pres.leave("a", "a-1");
    P.colorOf("a"); P.initials("Ada Lovelace");
    const outSent = [];
    const ob = Gt.createOutbox({ role: "editor", status: "live", send: (k, f) => outSent.push([k, f]) }, { now: vc.now, setTimer: vc.set, clearTimer: vc.clear });
    ob.cursor(1, 1); ob.cursor(2, 2); ob.select("board", ["e1"]); ob.laser(1, 1); ob.laser(2, 2); ob.emote("👍");
    vc.advance(20_000);                                 // pacing timers and the 10 s repeat
    ob.reset(); ob.resume(); vc.advance(1_000);
    ob.close?.();
    drove.outboxSent = outSent.length > 0;
    Gt.recordProblem("editor", "o", { k: "thread", id: "t1", anchor: { point: { x: 0, y: 0 } }, text: "x" }, []);
    Rm.newRecordId(vc.random); Rm.ago(0, 90_000);
    Rm.recordsView({ threads: [], pending: [] }, { me: "o", role: "editor", element: () => null });
    Nm.notesView(o.eds.notes.doc.live(), { me: "o", role: "editor", noteAuthor: () => null, nameOf: () => null });
    for (const s of [o, a, v]) for (const b of Object.values(s.binds)) b.close?.();
    drove.finished = true;
  } catch (e) {
    drove.error = String(e?.stack ?? e);
  }
  console.log(JSON.stringify({ hits, imported, drove }));
}
