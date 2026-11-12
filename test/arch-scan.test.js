// test/arch-scan.js on Bun's parser (brief p-scan): every evasion the regex and hand-lexer scanners leaked on is a case
// here, plus the two edges scanImports doesn't report (JSDoc `import("…")` types, `new URL(lit, import.meta.url)`).

import { test, expect } from "bun:test";
import { importsOf, packagesOf, checkBoundaries } from "./arch-scan.js";

const F = "web/core/x.js";
/** The edges of `src` as "kind:to" strings, sorted (urls on). */
const edges = src => importsOf(F, src, undefined, { urls: true }).map(e => `${e.kind}:${e.to}`).sort();
const A = "runtime:web/core/a.js";

test("plain forms: static, side-effect, export … from, export * from, import(), require(), multi-line lists", () => {
  expect(edges(`import { a } from "./a.js";`)).toEqual([A]);
  expect(edges(`import "./a.js";`)).toEqual([A]);
  expect(edges(`import{a}from"./a.js"`)).toEqual([A]);
  expect(edges(`export { a } from "./a.js";`)).toEqual([A]);
  expect(edges(`export * from "./a.js";`)).toEqual([A]);
  expect(edges(`export*from"./a.js"`)).toEqual([A]);
  expect(edges(`export * as ns from "./a.js";`)).toEqual([A]);
  expect(edges(`const m = await import("./a.js");`)).toEqual([A]);
  expect(edges("const m = await import(`./a.js`);")).toEqual([A]);
  expect(edges(`const m = require("./a.js");`)).toEqual([A]);
  expect(edges(`import {\n  a,\n  // b, a comment inside the list\n  c,\n} from\n  "./a.js";`)).toEqual([A]);
  expect(edges(`import {\n  a, /* it's here */\n  b,\n} from "./a.js";`)).toEqual([A]);       // an apostrophe in a comment in the list (old known miss)
  expect(importsOf(F, `import { a } from "./a.js"; import "./a.js"; export * from "./a.js";`)).toEqual([{ spec: "./a.js", to: "web/core/a.js", kind: "runtime" }]);  // deduped
});

test("p-serve H1: an import right after a comment that mentions import is caught", () => {
  expect(edges(`// we import the transport here\nimport { a } from "./a.js";`)).toEqual([A]);
  expect(edges(`/* import from "./b.js" */ import { a } from "./a.js";`)).toEqual([A]);
  expect(edges(`/** see import("./b.js") below */\nexport * from "./a.js";`)).toEqual(["runtime:web/core/a.js", "type:web/core/b.js"]);
  expect(edges(`/*\n * export * from "./b.js";\n */\nimport "./a.js";`)).toEqual([A]);
});

test("p8-tidy: imports after ++/--, a regex and division are caught (the hand-lexer's evasions)", () => {
  const cases = [
    `++/\\//.lastIndex; import("./a.js");`,                   // R2-M1
    `let x; x = --/\\//.lastIndex; import("./a.js");`,          // R2-M1
    `let i = 0; i++ / 2; import("./a.js"); // x`,               // L6
    `const a = [1]; let i = 0; a[i]++ / 2; import("./a.js");`,
    `let x = 1\n++/\\//.lastIndex; import("./a.js");`,          // R3-M1: prefix ++ after a newline
    `let x; if (x) { x = 2 } ++/\\//.lastIndex; import("./a.js");`,   // R3-M1: prefix ++ after a }
    `const a = [1]\n--/\\//.lastIndex; import("./a.js");`,
    `let x = { a: 1 }\n++/\\//.lastIndex; import("./a.js");`,
    `const f = () => {}\n++/\\//.lastIndex; import("./a.js");`,
    `const of = 4, y = 1; const z = y\nof / 2; import("./a.js"); const w = 1 / 3;`,   // R3-L1: \`of\` after a newline
    `const of = 4; const x = of / 2; import("./a.js"); const y = 1 / 3;`,              // R2-L2
    `async function g(y) { for await (const x of y) /\\//.test(x); } import("./a.js");`, // p8-tidyv M1
    `const s = "a\u2028b"; import("./a.js");`,                // R4-L1: U+2028 inside a string
  ];
  for (const src of cases) expect([src, edges(src)]).toEqual([src, [A]]);
});

test("strings, templates and regex literals that look like imports add nothing", () => {
  for (const src of [
    `const s = 'import "./a.js"';`,
    `const s = "import { a } from './a.js'";`,
    "const s = `import \"./a.js\"`;",
    "const s = `${1}\nimport(\"./a.js\")`;",
    `const s = "require('./a.js')";`,
    `const s = 'import("./a.js")';`,                           // not a JSDoc type either: it's in a string
    `if (false) { const s = 'import("./a.js")'; }`,             // a string in dead code is still a string
    `const r = /import\\("\\.\\/a\\.js"\\)/;`,
    `const s = "new URL('./a.js', import.meta.url)";`,
    "const s = `new URL(\"./a.js\", import.meta.url)`;",
    `export const x = "./a.js";`,
    `x.import("./a.js");`,
    `crypto.subtle.importKey("raw", raw, {}, false, []);`,
  ]) expect([src, edges(src)]).toEqual([src, []]);
  // ...but code inside a template's \${} is code
  expect(edges("const s = `${await import(\"./a.js\")}`;")).toEqual([A]);
});

test("JSDoc import(\"…\") types are kind type, only inside real comments", () => {
  expect(edges(`/** @typedef {import("./a.js").T} T */`)).toEqual(["type:web/core/a.js"]);
  expect(edges(`/** @param {import('./a.js').T} t */ export function f(t) {}`)).toEqual(["type:web/core/a.js"]);
  expect(edges(`// const m = await import("./a.js");`)).toEqual(["type:web/core/a.js"]);   // a commented-out import() reads as a type (as before)
  expect(edges(`/**\n * @property {() => import("./a.js").T} join\n */`)).toEqual(["type:web/core/a.js"]);
  expect(edges(`const s = "*/"; /** @type {import("./a.js").T} */ let t;`)).toEqual(["type:web/core/a.js"]);
  expect(edges(`let x = 1 / 2 /** @type {import("./a.js").T} */ ;`)).toEqual(["type:web/core/a.js"]);   // division, then a comment
  // a runtime import and a type of one file are two edges
  expect(edges(`import { a } from "./a.js";\n/** @returns {import("./a.js").R} */ export function f() {}`)).toEqual([A, "type:web/core/a.js"]);
  // static imports and require() inside comments are commented out: no edge
  expect(edges(`// import { a } from "./a.js";\n/* export * from "./a.js"; require("./a.js") */`)).toEqual([]);
  // legal comments are kept by the printer, so they read as strings: not JSDoc, so no type (documented in arch-scan.js)
  expect(edges(`/*! import("./a.js") */ //! import("./a.js")\nlet z;`)).toEqual([]);
});

test("the probe can't be fooled: the file already holds a token's text; a match spans two strings", () => {
  // A string holding the default token text must not make the comment's token read as "printed".
  expect(edges(`const k = "__arch_scan_0__ __arch_scan_1__"; /** @type {import("./a.js").T} */ let t;`)).toEqual(["type:web/core/a.js"]);
  // `"import(" + x + ")"` matches from one string's closing quote to the next's opening quote; its swap breaks the
  // parse. Valid JS, so no throw: that match gives no edge, and the real comment's type edge is still found.
  expect(edges(`const x = 1; const s = "import(" + x + ")";`)).toEqual([]);
  expect(edges(`const x = 1; const s = "import(" + x + ")"; /** @type {import("./a.js").T} */ let t;`)).toEqual(["type:web/core/a.js"]);
  expect(edges(`const x = "a"; const s = "new URL(" + x + ", import.meta.url)"; new URL("./a.js", import.meta.url);`)).toEqual(["url:web/core/a.js"]);
});

test("a .ts file is parsed as TypeScript (known miss, none in the repo today: scanImports drops `import type`)", () => {
  const ts = `import type { T } from "./t.ts";\nimport { a } from "./a.js";\nlet n: number = 1;\n/** @type {import("./b.js").B} */ let b: unknown;`;
  expect(importsOf("web/core/x.ts", ts).map(e => `${e.kind}:${e.to}`).sort()).toEqual(["runtime:web/core/a.js", "type:web/core/b.js"]);
  expect(() => importsOf(F, ts)).toThrow(/the parser rejects it/);     // the same text as .js is not JavaScript
});

test("new URL(lit, import.meta.url) is kind url, only in code, only with { urls: true }", () => {
  expect(edges(`const w = new Worker(new URL("./a.js", import.meta.url), { type: "module" });`)).toEqual(["url:web/core/a.js"]);
  expect(edges("const w = new SharedWorker(new URL(`./a.js`, import.meta.url));")).toEqual(["url:web/core/a.js"]);
  expect(edges(`if (false) { new URL('./a.js', import.meta.url); }`)).toEqual(["url:web/core/a.js"]);
  expect(edges(`// new Worker(new URL("./a.js", import.meta.url))\n/* new URL("./a.js", import.meta.url) */`)).toEqual([]);
  expect(importsOf(F, `new URL("./a.js", import.meta.url);`)).toEqual([]);                         // urls off
  expect(packagesOf(F, `new URL("pkg", import.meta.url);`)).toEqual([]);                            // never a package
});

test("packagesOf: bare specifiers, runtime and JSDoc type", () => {
  expect(packagesOf(F, `import { Database } from "bun:sqlite"; import "./a.js"; /** @type {import("pg").Pool} */ let p; const s = "import 'x'";`))
    .toEqual([{ spec: "bun:sqlite", kind: "runtime" }, { spec: "pg", kind: "type" }]);
});

test("a file the parser rejects fails loudly, never as 0 imports", () => {
  expect(() => importsOf(F, `import { from "./a.js"`)).toThrow(/web\/core\/x\.js: the parser rejects it/);
  expect(() => packagesOf(F, ` * not a comment\nimport "bun";`)).toThrow(/web\/core\/x\.js: the parser rejects it/);
  const v = checkBoundaries({ files: [{ path: F, src: `import { a from "./a.js"` }], isCore: () => true, isAdapter: () => false, adapterGroup: () => "" });
  expect(v.map(x => [x.rule, x.from])).toEqual([["parse", F]]);
  expect(v[0].message).toContain("the parser rejects it");
});
