// Import-graph scanner for the hexagonal boundary tests (docs/m2/OFFICE.md "Architecture"; brief p-arch).
// Static: it parses source text with Bun's parser (brief p-scan); it never executes a scanned file. Not a test file
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
//                             "runtime" (static import / export … from / export * from, side-effect import, import()
//                             with a literal specifier, require()) or "type" (a JSDoc `import("…")`: an import()
//                             inside a comment). With `{ urls: true }`, also kind "url":
//                             `new URL("./x.js", import.meta.url)`, as in `new Worker(new URL(…))` (opt-in, p-archv L1). Bare specifiers ("bun", "node:fs") are not returned: see packagesOf.
//                             Throws (naming the file) if the parser rejects the file; never returns [] for it.
//
//     How (brief p-scan): Bun's parser decides everything; there is no hand-written lexer, so no regex-vs-division,
//     comment or line-break rule can hide or invent an edge.
//       runtime  Bun.Transpiler.scanImports (import-statement, dynamic-import, require-call; any other kind it
//                reports counts as runtime too, never dropped).
//       type     scanImports doesn't see comments. Every raw-text `import("lit")` is a candidate; each candidate's
//                specifier is swapped for a unique sentinel and the copy is parsed again. A sentinel scanImports
//                reports was code (already a runtime edge); one transformSync prints was in a string, template or
//                regex literal (no edge); one in neither was dropped as a comment (a "type" edge). transformSync
//                runs with deadCodeElimination off, so a string in dead code still prints and never reads as a
//                comment. Legal comments (`/*! … */`, `//! …`) are printed, so an import() in one counts as a string
//                (no edge): they aren't JSDoc, so they carry no types.
//       url      each raw-text `new URL("lit", import.meta.url)` is swapped for `import("<sentinel>")` (same quote,
//                so a candidate inside a string or template stays inside it); it is an edge only if scanImports
//                reports that sentinel, i.e. only in code.
//     Known misses: import.meta.resolve, computed specifiers (as before), a specifier holding "$" or a line break;
//     the candidates are text patterns, so `new URL ("…", …)` with a space before "(" and a JSDoc `@import … from`
//     tag are missed (neither occurs in the repo today); in a .ts file (none today) scanImports drops `import type`.
//
//   packagesOf(file, src?, root?)
//                             the bare (package) imports of `file`, same parse (runtime and type; no url): `[{ spec, kind }]`, e.g.
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
//     "parse"             the parser rejects the file (its imports are unknown, so it can't pass; `to` is "")
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

const TS = /\.(m?ts|cts)$/;
const parsers = {
  js: new Bun.Transpiler({ loader: "js", deadCodeElimination: false }),
  ts: new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }),
};
// A literal specifier: the quote (group q), its text (group q+1), the same quote again.
const LIT = q => String.raw`(["'\x60])([^"'\x60$\n\r\u2028\u2029]+)` + "\\" + q;
const CAND = new RegExp(String.raw`\bimport\s*\(\s*${LIT(1)}\s*\)|\bnew\s+URL\(\s*${LIT(3)}\s*,\s*import\.meta\.url\s*\)`, "g");
const isRel = spec => /^\.{1,2}\//.test(spec);
const isBare = spec => !/^[./]/.test(spec) && !/\s/.test(spec);

/** Why the parser refused `src`: its first messages, with line and column. */
function why(e) {
  const list = Array.isArray(e?.errors) && e.errors.length ? e.errors : [e];
  return list.slice(0, 3).map(x => (x?.position ? `${x.position.line}:${x.position.column} ` : "") + (x?.message ?? String(x))).join("; ");
}

let last = { file: "", src: null, edges: null };   // checkBoundaries asks for packagesOf and importsOf of one file in a row

/** Every edge of `src` as `{ spec, kind }` (relative and bare), by the parser (see "How" above). */
function edgesOf(file, src) {
  if (last.file === file && last.src === src) return last.edges;
  const t = TS.test(file) ? parsers.ts : parsers.js;
  const fail = e => { throw new Error(`${file}: the parser rejects it, so its imports are unknown: ${why(e)}`); };
  let found;
  try { found = t.scanImports(src); } catch (e) { fail(e); }
  const edges = found.map(i => ({ spec: i.path, kind: "runtime" }));

  const cands = [...src.matchAll(CAND)].map((m, n) => ({ m, n }));
  // The token prefix occurs nowhere in `src`, so no token can already be in the file (a string holding one would
  // otherwise read as "printed" and hide a type edge).
  let pre = "__arch_scan_";
  while (src.includes(pre)) pre += "_";
  const token = n => `${pre}${n}__`;
  /** Parse `src` with the candidates in `list` swapped for tokens: { code, printed }, or null if that won't parse. */
  const probe = list => {
    let out = "", at = 0;
    for (const { m, n } of list) {
      if (m[1] !== undefined) {                      // import("lit"): swap the specifier only
        const i = m.index + m[0].indexOf(m[1] + m[2] + m[1]) + 1;
        out += src.slice(at, i) + token(n); at = i + m[2].length;
      } else {                                       // new URL("lit", import.meta.url): becomes import("<token>")
        out += src.slice(at, m.index) + `import(${m[3]}${token(n)}${m[3]})`; at = m.index + m[0].length;
      }
    }
    out += src.slice(at);
    try { return { code: new Set(t.scanImports(out).map(i => i.path)), printed: t.transformSync(out) }; } catch { return null; }
  };
  const judge = ({ m, n }, { code, printed }) => {
    if (m[1] !== undefined) { if (!code.has(token(n)) && !printed.includes(token(n))) edges.push({ spec: m[2], kind: "type" }); }
    else if (code.has(token(n))) edges.push({ spec: m[4], kind: "url" });
  };
  if (cands.length) {
    const all = probe(cands);
    if (all) for (const c of cands) judge(c, all);
    // A match can span code, e.g. `"import(" + x + ")"` (from one string's closing quote to the next's opening
    // quote); its swap breaks the parse. Then probe one candidate at a time: a swap inside a comment never breaks
    // a parse, so a candidate whose own probe doesn't parse is neither a comment nor code, and gives no edge.
    else for (const c of cands) { const one = probe([c]); if (one) judge(c, one); }
  }
  last = { file, src, edges };
  return edges;
}

export function importsOf(file, src, root = ROOT, { urls = false } = {}) {
  if (src === undefined) src = readFileSync(join(root, file), "utf8");
  const out = new Map();
  for (const { spec, kind } of edgesOf(file, src)) {
    if (!isRel(spec) || (kind === "url" && !urls)) continue;
    const to = posix.normalize(posix.join(posix.dirname(file), spec));
    out.set(to + " " + kind, { spec, to, kind });
  }
  return [...out.values()];
}

export function packagesOf(file, src, root = ROOT) {
  if (src === undefined) src = readFileSync(join(root, file), "utf8");
  const out = new Map();
  for (const { spec, kind } of edgesOf(file, src)) if (isBare(spec) && kind !== "url") out.set(spec + " " + kind, { spec, kind });
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
    let edges, packages = [];
    try { edges = importsOf(path, src, root, { urls }); if (core && allowPackage) packages = packagesOf(path, src, root); }
    catch (e) { found.push({ rule: "parse", from: path, to: "", kind: "", message: e.message }); continue; }
    for (const { spec, kind } of packages)
      if (!allowPackage(spec, path)) found.push({ rule: "core->package", from: path, to: spec, kind, message: `${path} -> ${spec} [${kind}]: core->package` });
    for (const { to, kind } of edges) {
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
