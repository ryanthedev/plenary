// The engine core imports ports, never adapters (docs/m2/OFFICE.md "Architecture"; brief p2-swap). The core files
// below get the Store, Bus, Blobs, Auth and Registry injected; only the composition root (server/main.js) picks
// adapters. test/auth/architecture.test.js covers platform's folders; this covers the engine's.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname, posix } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = ["server/server.js", "server/gateway.js", "server/room-host.js", "server/feed.js", "server/breather.js", "server/ids.js", "server/log.js", "server/bus/port.js"];
// Adapters: anything under these folders except a port module.
const ADAPTER_DIRS = ["server/bus/", "server/store/", "server/blobs/", "server/registry/", "server/auth/", "server/admin/"];
const PORTS = new Set(["server/bus/port.js"]);

/** Every relative module a file names: static imports and re-exports, `import()` and JSDoc `import("…")` types. */
function importsOf(file) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(m => m[1]);
  return specs.filter(s => s.startsWith(".")).map(s => posix.normalize(posix.join(dirname(file), s)));
}

test("the engine core (gateway, room host, feed, server) imports no adapter: Store, Bus, Blobs, Auth and Registry come injected", () => {
  const bad = [];
  for (const file of CORE) for (const dep of importsOf(file)) if (!PORTS.has(dep) && ADAPTER_DIRS.some(d => dep.startsWith(d))) bad.push(`${file} → ${dep}`);
  expect(bad).toEqual([]);
});

test("the check sees what it must: an adapter import in a core file would be caught", () => {
  expect(importsOf("server/main.js").some(d => ADAPTER_DIRS.some(a => d.startsWith(a)) && !PORTS.has(d))).toBe(true);   // main.js picks adapters
  expect(importsOf("server/gateway.js")).toContain("server/bus/port.js");
});
