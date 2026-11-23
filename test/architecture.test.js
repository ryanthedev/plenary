// The hexagonal boundary test for packages/, server/ and scripts/ (briefs p-arch
// and its follow-up after p-archv). Static: test/arch-scan.js parses import specifiers (static, re-exports, import(),
// require(), JSDoc import("…") types, `new URL(…, import.meta.url)`); nothing is executed. client's
// test/web/architecture.test.js reuses the scanner for web/.
//
// The folder layout IS the architecture (mirroring web/core, web/ports, web/adapters):
//   core      packages/protocol/, packages/core/, server/core/, and server/ports/.
//             Imports ports, shared modules and other core; no adapter, no composition root, and no bare package.
//   port      server/ports/*.js (documented port interfaces and shared port helpers, no adapter code).
//   adapter   server/adapters/driving/ (inbound HTTP/WS, may import core),
//             server/adapters/driven/  (outbound implementations: ports, SHARED, support, own group, bare packages),
//             server/adapters/support/ (adapter-only shared helpers: pg/, sqlite/, encode/; any adapter may import).
//   root      COMPOSITION_ROOTS (server/main.js and scripts/*) pick and wire adapters; nothing imports a root.
//
// Any new packages/<dir>/, top-level server/*.js, or scripts/*.js fails as "unclassified" unless explicitly placed.

import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, listFiles, importsOf, checkBoundaries } from "./arch-scan.js";

const SCAN = ["packages", "server", "scripts", "deploy"];   // every non-test code folder but web/ (client's)
const CORE_DIRS = ["packages/protocol/", "packages/core/", "server/core/"];
const PORT_DIRS = ["server/ports/"];
const DRIVING_DIR = "server/adapters/driving/";
const DRIVEN_DIR = "server/adapters/driven/";
const SUPPORT_DIR = "server/adapters/support/";
const SERVER_SUBDIRS = ["server/core/", "server/ports/", "server/adapters/"];

/** Driving adapters that share the HTTP server group (`server.js` mounts `static.js`, etc.). */
const HTTP_GROUP = new Set([
  "server/adapters/driving/server.js",
  "server/adapters/driving/static.js",
  "server/adapters/driving/blob-http.js",
  "server/adapters/driving/metrics-http.js",
  "server/adapters/driving/embed-http.js",
]);

const COMPOSITION_ROOTS = [
  "server/main.js",
  "scripts/dev-google.js",        // dev harness, self-described composition root for a local Google sign-in check (p5-google)
  "scripts/admin-bootstrap.js",   // platform: tenant bootstrap CLI; its core part, server/core/admin/tenants.js, imports only ports
  "scripts/cluster-rig.js",       // platform (p8-rig): local cluster rig CLI; spawns processes, imports no project module
  "scripts/fold-bench.js",        // platform: reports how long a checkpoint holds the event loop (imports whatever checkout --root names)
  "scripts/fanout-bench.js",      // platform: reports what a live frame costs a gateway for N viewers (imports whatever checkout --root names; #66)
  "scripts/clean.js",             // platform: safe cleanup CLI for test temp dirs, stopped rigs and scratch copies; shells out to lsof and the rig CLI
  "scripts/test-cluster.js",      // test harness: starts and tears down an isolated local services rig
  "scripts/test-compose.js",      // test harness (#71): three-node cluster test on a container runtime (`bun run test:compose`); never part of `bun test`
  "scripts/test-cluster-files.js", // test harness data: the gated test files test-cluster.js runs, also imported by its guard
  "scripts/load/run.js", "scripts/load/worker.js", "scripts/load/tokens.js", "scripts/load/client.js", "scripts/load/server.js",
  "scripts/load/stats.js",        // platform (p8-load): load client; run.js and worker.js are entry points, the rest their modules
  "scripts/plenary-client.js", "scripts/plenary-cli.js", "scripts/plenary-mcp.js", // agent tools: CLI & stdio MCP server
  "scripts/bench.js",             // reproducible performance benchmark suite
];

/** Non-port modules a driven adapter may import. */
const SHARED = ["server/core/ids.js", "server/core/auth/util.js"];

const under = (p, dirs) => dirs.some(d => p.startsWith(d));
const isPort = p => under(p, PORT_DIRS);
const isDriving = p => p.startsWith(DRIVING_DIR);
const isDriven = p => p.startsWith(DRIVEN_DIR);
const isSupport = p => p.startsWith(SUPPORT_DIR);
const isAdapter = p => isDriving(p) || isDriven(p) || isSupport(p);
const isCore = p => !isAdapter(p) && (under(p, CORE_DIRS) || isPort(p));

/**
 * One adapter = one group:
 * - HTTP driving adapters share `"server/http"`; other driving adapters are their own file group.
 * - Driven adapters: `"server/adapters/driven/blobs/s3.js"` → `"server/adapters/driven/blobs/s3"`.
 * - Support modules: `"server/adapters/support/pg/schema.js"` → `"server/adapters/support/pg"`.
 */
const adapterGroup = p => {
  if (HTTP_GROUP.has(p)) return "server/http";
  if (isDriving(p)) return p.replace(/\.\w+$/, "");
  if (isDriven(p)) {
    const rest = p.slice(DRIVEN_DIR.length).split("/");
    return rest.length >= 2 ? DRIVEN_DIR + rest[0] + "/" + rest[1].replace(/\.\w+$/, "") : p.replace(/\.\w+$/, "");
  }
  if (isSupport(p)) {
    const rest = p.slice(SUPPORT_DIR.length).split("/");
    return SUPPORT_DIR + rest[0].replace(/\.\w+$/, "");
  }
  return p;
};

/** Adapter-only support code may be imported by any adapter (not by core). */
const allowed = (to, from) => isSupport(to) && isAdapter(from);
/** What an adapter may import besides adapters of its own group and support code. */
const adapterMayImport = (to, from) => isPort(to) || SHARED.includes(to) || (isDriving(from) && isCore(to));

const ALLOWLIST = [];

const config = {
  isCore, isAdapter, adapterGroup, compositionRoots: COMPOSITION_ROOTS, allowed, adapterMayImport,
  allowPackage: (spec, from) => spec === "node:crypto" && from === "server/core/auth/share-policy.js",
  urls: true,
};
const FILES = listFiles(SCAN.filter(d => existsSync(join(ROOT, d))));

test("packages/, server/ and scripts/ follow the hexagonal import rules", () => {
  expect(checkBoundaries({ files: FILES, ...config, allowlist: ALLOWLIST }).map(v => v.message)).toEqual([]);
});

test("every server/ and packages/ sub-folder is classified (core, ports, or adapters)", () => {
  const dirs = [...new Set(FILES.filter(f => /^(server|packages)\//.test(f) && f.split("/").length > 2).map(f => f.split("/").slice(0, 2).join("/") + "/"))];
  expect(dirs.filter(d => ![...CORE_DIRS, ...SERVER_SUBDIRS].includes(d))).toEqual([]);
});

test("every allowlist entry says why", () => {
  for (const e of ALLOWLIST) expect(e.why.length).toBeGreaterThan(20);
});

test("the classes are what they must be (no vacuous pass)", () => {
  for (const p of [
    "packages/protocol/room.js", "packages/protocol/replica.js", "packages/core/doc.js",
    "server/core/gateway.js", "server/core/room-host.js", "server/core/feed.js", "server/core/ids.js", "server/core/log.js",
    "server/core/admin/boards.js", "server/core/auth/tenancy.js", "server/core/auth/util.js",
    "server/core/auth/resolver.js", "server/core/auth/permissions.js", "server/core/instrument.js",
    "server/ports/bus.js", "server/ports/blobs.js", "server/ports/metrics.js", "server/ports/store.js",
    "server/ports/auth.js", "server/ports/idp.js", "server/ports/registry.js", "server/ports/live-sources.js",
  ]) expect([p, isCore(p), isAdapter(p)]).toEqual([p, true, false]);

  for (const p of [
    "server/adapters/driven/store/sqlite.js", "server/adapters/driven/store/postgres.js",
    "server/adapters/driven/registry/postgres.js", "server/adapters/driven/bus/nats.js",
    "server/adapters/driven/bus/memory.js", "server/adapters/driven/blobs/s3.js",
    "server/adapters/driven/blobs/disk.js", "server/adapters/driven/auth/oidc.js",
    "server/adapters/driven/auth/dev.js", "server/adapters/driven/metrics/prometheus.js",
    "server/adapters/driving/auth-http.js", "server/adapters/driving/server.js",
    "server/adapters/driving/metrics-http.js", "server/adapters/driving/embed-http.js",
    "server/adapters/support/pg/schema.js", "server/adapters/support/sqlite/schema.js",
  ]) expect([p, isAdapter(p), isCore(p)]).toEqual([p, true, false]);

  for (const p of ["packages/natsbus/bus.js", "server/redis-cache.js", "scripts/seed.js"]) expect([p, isCore(p) || isAdapter(p)]).toEqual([p, false]);
  expect(adapterGroup("server/adapters/driving/static.js")).toBe(adapterGroup("server/adapters/driving/server.js"));
  expect(adapterGroup("server/adapters/driven/blobs/s3.js")).not.toBe(adapterGroup("server/adapters/driven/blobs/disk.js"));
  expect(FILES).toContain("server/main.js");
  expect(FILES.filter(isCore).length).toBeGreaterThan(20);
  expect(FILES.filter(isAdapter).length).toBeGreaterThan(10);
  expect(importsOf("server/main.js").map(i => i.to)).toContain("server/adapters/driven/store/sqlite.js");
  expect(importsOf("server/core/gateway.js").map(i => i.to)).toContain("server/ports/bus.js");
  expect(importsOf("server/core/admin/boards.js")).toContainEqual({ spec: "../../ports/registry.js", to: "server/ports/registry.js", kind: "type" });
});

test("shared code goes through ports and support modules, not through another adapter (p5-hexv L8, Blobs)", () => {
  expect(importsOf("server/adapters/driven/registry/postgres.js").map(i => i.to)).toContain("server/adapters/support/pg/schema.js");
  expect(importsOf("server/adapters/driven/store/postgres.js").map(i => i.to)).toContain("server/adapters/support/pg/schema.js");
  expect(importsOf("server/adapters/support/pg/schema.js")).toEqual([]);
  for (const f of ["server/adapters/driven/store/sqlite.js", "server/adapters/driven/registry/sqlite.js"]) {
    expect(importsOf(f).map(i => i.to)).toContain("server/adapters/support/sqlite/schema.js");
  }
  expect(importsOf("server/adapters/support/sqlite/schema.js")).toEqual([]);
  for (const f of ["server/adapters/driven/blobs/s3.js", "server/adapters/driven/blobs/disk.js"]) {
    expect(importsOf(f).map(i => i.to)).toContain("server/ports/blobs.js");
  }
});

test("every adapter imports its port module (one documented interface per port)", () => {
  const PORT_OF = {
    "server/adapters/driven/store/sqlite.js": "server/ports/store.js",
    "server/adapters/driven/store/postgres.js": "server/ports/store.js",
    "server/adapters/driven/registry/sqlite.js": "server/ports/registry.js",
    "server/adapters/driven/registry/postgres.js": "server/ports/registry.js",
    "server/adapters/driven/auth/registry.js": "server/ports/registry.js",
    "server/adapters/driven/bus/memory.js": "server/ports/bus.js",
    "server/adapters/driven/bus/nats.js": "server/ports/bus.js",
    "server/adapters/driven/blobs/disk.js": "server/ports/blobs.js",
    "server/adapters/driven/blobs/s3.js": "server/ports/blobs.js",
    "server/adapters/driven/metrics/prometheus.js": "server/ports/metrics.js",
    "server/adapters/driven/live-sources/http.js": "server/ports/live-sources.js",
    "server/adapters/driven/live-sources/memory.js": "server/ports/live-sources.js",
  };
  for (const [adapter, port] of Object.entries(PORT_OF)) {
    expect([adapter, importsOf(adapter).map(i => i.to).includes(port)]).toEqual([adapter, true]);
  }
});

// ---- the rules themselves, on planted sources: a violation of each kind fails ----

const plant = (path, src, allowlist = []) => checkBoundaries({ files: [{ path, src }], ...config, allowlist }).map(v => v.rule);

test("planted: core -> adapter (runtime, re-export, import(), JSDoc type, Worker URL), and core -> adapter-only support", () => {
  expect(plant("server/core/gateway.js", `import { sqliteStore } from "../adapters/driven/store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("packages/protocol/room.js", `export { natsBus } from "../../server/adapters/driven/bus/nats.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/room-host.js", `const m = await import("../adapters/driven/blobs/disk.js");`)).toEqual(["core->adapter"]);
  expect(plant("server/core/feed.js", `/** @typedef {import("../adapters/driven/auth/oidc.js").X} X */`)).toEqual(["core->adapter"]);
  expect(plant("server/core/feed.js", `const w = new Worker(new URL("../adapters/driven/store/sqlite.js", import.meta.url));`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `import { migrate } from "../adapters/support/pg/schema.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `import { x } from "../adapters/driving/server.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `import { x } from "../adapters/driven/store/sqlite.ts";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `import { subjects } from "../ports/bus.js"; import { normEmail } from "./auth/util.js";`)).toEqual([]);
});

test("planted: nothing imports a composition root (p-archv M1)", () => {
  expect(plant("server/core/gateway.js", `import { x } from "../main.js";`)).toEqual(["imports-root"]);
  expect(plant("server/core/admin/boards.js", `import { x } from "../../../scripts/dev-google.js";`)).toEqual(["imports-root"]);
  expect(plant("server/adapters/driven/bus/nats.js", `import { x } from "../../../main.js";`)).toEqual(["imports-root"]);
});

test("planted: a block comment closed before an import doesn't hide it (p-archv M2)", () => {
  expect(plant("server/core/gateway.js", `/* hot path */ import { a } from "../adapters/driven/store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `/* x */ const r = require("../adapters/driven/store/sqlite.js");`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `/**\n * doc\n */ import { a } from "../adapters/driven/store/sqlite.js";`)).toEqual(["core->adapter"]);
  expect(plant("server/core/gateway.js", `/* import { a } from "../adapters/driven/store/sqlite.js"; */`)).toEqual([]);
  expect(plant("server/core/gateway.js", `/*\n * import { a } from "../adapters/driven/store/sqlite.js";\n */`)).toEqual([]);
  expect(plant("server/core/gateway.js", `// const r = require("../adapters/driven/store/sqlite.js");`)).toEqual([]);
});

test("planted: a new packages/<dir> or top-level server file must be classified; core imports no bare package (p-archv M3)", () => {
  expect(plant("server/redis-cache.js", `import { RedisClient } from "bun";`)).toEqual(["unclassified"]);
  expect(plant("packages/natsbus/bus.js", `import { connect } from "@nats-io/transport-node";`)).toEqual(["unclassified"]);
  expect(plant("server/core/gateway.js", `import { SQL } from "bun";`)).toEqual(["core->package"]);
  expect(plant("packages/protocol/room.js", `import { readFileSync } from "node:fs";`)).toEqual(["core->package"]);
  expect(plant("server/core/feed.js", `const { connect } = require("@nats-io/transport-node");`)).toEqual(["core->package"]);
  expect(plant("server/adapters/driven/store/sqlite.js", `import { Database } from "bun:sqlite";`)).toEqual([]);
});

test("planted: adapter -> adapter, across ports and within one port", () => {
  expect(plant("server/adapters/driven/registry/sqlite.js", `import { sqliteStore } from "../store/sqlite.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/adapters/driven/bus/nats.js", `import { memoryBus } from "./memory.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/adapters/support/pg/schema.js", `import { x } from "../../driven/store/postgres.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/adapters/driving/auth-http.js", `import { x } from "../driven/store/sqlite.js";`)).toEqual(["adapter->adapter"]);
});

test("planted: a driven adapter imports only ports, SHARED, support code and packages; a driving adapter may import core", () => {
  expect(plant("server/adapters/driven/store/sqlite.js", `import { x } from "../../../core/gateway.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/adapters/driven/bus/nats.js", `import { x } from "../../../core/room-host.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/adapters/driven/registry/sqlite.js", `import { x } from "../../../core/auth/tenancy.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/adapters/driven/blobs/s3.js", `import { x } from "../../../../packages/protocol/codec.js";`)).toEqual(["adapter->core"]);
  expect(plant("server/adapters/driven/store/sqlite.js", `import { needId } from "../../../core/ids.js"; import { migrate } from "../../support/pg/schema.js"; import { mint } from "../../../ports/registry.js"; import { normEmail } from "../../../core/auth/util.js";`)).toEqual([]);
  expect(plant("server/adapters/driving/auth-http.js", `import { createBoard } from "../../core/admin/boards.js";`)).toEqual([]);
  expect(plant("server/adapters/driving/server.js", `import { gateway } from "../../core/gateway.js"; import { staticSite } from "./static.js";`)).toEqual([]);
});

test("planted: a new adapter-folder file is an adapter by default, so nothing but a root may import it", () => {
  expect(plant("server/core/admin/boards.js", `import { x } from "../../adapters/driven/auth/helper.js";`)).toEqual(["core->adapter"]);
});

test("planted: only composition roots wire adapters", () => {
  expect(plant("tools/start.js", `import { sqliteStore } from "../server/adapters/driven/store/sqlite.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("scripts/seed.js", `import { sqliteStore } from "../server/adapters/driven/store/sqlite.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("deploy/x.js", `import { natsBus } from "../server/adapters/driven/bus/nats.js";`)).toEqual(["unclassified", "wiring"]);
  expect(plant("server/main.js", `import { natsBus } from "./adapters/driven/bus/nats.js"; import { s3Blobs } from "./adapters/driven/blobs/s3.js";`)).toEqual([]);
});

test("planted: an extensionless relative import is a violation (it would dodge classification)", () => {
  expect(plant("server/core/gateway.js", `import { x } from "../adapters/driven/store/sqlite";`)).toEqual(["unresolved"]);
});

test("planted: a fixed allowlisted violation fails until its entry is deleted (the list only shrinks)", () => {
  const entry = [{ from: "server/adapters/driven/blobs/s3.js", to: "server/adapters/driven/blobs/disk.js", why: "planted" }];
  expect(plant("server/adapters/driven/blobs/s3.js", `import { checkBlob } from "./disk.js";`)).toEqual(["adapter->adapter"]);
  expect(plant("server/adapters/driven/blobs/s3.js", `import { checkBlob } from "./disk.js";`, entry)).toEqual([]);
  expect(plant("server/adapters/driven/blobs/s3.js", `import { needId } from "../../../core/ids.js";`, entry)).toEqual(["stale-allowlist"]);
});
