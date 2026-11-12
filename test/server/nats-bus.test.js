// The NATS Bus (server/bus/nats.js) against the Bus contract, and the contract against memory.js too (so the
// contract itself is known to describe the single-node bus). NATS tests skip when NATS_URL is unset; when it is
// set, a NATS that can't be reached fails them (it never skips).
import { test, expect, afterAll } from "bun:test";
import { memoryBus } from "../../server/bus/memory.js";
import { natsBus, subjects, encodeMessage, decodeMessage, MAX_BUS_BYTES } from "../../server/bus/nats.js";
import { busContract, runTenant } from "./bus-contract.js";
import { until, sleep } from "./helpers.js";

const URL = process.env.NATS_URL;
const nt = URL ? test : test.skip;
const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };

busContract("memory bus", o => memoryBus(o));
busContract("nats bus", o => natsBus({ url: URL, ...o }), { skip: !URL });

// ---- the wire format (no server needed) ----

test("nats wire: plain messages are plain JSON; top-level bytes ride after it, located by the header only", () => {
  const plain = encodeMessage({ conn: "c", data: '{"t":"ack"}' });
  expect(plain.byteFields).toBe(null);
  expect(new TextDecoder().decode(plain.payload)).toBe('{"conn":"c","data":"{\\"t\\":\\"ack\\"}"}');
  const bin = encodeMessage({ conn: "c", data: new Uint8Array([7, 8, 9]), close: 1008 });
  expect(bin.byteFields).toEqual([["data", 3]]);
  expect(decodeMessage(bin.payload, bin.byteFields)).toEqual({ conn: "c", close: 1008, data: new Uint8Array([7, 8, 9]) });
});

test("nats wire: nothing inside a client-authored field turns into bytes", () => {
  // A client can author `msg`, but only our publisher sets the header, so these stay what they are.
  const forged = { n: 1, conn: "c", msg: { t: "op", data: { type: "Buffer", data: [1, 2] }, "Plen-Bytes": '[["x",1]]' } };
  const { payload, byteFields } = encodeMessage(forged);
  expect(byteFields).toBe(null);
  expect(decodeMessage(payload, null)).toEqual(forged);
});

test("nats wire: nested bytes, bare bytes and bigints are refused, not mangled", () => {
  for (const bad of [{ msg: { data: new Uint8Array(1) } }, { list: [new Uint8Array(1)] }, { x: { b: Buffer.from([1]) } }, new Uint8Array(2), { n: 1n }])
    expect(() => encodeMessage(bad)).toThrow();
  // A top-level Buffer is a Uint8Array: it travels as bytes.
  const { payload, byteFields } = encodeMessage({ data: Buffer.from([1, 2]) });
  expect(decodeMessage(payload, byteFields).data).toEqual(new Uint8Array([1, 2]));
});

// ---- NATS only ----

const open = [];
const make = async o => { const b = await natsBus({ url: URL, ...o }); open.push(b); return b; };
afterAll(async () => { for (const b of open.splice(0)) await b.close().catch(() => {}); });
const tenant = runTenant();

nt("nats: re-exports the same subject names", () => {
  expect(subjects.entries("t-a", "b-1")).toBe("plen.t-a.b-1.entries");
  expect(() => subjects.inbox("t-a", "b.*")).toThrow();
});

nt("nats: two connections (two nodes) hear each other; per publisher, in order", async () => {
  const a = await make(), b = await make(), got = [], s = subjects.entries(tenant, "b-x");
  b.subscribe(s, m => got.push(m));
  await b.flush();                                   // b's interest is registered at the server
  for (let i = 0; i < 200; i++) a.publish(s, { seq: i });
  await until(() => got.length === 200, "200 across connections");
  expect(got.map(m => m.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i));
});

nt("nats: flush hands this process's own published messages to its own subscribers", async () => {
  const bus = await make(), got = [], s = subjects.inbox(tenant, "b-flush");
  bus.subscribe(s, m => got.push(m));
  for (let i = 0; i < 500; i++) bus.publish(s, i);
  await bus.flush();
  expect(got.length).toBe(500);
});

nt("nats: a 2 MB message (encoded) travels; one byte more is refused before the wire", async () => {
  const errors = [], a = await make({ onError: (e, s) => errors.push([e.code, s]) }), b = await make(), got = [];
  const s = subjects.inbox(tenant, "b-big");
  b.subscribe(s, m => got.push(m));
  await b.flush();
  const overhead = encodeMessage({ data: "" }).payload.byteLength;   // {"data":""}
  const edge = { data: "x".repeat(MAX_BUS_BYTES - overhead) };
  expect(encodeMessage(edge).payload.byteLength).toBe(MAX_BUS_BYTES);
  await a.publish(s, edge);
  await until(() => got.length === 1, "the 2 MB message");
  expect(got[0].data.length).toBe(edge.data.length);

  const over = { data: "x".repeat(MAX_BUS_BYTES - overhead + 1) };
  expect(await code(a.publish(s, over))).toBe("too-large");
  const binOver = { data: new Uint8Array(MAX_BUS_BYTES) };          // bytes count too, plus the JSON around them
  expect(await code(a.publish(s, binOver))).toBe("too-large");
  // Headers count too: a byte field whose payload alone fits, but not with its Plen-Bytes header, is ours to refuse.
  const binOverhead = encodeMessage({ data: new Uint8Array(0) }).payload.byteLength;
  const justUnder = { data: new Uint8Array(MAX_BUS_BYTES - binOverhead - 4) };
  expect(encodeMessage(justUnder).payload.byteLength).toBeLessThanOrEqual(MAX_BUS_BYTES);
  expect(await code(a.publish(s, justUnder))).toBe("too-large");
  expect(errors).toEqual([["too-large", s], ["too-large", s], ["too-large", s]]);
  // A byte field that fits with its header travels, and arrives as a plain Uint8Array.
  const binFits = { data: new Uint8Array(MAX_BUS_BYTES - binOverhead - 200).fill(7) };
  await a.publish(s, binFits);
  await until(() => got.length === 2, "the binary message");
  expect(got[1].data.byteLength).toBe(binFits.data.byteLength);
  expect(Buffer.isBuffer(got[1].data)).toBe(false);
  await a.flush(); await b.flush(); await sleep(50);
  expect(got.length).toBe(2);
});

nt("nats: a refused publish nobody awaits goes to onError, not to an unhandled rejection", async () => {
  const errors = [], bus = await make({ onError: e => errors.push(e.code) });
  let unhandled = 0; const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  try {
    bus.publish(subjects.inbox(tenant, "b-ff"), { data: "x".repeat(MAX_BUS_BYTES + 1) });   // not awaited
    bus.publish("plen.*.b", 1);                                                            // not awaited
    bus.publish(subjects.inbox(tenant, "b-ff"), { deep: { b: new Uint8Array(1) } });       // not awaited
    await sleep(50);
  } finally { process.off("unhandledRejection", onUnhandled); }
  expect(errors).toEqual(["too-large", "bad-id", "bad-entry"]);
  expect(unhandled).toBe(0);
});

nt("nats: wildcards and malformed subjects are refused on publish and subscribe", async () => {
  const bus = await make();
  for (const bad of ["plen.*.b.entries", "plen.>", "plen..x", ".x", "x.", "a b", "A.b", "", null, 5, "plen.t\n.b"]) {
    expect(await code(bus.publish(bad, 1))).toBe("bad-id");
    expect(() => bus.subscribe(bad, () => {})).toThrow();
  }
  expect(() => bus.subscribe(subjects.gateway("gw-1"), () => {})).not.toThrow();   // plen-gw.<id> today (SEAM p4)
});

nt("nats: a wildcard listener elsewhere would hear us, but our subscribe can't be widened", async () => {
  // Our own subscribe refuses '*', so one tenant's code path can't listen to another's; check that a message for
  // tenant A never reaches a subscriber of tenant B's same board name.
  const bus = await make(), got = [];
  bus.subscribe(subjects.entries(`${tenant}-b`, "b-1"), m => got.push(m));
  await bus.flush();
  await bus.publish(subjects.entries(`${tenant}-a`, "b-1"), "for a");
  await bus.flush(); await sleep(50);
  expect(got).toEqual([]);
});

nt("nats: an unreachable server rejects natsBus (callers decide; nothing hangs)", async () => {
  const t0 = Date.now();
  expect(await code(natsBus({ url: "nats://127.0.0.1:1", connectTimeoutMs: 1000 }))).not.toBe("resolved");
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("nats: natsBus needs a url (never reads env itself)", async () => {
  expect(await code(natsBus({}))).toBe("threw natsBus needs a url");
});

// ---- outages (fix round M2, L7): needs the nats-server binary; starts its own servers and stops them by PID ----

const natsBin = Bun.which("nats-server");
const ot = natsBin ? test : test.skip;
const freePort = () => { const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p; };

ot("nats outage: publishes are refused (unavailable) while down, reported once per outage, nothing replays; max_payload is re-checked on reconnect", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/plen-nats-`), port = freePort();
  const conf = mb => { const f = `${dir}/n${mb}.conf`; writeFileSync(f, `listen: "127.0.0.1:${port}"\nmax_payload: ${mb}MB\n`); return f; };
  const procs = [];
  const start = async mb => {
    const p = Bun.spawn([natsBin, "--config", conf(mb)], { stdout: "ignore", stderr: "ignore" });
    procs.push(p);
    await until(async () => { try { (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end(); return true; } catch { return false; } }, "nats-server up");
    return p;
  };
  const stop = async p => { p.kill("SIGKILL"); await p.exited; };
  try {
    let srv = await start(2);
    const errors = [], url = `nats://127.0.0.1:${port}`;
    const bus = await natsBus({ url, onError: e => errors.push(e.code), reconnectWaitMs: 100 });
    const listener = await natsBus({ url, reconnectWaitMs: 100 });
    open.push(bus, listener);
    const got = [], s = "plen.t-out.b-1.presence";
    listener.subscribe(s, m => got.push(m));
    await listener.flush();
    await bus.publish(s, "before");
    await until(() => got.includes("before"), "before");
    expect(bus.isUp()).toBe(true);

    await stop(srv);
    await until(() => !bus.isUp(), "outage noticed");
    const big = { data: "x".repeat(1024 * 1024) };
    for (let i = 0; i < 50; i++) expect(await code(bus.publish(s, big))).toBe("unavailable");   // 50 MB refused, not buffered
    expect(await code(bus.publish(s, "during"))).toBe("unavailable");
    expect(errors).toEqual(["unavailable"]);                                                    // once per outage

    srv = await start(2);
    await until(() => bus.isUp() && listener.isUp(), "reconnected", 10000);
    await listener.flush();
    await bus.publish(s, "after");
    await until(() => got.includes("after"), "after");
    await bus.flush(); await sleep(100);
    expect(got).toEqual(["before", "after"]);                                                  // nothing from the outage replays

    await stop(srv);                                                                            // a second outage is reported again
    await until(() => errors.length === 2, "second outage reported");
    srv = await start(1);                                                                       // back, but with a 1 MB max_payload
    await until(() => errors.includes("bad-config"), "max_payload re-checked", 10000);
    expect(bus.isUp()).toBe(false);
    expect(await code(bus.publish(s, "small"))).toBe("bad-config");
    expect(errors).toEqual(["unavailable", "unavailable", "bad-config"]);
    await bus.close(); await listener.close();
  } finally {
    for (const p of procs) if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
    await Promise.all(procs.map(p => p.exited));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("nats wire: a foreign header can't name __proto__ (or other prototype keys), and malformed headers are refused", () => {
  const { payload } = encodeMessage({ conn: "c" });
  const withTail = new Uint8Array([...payload, 1, 2]);
  for (const k of ["__proto__", "constructor", "prototype"]) expect(() => decodeMessage(withTail, [[k, 2]])).toThrow();
  for (const bad of [{}, [["data"]], [["data", -1]], [["data", 1.5]], [[5, 2]], "x"]) expect(() => decodeMessage(withTail, bad)).toThrow();
  expect(() => decodeMessage(new Uint8Array([...new TextEncoder().encode("[1]"), 1]), [["data", 1]])).toThrow();
  expect(decodeMessage(withTail, [["data", 2]])).toEqual({ conn: "c", data: new Uint8Array([1, 2]) });
});

// ---- a frozen server (fix round 2, M3): SIGSTOP keeps the TCP connection open, so no `disconnect` comes ----

ot("nats stall: a frozen server (SIGSTOP) caps what is queued, is declared stale by pings, and what was queued is dropped, not replayed", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/plen-nats-`), port = freePort(), conf = `${dir}/n.conf`;
  writeFileSync(conf, `listen: "127.0.0.1:${port}"\nmax_payload: 2MB\n`);
  const srv = Bun.spawn([natsBin, "--config", conf], { stdout: "ignore", stderr: "ignore" });
  let frozen = false;
  try {
    await until(async () => { try { (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end(); return true; } catch { return false; } }, "nats-server up");
    const url = `nats://127.0.0.1:${port}`, errors = [];
    const bus = await natsBus({ url, onError: e => errors.push([e.code, e.message]), pingIntervalMs: 500, maxPingOut: 2, maxPendingBytes: 8 * 1024 * 1024, reconnectWaitMs: 100, connectTimeoutMs: 1000 });
    const listener = await natsBus({ url });
    open.push(bus, listener);
    const got = [], s = "plen.t-stall.b-1.presence";
    listener.subscribe(s, m => got.push(m.k));
    await listener.flush();
    await bus.publish(s, { k: "before" });
    await until(() => got.includes("before"), "before");

    process.kill(srv.pid, "SIGSTOP"); frozen = true;
    const big = "x".repeat(1024 * 1024);
    let accepted = 0, refused = 0;
    for (let i = 0; i < 60; i++) {                     // 60 MB offered while frozen
      (await code(bus.publish(s, { k: `frozen-${i}`, big }))) === "resolved" ? accepted++ : refused++;
      if (i % 10 === 9) await sleep(20);
    }
    expect(accepted).toBeLessThanOrEqual(8);           // the cap: at most 8 MB queued, not 60
    expect(refused).toBe(60 - accepted);
    expect(bus.isUp()).toBe(false);
    expect(errors.map(e => e[0])).toEqual(["unavailable"]);           // congestion, reported once
    await until(() => errors.length === 2, "declared stale by pings", 5000);
    expect(errors[1][0]).toBe("unavailable");
    expect(errors[1][1]).toContain("stale");
    expect(await code(bus.publish(s, { k: "during" }))).toBe("unavailable");

    process.kill(srv.pid, "SIGCONT"); frozen = false;
    await until(() => bus.isUp(), "reconnected after resume", 10000);
    await until(() => listener.isUp(), "listener up", 10000);
    await listener.flush();
    await bus.publish(s, { k: "after" });
    await until(() => got.includes("after"), "after");
    await sleep(200);
    const replayed = got.filter(k => k.startsWith("frozen-")).length;
    // Only what already sat in the frozen server's kernel receive buffer can still arrive (1 in local runs);
    // everything queued in this process was dropped with the socket.
    expect(replayed).toBeLessThan(accepted);
    expect(replayed).toBeLessThanOrEqual(2);
    expect(got).not.toContain("during");
    await bus.close(); await listener.close();
  } finally {
    if (frozen) process.kill(srv.pid, "SIGCONT");
    srv.kill("SIGKILL"); await srv.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 40000);

test("nats: stall settings must be sane", async () => {
  for (const o of [{ pingIntervalMs: 0 }, { maxPingOut: -1 }, { maxPendingBytes: 1024 }, { ackEveryMs: NaN }])
    expect(await code(natsBus({ url: "nats://127.0.0.1:1", ...o }))).toMatch(/^threw natsBus/);
});
