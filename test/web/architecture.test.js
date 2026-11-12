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
//     setTimeout/setInterval, Math.random, performance, requestAnimationFrame directly): a token check over core's
//     source with comments and string literals blanked (not an import scanner; the same technique as the sign-in
//     source checks). Time, timers and randomness come from the clock port.
// The allowlist is explicit and shrink-only: an entry that no longer occurs fails the test.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, listFiles, importsOf, checkBoundaries } from "../arch-scan.js";

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
      if (isCore(from) && !(isPackage(to) || isPort(to) || isCore(to))) out.push({ rule: "core-imports", from, to });
      // Runtime only: a JSDoc type import loads nothing, and must not keep an allowlist entry alive (p6-hexv L).
      if (kind === "runtime" && to.startsWith("packages/protocol/") && from !== "web/core/sync.js") out.push({ rule: "protocol-seam", from, to });
      if (isPort(from) && kind === "runtime") out.push({ rule: "port-imports", from, to });
      if (isAdapter(from) && !(isPackage(to) || isPort(to) || isCore(to) || (isAdapter(to) && adapterGroup(to) === adapterGroup(from))))
        out.push({ rule: "adapter-imports", from, to });
    }
  }
  return out;
}

/** Browser globals core must not read, as patterns over code (member access like `x.location` is fine; only the bare
 *  global is caught). `Date(` covers `new Date(...)` and a bare `Date()` (the wall clock); `self` is the worker global. */
const NAMES = ["document", "window", "globalThis", "self", "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "navigator", "SharedWorker", "Worker", "WebSocket", "XMLHttpRequest", "fetch", "requestAnimationFrame", "cancelAnimationFrame",
  "matchMedia", "performance", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "Date.now",
  "Math.random", "crypto", "addEventListener", "postMessage", "console"];
const CORE_GLOBALS = [
  ...NAMES.map(g => ({ global: g, re: new RegExp(`(^|[^.\\w$])${g.replace(".", "\\.")}(?![\\w$])`, "m") })),
  { global: "Date(", re: /(^|[^.\w$])Date\s*\(/m },
];

/**
 * Source with comments and string-literal text blanked (lengths and newlines kept), so only code is checked. Template
 * literals keep their `${...}` expressions as code (p6-hexv: a global inside `${}` must still be caught), nested to
 * any depth. Regex literals are not special-cased (none in core holds a quote).
 */
export function codeOnly(src) {
  let out = "", i = 0;
  const blank = c => (c === "\n" ? "\n" : " ");
  // Code until the end, or (inExpr) until the "}" that closes a template's ${.
  function code(inExpr) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
      if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2), end = e < 0 ? src.length : e + 2; while (i < end) out += blank(src[i++]); continue; }
      if (c === '"' || c === "'") {
        out += src[i++];
        while (i < src.length && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") { out += " "; i++; } if (i < src.length) out += blank(src[i++]); }
        if (i < src.length) out += src[i++];
        continue;
      }
      if (c === "`") { out += src[i++]; template(); continue; }
      if (inExpr && c === "{") depth++;
      if (inExpr && c === "}") { if (depth === 0) return; depth--; }
      out += src[i++];
    }
  }
  // Template text until the closing backtick; each ${ ... } inside is code.
  function template() {
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { out += " "; i++; if (i < src.length) out += blank(src[i++]); continue; }
      if (c === "`") { out += src[i++]; return; }
      if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; code(true); if (i < src.length) out += src[i++]; continue; }
      out += blank(src[i++]);
    }
  }
  code(false);
  return out;
}
/** [{ file, global }] for every bare browser global in a core source. */
export function globalsIn(file, src) {
  const text = codeOnly(src), out = [];
  for (const { global, re } of CORE_GLOBALS) if (re.test(text)) out.push({ file, global });
  return out;
}

/** Dev-only modules: never in the production page's graph (server/static.js denies these paths too). */
export const isDevModule = p =>
  p === "web/core/dev-users.js" || p === "web/adapters/transport/local.js" || p.startsWith("web/adapters/transport/shared-worker/") ||
  p.startsWith("web/adapters/collab/") || /^web\/adapters\/[^/]+\/fake\.js$/.test(p) || p === "web/adapters/clock/virtual.js" ||
  /^web\/dev[^/]*\.(js|html)$/.test(p) || p.startsWith("web/collab/");
/** Every file a browser loads from `entry`: runtime imports, followed transitively (JSDoc type imports load nothing). */
export function runtimeGraph(entry, imp) {
  const seen = new Set([entry]), todo = [entry];
  while (todo.length) for (const { to, kind } of imp(todo.pop())) if (kind === "runtime" && !seen.has(to)) { seen.add(to); todo.push(to); }
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
      isAdapter, adapterGroup, compositionRoots: ROOTS, allowlist: [],
    });
    expect(v.map(x => `${x.rule}: ${x.from} -> ${x.to}`)).toEqual([]);
  });

  test("web/ rules: core imports only packages, ports, core; the protocol seam; ports import nothing; adapters stay in their lane", () => {
    const graph = listFiles(["web"]).map(f => [f, importsOf(f)]);
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
    expect(webViolations([g("web/ports/net.js", ' * @property {() => import("./transport.js").Transport} join')])).toEqual([]);
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
    // p6-hexv: the wall clock through Date(), and the worker global self.
    expect(hits("const d = new Date();")).toEqual(["Date("]);
    expect(hits("const s = Date();")).toEqual(["Date("]);
    expect(hits("self.postMessage(1);")).toEqual(["self"]);
    expect(hits("x.self; mySelf(); isDate(1); toDate (2); a.Date(3);")).toEqual([]);
    // Strict on purpose: a property key named like a global (`{ self: 1 }`) is flagged too; core simply avoids such names.
    expect(hits("const o = { self: 1 };")).toEqual(["self"]);
  });

  // Manager decision (p6-hex fix round): web/main.js is the production root; nothing it loads may be a dev module.
  test("production: web/main.js's whole runtime graph holds no dev module, and every file exists under a served mount", () => {
    const graph = runtimeGraph("web/main.js", f => importsOf(f));
    expect(graph.length).toBeGreaterThan(15);
    expect(graph.filter(isDevModule)).toEqual([]);
    expect(graph).toContain("web/adapters/transport/ws.js");
    expect(graph.filter(p => !(p.startsWith("web/") || p.startsWith("packages/core/") || p.startsWith("packages/protocol/")))).toEqual([]);
    expect(graph.filter(p => { try { readFileSync(join(ROOT, p)); return false; } catch { return true; } })).toEqual([]);
    const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
    expect([...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1])).toEqual(["main.js"]);
    expect(html).not.toMatch(/src="[^"]*dev/);
    // The dev root, by contrast, does load the dev rooms (so the check above is not vacuous).
    expect(runtimeGraph("web/dev-main.js", f => importsOf(f)).filter(isDevModule).length).toBeGreaterThan(0);
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
});
