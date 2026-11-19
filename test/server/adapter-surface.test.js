// One surface per port: every adapter of a port has exactly the port's methods, plus only the documented adapter-only extras,
// and core code never calls an extra. The behaviour behind each method is pinned by the port's contract suite
// (store-contract.js, auth/registry-contract.js, bus-contract.js, blobs-contract.js), which every adapter runs.
// SQLite, memory and disk run in plain `bun test`; Postgres, NATS and S3 run under `bun run test:cluster` (DATABASE_URL, NATS_URL, S3_*).
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteStore } from "../../server/store/sqlite.js";
import { postgresStore } from "../../server/store/postgres.js";
import { STORE_METHODS } from "../../server/store/port.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { REGISTRY_METHODS } from "../../server/auth/registry-port.js";
import { SQL } from "bun";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { postgresRegistry } from "../../server/registry/postgres.js";
import { memoryBus } from "../../server/bus/memory.js";
import { natsBus } from "../../server/bus/nats.js";
import { BUS_MEMBERS } from "../../server/bus/port.js";
import { diskBlobs } from "../../server/blobs/disk.js";
import { s3Blobs } from "../../server/blobs/s3.js";
import { BLOBS_METHODS } from "../../server/blobs/port.js";
import { listFiles, ROOT } from "../arch-scan.js";
import { tempDir, cleanup } from "./helpers.js";

afterAll(cleanup);
const E = process.env;
const names = o => Object.keys(o).sort();
/** The adapter's own members, minus what the port names: must be a subset of `extras`. */
const surface = (adapter, port, extras) => {
  expect(port.filter(m => typeof adapter[m] !== "function" && typeof adapter[m] !== "number")).toEqual([]);   // nothing missing
  expect(names(adapter).filter(m => !port.includes(m) && !extras.includes(m))).toEqual([]);                     // nothing undocumented
};

/** The schema a Postgres case made. */
const dropSchema = async schema => { const sql = new SQL({ url: E.DATABASE_URL, max: 1 }); try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await sql.close(); } };
const STORE_EXTRAS = ["pragmas", "settings", "clusterId"];
/** Bus extras: `subscriberCount` (both), `isUp` (NATS connection state, tests). */
const BUS_EXTRAS = ["subscriberCount", "isUp"];
/** Registry extras (`linkUsesFor` is the optional batch read; `idemSize` a test helper every adapter has): diagnostics and a housekeeping call and the client-side gate's state (`gate()`, read by main.js), adapter-only (the memory adapter is the reference list). */
const REGISTRY_EXTRAS = ["pragmas", "settings", "readSettings", "idemPrune", "gate", "idemSize", "linkUsesFor"];

test("Store: sqlite has exactly the port's methods", async () => {
  const s = sqliteStore({ path: ":memory:" });
  surface(s, STORE_METHODS, STORE_EXTRAS);
  await s.close();
});
test.skipIf(!E.DATABASE_URL)("Store: postgres has exactly the port's methods", async () => {
  const schema = `pl_surface_${process.pid}_store`, s = await postgresStore({ url: E.DATABASE_URL, schema, max: 2 });
  try { surface(s, STORE_METHODS, STORE_EXTRAS); } finally { await s.close(); await dropSchema(schema); }
});

test("Registry: memory and sqlite have exactly the port's methods", async () => {
  surface(memoryRegistry(), REGISTRY_METHODS, REGISTRY_EXTRAS);
  const r = sqliteRegistry({ path: ":memory:" });
  surface(r, REGISTRY_METHODS, REGISTRY_EXTRAS);
  await r.close();
});
test.skipIf(!E.DATABASE_URL)("Registry: postgres has the exactly the port's methods", async () => {
  const schema = `pl_surface_${process.pid}_registry`, r = await postgresRegistry({ url: E.DATABASE_URL, schema, max: 2 });
  try { surface(r, REGISTRY_METHODS, REGISTRY_EXTRAS); } finally { await r.close(); await dropSchema(schema); }
});

test("Bus: memory has exactly the port's members", async () => {
  const b = memoryBus();
  surface(b, BUS_MEMBERS, BUS_EXTRAS);
  await b.close();
});
test.skipIf(!E.NATS_URL)("Bus: nats has exactly the port's members", async () => {
  const b = await natsBus({ url: E.NATS_URL, cluster: null });
  try { surface(b, BUS_MEMBERS, BUS_EXTRAS); } finally { await b.close(); }
});

test("Blobs: disk has exactly the port's methods", () => surface(diskBlobs({ dir: tempDir() }), BLOBS_METHODS, []));
test.skipIf(!E.S3_ENDPOINT)("Blobs: s3 has exactly the port's methods", () =>
  surface(s3Blobs({ endpoint: E.S3_ENDPOINT, bucket: E.S3_BUCKET, region: E.S3_REGION ?? "us-east-1", accessKeyId: E.S3_ACCESS_KEY_ID, secretAccessKey: E.S3_SECRET_ACCESS_KEY }), BLOBS_METHODS, []));

test("no adapter-only member leaks into core: only adapters, composition roots and tests name them", () => {
  const used = [...new Set([...STORE_EXTRAS, ...REGISTRY_EXTRAS].filter(m => m !== "settings" && m !== "linkUsesFor"))];   // `settings` is too common a word, and `linkUsesFor` is the port's optional batch read that core feature-detects; the others are distinctive
  const hits = [], files = listFiles(["server", "packages"]);
  expect(files.length).toBeGreaterThan(20);
  for (const f of files) {
    if (/^server\/(store|registry|bus|blobs|pg)\//.test(f) || f === "server/main.js") continue;
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of used) if (new RegExp(`\\.${m}\\(`).test(text)) hits.push(`${f}: .${m}(`);
  }
  expect(hits).toEqual([]);
});
