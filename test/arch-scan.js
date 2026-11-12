// Import-graph scanner for the hexagonal boundary tests (docs/m2/OFFICE.md "Architecture"; brief p-arch).
// Static: it reads source text and parses import specifiers; it never executes a scanned file. Not a test file
// itself (no `.test.js`), so `bun test` only runs it through the tests that import it.
//
// API
//
//   ROOT                      the repo root (absolute path)
//
//   listFiles(dirs, root?)    every script file (.js .mjs .cjs .ts .mts .cts) under the repo-relative `dirs` (folders,
//                             recursively, or single files), as sorted repo-relative posix paths (node_modules skipped)
//
//   importsOf(file, src?, root?, { urls }?)
//                             the relative imports of repo-relative `file` (read from `root`, or taken from `src`),
//                             each `{ spec, to, kind }`: `to` is the target as a repo-relative posix path; `kind` is
//                             "runtime" (static import / export … from, side-effect import, import() with a quoted
//                             or template-literal specifier, require()) or "type" (a JSDoc `import("…")`, i.e. an
//                             import() inside a comment). With `{ urls: true }`, also kind "url":
//                             `new URL("./x.js", import.meta.url)`, as in `new Worker(new URL(…))` (opt-in, p-archv L1). Bare specifiers ("bun", "node:fs") are not returned: see packagesOf.
//                             An import inside a comment is ignored (commented out); "inside" is judged on the
//                             import's own line: after `//`, inside a `/* … ` still open at it, or on a `*`
//                             continuation line. A `/* … */` closed before the import does not hide it.
//                             Known misses (unusual here): a block comment between `import` and its "(",
//                             import.meta.resolve, computed specifiers, an apostrophe inside a comment within a
//                             multi-line import. Known false positive (fails safe): an import-like string literal.
//
//   packagesOf(file, src?, root?)
//                             the bare (package) imports of `file`, same grammar: `[{ spec, kind }]`, e.g.
//                             { spec: "bun:sqlite", kind: "runtime" }
//
//   checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots, allowed, allowlist, root,
//                     adapterMayImport, allowPackage, urls })
//                             the violations in `files`, [] when clean. Each is `{ rule, from, to, kind, message }`.
//     files               repo-relative paths, or `{ path, src }` objects (synthetic sources, for testing the rule)
//     isCore(p)           p is core: depends only on ports and shared modules, never on an adapter
//     isAdapter(p)        p is an adapter (or adapter-only support code); ports and shared modules are NOT adapters
//     adapterGroup(p)     the adapter p belongs to; files of one adapter (one group) may import each other
//     compositionRoots    paths allowed to import any adapter (they wire them)
//     allowed(to, from)   optional: true lets `from` import adapter `to` anyway (e.g. adapter-only helpers such as
//                         server/pg/schema.js, allowed for adapters but not for core)
//     allowlist           optional `[{ from, to, why }]`: known violations, tolerated; an entry that no longer
//                         occurs is itself a violation (rule "stale-allowlist"), so the list can only shrink
//     root                optional repo root for reading files (default ROOT)
//     adapterMayImport(to, from)   optional: when given, an adapter may import a non-adapter `to` only if this is
//                         true (e.g. ports and an explicit shared list; a driving adapter may also import core)
//     allowPackage(spec, from)     optional: when given, a core file may import a bare package only if this is true
//     urls                optional: also check `new URL("./x.js", import.meta.url)` edges (kind "url"); a "url" edge
//                         may name a composition root (it starts that program, e.g. a worker entry)
//   Rules, for every file that is not a composition root, and every import `to` it names (runtime or type):
//     "unresolved"        a relative specifier without a script/.json extension (it would dodge classification)
//     "imports-root"      any file imports a composition root (and so, transitively, every adapter it wires)
//     "core->adapter"     isCore(from) and isAdapter(to)
//     "adapter->adapter"  isAdapter(from), isAdapter(to), different adapterGroup
//     "wiring"            from is neither core nor adapter, and imports an adapter: only composition roots wire
//     "unclassified"      from is neither core, adapter nor a composition root
//     "adapter->core"     (with adapterMayImport) an adapter imports a non-adapter it may not
//     "core->package"     (with allowPackage) a core file imports a bare package it may not (a framework, a driver)
//   Tests are not passed in `files`, so tests may import anything.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const ROOT = join(import.meta.dir, "..");
const SCRIPT = /\.(m?js|cjs|m?ts|cts)$/;

export function listFiles(dirs, root = ROOT) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === "node_modules") continue;
      const rel = dir + "/" + name;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (SCRIPT.test(rel)) out.push(rel);
    }
  };
  for (const d of dirs.map(d => d.replace(/\/$/, ""))) statSync(join(root, d)).isDirectory() ? walk(d) : out.push(d);
  return out.sort();
}

/**
 * Is position `i` inside a comment, judged on its own line: after `//`, inside a `/*` still open at `i`, or on a
 * `*` continuation line of a block comment (unless that comment closes before `i`). A `/* … *\/` that closes before
 * `i` doesn't count (p-archv M2).
 */
function onComment(src, i) {
  let p = src.slice(src.lastIndexOf("\n", i - 1) + 1, i).trimStart();
  if (p.startsWith("*")) {                       // a continuation line, or the close of an earlier block comment
    const k = p.indexOf("*/");
    if (k < 0) return true;
    p = p.slice(k + 2);
  }
  p = p.replace(/\/\*.*?\*\//g, "");             // block comments closed before i
  return p.includes("/*") || p.trimStart().startsWith("//");
}

// Same grammar as test/auth/architecture.test.js (verified in p5-hexv), for relative or bare specifiers.
const REL = String.raw`\.{1,2}\/[^"'\x60$]+`, BARE = String.raw`[^."'\x60$\/\s][^"'\x60$\s]*`;
const grammar = spec => ({
  stat: new RegExp(String.raw`(?:^|[;\s{}])(import|export)\b\s*(?:[^"'\x60;]*?\bfrom\s*)?["'](${spec})["']`, "g"),
  dyn: new RegExp(String.raw`\bimport\(\s*(["'\x60])(${spec})\1\s*\)`, "g"),
  req: new RegExp(String.raw`\brequire\(\s*(["'\x60])(${spec})\1\s*\)`, "g"),
  url: new RegExp(String.raw`\bnew\s+URL\(\s*(["'\x60])(${spec})\1\s*,\s*import\.meta\.url\s*\)`, "g"),
});
const G_REL = grammar(REL), G_BARE = grammar(BARE);

function scan(src, g, add, urls) {
  for (const m of src.matchAll(g.stat)) if (!onComment(src, m.index + m[0].indexOf(m[1]))) add(m[2], "runtime");
  for (const m of src.matchAll(g.dyn)) add(m[2], onComment(src, m.index) ? "type" : "runtime");
  for (const m of src.matchAll(g.req)) if (!onComment(src, m.index)) add(m[2], "runtime");
  if (urls) for (const m of src.matchAll(g.url)) if (!onComment(src, m.index)) add(m[2], "url");
}

export function importsOf(file, src, root = ROOT, { urls = false } = {}) {
  if (src === undefined) src = readFileSync(join(root, file), "utf8");
  const out = new Map();
  scan(src, G_REL, (spec, kind) => {
    const to = posix.normalize(posix.join(posix.dirname(file), spec));
    out.set(to + " " + kind, { spec, to, kind });
  }, urls);
  return [...out.values()];
}

export function packagesOf(file, src, root = ROOT) {
  if (src === undefined) src = readFileSync(join(root, file), "utf8");
  const out = new Map();
  scan(src, G_BARE, (spec, kind) => out.set(spec + " " + kind, { spec, kind }));
  return [...out.values()];
}

export function checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots = [], allowed = () => false, allowlist = [], root = ROOT,
  adapterMayImport, allowPackage, urls = false }) {
  const found = [];
  const roots = new Set(compositionRoots);
  for (const f of files) {
    const path = typeof f === "string" ? f : f.path;
    if (roots.has(path)) continue;
    const src = typeof f === "string" ? undefined : f.src;
    const core = isCore(path), adapter = !core && isAdapter(path);
    if (!core && !adapter) { found.push({ rule: "unclassified", from: path, to: "", kind: "", message: `${path}: neither core, adapter nor a composition root` }); }
    if (core && allowPackage) for (const { spec, kind } of packagesOf(path, src, root))
      if (!allowPackage(spec, path)) found.push({ rule: "core->package", from: path, to: spec, kind, message: `${path} -> ${spec} [${kind}]: core->package` });
    for (const { to, kind } of importsOf(path, src, root, { urls })) {
      const v = rule => found.push({ rule, from: path, to, kind, message: `${path} -> ${to} [${kind}]: ${rule}` });
      if (!/\.(m?js|cjs|m?ts|cts|json)$/.test(to)) { v("unresolved"); continue; }
      if (roots.has(to)) { if (kind !== "url") v("imports-root"); continue; }
      if (!isAdapter(to)) { if (adapter && adapterMayImport && !adapterMayImport(to, path)) v("adapter->core"); continue; }
      if (allowed(to, path)) continue;
      if (core) v("core->adapter");
      else if (adapter) { if (adapterGroup(path) !== adapterGroup(to)) v("adapter->adapter"); }
      else v("wiring");
    }
  }
  const listed = e => found.some(v => v.from === e.from && v.to === e.to);
  const out = found.filter(v => !allowlist.some(e => e.from === v.from && e.to === v.to));
  for (const e of allowlist) if (!listed(e))
    out.push({ rule: "stale-allowlist", from: e.from, to: e.to, kind: "", message: `allowlist entry ${e.from} -> ${e.to} no longer occurs: delete it` });
  return out;
}
