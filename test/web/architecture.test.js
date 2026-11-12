// web/'s hexagonal boundary test (docs/m2/OFFICE.md "Architecture"; brief p6-hex). Client owns it; it reuses engine's
// scanner (test/arch-scan.js, 44dd1aa: listFiles, importsOf, checkBoundaries) and never parses imports itself.
//
// Layers (web/):
//   core      web/core/**        sync binding, session + roles, sign-in, collab models, the dev token table
//   ports     web/ports/**       contracts only: import nothing at runtime
//   adapters  web/adapters/**    one adapter per group: `<port>/<name>` (storage/session, transport/local,
//                                transport/shared-worker = client + host + worker entry, ...), except dom/** = one group
//                                (the page's UI: chrome, paint, panel, export, collab renderers)
//   roots     web/main.js (index.html), web/dev.js (dev.html), web/collab/dev.js (collab/dev.html),
//             web/adapters/transport/shared-worker/worker.js (the SharedWorker's own global scope)
// Rules (beyond checkBoundaries' core->adapter, adapter->adapter, wiring, unclassified):
//   - core imports only packages/*, web/ports/** and web/core/**;
//   - the protocol seam: of web/, only web/core/sync.js imports packages/protocol, except the two transports that
//     carry it (allowlisted below with the reason: local.js holds the reference Room, ws.js the codec);
//   - ports import nothing at runtime (JSDoc type imports of other ports are fine);
//   - an adapter imports only packages/*, ports, core, and its own group;
//   - core reads no browser global (DOM, Worker, WebSocket, storage, location/history, fetch, and no Date.now,
//     setTimeout/setInterval, Math.random, performance, requestAnimationFrame directly), decided by Bun's parser
//     (brief p8-globals): each name is a Bun.Transpiler `define` to a unique sentinel, and define rewrites only free
//     (unbound) references, never a shadowed local, a member or property name, a string, a template's text, a regex
//     or a comment. Time, timers and randomness come from the clock port. Also no `Function(`, `eval` or
//     `import.meta` (p7-archtest, C-14: `Function("return this")()` reaches every global; core never needs a URL);
//   - core has no computed import(): only a quoted (or ${}-free template) specifier, so the scanner sees every edge;
//     also decided by the parser (each `import` keyword is swapped for a defined sentinel; see computedImports);
//   - a file the parser rejects fails both checks loudly (it throws), never "no globals" (as arch-scan's "parse");
//   - `new URL("./x.js", import.meta.url)` edges count (arch-scan's { urls: true }) in every rule and in the
//     production graph, so a Worker or a dev module started by URL is checked like an import (p7-archtest, C-14);
//   - one list of dev-only modules (DEV_MODULES), checked against server/static.js's DENY (p7-archtest, C-16).
// The runtime half of the globals rule (aliases, computed members, Function("return this")) is
// test/web/core-runtime-globals.test.js.
// The allowlist is explicit and shrink-only: an entry that no longer occurs fails the test.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, listFiles, importsOf, checkBoundaries } from "../arch-scan.js";
import { denied } from "../../server/static.js";

/** Every relative edge of a web/ file, `new URL(…, import.meta.url)` included (kind "url"). */
const edgesOf = (f, src) => importsOf(f, src, ROOT, { urls: true });
/** Loads something at run time: a runtime import, or a module started by URL (a Worker). */
const loads = kind => kind === "runtime" || kind === "url";

const ROOTS = ["web/main.js", "web/dev-main.js", "web/dev.js", "web/collab/dev.js", "web/adapters/transport/shared-worker/worker.js"];
const isCore = p => p.startsWith("web/core/");
const isPort = p => p.startsWith("web/ports/");
const isAdapter = p => p.startsWith("web/adapters/") && !ROOTS.includes(p);
const isPackage = p => p.startsWith("packages/");
/** `<port>/<name>` under web/adapters, the whole of dom/** as one, a sub-folder adapter (shared-worker/) as one. */
export function adapterGroup(p) {
  const [port, name] = p.slice("web/adapters/".length).split("/");
  if (port === "dom") return "dom";
  return `${port}/${name.replace(/\.m?js$/, "")}`;
}

/** Known exceptions to the web/ rules below (not to checkBoundaries'), each with its reason. Shrink-only. */
const SEAM_ALLOWLIST = [
  { from: "web/adapters/transport/local.js", to: "packages/protocol/room.js", why: "the in-page reference room IS packages/protocol's Room behind a gateway stand-in" },
  { from: "web/adapters/transport/local.js", to: "packages/protocol/ports.js", why: "the reference room's auth table and memory log" },
  { from: "web/adapters/transport/local.js", to: "packages/protocol/presence.js", why: "the gateway stand-in checks and rate-limits presence as the real gateway does" },
  { from: "web/adapters/transport/local.js", to: "packages/protocol/codec.js", why: "every message crosses the wire codec, as on a socket" },
  { from: "web/adapters/transport/ws.js", to: "packages/protocol/codec.js", why: "a wire transport runs the codec (web/ports/transport.js: send)" },
];

/** The web/-specific violations of one import graph: [{ rule, from, to }]. `graph`: [[from, imports]]. */
export function webViolations(graph) {
  const out = [];
  for (const [from, imports] of graph) {
    if (ROOTS.includes(from)) continue;
    for (const { to, kind } of imports) {
      // A URL edge may start a composition root (new SharedWorker(new URL("./worker.js", …))), as in checkBoundaries;
      // never from core (core starts no program).
      if (kind === "url" && ROOTS.includes(to) && !isCore(from)) continue;
      if (isCore(from) && !(isPackage(to) || isPort(to) || isCore(to))) out.push({ rule: "core-imports", from, to });
      // Runtime only: a JSDoc type import loads nothing, and must not keep an allowlist entry alive (p6-hexv L).
      if (loads(kind) && to.startsWith("packages/protocol/") && from !== "web/core/sync.js") out.push({ rule: "protocol-seam", from, to });
      if (isPort(from) && loads(kind)) out.push({ rule: "port-imports", from, to });
      if (isAdapter(from) && !(isPackage(to) || isPort(to) || isCore(to) || (isAdapter(to) && adapterGroup(to) === adapterGroup(from))))
        out.push({ rule: "adapter-imports", from, to });
    }
  }
  return out;
}

/** Browser globals core must not read (member access like `x.location`, a property key or a shadowed local is fine;
 *  only a free reference to the global is caught). `Date(` covers `new Date(...)` and a bare `Date()` (the wall
 *  clock); `self` is the worker global. */
const NAMES = ["document", "window", "globalThis", "self", "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "navigator", "SharedWorker", "Worker", "WebSocket", "XMLHttpRequest", "fetch", "requestAnimationFrame", "cancelAnimationFrame",
  "matchMedia", "performance", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "Date.now",
  "Math.random", "crypto", "addEventListener", "postMessage", "console"];
/** Each rule: `global` (the reported name), `name` (the free reference the parser looks for), and `call` (only a call
 *  or a `new` of it counts). Reported in this order. */
const CORE_GLOBALS = [
  ...NAMES.map(g => ({ global: g, name: g })),
  { global: "Date(", name: "Date", call: true },
  // p7-archtest (C-14): the doors to every global and to URLs. Function("return this")() is globalThis; eval runs code
  // no scan sees; import.meta.url is only for building module URLs, which core never does.
  { global: "Function(", name: "Function", call: true },
  { global: "eval", name: "eval" },
  { global: "import.meta", name: "import.meta" },
];
/** Every name the parser is asked about: each rule's name, plus the object of each dotted name ("Date", "Math"), so
 *  `Date?.now` and `Math["random"]` count as `Date.now` and `Math.random` too. */
const DEFINED = [...new Set(CORE_GLOBALS.flatMap(r => (r.name.includes(".") && r.name !== "import.meta" ? [r.name, r.name.split(".")[0]] : [r.name])))];

/** One transpiler per sentinel prefix (a define map is fixed at construction). deadCodeElimination is off, so code in
 *  `if (false) { … }` is still printed (and still judged), as in arch-scan.js. */
const plain = new Bun.Transpiler({ loader: "js", deadCodeElimination: false });
const withDefine = define => new Bun.Transpiler({ loader: "js", deadCodeElimination: false, define });
/** Appended to every source so the parser reads it as an ES module (strict, as the browser loads core). Without it Bun
 *  parses a file with no import/export sloppily, and a block's `function fetch() {}` would bind a later `fetch(u)` to
 *  itself (sloppy-mode hoisting), hiding a real global read. On its own line, so a trailing // comment can't eat it. */
const AS_MODULE = "\nexport {};\n";
/** `src` printed by the parser, or a loud error naming `file` (a file the parser rejects never reads as clean). */
function printed(file, src, t = plain) {
  try { return t.transformSync(src + AS_MODULE); }
  catch (e) {
    const list = Array.isArray(e?.errors) && e.errors.length ? e.errors : [e];
    const why = list.slice(0, 3).map(x => (x?.position ? `${x.position.line}:${x.position.column} ` : "") + (x?.message ?? String(x))).join("; ");
    throw new Error(`${file}: the parser rejects it, so its globals and imports are unknown: ${why}`);
  }
}
/** A sentinel prefix found nowhere in `src` nor in its printed form (printing decodes escapes: "\x5f_g" prints "__g"),
 *  so every sentinel in a printed output was put there by `define`, i.e. by the parser, never by the file's text. */
function prefixFor(src, out) {
  let pre = "__arch_g_";
  while (src.includes(pre) || out.includes(pre)) pre += "_";
  return pre;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Throws, naming `file`, if `src` holds a `with` statement (p8-globalsv L1): inside a `with` body `define` rewrites
 * nothing, so neither check could see a global or an import() there. `with` is a SyntaxError in every ES module, but
 * Bun's transpiler accepts it, and a type-only port is loaded by no test, so the check itself must refuse it.
 * Decided by the parser, never by the text: every raw word `with` is a candidate.
 *   - Swapped for a token `<pre>w<n>`, defined to `<pre>v<n>`: printed `<pre>v<n>` means the token was a free
 *     reference, and only a `with` keyword in code becomes one (`with` is reserved, so it is never a name); in a
 *     comment, string, template text or regex, or as a property, member or method name, it isn't printed as `v`.
 *   - That swap can also break the parse: `with (o) { … }` becomes `<tok>(o) { … }`. The same is true of an import
 *     attribute (`import j from "./a.json" with { type: "json" }`). So a candidate whose identifier probe doesn't
 *     parse is probed again swapped for `if`: `with ( Expression ) Statement` is exactly `if ( Expression ) Statement`
 *     (no else), so a `with` statement always parses as an `if`, and an import attribute never does.
 * All candidates are swapped at once first; one at a time only if that copy doesn't parse.
 */
function refuseWith(file, src, base) {
  const cands = [...src.matchAll(/\bwith\b/g)].map((m, n) => ({ at: m.index, n }));
  if (!cands.length) return;
  const pre = prefixFor(src, base);
  const t = withDefine(Object.fromEntries(cands.map(({ n }) => [`${pre}w${n}`, `${pre}v${n}`])));
  const swap = (list, as) => {
    let s = "", at = 0;
    for (const c of list) { s += src.slice(at, c.at) + (as ?? `${pre}w${c.n}`); at = c.at + "with".length; }
    try { return t.transformSync(s + src.slice(at) + AS_MODULE); } catch { return null; }
  };
  const free = (c, text) => new RegExp(`${escapeRe(pre)}v${c.n}(?![\\w$])`).test(text);
  const isWith = c => { const one = swap([c]); return one !== null ? free(c, one) : swap([c], "if") !== null; };
  const all = swap(cands);
  const hit = all !== null ? cands.find(c => free(c, all)) : cands.find(isWith);
  if (hit) {
    const line = src.slice(0, hit.at).split(/\r\n|[\n\r\u2028\u2029]/).length;
    throw new Error(`${file}: a \`with\` statement (line ${line}): names inside it are unknown to the parser, and no ES module may hold one`);
  }
}

/**
 * [{ file, global }] for every free reference to a forbidden browser global in a core source, in CORE_GLOBALS order.
 * Method (brief p8-globals): Bun.Transpiler's `define` rewrites only free references (a shadowed binding, a member
 * name, a property key, a string, a template's text, a regex and a comment are left alone; `${…}` is code), so each
 * name is defined to a unique sentinel and the printed output is read for sentinels. Only the neighbours of a sentinel
 * in that canonical output are looked at: for `Date(` and `Function(` every use counts except as the object of `.`,
 * `?.` or `[` or the operand of typeof / instanceof (p8-globals2), and for a dotted name's object `?.prop` or
 * `["prop"]` after it. Throws if the parser rejects `src`, or if it holds a `with` statement (refuseWith).
 */
export function globalsIn(file, src) {
  const base = printed(file, src);
  refuseWith(file, src, base);
  const pre = prefixFor(src, base);
  const define = Object.fromEntries(DEFINED.map((n, i) => [n, `${pre}${i}`]));
  const out = printed(file, src, withDefine(define));
  const seen = new Set();                                         // indexes of rules hit
  for (const m of out.matchAll(new RegExp(`${escapeRe(pre)}(\\d+)(?![\\w$])`, "g"))) {
    const name = DEFINED[+m[1]], after = out.slice(m.index + m[0].length), before = out.slice(Math.max(0, m.index - 12), m.index);
    CORE_GLOBALS.forEach((r, k) => {
      if (r.name === name) {
        if (!r.call) seen.add(k);
        // p8-globals2 (L2, L3): any use counts (a call, a construction, a tagged template, a compound callee such as
        // `(0, Date)()`, `Date?.()`, an alias) except as the object of a member access (`Date.UTC`, `Date?.x`, `Date[k]`) or the
        // operand of typeof / instanceof, and that only when the sentinel itself isn't called, optionally called or
        // tagged: in `typeof Date()` the operand is the call (p8-globals2v H1).
        else if (!/^\s*(\?\.(?!\s*\()|\.|\[)/.test(after) && !(/(^|[^\w$])(typeof|instanceof)\s+$/.test(before) && !/^\s*(\?\.\s*)?[(`]/.test(after))) seen.add(k);
      } else if (r.name.startsWith(name + ".") && r.name !== "import.meta") {
        const prop = escapeRe(r.name.slice(name.length + 1));
        if (new RegExp(`^\\s*(\\?\\.\\s*${prop}(?![\\w$])|(\\?\\.\\s*)?\\[\\s*(["'\`])${prop}\\3\\s*\\])`).test(after)) seen.add(k);
      }
    });
  }
  return CORE_GLOBALS.filter((_, k) => seen.has(k)).map(r => ({ file, global: r.global }));
}

/**
 * [{ start, text }] for every import( call in a source whose specifier is not a literal: one quoted string, or a
 * template with no ${} and no backslash, as the only argument. Decided by the parser (brief p8-globals):
 *   - candidates: every raw-text word `import`; each is swapped for a token `<pre>a<n>`, and `<pre>a<n>` is defined to
 *     `<pre>b<n>`. In code the token is a free reference, so `<pre>b<n>` is printed; in a comment it vanishes, in a
 *     string, template text or regex it stays `<pre>a<n>`; as a member or property name (`x.import(…)`) it isn't free.
 *   - a printed `<pre>b<n>(` is an import() call in code; the argument printed after it is judged (the printer's
 *     canonical form: a string literal in quotes, a template, or anything else).
 *   - all candidates are swapped at once; if that copy doesn't parse (a static `import … from` swapped becomes
 *     `<tok> … from`, which never parses), each is probed alone, and one whose own probe fails is a static import
 *     (a swap in a comment, a string or a call never breaks a parse), so no import() call.
 * Throws if the parser rejects `src` itself, or if it holds a `with` statement (refuseWith).
 */
export function computedImports(src, file = "<source>") {
  const base = printed(file, src);
  refuseWith(file, src, base);
  const cands = [...src.matchAll(/\bimport\b/g)].map((m, n) => ({ at: m.index, n }));
  if (!cands.length) return [];
  const pre = prefixFor(src, base);
  const t = withDefine(Object.fromEntries(cands.map(({ n }) => [`${pre}a${n}`, `${pre}b${n}`])));
  const probe = list => {
    let s = "", at = 0;
    for (const c of list) { s += src.slice(at, c.at) + `${pre}a${c.n}`; at = c.at + "import".length; }
    try { return t.transformSync(s + src.slice(at) + AS_MODULE); } catch { return null; }
  };
  const LITERAL = /^\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`$\\]*`)\s*\)/;
  const out = [];
  const judge = (c, text) => {
    const m = new RegExp(`${escapeRe(pre)}b${c.n}(?![\\w$])`).exec(text);
    if (!m) return;                                                // comment, string, member or property name
    const after = text.slice(m.index + m[0].length);
    if (!/^\s*\(/.test(after)) return;                             // import.meta and the like: not a call
    if (!LITERAL.test(after.trimStart())) out.push({ start: c.at, text: src.slice(c.at, c.at + 46).split(/[\n\r\u2028\u2029]/)[0] });
  };
  const all = probe(cands);
  if (all !== null) for (const c of cands) judge(c, all);
  else for (const c of cands) { const one = probe([c]); if (one !== null) judge(c, one); }
  return out;
}

/**
 * THE list of dev-only modules (p7-archtest, C-16): never in the production page's graph, and server/static.js's
 * DENY must refuse every one (checked below, so the two can't drift). Each entry matches repo paths under web/.
 */
export const DEV_MODULES = Object.freeze([
  { why: "dev pages and their roots (dev.html, dev.js, dev-main.html, dev-main.js)", test: p => /^web\/dev[^/]*\.(js|html)$/.test(p) },
  { why: "the collab dev harness (web/collab/**)", test: p => p.startsWith("web/collab/") },
  { why: "the dev token table", test: p => p === "web/core/dev-users.js" },
  { why: "the in-page dev room", test: p => p === "web/adapters/transport/local.js" },
  { why: "the in-browser dev room", test: p => p.startsWith("web/adapters/transport/shared-worker/") },
  { why: "test fakes (web/adapters/<port>/fake.js)", test: p => /^web\/adapters\/[^/]+\/fake\.js$/.test(p) },
  { why: "the virtual clock (tests)", test: p => p === "web/adapters/clock/virtual.js" },
  { why: "the in-memory store (tests)", test: p => p === "web/adapters/storage/memory.js" },
]);
/** Dev-only modules: never in the production page's graph (server/static.js denies these paths too). */
export const isDevModule = p => DEV_MODULES.some(d => d.test(p));
/** web/<rest> → the URL path static.js serves it at ("/<rest>"). */
const urlPathOf = p => p.slice("web".length);
/** Every file a browser loads from `entry`: runtime imports and modules started by URL, followed transitively
 *  (JSDoc type imports load nothing). */
export function runtimeGraph(entry, imp) {
  const seen = new Set([entry]), todo = [entry];
  while (todo.length) for (const { to, kind } of imp(todo.pop())) if (loads(kind) && !seen.has(to)) { seen.add(to); todo.push(to); }
  return [...seen].sort();
}


/** Violations minus the allowlist, plus every allowlist entry that no longer occurs (stale). */
export function applyAllowlist(violations, allowlist) {
  const key = v => `${v.from} -> ${v.to}`;
  const allowed = new Set(allowlist.map(key)), seen = new Set(violations.map(key));
  return [
    ...violations.filter(v => !allowed.has(key(v))).map(v => `${v.rule}: ${key(v)}`),
    ...allowlist.filter(a => !seen.has(key(a))).map(a => `stale-allowlist: ${key(a)}`),
  ];
}

describe("web/ architecture (hexagonal boundaries)", () => {

  test("every web/ file is core, port, adapter or a composition root (nothing unclassified)", () => {
    const files = listFiles(["web"]);
    expect(files.length).toBeGreaterThan(30);
    const odd = files.filter(p => !isCore(p) && !isPort(p) && !isAdapter(p) && !ROOTS.includes(p));
    expect(odd).toEqual([]);
    for (const r of ROOTS) expect(files).toContain(r);
  });

  test("checkBoundaries: core imports no adapter, adapters don't import each other, only roots wire adapters", () => {
    const files = listFiles(["web"]);
    const v = checkBoundaries({
      files,
      isCore: p => isCore(p) || isPort(p),                  // ports, like core, never import an adapter
      isAdapter, adapterGroup, compositionRoots: ROOTS, allowlist: [], urls: true,
    });
    expect(v.map(x => `${x.rule}: ${x.from} -> ${x.to}`)).toEqual([]);
  });

  test("web/ rules: core imports only packages, ports, core; the protocol seam; ports import nothing; adapters stay in their lane", () => {
    const graph = listFiles(["web"]).map(f => [f, edgesOf(f)]);
    expect(applyAllowlist(webViolations(graph), SEAM_ALLOWLIST)).toEqual([]);
  });

  // The rules themselves, on synthetic sources, so a broken rule fails here (a mutation check that stays in the repo).
  test("the rules catch what they should (synthetic sources)", () => {
    const g = (path, src) => [path, importsOf(path, src)];
    const bad = webViolations([
      g("web/core/a.js", 'import { x } from "../adapters/storage/local.js";'),
      g("web/core/b.js", 'import { R } from "../../packages/protocol/room.js";'),
      g("web/ports/p.js", 'import { y } from "../core/sync.js";'),
      g("web/adapters/storage/local.js", 'import { z } from "../clock/browser.js";'),
      g("web/adapters/dom/app.js", 'import { s } from "./paint.js";\nimport { t } from "./collab/ui.js";'),
      g("web/adapters/transport/shared-worker/host.js", 'import { c } from "./client.js";'),
    ]).map(v => `${v.rule}: ${v.from}`);
    expect(bad).toEqual([
      "core-imports: web/core/a.js",
      "protocol-seam: web/core/b.js",
      "port-imports: web/ports/p.js",
      "adapter-imports: web/adapters/storage/local.js",
    ]);
    // A port's JSDoc type import is not a runtime import.
    expect(webViolations([g("web/ports/net.js", '/**\n * @property {() => import("./transport.js").Transport} join\n */')])).toEqual([]);
    // Shrink-only: a stale entry is a violation.
    expect(applyAllowlist([], [{ from: "web/x.js", to: "packages/protocol/room.js" }])).toEqual(["stale-allowlist: web/x.js -> packages/protocol/room.js"]);
    // checkBoundaries with the same classification catches a core -> adapter import and an unwired adapter import.
    const v = checkBoundaries({
      files: [{ path: "web/core/a.js", src: 'import { x } from "../adapters/storage/local.js";' },
        { path: "web/adapters/storage/local.js", src: 'import { y } from "../clock/browser.js";' }],
      isCore: p => isCore(p) || isPort(p), isAdapter, adapterGroup, compositionRoots: ROOTS, allowlist: [],
    }).map(x => x.rule).sort();
    expect(v).toEqual(["adapter->adapter", "core->adapter"]);
  });

  test("core reads no browser global (clock, storage, location and the DOM come through ports or the root)", () => {
    const core = listFiles(["web/core"]);
    expect(core.length).toBeGreaterThan(8);
    expect(core.flatMap(f => globalsIn(f, readFileSync(join(ROOT, f), "utf8"))).map(v => `${v.file}: ${v.global}`)).toEqual([]);
  });

  test("the globals rule catches bare globals, not comments, strings or member names (synthetic sources)", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits("const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("setTimeout(f, 1); document.title = 'x';")).toEqual(["document", "setTimeout"]);
    expect(hits("const r = Math.random() * 2;")).toEqual(["Math.random"]);
    expect(hits("if (location.hash) history.back();")).toEqual(["location", "history"]);
    expect(hits("// Date.now and setTimeout in a comment\n/* document */ const s = \"localStorage\";")).toEqual([]);
    expect(hits("o.location = 1; clock.setTimeout; const { now } = clock; myfetch(); x.document;")).toEqual([]);
    // p6-hexv: inside a template's ${...} it is code, at any depth; the template's own text is not.
    expect(hits("const s = `${Date.now()}`;")).toEqual(["Date.now"]);
    expect(hits("const s = `a ${`b ${document.title} c`} d`;")).toEqual(["document"]);
    expect(hits("const s = `document ${'location'} ${{ a: 1 }.a} Date.now`;")).toEqual([]);
    expect(hits("const s = `${x}`; const t = setTimeout;")).toEqual(["setTimeout"]);   // the scan resumes after a template
    // p7-archtestv R2-MED-2: after the ")" of an if head a "/" starts a regex, so the line's Date.now stays code.
    expect(hits("if (client) /\\//.test(board); const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("const m = (a + b) / 2; const t = Date.now(); // a comment")).toEqual(["Date.now"]);
    expect(hits("const m = (a + b) / 2; // Date.now in a comment")).toEqual([]);
    // p8-tidyv M1 and L6: the line after for await (…) /re/ and after i++ / 2 stays code.
    expect(hits("for await (const x of y) /\\//.test(x); const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("i++ / 2; const t = Date.now(); // x")).toEqual(["Date.now"]);
    expect(hits("++/\\//.lastIndex; const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("x = --/\\//.lastIndex; const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("const x = of / 2; const t = Date.now(); const y = 1 / 3;")).toEqual(["Date.now"]);
    for (const line of ["x\n++/\\//.lastIndex; import(d); Date.now();", "if (x) { x = 2 } ++/\\//.lastIndex; import(d); Date.now();",
      "const a = [1]\n--/\\//.lastIndex; import(d); Date.now();", "x = { a: 1 }\n++/\\//.lastIndex; import(d); Date.now();",
      "const f = () => {}\n++/\\//.lastIndex; import(d); Date.now();", "const z = y\nof / 2; Date.now(); const w = 1 / 3;"]) expect(hits(line)).toEqual(["Date.now"]);
    // p6-hexv: the wall clock through Date(), and the worker global self.
    expect(hits("const d = new Date();")).toEqual(["Date("]);
    expect(hits("const s = Date();")).toEqual(["Date("]);
    expect(hits("self.postMessage(1);")).toEqual(["self"]);
    expect(hits("x.self; mySelf(); isDate(1); toDate (2); a.Date(3);")).toEqual([]);
    // p7-archtestv MED-2: a regex literal holding // , /* or a quote no longer hides the rest of its line.
    expect(hits("const r = /\\//; const z = r && Date.now();")).toEqual(["Date.now"]);
    expect(hits("const r = /\\/*x/; setTimeout(f);")).toEqual(["setTimeout"]);
    expect(hits("const q = /[\"'`]/g; document.title;")).toEqual(["document"]);
    // p8-globals: a top-level return is a SyntaxError in a module, so the case sits in a function (same evasion).
    expect(hits("function f() { const q = s.replace(/\\/\\//g, ''); return /a/.test(x) && fetch(u); }")).toEqual(["fetch"]);
    expect(hits("const h = a / b / 2; const w = (x) / y; setInterval(f);")).toEqual(["setInterval"]);   // division stays code
    expect(hits("const r = /Date.now() document/;")).toEqual([]);                                        // a regex body is not code
    // p8-globals (changed expectation, listed in docs/m2/reports/p8-globals.md): a property key named like a global
    // (`{ self: 1 }`) is no read of the global, and the parser knows it; HEAD's text scan flagged it. The shorthand
    // `{ self }` IS a read and is still caught.
    expect(hits("const o = { self: 1 };")).toEqual([]);
    expect(hits("const o = { self };")).toEqual(["self"]);
  });

  // ── p8-globals: the check is Bun's parser (define), proved name by name ──

  // Written out, not derived from NAMES / CORE_GLOBALS, so dropping a name from either list fails here.
  const EVERY_GLOBAL = ["document", "window", "globalThis", "self", "location", "history", "localStorage", "sessionStorage", "indexedDB",
    "navigator", "SharedWorker", "Worker", "WebSocket", "XMLHttpRequest", "fetch", "requestAnimationFrame", "cancelAnimationFrame",
    "matchMedia", "performance", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "Date.now",
    "Math.random", "crypto", "addEventListener", "postMessage", "console", "Date(", "Function(", "eval", "import.meta"];
  /** A bare use of each rule's global, in code. */
  const use = g => g === "import.meta" ? "import.meta.url" : g.endsWith("(") ? `${g.slice(0, -1)}(1)` : g === "eval" ? "eval(x)" : `${g}.x`;

  test("p8-globals: each global, on its own, is caught in code and nowhere else", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    for (const g of EVERY_GLOBAL) {
      expect([g, hits(`const v = ${use(g)};`)]).toEqual([g, [g]]);                    // a free reference
      expect([g, hits(`const v = () => \`a \${${use(g)}} b\`;`)]).toEqual([g, [g]]);     // inside a template's ${}
      expect([g, hits(`const v = o.${use(g)};`)]).toEqual([g, []]);                        // a member of something else
      expect([g, hits(`const s = "${use(g)}", t = '${use(g)}', u = \`${use(g)}\`; // ${use(g)}\n/* ${use(g)} */ const r = /${use(g).replace(/[()]/g, "\\$&")}/;`)]).toEqual([g, []]);
      if (g !== "import.meta" && g !== "eval") {                                           // neither can be a binding
        const base = g.replace(/[.(].*/, "");
        expect([g, hits(`function f(${base}) { return ${use(g)}; }`)]).toEqual([g, []]);  // shadowed by a parameter
        expect([g, hits(`{ const ${base} = {}; ${use(g)}; }`)]).toEqual([g, []]);         // shadowed by a block's const
      }
    }
  });

  test("p8-globals: shadowing, hoisting, keys, dead code, Date/Math forms (changed and tightened expectations)", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    // Changed (looser, no global read): shadowed locals, hoisted var/function, catch params, keys, class members.
    expect(hits("const document = make(); document.title;")).toEqual([]);
    expect(hits("function q() { return location.hash; } var location = { hash: '' };")).toEqual([]);
    expect(hits("try { f() } catch (performance) { performance.now() }")).toEqual([]);
    expect(hits("const { document: d } = o; class A { fetch() {} static self = 1 } o = { console: 1, ['x']: 2 };")).toEqual([]);
    // But a shadow ends with its scope: the same name outside it is the global.
    expect(hits("{ const document = 1; } document.title;")).toEqual(["document"]);
    expect(hits("function f(fetch) { return fetch; } fetch(u);")).toEqual(["fetch"]);
    expect(hits("const o = { [self]: 1 }; export default document;")).toEqual(["document", "self"]);
    expect(hits("const t = typeof window; delete navigator.x; crypto = 1;")).toEqual(["window", "navigator", "crypto"]);
    // Dead code is still code (deadCodeElimination is off).
    expect(hits("if (false) { document.title; }")).toEqual(["document"]);
    // Date( and Function( mean a call or a construction, as before; `new Date` without parens is one too (tightened:
    // HEAD's text rule needed the "(").
    expect(hits("const d = new Date;")).toEqual(["Date("]);
    expect(hits("const d = new Date(1), e = Date?.(), f = new Function;")).toEqual(["Date(", "Function("]);
    expect(hits("Date.UTC(1); x instanceof Date; new Date.Sub(); typeof Function;")).toEqual([]);   // as HEAD: no call of Date itself
    // Dotted names through optional chaining and a quoted key (tightened: HEAD missed these).
    expect(hits("Date?.now(); Math['random']();")).toEqual(["Date.now", "Math.random"]);
    expect(hits('Date?.["now"](); Math?.random();')).toEqual(["Date.now", "Math.random"]);
    expect(hits("Date . now();")).toEqual(["Date.now"]);
    expect(hits("const Math = { random: () => 4 }; Math.random(); Date.nowish();")).toEqual([]);
  });

  test("p8-globals: every source is parsed as a module, so a block's function doesn't hoist over a global", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits("{ function fetch() {} } fetch(u);")).toEqual(["fetch"]);
    expect(hits("if (x) { function setTimeout() {} } setTimeout(f, 1); // a trailing comment")).toEqual(["setTimeout"]);
    expect(hits("export {}; { function fetch() {} } fetch(u);")).toEqual(["fetch"]);
    expect(hits("function fetch() {} fetch(u);")).toEqual([]);                  // a top-level function is a real binding
    // Bun's own import.meta properties are import.meta too.
    for (const p of ["main", "require('x')", "resolve('x')", "env.X", "hot", "dirname", "path"]) expect(hits(`const v = import.meta.${p};`)).toEqual(["import.meta"]);
  });

  test("p8-globals2 (L2, L3, L4): Date and Function count in any use but a member access, typeof or instanceof", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    // L2: compound callees (HEAD missed these too).
    expect(hits("const d = new (0, Date)();")).toEqual(["Date("]);
    expect(hits("const d = (0, Date)();")).toEqual(["Date("]);
    expect(hits('const g = new (0, Function)("return this")();')).toEqual(["Function("]);
    // L3: tagged templates.
    expect(hits("const d = Date`x`;")).toEqual(["Date("]);
    expect(hits("const g = Function`return this`();")).toEqual(["Function("]);
    // Aliases and hand-offs are uses too (tightened).
    expect(hits("const D = Date; D.now();")).toEqual(["Date("]);
    expect(hits("f(Function); const a = [Date];")).toEqual(["Date(", "Function("]);
    // L4: an optional call on its own.
    expect(hits("Date?.();")).toEqual(["Date("]);
    expect(hits('Function?.("x");')).toEqual(["Function("]);
    // Unchanged: member access, typeof, instanceof.
    expect(hits("Date.UTC(1); Date?.x; Date[k]; Date?.[k]; typeof Date; x instanceof Function; new Date.Sub();")).toEqual([]);
    expect(hits("Date.now(); Date?.now(); Date[\"now\"]();")).toEqual(["Date.now"]);
    expect(hits("x instanceof Date && typeof Function === 'function';")).toEqual([]);
  });

  test("p8-globals2v H1: typeof / instanceof exempt the bare name only, never a call, optional call or tag of it", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits("const t = typeof Date();")).toEqual(["Date("]);
    expect(hits("const t = typeof Date?.();")).toEqual(["Date("]);
    expect(hits("const t = typeof Function('return this')();")).toEqual(["Function("]);
    expect(hits("const t = typeof Function('globalThis.fetch(1)')();")).toEqual(["Function("]);
    expect(hits("x instanceof Date();")).toEqual(["Date("]);
    expect(hits("x = typeof\nDate();")).toEqual(["Date("]);
    expect(hits("x = typeof (Date)();")).toEqual(["Date("]);
    expect(hits("x = typeof /*c*/ Date();")).toEqual(["Date("]);
    expect(hits("const t = typeof Date`x`;")).toEqual(["Date("]);
    expect(hits("const t = typeof Function`return this`;")).toEqual(["Function("]);
    // Still [] (the bare name as the operand):
    expect(hits("typeof Date; x instanceof Function; typeof Date === 'function';")).toEqual([]);
    expect(hits("const t = typeof Date;")).toEqual([]);
    expect(hits("x instanceof Function;")).toEqual([]);
    expect(hits("if (typeof Date === 'function') f();")).toEqual([]);
  });

  test("p8-globals2 (L1): a `with` statement is a loud failure in both checks; the word `with` elsewhere is not", () => {
    const g = src => () => globalsIn("web/core/x.js", src), c = src => () => computedImports(src, "web/ports/p.js");
    for (const src of ["with (o) { document.title; }", "function f(o) {\n  with (o)\n  { return import(d); }\n}",
      "with (o) x.y;", "const f = () => `${(() => { with (o) { return 1; } })()}`;", "a: with (o) { break a; }",
      "if (x) with (o) y; else z;", "class A { static { with (o) {} } }", "/* with */ const s = 'with'; with(o){}"]) {
      expect(g(src)).toThrow(/web\/core\/x\.js: a `with` statement \(line \d+\)/);
      expect(c(src)).toThrow(/web\/ports\/p\.js: a `with` statement/);
    }
    expect(c("const a = 1;\nfunction f(o) {\n  with (o) {}\n}")).toThrow(/\(line 3\)/);
    // Not a with statement: comments, strings, templates, regex, property, member and method names, import attributes,
    // and names that merely contain "with".
    for (const src of ["// with (o) { document }\n/* with (o) {} */ const s = 'with (o) {}', t = \"with\", u = `with (o) ${1}`;",
      "const r = /with (o)/; const o = { with: 1, 'with': 2 }; o.with; o?.with; o['with'];",
      "class A { with() {} static with = 1; #with = 2; get with() { return 1; } } const b = { with() {} };",
      'import j from "./a.json" with { type: "json" };\nexport { k } from "./b.json" with { type: "json" };',
      "const withX = 1, $with = 2, with_ = 3; withX + $with + with_;", 'const m = import("./a.json", { with: { type: "json" } });']) {
      expect(g(src)).not.toThrow();
      expect(c(src)).not.toThrow();
    }
  });

  test("p8-globals: R4-L1 (a raw U+2028 / U+2029 inside a string) ends nothing; CR and LS line breaks still break", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits("const s = 'a\u2028'; import(d); Date.now();")).toEqual(["Date.now"]);
    expect(hits('const s = "c\u2029d", u = `e\u2028`; setTimeout(f);')).toEqual(["setTimeout"]);
    expect(computedImports("const s = 'a\u2028'; import(d); Date.now();")).toHaveLength(1);
    expect(computedImports('const s = "c\u2029d"; import(d);')).toHaveLength(1);
    expect(hits("const s = 1; // c\u2028document.title")).toEqual(["document"]);
  });

  test("p8-globals: the sentinel can't be forged by the file's own text (raw or escaped)", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits('const a = "__arch_g_0", b = "\\x5f_arch_g_1", c = "__arch_g_2(";')).toEqual([]);
    expect(hits('const a = "__arch_g_0"; const t = Date.now();')).toEqual(["Date.now"]);
    expect(computedImports('const a = "__arch_g_b0(x)", b = "\\x5f_arch_g_b1(y)"; import("./a.js");')).toEqual([]);
    expect(computedImports('const a = "__arch_g_b0(x)"; import(a);')).toHaveLength(1);
    // Escapes alone (no raw prefix in the file): printing decodes "\x5f" to "_", so the prefix must be absent from the
    // printed output too.
    expect(hits('const b = "\\x5f_arch_g_0";')).toEqual([]);
    expect(computedImports('const a = "\\x5f_arch_g_b0(x)"; import("./a.js");')).toEqual([]);
  });

  test("p8-globals: a file the parser rejects fails loudly in both checks, never as clean", () => {
    expect(() => globalsIn("web/core/x.js", "const ;")).toThrow(/web\/core\/x\.js: the parser rejects it/);
    expect(() => globalsIn("web/core/x.js", "const s = 'a\nb'; document;")).toThrow(/parser rejects/);
    expect(() => computedImports("import(", "web/core/y.js")).toThrow(/web\/core\/y\.js: the parser rejects it/);
    expect(() => computedImports("function (", "web/core/y.js")).toThrow(/parser rejects/);
  });

  test("p8-globals: computed import() forms the parser decides (changed expectations listed in the report)", () => {
    const n = src => computedImports(src).length;
    expect(n("const m = await import /* c */ (name);")).toBe(1);                   // a comment between import and (
    expect(n("const m = await import\n(name);")).toBe(1);
    expect(n('import { a } from "./a.js";\nimport * as b from "./b.js";\nexport { c } from "./c.js";\nconst m = import(spec);')).toBe(1);   // static imports beside it
    expect(n('import "./side.js";\nconst m = import("./x.js");')).toBe(0);
    expect(n('const m = import("x", { with: { type: "json" } });')).toBe(1);       // as HEAD: only a lone literal
    expect(n("const m = import.meta; const u = import.meta.url;")).toBe(0);         // not a call
    expect(n("const v = `${import(spec)}`; /*! import(name) */")).toBe(1);
    expect(n("if (false) { import(name); }")).toBe(1);                                // dead code is code
    // Changed (looser; HEAD flagged them as computed, but each is one literal the scanner reads):
    expect(n('const m = import(("./x.js"));')).toBe(0);
    expect(n('const m = import("./\\u0078.js");')).toBe(0);
    expect(n("const o = { import(x) { return x; } }; o?.import(y); class C { import(z) {} }")).toBe(0);
  });

  // Manager decision (p6-hex fix round): web/main.js is the production root; nothing it loads may be a dev module.
  test("production: web/main.js's whole runtime graph holds no dev module, and every file exists under a served mount", () => {
    const graph = runtimeGraph("web/main.js", f => edgesOf(f));
    expect(graph.length).toBeGreaterThan(15);
    expect(graph.filter(isDevModule)).toEqual([]);
    expect(graph).toContain("web/adapters/transport/ws.js");
    // p7-wire: the collab UI is production, over the sync-side port (never the fake).
    expect(graph).toContain("web/adapters/collab/sync.js");
    expect(graph).toContain("web/adapters/dom/collab/ui.js");
    expect(graph.filter(p => !(p.startsWith("web/") || p.startsWith("packages/core/") || p.startsWith("packages/protocol/")))).toEqual([]);
    expect(graph.filter(p => { try { readFileSync(join(ROOT, p)); return false; } catch { return true; } })).toEqual([]);
    const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
    expect([...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1])).toEqual(["main.js"]);
    expect(html).not.toMatch(/src="[^"]*dev/);
    // The dev root, by contrast, does load the dev rooms (so the check above is not vacuous).
    expect(runtimeGraph("web/dev-main.js", f => edgesOf(f)).filter(isDevModule).length).toBeGreaterThan(0);
  });

  test("the production-graph check catches a dev module reached transitively (synthetic sources)", () => {
    const src = {
      "web/main.js": 'import { a } from "./adapters/dom/app.js";\n/** @type {import("./adapters/clock/virtual.js").X} */',
      "web/adapters/dom/app.js": 'import { b } from "../../core/session.js";',
      "web/core/session.js": 'import { DEV_USERS } from "./dev-users.js";',
      "web/core/dev-users.js": "export const DEV_USERS = {};",
    };
    const graph = runtimeGraph("web/main.js", f => importsOf(f, src[f] ?? ""));
    expect(graph.filter(isDevModule)).toEqual(["web/core/dev-users.js"]);          // the type import of virtual.js loads nothing
    expect(isDevModule("web/dev-main.js") && isDevModule("web/adapters/auth/fake.js") && !isDevModule("web/adapters/auth/http.js")).toBe(true);
  });

  test("adapter groups: dom is one adapter; each transport is its own; shared-worker's three files are one", () => {
    expect(adapterGroup("web/adapters/dom/app.js")).toBe(adapterGroup("web/adapters/dom/collab/ui.js"));
    expect(adapterGroup("web/adapters/transport/local.js")).not.toBe(adapterGroup("web/adapters/transport/ws.js"));
    expect(new Set(["client", "host", "worker"].map(f => adapterGroup(`web/adapters/transport/shared-worker/${f}.js`))).size).toBe(1);
    expect(adapterGroup("web/adapters/storage/session.js")).not.toBe(adapterGroup("web/adapters/storage/local.js"));
  });

  // ── p7-archtest (p7-audit C-14, C-16) ──

  test("core has no computed import(): every specifier is a literal the scanner sees", () => {
    const hits = listFiles(["web/core", "web/ports"]).flatMap(f => computedImports(readFileSync(join(ROOT, f), "utf8"), f).map(h => `${f}: ${h.text}`));
    expect(hits).toEqual([]);
  });

  test("computedImports flags a non-literal specifier only (synthetic sources)", () => {
    const n = src => computedImports(src).length;
    expect(n('const m = await import("./x.js");')).toBe(0);
    expect(n("const m = await import('./x.js');")).toBe(0);
    expect(n("const m = await import(`./x.js`);")).toBe(0);
    expect(n('/** @type {import("./x.js").T} */ // import(name)')).toBe(0);     // types and comments load nothing
    expect(n('const s = "import(name)";')).toBe(0);
    expect(n("const m = await import(name);")).toBe(1);
    expect(n('const m = await import("../adapters/" + "storage/local.js");')).toBe(1);
    expect(n("const m = await import(`../adapters/${kind}.js`);")).toBe(1);
    expect(n("const m = await import ( spec );")).toBe(1);
    expect(n("x.import(y);")).toBe(0);                                            // a method named import
    expect(n("const r = /\\//; import(board).catch(() => {});")).toBe(1);         // p7-archtestv MED-2
    // p7-archtestv R2-MED-2: a regex after the ")" of an if/while/for/with head, then a computed import on that line.
    expect(n("if (client) /\\//.test(board); import(board).then(m => m); const t = Date.now();")).toBe(1);
    // p8-tidyv H2: each head word on its own (a "//" inside the regex would open a comment if read as division).
    expect(n("while (go) /\\//.test(s); import(spec)")).toBe(1);
    expect(n("for (;;) /\\//.test(c); import(d)")).toBe(1);
    expect(n("x.if(a) / 2; // import(y)")).toBe(0);                             // a method named if: division
    expect(n("x . if (a) / 2; // import(y)")).toBe(0);
    // p8-tidyv M1: for await (…) /re/.
    expect(n("for await (const x of y) /\\//.test(x); import(d); Date.now();")).toBe(1);
    expect(n("const a = await (p) / 2; // import(y)")).toBe(0);                  // await alone: division
    expect(n("await (p) / 2; // import(y)")).toBe(0);
    // p8-tidyv L6: a postfix ++ / -- ends the value, so "/" divides.
    expect(n("i++ / 2; import(d); Date.now(); // x")).toBe(1);
    expect(n("i-- / 2; import(d); // x")).toBe(1);
    // p8-tidyv R2-M1: a prefix ++ / -- may take a regex; postfix ones still divide.
    expect(n("++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("x = --/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("a[i]++ / 2; import(d); // x")).toBe(1);
    expect(n("(a)++ / 2; import(d); // x")).toBe(1);
    expect(n("if (x) ++/\\//.lastIndex; import(d);")).toBe(1);
    expect(n("function f() { return ++/\\//.lastIndex; import(d); }")).toBe(1);   // p8-globals: in a function (module)
    // p8-tidyv R2-L2: `of` as a name divides; `for (… of /re/)` still starts a regex.
    expect(n("const x = of / 2; import(d); const y = 1 / 3;")).toBe(1);
    expect(n("for (const x of /\\//.exec(s)) import(d);")).toBe(1);
    expect(n("for (const [a] of /\\//.exec(s)) import(d);")).toBe(1);
    // p8-tidyv R3-M1: a line break (or a block's "}") before ++/-- makes it prefix, so a regex may follow.
    expect(n("x\n++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("if (x) { x = 2 } ++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("const a = [1]\n--/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("x = { a: 1 }\n++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("const f = () => {}\n++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("x /* c */ ++ / 2; import(d); // x")).toBe(1);                      // same line through a comment: postfix
    // p8-tidyv R3-L1: `of` as a name after a line break; a for head with line breaks still reads `of` as a keyword.
    expect(n("const z = y\nof / 2; import(d); const w = 1 / 3;")).toBe(1);
    expect(n("for (const x\nof /\\//.exec(s)) import(d);")).toBe(1);
    expect(n("for await (const x of /\\//.exec(s)) import(d);")).toBe(1);
    expect(n("f(y, of / 2); import(d); const w = 1 / 3;")).toBe(1);
    expect(n("for (let i = of / 2; i < 1; i++) import(d);")).toBe(1);           // `of` as a name inside a classic for head
    // Round 4, the builder's own evasion: CR, LS (U+2028) and PS (U+2029) are line breaks too (ASI, and they end a //
    // comment and a regex literal). Bun parses and runs these.
    expect(n("x\r++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("x\u2028++/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("x\u2029--/\\//.lastIndex; import(d); Date.now();")).toBe(1);
    expect(n("const s = 1; // a comment\u2028import(d);")).toBe(1);
    expect(n("const s = 1; // a comment\rimport(d);")).toBe(1);
    expect(n("const mid = (a + b) / 2; import(x); // (a + b) / 2 divides")).toBe(1);   // division still divides
  });

  test("the globals rule also catches Function(, eval and import.meta (synthetic sources)", () => {
    const hits = src => globalsIn("web/core/x.js", src).map(v => v.global);
    expect(hits('const g = Function("return this")();')).toEqual(["Function("]);
    expect(hits('const g = new Function("return this")();')).toEqual(["Function("]);
    expect(hits('const g = eval("this");')).toEqual(["eval"]);
    expect(hits('const u = new URL("../adapters/storage/local.js", import.meta.url);')).toEqual(["import.meta"]);
    expect(hits("x.Function(1); isFunction(f); evaluate(); o.eval; x.import.meta;")).toEqual([]);
    expect(hits("/** @param {Function} f */ const s = 'eval';")).toEqual([]);
  });

  test("new URL(…, import.meta.url) edges count: core → adapter is a violation in both rule sets (synthetic sources)", () => {
    const src = 'const u = new URL("../adapters/storage/local.js", import.meta.url);';
    expect(webViolations([["web/core/a.js", edgesOf("web/core/a.js", src)]]).map(v => v.rule)).toEqual(["core-imports"]);
    const v = checkBoundaries({
      files: [{ path: "web/core/a.js", src }], isCore: p => isCore(p) || isPort(p), isAdapter, adapterGroup,
      compositionRoots: ROOTS, allowlist: [], urls: true,
    }).map(x => x.rule);
    expect(v).toEqual(["core->adapter"]);
  });

  test("the production graph follows new URL(…): a dev module started by URL from dom/app.js is caught (synthetic sources)", () => {
    const src = {
      "web/main.js": 'import { a } from "./adapters/dom/app.js";',
      "web/adapters/dom/app.js": 'const w = new SharedWorker(new URL("../transport/shared-worker/worker.js", import.meta.url));',
      "web/adapters/transport/shared-worker/worker.js": "",
    };
    const graph = runtimeGraph("web/main.js", f => edgesOf(f, src[f] ?? ""));
    expect(graph.filter(isDevModule)).toEqual(["web/adapters/transport/shared-worker/worker.js"]);
  });

  // C-16: one list of dev modules (DEV_MODULES), checked against static.js's DENY.
  // Every script and HTML page under web/, at any depth (p7-archtestv LOW 6: web/collab/dev.html too).
  const webPages = () => readdirSync(join(ROOT, "web"), { recursive: true }).map(String).filter(f => f.endsWith(".html")).map(f => `web/${f.split("\\").join("/")}`);
  const allWebFiles = () => listFiles(["web"]).concat(webPages()).sort();
  const devFiles = () => allWebFiles().filter(isDevModule);

  // C-16, closed by engine in 422526c: DENY refuses every dev-only module.
  test("C-16: static.js's DENY refuses every dev-only module on DEV_MODULES", () => {
    const files = devFiles();
    expect(files).toContain("web/adapters/storage/memory.js");
    expect(files).toContain("web/core/dev-users.js");
    expect(files).toContain("web/dev-main.js");
    expect(files).toContain("web/collab/dev.html");
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter(f => !denied(urlPathOf(f)))).toEqual([]);
    // Every list entry names at least one real file (a stale rule shows here).
    for (const d of DEV_MODULES) expect(files.some(d.test)).toBe(true);
  });

  test("and the other way: every web/ file DENY refuses is on DEV_MODULES", () => {
    const all = allWebFiles();
    expect(all).toContain("web/collab/dev.html");
    expect(all.filter(f => denied(urlPathOf(f)) && !isDevModule(f))).toEqual([]);
  });
});
