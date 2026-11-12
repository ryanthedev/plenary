// Import-graph scanner for the hexagonal boundary tests (docs/m2/OFFICE.md "Architecture"; brief p-arch).
// Static: it reads source text and parses import specifiers; it never executes a scanned file. Not a test file
// itself (no `.test.js`), so `bun test` only runs it through the tests that import it.
//
// API
//
//   ROOT                      the repo root (absolute path)
//
//   listFiles(dirs, root?)    every .js/.mjs file under the repo-relative `dirs` (folders, recursively, or single
//                             files), as sorted repo-relative posix paths (node_modules skipped)
//
//   importsOf(file, src?, root?)
//                             the relative imports of repo-relative `file` (read from `root`, or taken from `src`),
//                             each `{ spec, to, kind }`: `to` is the target as a repo-relative posix path; `kind` is
//                             "runtime" (static import / export … from, side-effect import, import() with a quoted
//                             or template-literal specifier, require()) or "type" (a JSDoc `import("…")`, i.e. an
//                             import() on a comment line). Bare specifiers ("bun", "node:fs") are not returned.
//                             A static import / require() on a comment line is ignored (it is commented out).
//                             Known misses (unusual here): a block comment between `import` and its "(",
//                             import.meta.resolve, computed specifiers, an apostrophe inside a comment within a
//                             multi-line import.
//
//   checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots, allowed, allowlist, root })
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
//   Rules, for every file that is not a composition root, and every import `to` it names (runtime or type):
//     "unresolved"        a relative specifier without a .js/.mjs/.json extension (it would dodge classification)
//     "core->adapter"     isCore(from) and isAdapter(to)
//     "adapter->adapter"  isAdapter(from), isAdapter(to), different adapterGroup
//     "wiring"            from is neither core nor adapter, and imports an adapter: only composition roots wire
//     "unclassified"      from is neither core, adapter nor a composition root
//   Tests are not passed in `files`, so tests may import anything.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export function listFiles(dirs, root = ROOT) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === "node_modules") continue;
      const rel = dir + "/" + name;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.m?js$/.test(rel)) out.push(rel);
    }
  };
  for (const d of dirs.map(d => d.replace(/\/$/, ""))) statSync(join(root, d)).isDirectory() ? walk(d) : out.push(d);
  return out.sort();
}

/** Is position `i` on a comment line (starts with //, /*, or * after indentation)? */
function onComment(src, i) {
  const line = src.slice(src.lastIndexOf("\n", i - 1) + 1, i).trimStart();
  return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*");
}

// Same grammar as test/auth/architecture.test.js (verified in p5-hexv).
const STAT = /(?:^|[;\s{}])(import|export)\b\s*(?:[^"'\x60;]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
const DYN = /\bimport\(\s*(["'\x60])(\.{1,2}\/[^"'\x60$]+)\1\s*\)/g;
const REQ = /\brequire\(\s*(["'\x60])(\.{1,2}\/[^"'\x60$]+)\1\s*\)/g;

export function importsOf(file, src, root = ROOT) {
  if (src === undefined) src = readFileSync(join(root, file), "utf8");
  const out = new Map();
  const add = (spec, kind) => {
    const to = posix.normalize(posix.join(posix.dirname(file), spec));
    out.set(to + " " + kind, { spec, to, kind });
  };
  for (const m of src.matchAll(STAT)) if (!onComment(src, m.index + m[0].indexOf(m[1]))) add(m[2], "runtime");
  for (const m of src.matchAll(DYN)) add(m[2], onComment(src, m.index) ? "type" : "runtime");
  for (const m of src.matchAll(REQ)) if (!onComment(src, m.index)) add(m[2], "runtime");
  return [...out.values()];
}

export function checkBoundaries({ files, isCore, isAdapter, adapterGroup, compositionRoots = [], allowed = () => false, allowlist = [], root = ROOT }) {
  const found = [];
  const roots = new Set(compositionRoots);
  for (const f of files) {
    const path = typeof f === "string" ? f : f.path;
    if (roots.has(path)) continue;
    const src = typeof f === "string" ? undefined : f.src;
    const core = isCore(path), adapter = !core && isAdapter(path);
    if (!core && !adapter) { found.push({ rule: "unclassified", from: path, to: "", kind: "", message: `${path}: neither core, adapter nor a composition root` }); }
    for (const { to, kind } of importsOf(path, src, root)) {
      const v = rule => found.push({ rule, from: path, to, kind, message: `${path} -> ${to} [${kind}]: ${rule}` });
      if (!/\.(m?js|json)$/.test(to)) { v("unresolved"); continue; }
      if (!isAdapter(to) || allowed(to, path)) continue;
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
