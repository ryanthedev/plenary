// The HTTP request deadline at the composition root (PROTOCOL.md "HTTP request deadline"): PLENARY_REQUEST_DEADLINE_MS, the inner limits
// that must stay under it (checked at start-up), what main.js hands the adapters, and the deadline stats on /health.
import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { start, checkInnerLimits, nodeConfig, REGISTRY_LIMIT_MS, OIDC_TIMEOUT_MS, SQLITE_BUSY_MS } from "../../server/main.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { tempDir, cleanup } from "./helpers.js";

setDefaultTimeout(30_000);
afterAll(cleanup);

const base = () => ({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "error" });
const cluster = () => ({ ...base(), DATABASE_URL: "postgres://u:pw@127.0.0.1:1/p", NATS_URL: "nats://127.0.0.1:1", COOKIE_KEY: "k".repeat(32), PLENARY_BLOBS: "local-disk" });

test("the inner limits main.js sets are 5000 ms (Registry) and 3500 ms (Google), under the 8000 ms default", () => {
  expect([REGISTRY_LIMIT_MS, OIDC_TIMEOUT_MS]).toEqual([5000, 3500]);
  expect(nodeConfig(base()).requestDeadlineMs).toBe(8000);
  expect(nodeConfig({ ...base(), PLENARY_REQUEST_DEADLINE_MS: " 6000 " }).requestDeadlineMs).toBe(6000);
});

test("PLENARY_REQUEST_DEADLINE_MS: a whole number of ms, at least 1; anything else refuses the start", () => {
  for (const bad of ["", "abc", "0", "-5", "1.5", "99999999999", "8e3"])
    expect(() => nodeConfig({ ...base(), PLENARY_REQUEST_DEADLINE_MS: bad })).toThrow(/PLENARY_REQUEST_DEADLINE_MS must be a whole number/);
});

test("start-up refuses a deadline that is not above an inner limit, naming the setting and the limit", () => {
  expect(() => nodeConfig({ ...cluster(), PLENARY_REQUEST_DEADLINE_MS: "5000" })).toThrow(/PLENARY_REQUEST_DEADLINE_MS \(5000 ms\) must be above the Postgres Registry's statement and lock limits \(5000 ms\)/);
  expect(() => nodeConfig({ ...cluster(), PLENARY_REQUEST_DEADLINE_MS: "5001" })).not.toThrow();
  expect(() => nodeConfig({ ...base(), GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", PLENARY_REQUEST_DEADLINE_MS: "3500" })).toThrow(/the SQLite Registry's busy timeout \(5000 ms\)|Google's request timeout \(3500 ms\)/);   // both name a limit not under 3500
  expect(() => nodeConfig({ ...base(), GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", PLENARY_REQUEST_DEADLINE_MS: "5001" })).not.toThrow();
  // L2: a single node's SQLite registry waits up to 5000 ms for a lock, so it is held to the deadline too
  expect(SQLITE_BUSY_MS).toBe(5000);
  expect(() => nodeConfig({ ...base(), PLENARY_REQUEST_DEADLINE_MS: "5000" })).toThrow(/the SQLite Registry's busy timeout \(5000 ms\)/);
  expect(() => nodeConfig({ ...base(), PLENARY_REQUEST_DEADLINE_MS: "5001" })).not.toThrow();
  expect(() => checkInnerLimits(3500, { "Google's request timeout": OIDC_TIMEOUT_MS })).toThrow(/Google's request timeout \(3500 ms\)/);
  expect(() => checkInnerLimits(10, { a: 9, b: 10 })).toThrow(/\(10 ms\) must be above b \(10 ms\)/);
});

test("a cluster start passes 5000 ms statement and lock limits to the Postgres Registry; /health shows the deadline stats", async () => {
  const seen = {};
  const adapters = {
    postgresStore: async () => ({ ...sqliteStore({ path: join(tempDir(), "p.db") }), clusterId: async () => "c-0123456789abcdef" }),
    postgresRegistry: async o => { seen.registry = o; return sqliteRegistry({ path: join(tempDir(), "r.db") }); },
    natsBus: async o => memoryBus({ onError: o.onError, cluster: o.cluster }),
  };
  const app = await start({ ...cluster(), PLENARY_REQUEST_DEADLINE_MS: "7000" }, { adapters, write: () => {} }).catch(e => e);
  try {
    expect(app instanceof Error ? app.message : "").toBe("");
    expect(seen.registry).toMatchObject({ statementTimeoutMs: 5000, lockTimeoutMs: 5000 });
    const h = await (await fetch(app.server.url + "/health")).json();
    expect(h.http).toEqual({ deadlineMs: 7000, deadline: {}, late: { applied: 0, failed: 0 } });
  } finally { await app?.stop?.(); }
});

test("L1: a cluster start refuses when the Registry's longest call (queue wait + limit + 1 s backstop, from gate()) is not under the deadline, and closes what opened", async () => {
  const closed = [];
  const mk = queueTimeoutMs => ({
    postgresStore: async () => { const st = sqliteStore({ path: join(tempDir(), "p.db") }); return { ...st, clusterId: async () => "c-0123456789abcdef", close: async () => { closed.push("store"); await st.close(); } }; },
    postgresRegistry: async () => { const r = sqliteRegistry({ path: join(tempDir(), "r.db") }); return { ...r, gate: () => ({ queueTimeoutMs }), close: async () => { closed.push("registry"); await r.close(); } }; },
    natsBus: async o => memoryBus({ onError: o.onError, cluster: o.cluster }),
  });
  const err = await start({ ...cluster(), PLENARY_REQUEST_DEADLINE_MS: "8000" }, { adapters: mk(3050), write: () => {} }).catch(e => e);   // 3050 + 5000 + 1000 = 9050
  expect(err.message).toMatch(/PLENARY_REQUEST_DEADLINE_MS \(8000 ms\) must be above the Postgres Registry's longest call .* \(9050 ms\)/);
  expect(closed.sort()).toEqual(["registry", "store"]);
  const ok = await start({ ...cluster(), PLENARY_REQUEST_DEADLINE_MS: "8000" }, { adapters: mk(1050), write: () => {} });   // the adapter's own default: 7050
  await ok.stop();
});
