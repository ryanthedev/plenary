// The hexagonal import rule for server/auth and server/admin.
// Engine owns the repo-wide test/architecture.test.js; this one covers platform's folders only.
//
//   port      a port module: typedefs, shared port pieces (mint, RegistryError), no adapter code
//   core      application logic that depends only on ports (and other core)
//   adapter   a driven adapter (implements a port: memory Registry, Google IdP, session / dev verifiers)
//   driving   a driving adapter (HTTP): calls into the core; gets its driven adapters injected
//
// Rules, for every file in scope:
//   1. it is classified in CLASSES below (a new file must be added, on purpose);
//   2. it imports no `adapter` and no `driving` file (adapters never import each other; the core and the ports
//      never import an adapter; http.js gets adapters injected), counting static `import`/`export … from`,
//      `import()`, `require()` and JSDoc `import("…")` types (test/arch-scan.js's importsOf: Bun's parser, so a
//      comment or string can't hide or invent one; a file the parser rejects is itself a violation);
//   3. it imports nothing outside server/auth and server/admin by relative path (no reaching into another
//      folder's adapters).
// And inbound, for every other file under server/: only the composition root (server/main.js) may import an
// auth/admin `adapter` or `driving` file.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { importsOf } from "../arch-scan.js";

const ROOT = join(import.meta.dir, "..", "..");

/** @type {Record<string, "port"|"core"|"adapter"|"driving">} */
export const CLASSES = {
  "server/auth/registry-port.js": "port",    // Registry typedefs, mint, RegistryError
  "server/auth/idp-port.js": "port",         // Identity, the IdP port (begin/finish), the Verifier port
  "server/auth/port.js": "port",             // the Auth port (verify, role) and authPort, composed over injected verifiers + tenancy
  "server/auth/util.js": "core",             // roles, base64url, ids: pure helpers
  "server/auth/tenancy.js": "core",          // role resolution over the Registry port
  "server/auth/resolver.js": "core",         // the permission resolver: pure union of every source, with sources (domain logic)
  "server/auth/permissions.js": "core",      // permissions, built-in roles, role clipping per scope (domain data, pure)
  "server/auth/access.js": "core",          // Teams and access at a scope (PROTOCOL.md § Teams and access)
  "server/auth/explain.js": "core",         // the access explanation: sources, needs, owners, Ask state (PROTOCOL.md § Access explanation and requests)
  "server/auth/roles.js": "core",           // Roles: custom roles and the permission matrix (PROTOCOL.md § Roles)
  "server/auth/spaces.js": "core",           // Spaces and Groups: pages, pickers, create, rename, general access (PROTOCOL.md § Spaces and Groups)
  "server/auth/trash.js": "core",           // trash and restore a board or Space, the Trash list and the board-URL notice (PROTOCOL.md § Trash and restore)
  "server/auth/move.js": "core",             // move a board: options, the access diff, the compare-and-set move (PROTOCOL.md § Move board)
  "server/auth/home.js": "core",             // the Home screen's read side over the Registry port + tenancy (PROTOCOL.md § Home)
  "server/admin/boards.js": "core",          // admin use cases over the Registry port
  "server/admin/tenants.js": "core",         // bootstrapTenant over the Registry port (its CLI root: scripts/admin-bootstrap.js)
  "server/auth/registry.js": "adapter",      // in-memory Registry
  "server/auth/oidc.js": "adapter",          // Google OIDC (IdP port)
  "server/auth/session.js": "adapter",       // session tokens (Verifier port, plus issue())
  "server/auth/dev.js": "adapter",           // dev tokens (Verifier port)
  "server/auth/http.js": "driving",          // HTTP routes
};
const SCOPE = ["server/auth", "server/admin"];
const COMPOSITION_ROOTS = ["server/main.js"];


const inScope = p => SCOPE.some(d => p.startsWith(d + "/"));

/**
 * The rule as a pure function.
 * @param {{ path: string, src: string }[]} files   repo-relative paths
 * @param {Record<string, string>} classes
 * @returns {string[]} violations, each "from -> to: why"
 */
export function violations(files, classes, roots = COMPOSITION_ROOTS) {
  const out = [];
  const bad = to => classes[to] === "adapter" || classes[to] === "driving";
  for (const { path, src } of files) {
    let targets;
    try { targets = importsOf(path, src); } catch (e) { out.push(e.message); continue; }
    if (inScope(path)) {
      if (!classes[path]) { out.push(`${path}: unclassified (add it to CLASSES)`); continue; }
      for (const { to, kind } of targets) {
        const k = `${path} -> ${to} [${kind}]`;
        if (!inScope(to)) out.push(`${k}: reaches outside server/auth and server/admin`);
        else if (!classes[to]) out.push(`${k}: imports an unclassified path (extensionless? add it to CLASSES)`);
        else if (bad(to)) out.push(`${k}: ${classes[path]} imports ${classes[to]}`);
      }
    } else if (!roots.includes(path)) {
      for (const { to, kind } of targets)
        if (inScope(to) && (bad(to) || !classes[to])) out.push(`${path} -> ${to} [${kind}]: only a composition root may import ${classes[to] ?? "an unclassified path"}`);
    }
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir + "/" + name;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith(".js")) out.push({ path: rel, src: readFileSync(join(ROOT, rel), "utf8") });
  }
  return out;
}

const key = v => v.slice(0, v.indexOf("]:") + 1);

test("server/auth and server/admin follow the hexagonal import rule", () => {
  expect(violations(walk("server"), CLASSES)).toEqual([]);
});

test("every classified file exists", () => {
  for (const p of Object.keys(CLASSES)) expect(statSync(join(ROOT, p)).isFile()).toBe(true);
});

// ---- the checker itself, on synthetic sources (a re-introduced violation of each kind fails) ----

const C = { "server/auth/a.js": "adapter", "server/auth/b.js": "adapter", "server/auth/c.js": "core",
  "server/auth/p.js": "port", "server/auth/h.js": "driving" };
const one = (path, src) => violations([{ path, src }], C);

test("checker: adapter -> adapter by static import", () => {
  expect(one("server/auth/a.js", `import { x } from "./b.js";`)).toEqual(["server/auth/a.js -> server/auth/b.js [runtime]: adapter imports adapter"]);
  expect(one("server/auth/a.js", `import {\n  x,\n  y,\n} from "./b.js"`)).toHaveLength(1);
  expect(one("server/auth/a.js", `export { x } from "./b.js";`)).toHaveLength(1);
  expect(one("server/auth/a.js", `import "./b.js";`)).toHaveLength(1);
});

test("checker: core -> adapter by import() and by a JSDoc type", () => {
  expect(one("server/auth/c.js", `const m = await import("./a.js");`)).toHaveLength(1);
  expect(one("server/auth/c.js", `/** @typedef {import("./a.js").T} T */`)).toEqual(["server/auth/c.js -> server/auth/a.js [type]: core imports adapter"]);
  expect(one("server/auth/p.js", `/** @param {import('./a.js').T} t */`)).toHaveLength(1);
});

test("checker: driving -> adapter, and reaching outside the scope", () => {
  expect(one("server/auth/h.js", `import { a } from "./a.js";`)).toHaveLength(1);
  expect(one("server/auth/c.js", `import { s } from "../store/sqlite.js";`)).toEqual(["server/auth/c.js -> server/store/sqlite.js [runtime]: reaches outside server/auth and server/admin"]);
});

test("checker: allowed imports, look-alikes and unclassified files", () => {
  expect(one("server/auth/a.js", `import { x } from "./p.js"; import { y } from "./c.js"; /** @type {import("./p.js").T} */`)).toEqual([]);
  expect(one("server/auth/a.js", `const k = await crypto.subtle.importKey("raw", raw, {}, false, []);`)).toEqual([]);
  expect(one("server/auth/a.js", `import { SQL } from "bun";`)).toEqual([]);
  expect(one("server/auth/new.js", `export const x = 1;`)).toEqual(["server/auth/new.js: unclassified (add it to CLASSES)"]);
});

test("checker: inbound, only a composition root imports an auth adapter", () => {
  expect(one("server/registry/x.js", `import { mint } from "../auth/a.js";`)).toEqual(["server/registry/x.js -> server/auth/a.js [runtime]: only a composition root may import adapter"]);
  expect(one("server/registry/x.js", `import { mint } from "../auth/p.js";`)).toEqual([]);
  expect(one("server/main.js", `import { a } from "./auth/a.js";`)).toEqual([]);
});

test("checker: a runtime import and a JSDoc type of the same file are reported separately", () => {
  const src = `import { mint } from "../auth/a.js";\n/** @returns {import("../auth/a.js").R} */`;
  const v = one("server/registry/x.js", src);
  expect(v.map(key).sort()).toEqual(["server/registry/x.js -> server/auth/a.js [runtime]", "server/registry/x.js -> server/auth/a.js [type]"]);
});

test("checker: an export … from / export * from directly below a comment line is caught (p5-hexv MEDIUM 1)", () => {
  expect(one("server/auth/c.js", `// Convenience re-export for callers.\nexport { a } from "./a.js";`)).toEqual(["server/auth/c.js -> server/auth/a.js [runtime]: core imports adapter"]);
  expect(one("server/auth/c.js", `/** doc */\nexport * from "./a.js";`)).toHaveLength(1);
  expect(one("server/auth/c.js", `/*\n * see below\n */\nimport { a } from "./a.js";`)).toEqual(["server/auth/c.js -> server/auth/a.js [runtime]: core imports adapter"]);
  // still ignored: the same lines commented out
  expect(one("server/auth/c.js", `// export { a } from "./a.js";\n// import { a } from "./a.js";\n/*\n * export * from "./a.js";\n */`)).toEqual([]);
});

test("checker: unspaced import, template-literal import() and require() (p5-hexv LOW 3)", () => {
  expect(one("server/auth/c.js", `import{a}from"./a.js";`)).toHaveLength(1);
  expect(one("server/auth/c.js", `export*from"./a.js";`)).toHaveLength(1);
  expect(one("server/auth/c.js", "const m = await import(`./a.js`);")).toHaveLength(1);
  expect(one("server/auth/c.js", `const m = require("./a.js");`)).toEqual(["server/auth/c.js -> server/auth/a.js [runtime]: core imports adapter"]);
  expect(one("server/auth/c.js", `// const m = require("./a.js");`)).toEqual([]);
  expect(one("server/auth/c.js", `export const x = "./a.js"; export function f() { return "./a.js"; }`)).toEqual([]);
});

test("checker: an extensionless or unknown in-scope target is a violation", () => {
  expect(one("server/auth/a.js", `import { x } from "./b";`)).toEqual(["server/auth/a.js -> server/auth/b [runtime]: imports an unclassified path (extensionless? add it to CLASSES)"]);
  expect(one("server/registry/x.js", `import { x } from "../auth/a";`)).toHaveLength(1);
});

// ---- #48: adapters only translate; the Space/Group rules live in the core service ----
const WRITES = /\bregistry\s*\.\s*(createBoard|createSpace|createGroup|rename|updateScope|setGeneralRole|setScopedGrant|ensurePersonalSpace)\b/;
const writesOrgDirectly = src => WRITES.test(src);

test("the HTTP adapter calls no Space, Group or board write on the Registry: the core service owns them", () => {
  const src = readFileSync(join(ROOT, "server/auth/http.js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[^]*?\*\//g, "");
  expect(writesOrgDirectly(src)).toBe(false);
  expect(src).toMatch(/spaces\.createBoard\(/);
});
test("planted: a route that writes the Registry itself is caught; the service file is core and imports no adapter", () => {
  expect(writesOrgDirectly("await registry.createSpace({ tenant })")).toBe(true);
  expect(writesOrgDirectly("await registry.rename({ type: 'space' }, n)")).toBe(true);
  expect(writesOrgDirectly("await spaces.createBoard(who, b)")).toBe(false);
  expect(CLASSES["server/auth/spaces.js"]).toBe("core");
  expect(CLASSES["server/auth/access.js"]).toBe("core");
  expect(violations([{ path: "server/auth/spaces.js", src: `import { x } from "./http.js";` }], CLASSES)).toEqual(expect.arrayContaining([expect.stringContaining("core imports driving")]));
  expect(violations([{ path: "server/auth/spaces.js", src: `import { x } from "./registry.js";` }], CLASSES)).toEqual(expect.arrayContaining([expect.stringContaining("core imports adapter")]));
});
