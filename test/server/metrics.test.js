// /metrics (#69, PROTOCOL.md § Metrics): the Prometheus adapter, the access guard, the Store decorator and a live node's numbers.
// Rates and lag use injected clocks; nothing here generates load.
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { prometheusMetrics, MAX_SERIES } from "../../server/metrics/prometheus.js";
import { noopMetrics } from "../../server/metrics/port.js";
import { metricsRoute } from "../../server/metrics-http.js";
import { instrumentedStore } from "../../server/instrument.js";
import { STORE_METHODS } from "../../server/store/port.js";
import { start } from "../../server/main.js";
import { rig, settled, sock } from "./rig.js";
import { cleanup, tempDir, until } from "./helpers.js";
import { makeElement } from "../../packages/core/model.js";

afterAll(cleanup);
const TOKEN = "metrics-token-0123456789abcdef";
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const get = (url, token, init = {}) => fetch(url + "/metrics", { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });
/** The value of one series line, e.g. `plenary_ops_total` or `plenary_lease_changes_total{event="acquired"}`; undefined when absent. */
const value = (text, series) => { const l = text.split("\n").find(x => x.startsWith(series + " ")); return l === undefined ? undefined : Number(l.slice(series.length + 1)); };

// ---- the adapter ----

test("prometheus: counters, labels, gauges and histograms render in the text format", () => {
  const m = prometheusMetrics();
  const c = m.counter("t_total", "A counter.", ["kind"]);
  c.inc(1, { kind: "a" }); c.inc(2, { kind: "a" }); c.inc(1, { kind: "b" });
  const plain = m.counter("t_plain_total", "Plain.");
  m.gauge("t_gauge", "A gauge.", () => 7);
  const h = m.histogram("t_seconds", "A histogram.", { buckets: [0.1, 1] });
  h.observe(0.05); h.observe(0.5); h.observe(5);
  expect(m.render()).toBe([
    "# HELP t_total A counter.", "# TYPE t_total counter", 't_total{kind="a"} 3', 't_total{kind="b"} 1',
    "# HELP t_plain_total Plain.", "# TYPE t_plain_total counter", "t_plain_total 0",
    "# HELP t_gauge A gauge.", "# TYPE t_gauge gauge", "t_gauge 7",
    "# HELP t_seconds A histogram.", "# TYPE t_seconds histogram",
    't_seconds_bucket{le="0.1"} 1', 't_seconds_bucket{le="1"} 2', 't_seconds_bucket{le="+Inf"} 3', "t_seconds_sum 5.55", "t_seconds_count 3", ""].join("\n"));
  plain.inc(); expect(value(m.render(), "t_plain_total")).toBe(1);
});

test("prometheus: label values are escaped; a labelled histogram carries its labels and le", () => {
  const m = prometheusMetrics();
  m.counter("e_total", "x", ["v"]).inc(1, { v: 'a"b\\c\nd' });
  m.histogram("l_seconds", "x", { buckets: [1], labelNames: ["op"] }).observe(0.5, { op: "read" });
  const t = m.render();
  expect(t).toContain('e_total{v="a\\"b\\\\c\\nd"} 1');
  expect(t).toContain('l_seconds_bucket{op="read",le="1"} 1');
  expect(t).toContain('l_seconds_count{op="read"} 1');
});

test("prometheus: never throws or blocks: bad values, unknown labels, type clashes, a throwing gauge and a runaway label are dropped", () => {
  const m = prometheusMetrics();
  const c = m.counter("d_total", "x", ["k"]);
  for (const bad of [NaN, -1, Infinity, "x", null]) c.inc(bad, { k: "a" });
  c.inc(1);                       // label missing
  c.inc(1, { other: "a" });       // label unknown
  c.inc(1, null);
  expect(m.render()).not.toContain("d_total{");
  expect(m.histogram("d_total", "clash")).toBe(noopMetrics.histogram());   // same name, another type
  m.histogram("d_total", "clash").observe(1);
  expect(m.counter("bad name", "x")).toBe(noopMetrics.counter());
  m.counter("bad name", "x").inc();
  m.gauge("boom", "x", () => { throw new Error("no"); });
  m.gauge("nan", "x", () => NaN);
  const h = m.histogram("d_seconds", "x");
  h.observe(NaN); h.observe(undefined); h.observe(Infinity);
  const t = m.render();
  expect(t).not.toMatch(/^boom |^nan /m);
  expect(value(t, "d_seconds_count")).toBe(0);
  // series cap: a label that was meant to be bounded cannot grow without limit
  for (let i = 0; i < MAX_SERIES + 50; i++) c.inc(1, { k: "v" + i });
  expect(m.render().split("\n").filter(l => l.startsWith("d_total{")).length).toBe(MAX_SERIES);
});

test("prometheus: registering a counter or histogram again returns the same instrument's series; a gauge's reader is replaced", () => {
  const m = prometheusMetrics();
  m.counter("r_total", "x").inc(); m.counter("r_total", "x").inc(2);
  expect(value(m.render(), "r_total")).toBe(3);
  m.gauge("r_gauge", "x", () => 1); m.gauge("r_gauge", "x", () => 2);
  expect(value(m.render(), "r_gauge")).toBe(2);
});

// ---- the access guard (the route is an adapter; the guard is the security surface) ----

const req = (token, method = "GET") => new Request("http://x/metrics", { method, headers: token === undefined ? {} : { authorization: token } });

test("route: disabled is a plain 404 whatever the request carries", async () => {
  for (const o of [undefined, null, {}, { token: "" }, { token: TOKEN }, { render: () => "x" }]) {
    const res = await metricsRoute(o).handle(req(`Bearer ${TOKEN}`));
    expect([res.status, await res.json()]).toEqual([404, { error: "not-found" }]);
  }
});

test("route: only the exact bearer token gets the text; everything else is 401 with no body of metrics", async () => {
  const route = metricsRoute({ token: TOKEN, render: () => "plenary_x 1\n" });
  const ok = await route.handle(req(`Bearer ${TOKEN}`));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.text()).toBe("plenary_x 1\n");
  for (const bad of [undefined, "", "Bearer", "Bearer ", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, `Basic ${TOKEN}`, TOKEN, "Bearer " + "x".repeat(10_000)]) {
    const res = await route.handle(req(bad));
    expect([bad, res.status, res.headers.get("www-authenticate")]).toEqual([bad, 401, "Bearer"]);
    expect(await res.text()).not.toContain("plenary_x");
  }
});

test("route: a right token with another method is 405; a failing render is a 500 without its message", async () => {
  expect((await metricsRoute({ token: TOKEN, render: () => "" }).handle(req(`Bearer ${TOKEN}`, "POST"))).status).toBe(405);
  expect((await metricsRoute({ token: TOKEN, render: () => "" }).handle(req("nope", "POST"))).status).toBe(401);   // auth first
  const res = await metricsRoute({ token: TOKEN, render: () => { throw new Error("secret detail"); } }).handle(req(`Bearer ${TOKEN}`));
  expect([res.status, await res.text()]).toEqual([500, '{"error":"internal"}']);
});

// ---- store latency ----

/** A fake Store whose every method answers `plan[op]` (a value, or an Error to reject with, or a function). */
const fakeStore = (plan = {}) => Object.fromEntries([...STORE_METHODS.map(op => [op, async (...a) => { const r = plan[op]; if (r instanceof Error) throw r; return typeof r === "function" ? r(...a) : r ?? op; }]), ["pragmas", () => "adapter-only"]]);

test("instrumentedStore: times each call on the injected clock, counts rejections, and changes nothing else", async () => {
  const m = prometheusMetrics();
  let t = 0;
  const calls = [];
  const s = instrumentedStore(fakeStore({ lastSeq: async () => { t += 30; return 5; }, read: () => { t += 2000; throw new Error("db down"); }, append: (...a) => { calls.push(a); t += 4; } }), m, () => t);
  expect(await s.lastSeq("t", "b")).toBe(5);
  await s.append("t", "b", [1], 0, 1);
  expect(calls).toEqual([["t", "b", [1], 0, 1]]);
  await expect(s.read("t", "b")).rejects.toThrow("db down");
  expect(s.pragmas()).toBe("adapter-only");
  const txt = m.render();
  expect(value(txt, 'plenary_store_seconds_count{op="lastSeq"}')).toBe(1);
  expect(value(txt, 'plenary_store_seconds_bucket{op="lastSeq",le="0.025"}')).toBe(0);
  expect(value(txt, 'plenary_store_seconds_bucket{op="lastSeq",le="0.05"}')).toBe(1);   // 30 ms
  expect(value(txt, 'plenary_store_seconds_bucket{op="append",le="0.005"}')).toBe(1);   // 4 ms
  expect(value(txt, 'plenary_store_seconds_bucket{op="read",le="1"}')).toBe(0);
  expect(value(txt, 'plenary_store_seconds_bucket{op="read",le="2.5"}')).toBe(1);       // a rejected call is still timed
  expect(value(txt, 'plenary_store_errors_total{op="read"}')).toBe(1);
  expect(txt).not.toContain('plenary_store_errors_total{op="lastSeq"}');
});

test("instrumentedStore: a synchronous throw is counted and rethrown; close is not timed; the metric names are the port's methods only", async () => {
  const m = prometheusMetrics();
  const s = instrumentedStore({ ...fakeStore(), lease() { throw new Error("sync"); }, close: async () => "closed" }, m, () => 0);
  expect(() => s.lease("t", "b")).toThrow("sync");
  expect(await s.close()).toBe("closed");
  const txt = m.render();
  expect(value(txt, 'plenary_store_errors_total{op="lease"}')).toBe(1);
  expect(txt).not.toContain('op="close"');
});

// ---- a live gateway + host ----

test("a live server records connections, boards hosted, ops, lease changes, store latency and fan-out lag", async () => {
  const m = prometheusMetrics();
  const offset = 2000;   // the gateway's clock runs 2 s ahead of the room's: that is the fan-out lag, exactly (plus a few ms)
  const r = await rig({ server: { metrics: m, metricsEndpoint: { token: TOKEN, render: m.render }, now: () => Date.now() + offset }, wrapStore: s => instrumentedStore(s, m) });
  const [a, b] = ["editor", "viewer"].map(n => r.client(n));
  await a.connect(); await b.connect();
  const before = await (await get(r.server.url, TOKEN)).text();
  expect(value(before, "plenary_ops_total")).toBe(0);
  for (let i = 0; i < 3; i++) a.send("board", { elements: [rect("e" + i, i)] });
  await settled(r, [a, b]);
  const res = await get(r.server.url, TOKEN);
  expect(res.status).toBe(200);
  const t = await res.text();
  expect(value(t, "plenary_connections")).toBe(2);
  expect(value(t, "plenary_boards_hosted")).toBe(1);
  expect(value(t, "plenary_ops_total")).toBe(3);
  expect(value(t, 'plenary_lease_changes_total{event="acquired"}')).toBe(1);
  expect(t).not.toContain('event="lost"');
  expect(value(t, 'plenary_store_seconds_count{op="append"}')).toBeGreaterThanOrEqual(1);
  expect(value(t, 'plenary_store_seconds_count{op="acquire"}')).toBe(1);
  expect(value(t, "plenary_fanout_lag_seconds_count")).toBeGreaterThanOrEqual(1);
  expect(value(t, 'plenary_fanout_lag_seconds_bucket{le="1"}')).toBe(0);                                 // never under the injected 2 s
  expect(value(t, 'plenary_fanout_lag_seconds_bucket{le="10"}')).toBe(value(t, "plenary_fanout_lag_seconds_count"));
  // no per-board / per-user label anywhere
  expect(t).not.toContain(r.ids.board); expect(t).not.toContain("dev:");
  await b.drop();
  await until(async () => value(await (await get(r.server.url, TOKEN)).text(), "plenary_connections") === 1, "the connection gauge to fall");
  await a.drop();
  await r.stop();
});

test("a lease taken from under a room is counted as lost; a clean stop counts a release", async () => {
  const m = prometheusMetrics();
  const r = await rig({ server: { metrics: m } });
  const a = r.client("editor");
  await a.connect();
  a.send("board", { elements: [rect("one")] });
  await settled(r, [a]);
  expect(value(m.render(), 'plenary_lease_changes_total{event="acquired"}')).toBe(1);
  await r.rawStore.openEpoch(r.ids.tenant, r.ids.board);   // another holder takes the board: this host's next write is fenced
  a.send("board", { elements: [rect("two")] });
  await until(() => value(m.render(), 'plenary_lease_changes_total{event="lost"}') === 1, "the lost lease to be counted");
  await a.drop();
  await r.stop();
  const t = m.render();
  expect(value(t, 'plenary_lease_changes_total{event="lost"}')).toBe(1);   // exactly once, never double-counted
  expect(t).not.toContain('event="released"');                            // a lost lease is never released
});

test("a clean stop releases the lease and counts it", async () => {
  const m = prometheusMetrics();
  const r = await rig({ server: { metrics: m } });
  const a = r.client("editor");
  await a.connect();
  a.send("board", { elements: [rect("one")] });
  await settled(r, [a]);
  await a.drop();
  await r.stop();
  expect(value(m.render(), 'plenary_lease_changes_total{event="released"}')).toBe(1);
});

test("a host-only node serves /metrics (it holds the leases) and a node without a token answers 404", async () => {
  const m = prometheusMetrics();
  const r = await rig({ server: { roles: { gateway: false, host: true }, metrics: m, metricsEndpoint: { token: TOKEN, render: m.render } } });
  const res = await get(r.server.url, TOKEN);
  expect(res.status).toBe(200);
  const t = await res.text();
  expect(value(t, "plenary_boards_hosted")).toBe(0);
  expect(t).not.toContain("plenary_connections");   // no gateway here
  expect((await get(r.server.url, "wrong")).status).toBe(401);
  expect((await get(r.server.url)).status).toBe(401);
  await r.stop();
  const off = await rig({ server: { roles: { gateway: false, host: true } } });
  expect((await get(off.server.url, TOKEN)).status).toBe(404);
  const off2 = await rig();
  expect((await get(off2.server.url, TOKEN)).status).toBe(404);
  expect((await get(off2.server.url)).status).toBe(404);
  await off.stop(); await off2.stop();
});

// ---- start(env): the switch ----

test("main start: PLENARY_METRICS_TOKEN turns /metrics on; unset it is 404; a short or blank token refuses the start without echoing it", async () => {
  const dir = tempDir();
  const base = { PLENARY_DATA_DIR: dir, PORT: "0", COOKIE_KEY: "k".repeat(40) };
  const off = await start({ ...base, PLENARY_DATA_DIR: tempDir() }, { write() {} });
  try { expect((await get(off.server.url, TOKEN)).status).toBe(404); } finally { await off.stop(); }
  for (const bad of ["", "short", " ".repeat(8)]) await expect(start({ ...base, PLENARY_METRICS_TOKEN: bad }, { write() {} })).rejects.toThrow(/PLENARY_METRICS_TOKEN must be at least 16 bytes/);
  const on = await start({ ...base, PLENARY_METRICS_TOKEN: TOKEN }, { write() {} });
  try {
    expect((await get(on.server.url)).status).toBe(401);
    const t = await (await get(on.server.url, TOKEN)).text();
    expect(value(t, "plenary_connections")).toBe(0);
    expect(t).toContain("# TYPE plenary_store_seconds histogram");
  } finally { await on.stop(); }
  // main.js wraps the Store: one editor's op through the real wiring shows up as Store latency and an op.
  const live = await start({ ...base, PLENARY_DATA_DIR: tempDir(), PLENARY_METRICS_TOKEN: TOKEN, PLENARY_DEV_TOKENS: JSON.stringify({ "dev-token-ann-0123456789": { name: "ann", role: "editor" } }) }, { write() {} });
  try {
    const ws = await sock(live.server.wsUrl);
    ws.send({ t: "hello", v: 1, token: "dev-token-ann-0123456789", board: live.devBoard, since: 0, client: "a" });
    await ws.next(m => m.t === "welcome");
    ws.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { appState: { grid: 20 }, appBase: { grid: 0 } } });
    await ws.next(m => m.t === "ack");
    const t = await (await get(live.server.url, TOKEN)).text();
    expect(value(t, "plenary_ops_total")).toBe(1);
    expect(value(t, "plenary_connections")).toBe(1);
    expect(value(t, 'plenary_store_seconds_count{op="append"}')).toBeGreaterThanOrEqual(1);
    await ws.close();
  } finally { await live.stop(); }
});

// ---- the docs name every metric ----

test("every metric a running node exposes is named in PROTOCOL.md, with its type, and deploy/README.md names the token variable", async () => {
  const m = prometheusMetrics();
  const r = await rig({ server: { metrics: m, metricsEndpoint: { token: TOKEN, render: m.render } }, wrapStore: s => instrumentedStore(s, m) });
  const text = await (await get(r.server.url, TOKEN)).text();
  const names = [...text.matchAll(/^# TYPE (\S+) (\w+)$/gm)];
  expect(names.map(x => x[1]).sort()).toEqual(["plenary_boards_hosted", "plenary_connections", "plenary_fanout_lag_seconds", "plenary_lease_changes_total", "plenary_ops_total", "plenary_store_errors_total", "plenary_store_seconds"]);
  const doc = readFileSync(new URL("../../PROTOCOL.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("## Metrics (`/metrics`"), doc.indexOf("\n## Ports"));
  for (const [, name, type] of names) expect(section).toMatch(new RegExp("\\| `" + name + "` \\| " + type + " \\|"));
  expect(readFileSync(new URL("../../deploy/README.md", import.meta.url), "utf8")).toContain("PLENARY_METRICS_TOKEN");
  await r.stop();
});
