// The hexagonal boundary test for packages/ and server/ (docs/m2/OFFICE.md "Architecture"; brief p-arch).
// Static: test/arch-scan.js parses import specifiers (static, re-exports, import(), require(), JSDoc import("…")
// types); nothing is executed. client's test/web/architecture.test.js and platform's test/auth/architecture.test.js
// reuse the scanner for their own rules.
//
// Classes come from folders, not a hand-kept file list (p2-swapv L4):
//   adapter   every file under an ADAPTER_DIRS folder, except ports and the listed NOT_ADAPTERS. A new file in an
//             adapter folder is an adapter by default (the strict side), so nothing imports it until it is listed.
//   port      by name: port.js or *-port.js in an adapter folder (typedefs and shared port pieces, no adapter code)
//   core      every other file under packages/ and server/: packages/protocol, packages/core, server/gateway.js,
//             room-host.js, server.js, feed.js, breather.js, ids.js, log.js, server/admin/ (CORE_DIRS), the ports
//             and NOT_ADAPTERS. Every server/ sub-folder must be in CORE_DIRS, ADAPTER_DIRS or SUPPORT_DIRS.
//   root      COMPOSITION_ROOTS: server/main.js (the product) and scripts/dev-google.js (a dev harness); any other
//             file under scripts/ is unclassified and may not wire adapters
//   adapter-only support: SUPPORT_DIRS (server/pg/) holds code several adapters share (Postgres start-up). It is
//             treated as an adapter (core may not import it, it may not import other adapters) that any adapter may
//             import.
// One adapter = one group: its file, or its own sub-folder (server/store/postgres/*.js would be one group). Two
// adapters of one port (blobs/s3.js and blobs/disk.js) are two groups: an adapter never imports another adapter.

import { test, expect } from "bun:test";
import { listFiles, importsOf, checkBoundaries } from "./arch-scan.js";

const SCAN = ["packages", "server", "scripts"];   // every non-test JS folder but web/ (client's) and docs/
const ADAPTER_DIRS = ["server/store/", "server/registry/", "server/bus/", "server/blobs/", "server/auth/"];
const SUPPORT_DIRS = ["server/pg/"];
const COMPOSITION_ROOTS = [
  "server/main.js",
  "scripts/dev-google.js",   // dev harness, self-described composition root for a local Google sign-in check (p5-google)
];
/** server/ sub-folders that hold core code. Every server/ sub-folder must be here, in ADAPTER_DIRS or in SUPPORT_DIRS, so
 * a new adapter folder can't pass as core by default. */
const CORE_DIRS = ["server/admin/"];
/** Files in adapter folders that are not adapters (explicit; anything else there is an adapter). */
const NOT_ADAPTERS = {
  "server/auth/util.js": "shared pure helpers (roles, base64url, ids); imported by core, ports and adapters",
  "server/auth/tenancy.js": "core: role resolution over the Registry port (platform's CLASSES calls it core)",
};
const isPort = p => ADAPTER_DIRS.some(d => p.startsWith(d)) && /(^|\/|-)port\.js$/.test(p.slice(p.lastIndexOf("/") + 1));
const isSupport = p => SUPPORT_DIRS.some(d => p.startsWith(d));
const isAdapter = p => isSupport(p) || (ADAPTER_DIRS.some(d => p.startsWith(d)) && !isPort(p) && !(p in NOT_ADAPTERS));
const isCore = p => /^(packages|server)\//.test(p) && !isAdapter(p) && !COMPOSITION_ROOTS.includes(p);
/** "server/blobs/s3.js" → "server/blobs/s3"; "server/store/postgres/x.js" → "server/store/postgres". */
const adapterGroup = p => {
  const d = [...ADAPTER_DIRS, ...SUPPORT_DIRS].find(d => p.startsWith(d));
  return d ? d + p.slice(d.length).split("/")[0].replace(/\.m?js$/, "") : p;
};
/** Adapter-only support code may be imported by any adapter (not by core). */
const allowed = (to, from) => isSupport(to) && isAdapter(from);

// ---- ALLOWLIST: today's known violations. Each is a fix job (docs/m2/reports/p-arch.md). The test fails on any
// violation not listed here AND on any entry that no longer occurs, so this list can only shrink. ----
const ALLOWLIST = [
  { from: "server/blobs/s3.js", to: "server/blobs/disk.js",
    why: "adapter -> adapter (same port): s3 reuses checkBlob, imageKind and MAX_BLOB_BYTES from the disk adapter. " +
      "Fix: move them to a Blobs port module (server/blobs/port.js) that both import." },
];

const config = { isCore, isAdapter, adapterGroup, compositionRoots: COMPOSITION_ROOTS, allowed };
const FILES = listFiles(SCAN);

test("packages/ and server/ follow the hexagonal import rules (core -> adapter, adapter -> adapter, only roots wire)", () => {
  expect(checkBoundaries({ files: FILES, ...config, allowlist: ALLOWLIST }).map(v => v.message)).toEqual([]);
});

test("every server/ sub-folder is classified (core, adapter or adapter-only support)", () => {
  const dirs = [...new Set(FILES.filter(f => f.startsWith("server/") && f.split("/").length > 2).map(f => f.split("/").slice(0, 2).join("/") + "/"))];
  expect(dirs.filter(d => ![...CORE_DIRS, ...ADAPTER_DIRS, ...SUPPORT_DIRS].includes(d))).toEqual([]);
});

test("every allowlist entry says why", () => {
  for (const e of ALLOWLIST) expect(e.why.length).toBeGreaterThan(20);
});

test("the derived sets are what they must be (no vacuous pass)", () => {
  for (const p of ["packages/protocol/room.js", "packages/protocol/replica.js", "server/gateway.js", "server/room-host.js",
    "server/server.js", "server/feed.js", "server/ids.js", "server/admin/boards.js", "server/auth/tenancy.js"]) expect([p, isCore(p)]).toEqual([p, true]);
  for (const p of ["server/store/sqlite.js", "server/store/postgres.js", "server/registry/postgres.js", "server/bus/nats.js",
    "server/bus/memory.js", "server/blobs/s3.js", "server/auth/oidc.js", "server/auth/dev.js", "server/auth/http.js",
    "server/pg/schema.js"]) expect([p, isAdapter(p)]).toEqual([p, true]);
  for (const p of ["server/bus/port.js", "server/auth/port.js", "server/auth/idp-port.js", "server/auth/registry-port.js",
    "server/auth/util.js"]) expect([p, isAdapter(p)]).toEqual([p, false]);   // ports and shared modules
  for (const p of [...Object.keys(NOT_ADAPTERS), ...COMPOSITION_ROOTS]) expect(FILES).toContain(p);
  expect(FILES.filter(isCore).length).toBeGreaterThan(20);
  expect(FILES.filter(isAdapter).length).toBeGreaterThan(10);
  // the scanner sees real edges: main.js wires adapters; the core reaches the Bus port; JSDoc types count
  expect(importsOf("server/main.js").map(i => i.to)).toContain("server/store/sqlite.js");
  expect(importsOf("server/gateway.js").map(i => i.to)).toContain("server/bus/port.js");
  expect(importsOf("server/admin/boards.js")).toContainEqual({ spec: "../auth/registry-port.js", to: "server/auth/registry-port.js", kind: "type" });
});

test("the Postgres adapters share start-up code through server/pg/schema.js, not through each other (p5-hexv L8)", () => {
  expect(importsOf("server/registry/postgres.js").map(i => i.to)).toContain("server/pg/schema.js");
  expect(importsOf("server/store/postgres.js").map(i => i.to)).toContain("server/pg/schema.js");
  expect(importsOf("server/pg/schema.js")).toEqual([]);   // a leaf
});

// ---- the rule itself, on planted sources: a violation of each kind fails ----

// Only the planted file is checked, with its own allowlist: the real tree and ALLOWLIST don't leak in, so these
// tests stay green when an allowlisted violation is fixed. Classification is by path, so the expectations hold.
const plant = (path, src, allowlist = []) => checkBoundaries({ files: [{ path, src }], ...config, allowlist }).map(v => v.rule);

test("planted: core -> adapter (runtime, re-export, import(), JSDoc type), and core -> adapter-only support", () => {
  expect(plant("server/gateway.js", `import { sqliteStore } from "./store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("packages/protocol/room.js", `export { natsBus } from "../../server/bus/nats.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/room-host.js", `const m = await import("./blobs/disk.js");`)).toEqual(["core->adapter"]);
  expect(plant("server/feed.js", `/** @typedef {import("./auth/oidc.js").X} X */`)).toEqual(["core->adapter"]);
  expect(plant("server/server.js", `import { migrate } from "./pg/schema.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `import { subjects } from "./bus/port.js"; import { normEmail } from "./auth/util.js";`)).toEqual([]);
});

test("planted: adapter -> adapter, across ports and within one port; an adapter may use ports, shared and support code", () => {
  expect(plant("server/registry/sqlite.js", `import { sqliteStore } from "../store/sqlite.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/bus/nats.js", `import { memoryBus } from "./memory.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/pg/schema.js", `import { x } from "../store/postgres.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/store/sqlite.js", `import { needId } from "../ids.js"; import { migrate } from "../pg/schema.js"; import { mint } from "../auth/registry-port.js";`)).toEqual([]);
});

test("planted: a new adapter-folder file is an adapter by default, so nothing but the root may import it", () => {
  expect(plant("server/admin/boards.js", `import { x } from "../auth/helper.js";`)).toEqual(["core->adapter"]);
});

test("planted: only composition roots wire adapters", () => {
  // a file that is neither core nor adapter (e.g. a second entry point outside the classified folders) wiring one
  const v = checkBoundaries({ files: [{ path: "tools/start.js", src: `import { sqliteStore } from "../server/store/sqlite.js";` }],
    ...config }).map(v => v.rule);
  expect(v).toEqual(["unclassified", "wiring"]);
  expect(plant("scripts/seed.js", `import { sqliteStore } from "../server/store/sqlite.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("server/main.js", `import { natsBus } from "./bus/nats.js"; import { s3Blobs } from "./blobs/s3.js";`)).toEqual([]);
});

test("planted: an extensionless relative import is a violation (it would dodge classification)", () => {
  expect(plant("server/gateway.js", `import { x } from "./store/sqlite";`)).toEqual(["unresolved"]);
});

test("planted: a fixed allowlisted violation fails until its entry is deleted (the list only shrinks)", () => {
  const entry = [{ from: "server/blobs/s3.js", to: "server/blobs/disk.js", why: "planted" }];
  expect(plant("server/blobs/s3.js", `import { checkBlob } from "./disk.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/blobs/s3.js", `import { checkBlob } from "./disk.js";`, entry)).toEqual([]);           // tolerated
  expect(plant("server/blobs/s3.js", `import { needId } from "../ids.js";`, entry)).toEqual(["stale-allowlist"]); // fixed
});

test("commented-out imports and look-alike strings are not imports", () => {
  expect(plant("server/gateway.js", `// import { s } from "./store/sqlite.js";\nconst p = "./store/sqlite.js";`)).toEqual([]);
});
