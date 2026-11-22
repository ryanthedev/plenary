// The hexagonal boundary test for packages/, server/ and scripts/ (docs/m2/OFFICE.md "Architecture"; briefs p-arch
// and its follow-up after p-archv). Static: test/arch-scan.js parses import specifiers (static, re-exports, import(),
// require(), JSDoc import("…") types, `new URL(…, import.meta.url)`); nothing is executed. client's
// test/web/architecture.test.js reuses the scanner for web/.
//
// Every file must be classified; a file in none of the classes fails as "unclassified" (p-archv M3), so a new
// packages/<dir>/, a new top-level server/*.js or a new script can't pass as core by default:
//   core      CORE_DIRS (packages/protocol/, packages/core/, server/admin/), CORE_FILES (the top-level server/ core
//             files), the ports and NOT_ADAPTERS. Imports ports, shared modules and other core; no adapter, no
//             composition root, and no bare package (no framework or driver: "bun", "node:fs", "@nats-io/…").
//             Globals (Bun.serve, process) are invisible to any import rule.
//             server/log.js is the Log port and its stdout adapter in one file (p-archv L7); fine while only core
//             and roots import it.
//   port      by name: port.js or *-port.js in an adapter folder (typedefs and shared port pieces, no adapter code)
//   adapter   every file under an ADAPTER_DIRS folder, except ports and NOT_ADAPTERS (a new file there is an adapter
//             by default, the strict side), plus the DRIVING adapters and SUPPORT_DIRS.
//             Driven adapters import only ports, SHARED, SUPPORT_DIRS, their own group and bare packages
//             ("adapter->core" otherwise; manager decision on p-archv question 3).
//             DRIVING adapters (HTTP/WebSocket calling into the core: server.js, static.js, auth/http.js) may also
//             import core.
//   adapter-only support: SUPPORT_DIRS (server/pg/) holds code several adapters share (Postgres start-up). It counts
//             as an adapter (core may not import it, it may not import other adapters) that any adapter may import.
//   root      COMPOSITION_ROOTS pick and wire adapters; nothing imports a root. Every script under scripts/ must be a
//             root (strict on purpose, p-archv L3): a new dev script is added here when it is written.
// One adapter = one group: its file, its own sub-folder (server/store/postgres/*.js would be one group), or an
// explicit group in DRIVING. Two adapters of one port (blobs/s3.js and blobs/disk.js) are two groups: an adapter
// never imports another adapter.

import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, listFiles, importsOf, checkBoundaries } from "./arch-scan.js";

const SCAN = ["packages", "server", "scripts", "deploy"];   // every non-test code folder but web/ (client's) and docs/
const CORE_DIRS = ["packages/protocol/", "packages/core/", "server/admin/"];
const CORE_FILES = ["server/gateway.js", "server/room-host.js", "server/feed.js", "server/breather.js", "server/ids.js", "server/log.js"];
const ADAPTER_DIRS = ["server/store/", "server/registry/", "server/bus/", "server/blobs/", "server/auth/"];
const SUPPORT_DIRS = ["server/pg/"];
/** Driving adapters, each with its group: server.js serves HTTP/WebSocket (Bun.serve) and mounts static.js. */
const DRIVING = {
  "server/server.js": "server/http",
  "server/static.js": "server/http",
  "server/auth/http.js": "server/auth/http",
};
const COMPOSITION_ROOTS = [
  "server/main.js",
  "scripts/dev-google.js",        // dev harness, self-described composition root for a local Google sign-in check (p5-google)
  "scripts/admin-bootstrap.js",   // platform: tenant bootstrap CLI; its core part, server/admin/tenants.js, imports only ports
  "scripts/cluster-rig.js",       // platform (p8-rig): local cluster rig CLI; spawns processes, imports no project module
  "scripts/load/run.js", "scripts/load/worker.js", "scripts/load/tokens.js", "scripts/load/client.js", "scripts/load/server.js",
  "scripts/load/stats.js",        // platform (p8-load): load client; run.js and worker.js are entry points, the rest their modules
  "scripts/plenary-client.js", "scripts/plenary-cli.js", "scripts/plenary-mcp.js", // agent tools: CLI & stdio MCP server
];
/** Files in adapter folders that are not adapters (explicit; anything else there is an adapter). */
const NOT_ADAPTERS = {
  "server/auth/util.js": "shared pure helpers (roles, base64url, ids); imported by core, ports and adapters",
  "server/auth/tenancy.js": "core: role resolution over the Registry port (platform's CLASSES calls it core)",
};
/** Non-port modules a driven adapter may import. */
const SHARED = ["server/ids.js", "server/auth/util.js"];

const under = (p, dirs) => dirs.some(d => p.startsWith(d));
const isPort = p => under(p, ADAPTER_DIRS) && /(^|-)port\.js$/.test(p.slice(p.lastIndexOf("/") + 1));
const isSupport = p => under(p, SUPPORT_DIRS);
const isAdapter = p => isSupport(p) || p in DRIVING || (under(p, ADAPTER_DIRS) && !isPort(p) && !(p in NOT_ADAPTERS));
const isCore = p => !isAdapter(p) && (under(p, CORE_DIRS) || CORE_FILES.includes(p) || isPort(p) || p in NOT_ADAPTERS);
/** "server/blobs/s3.js" → "server/blobs/s3"; "server/store/postgres/x.js" → "server/store/postgres". */
const adapterGroup = p => {
  if (p in DRIVING) return DRIVING[p];
  const d = [...ADAPTER_DIRS, ...SUPPORT_DIRS].find(d => p.startsWith(d));
  return d ? d + p.slice(d.length).split("/")[0].replace(/\.\w+$/, "") : p;
};
/** Adapter-only support code may be imported by any adapter (not by core). */
const allowed = (to, from) => isSupport(to) && isAdapter(from);
/** What an adapter may import besides adapters of its own group and support code. */
const adapterMayImport = (to, from) => isPort(to) || SHARED.includes(to) || (from in DRIVING && isCore(to));

// ---- ALLOWLIST: known violations, each a fix job with its reason. The test fails on any violation not listed
// here AND on any entry that no longer occurs, so this list can only shrink. Empty since the Blobs port module
// (server/blobs/port.js) replaced s3.js -> disk.js (p-arch follow-up). Entry shape: { from, to, why }. ----
const ALLOWLIST = [];

const config = { isCore, isAdapter, adapterGroup, compositionRoots: COMPOSITION_ROOTS, allowed, adapterMayImport,
  allowPackage: () => false, urls: true };
const FILES = listFiles(SCAN.filter(d => existsSync(join(ROOT, d))));

test("packages/, server/ and scripts/ follow the hexagonal import rules", () => {
  expect(checkBoundaries({ files: FILES, ...config, allowlist: ALLOWLIST }).map(v => v.message)).toEqual([]);
});

test("every server/ and packages/ sub-folder is classified (core, adapter or adapter-only support)", () => {
  const dirs = [...new Set(FILES.filter(f => /^(server|packages)\//.test(f) && f.split("/").length > 2).map(f => f.split("/").slice(0, 2).join("/") + "/"))];
  expect(dirs.filter(d => ![...CORE_DIRS, ...ADAPTER_DIRS, ...SUPPORT_DIRS].includes(d))).toEqual([]);
});

test("every allowlist entry says why", () => {
  for (const e of ALLOWLIST) expect(e.why.length).toBeGreaterThan(20);
});

test("the classes are what they must be (no vacuous pass)", () => {
  for (const p of ["packages/protocol/room.js", "packages/protocol/replica.js", "packages/core/doc.js", "server/gateway.js",
    "server/room-host.js", "server/feed.js", "server/ids.js", "server/log.js", "server/admin/boards.js", "server/auth/tenancy.js",
    "server/bus/port.js", "server/blobs/port.js", "server/auth/port.js", "server/auth/idp-port.js", "server/auth/registry-port.js",
    "server/auth/util.js"]) expect([p, isCore(p), isAdapter(p)]).toEqual([p, true, false]);
  for (const p of ["server/store/sqlite.js", "server/store/postgres.js", "server/registry/postgres.js", "server/bus/nats.js",
    "server/bus/memory.js", "server/blobs/s3.js", "server/blobs/disk.js", "server/auth/oidc.js", "server/auth/dev.js",
    "server/auth/http.js", "server/server.js", "server/pg/schema.js"]) expect([p, isAdapter(p), isCore(p)]).toEqual([p, true, false]);
  for (const p of ["packages/natsbus/bus.js", "server/redis-cache.js", "scripts/seed.js"]) expect([p, isCore(p) || isAdapter(p)]).toEqual([p, false]);
  expect(adapterGroup("server/static.js")).toBe(adapterGroup("server/server.js"));
  expect(adapterGroup("server/blobs/s3.js")).not.toBe(adapterGroup("server/blobs/disk.js"));
  expect(FILES).toContain("server/main.js");   // the other roots may come and go (scripts)
  expect(FILES.filter(isCore).length).toBeGreaterThan(20);
  expect(FILES.filter(isAdapter).length).toBeGreaterThan(10);
  // the scanner sees real edges: main.js wires adapters; the core reaches the Bus port; JSDoc types count
  expect(importsOf("server/main.js").map(i => i.to)).toContain("server/store/sqlite.js");
  expect(importsOf("server/gateway.js").map(i => i.to)).toContain("server/bus/port.js");
  expect(importsOf("server/admin/boards.js")).toContainEqual({ spec: "../auth/registry-port.js", to: "server/auth/registry-port.js", kind: "type" });
});

test("shared code goes through ports and support modules, not through another adapter (p5-hexv L8, Blobs)", () => {
  expect(importsOf("server/registry/postgres.js").map(i => i.to)).toContain("server/pg/schema.js");
  expect(importsOf("server/store/postgres.js").map(i => i.to)).toContain("server/pg/schema.js");
  expect(importsOf("server/pg/schema.js")).toEqual([]);   // a leaf
  for (const f of ["server/blobs/s3.js", "server/blobs/disk.js"]) expect(importsOf(f).map(i => i.to)).toContain("server/blobs/port.js");
});

// ---- the rules themselves, on planted sources: a violation of each kind fails ----

// Only the planted file is checked, with its own allowlist: the real tree and ALLOWLIST don't leak in, so these
// tests stay green when an allowlisted violation is fixed. Classification is by path, so the expectations hold.
const plant = (path, src, allowlist = []) => checkBoundaries({ files: [{ path, src }], ...config, allowlist }).map(v => v.rule);

test("planted: core -> adapter (runtime, re-export, import(), JSDoc type, Worker URL), and core -> adapter-only support", () => {
  expect(plant("server/gateway.js", `import { sqliteStore } from "./store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("packages/protocol/room.js", `export { natsBus } from "../../server/bus/nats.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/room-host.js", `const m = await import("./blobs/disk.js");`)).toEqual(["core->adapter"]);
  expect(plant("server/feed.js", `/** @typedef {import("./auth/oidc.js").X} X */`)).toEqual(["core->adapter"]);
  expect(plant("server/feed.js", `const w = new Worker(new URL("./store/sqlite.js", import.meta.url));`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `import { migrate } from "./pg/schema.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `import { x } from "./server.js";`)).toEqual(["core->adapter"]);   // a driving adapter
  expect(plant("server/gateway.js", `import { x } from "./store/sqlite.ts";`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `import { subjects } from "./bus/port.js"; import { normEmail } from "./auth/util.js";`)).toEqual([]);
});

test("planted: nothing imports a composition root (p-archv M1)", () => {
  expect(plant("server/gateway.js", `import { x } from "./main.js";`)).toEqual(["imports-root"]);
  expect(plant("server/admin/boards.js", `import { x } from "../../scripts/dev-google.js";`)).toEqual(["imports-root"]);
  expect(plant("server/bus/nats.js", `import { x } from "../main.js";`)).toEqual(["imports-root"]);
});

test("planted: a block comment closed before an import doesn't hide it (p-archv M2)", () => {
  expect(plant("server/gateway.js", `/* hot path */ import { a } from "./store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `/* x */ const r = require("./store/sqlite.js");`)).toEqual(["core->adapter"]);
  expect(plant("server/gateway.js", `/**\n * doc\n */ import { a } from "./store/sqlite.js";`)).toEqual(["core->adapter"]);
  // still comments: an open block comment, a continuation line, a line comment
  expect(plant("server/gateway.js", `/* import { a } from "./store/sqlite.js"; */`)).toEqual([]);
  expect(plant("server/gateway.js", `/*\n * import { a } from "./store/sqlite.js";\n */`)).toEqual([]);
  expect(plant("server/gateway.js", `// const r = require("./store/sqlite.js");`)).toEqual([]);
});

test("planted: a new packages/<dir> or top-level server file must be classified; core imports no bare package (p-archv M3)", () => {
  expect(plant("server/redis-cache.js", `import { RedisClient } from "bun";`)).toEqual(["unclassified"]);
  expect(plant("packages/natsbus/bus.js", `import { connect } from "@nats-io/transport-node";`)).toEqual(["unclassified"]);
  expect(plant("server/gateway.js", `import { SQL } from "bun";`)).toEqual(["core->package"]);
  expect(plant("packages/protocol/room.js", `import { readFileSync } from "node:fs";`)).toEqual(["core->package"]);
  expect(plant("server/feed.js", `const { connect } = require("@nats-io/transport-node");`)).toEqual(["core->package"]);
  expect(plant("server/store/sqlite.js", `import { Database } from "bun:sqlite";`)).toEqual([]);   // adapters may
});

test("planted: adapter -> adapter, across ports and within one port", () => {
  expect(plant("server/registry/sqlite.js", `import { sqliteStore } from "../store/sqlite.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/bus/nats.js", `import { memoryBus } from "./memory.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/pg/schema.js", `import { x } from "../store/postgres.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/auth/http.js", `import { x } from "../store/sqlite.js";`)).toEqual(["adapter->adapter"]);
});

test("planted: a driven adapter imports only ports, SHARED, support code and packages; a driving adapter may import core", () => {
  expect(plant("server/store/sqlite.js", `import { x } from "../gateway.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/bus/nats.js", `import { x } from "../room-host.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/registry/sqlite.js", `import { x } from "../auth/tenancy.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/blobs/s3.js", `import { x } from "../../packages/protocol/codec.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/store/sqlite.js", `import { needId } from "../ids.js"; import { migrate } from "../pg/schema.js"; import { mint } from "../auth/registry-port.js"; import { normEmail } from "../auth/util.js";`)).toEqual([]);
  expect(plant("server/auth/http.js", `import { createBoard } from "../admin/boards.js";`)).toEqual([]);
  expect(plant("server/server.js", `import { gateway } from "./gateway.js"; import { staticSite } from "./static.js";`)).toEqual([]);
});

test("planted: a new adapter-folder file is an adapter by default, so nothing but a root may import it", () => {
  expect(plant("server/admin/boards.js", `import { x } from "../auth/helper.js";`)).toEqual(["core->adapter"]);
});

test("planted: only composition roots wire adapters", () => {
  expect(plant("tools/start.js", `import { sqliteStore } from "../server/store/sqlite.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("scripts/seed.js", `import { sqliteStore } from "../server/store/sqlite.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("deploy/x.js", `import { natsBus } from "../server/bus/nats.js";`)).toEqual(["unclassified", "wiring"]);
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
