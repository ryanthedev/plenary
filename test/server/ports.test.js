// Blobs (local disk), Bus (in memory) and the logger.
import { test, expect, afterAll } from "bun:test";
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { diskBlobs, imageKind, MAX_BLOB_BYTES } from "../../server/adapters/driven/blobs/disk.js";
import { memoryBus, subjects } from "../../server/adapters/driven/bus/memory.js";
import { createLogger } from "../../server/core/log.js";
import { tempDir, cleanup, fakePng, sha1 } from "./helpers.js";

afterAll(cleanup);
const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };
const filesUnder = dir => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => d.name) : [];

// ---- Blobs ----

test("blobs: put then get returns the bytes; put is idempotent", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const bytes = fakePng(300, 7), h = sha1(bytes);
  expect(await blobs.get("t-a", h)).toBe(null);
  await blobs.put("t-a", h, bytes);
  await blobs.put("t-a", h, bytes);
  expect(await blobs.get("t-a", h)).toEqual(bytes);
  expect(filesUnder(dir)).toEqual([h]);                       // one file, no temp left behind
});

test("blobs: a hash mismatch is refused and nothing is stored", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const bytes = fakePng(100, 1), other = sha1(fakePng(100, 2));
  expect(await code(blobs.put("t-a", other, bytes))).toBe("hash-mismatch");
  expect(await blobs.get("t-a", other)).toBe(null);
  expect(filesUnder(dir)).toEqual([]);
});

test("blobs: the 10 MB cap", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const big = fakePng(MAX_BLOB_BYTES + 1, 3);
  expect(await code(blobs.put("t-a", sha1(big), big))).toBe("too-large");
  const edge = fakePng(MAX_BLOB_BYTES, 4), h = sha1(edge);
  await blobs.put("t-a", h, edge);
  expect((await blobs.get("t-a", h)).byteLength).toBe(MAX_BLOB_BYTES);
  expect(filesUnder(dir)).toEqual([h]);
});

test("blobs: tenants are isolated", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const bytes = fakePng(80, 5), h = sha1(bytes);
  await blobs.put("t-a", h, bytes);
  expect(await blobs.get("t-b", h)).toBe(null);
  await blobs.put("t-b", h, bytes);
  expect(await blobs.get("t-b", h)).toEqual(bytes);
  expect(filesUnder(dir).length).toBe(2);
});

test("blobs: bad tenant ids and bad hashes are refused; nothing escapes the directory", async () => {
  const root = tempDir(), dir = join(root, "blobs"), blobs = diskBlobs({ dir });
  mkdirSync(dir); writeFileSync(join(root, "outside"), "secret");
  const bytes = fakePng(80, 6), h = sha1(bytes);
  for (const t of ["..", "../x", "a/b", "", ".", "t.a", "T-A", "a\0b", null, 5, "x".repeat(65)]) {
    expect(await code(blobs.put(t, h, bytes))).toBe("bad-id");
    expect(await code(blobs.get(t, h))).toBe("bad-id");
  }
  for (const s of ["../outside", "..", "", h.toUpperCase(), h.slice(1), h + "0", "g".repeat(40), `../../${"a".repeat(34)}`, null]) {
    expect(await code(blobs.put("t-a", s, bytes))).toBe("bad-id");
    expect(await code(blobs.get("t-a", s))).toBe("bad-id");
  }
  expect(filesUnder(dir)).toEqual([]);
  expect(readdirSync(root).sort()).toEqual(["blobs", "outside"]);
});

test("blobs: only PNG, JPEG, GIF and WebP; SVG and text are refused", async () => {
  const blobs = diskBlobs({ dir: tempDir() });
  const enc = s => new TextEncoder().encode(s);
  for (const b of [enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), enc("just some text, long enough"), new Uint8Array(0)])
    expect(["not-image", "bad-entry"]).toContain(await code(blobs.put("t-a", sha1(b), b)));
  const pad = head => { const b = new Uint8Array(32); b.set(head); return b; };
  expect(imageKind(fakePng())).toBe("png");
  expect(imageKind(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  expect(imageKind(pad(enc("GIF89a")))).toBe("gif");
  expect(imageKind(pad([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBP")]))).toBe("webp");
  expect(imageKind(pad(enc("RIFF....WAVE")))).toBe(null);
  expect(imageKind(enc("<svg></svg>....."))).toBe(null);
});

test("blobs: a file that isn't under the blob's name yet (a torn temp write) is not a hit", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const bytes = fakePng(90, 8), h = sha1(bytes);
  mkdirSync(join(dir, "t-a", h.slice(0, 2)), { recursive: true });
  writeFileSync(join(dir, "t-a", h.slice(0, 2), ".tmp-1-x-1"), "half");
  expect(await blobs.get("t-a", h)).toBe(null);
  await blobs.put("t-a", h, bytes);
  expect(await blobs.get("t-a", h)).toEqual(bytes);
});

test("blobs: two puts of one hash at once leave one file with the bytes, and no temp file", async () => {
  const dir = tempDir(), blobs = diskBlobs({ dir });
  const bytes = fakePng(5000, 9), h = sha1(bytes);
  await Promise.all(Array.from({ length: 8 }, () => blobs.put("t-a", h, bytes)));
  expect(filesUnder(dir)).toEqual([h]);
  expect(await blobs.get("t-a", h)).toEqual(bytes);
});

// ---- Bus ----

test("bus: subjects are per board and per kind; ids can't widen them", () => {
  expect(subjects.entries("t-a", "b-1")).toBe("plen.t-a.b-1.entries");
  expect(subjects.presence("t-a", "b-1")).toBe("plen.t-a.b-1.presence");
  expect(subjects.inbox("t-a", "b-1")).toBe("plen.t-a.b-1.inbox");
  expect(subjects.emotes("t-a", "b-1")).toBe("plen.t-a.b-1.emotes");
  expect(subjects.gateway("t-a", "b-1", "g-1")).toBe("plen.t-a.b-1.gw.g-1");
  for (const bad of ["*", ">", "a.b", "", "t a", "A", null]) {
    expect(() => subjects.entries(bad, "b-1")).toThrow();
    expect(() => subjects.inbox("t-a", bad)).toThrow();
    expect(() => subjects.gateway(bad, "b-1", "g-1")).toThrow();
    expect(() => subjects.gateway("t-a", bad, "g-1")).toThrow();
    expect(() => subjects.gateway("t-a", "b-1", bad)).toThrow();
  }
});

test("bus: delivers to that subject's subscribers only, in publish order, asynchronously", async () => {
  const bus = memoryBus(), got = [];
  bus.subscribe(subjects.entries("t-a", "b-1"), m => got.push(["a1.entries", m]));
  bus.subscribe(subjects.entries("t-a", "b-1"), m => got.push(["a1.entries#2", m]));
  bus.subscribe(subjects.presence("t-a", "b-1"), m => got.push(["a1.presence", m]));
  bus.subscribe(subjects.entries("t-a", "b-2"), m => got.push(["a2.entries", m]));
  bus.subscribe(subjects.entries("t-b", "b-1"), m => got.push(["b1.entries", m]));
  bus.publish(subjects.entries("t-a", "b-1"), 1);
  bus.publish(subjects.presence("t-a", "b-1"), 2);
  bus.publish(subjects.entries("t-a", "b-1"), 3);
  bus.publish(subjects.inbox("t-a", "b-1"), 4);                 // nobody listens
  expect(got).toEqual([]);                                      // not re-entrant
  await bus.flush();
  expect(got).toEqual([["a1.entries", 1], ["a1.entries#2", 1], ["a1.presence", 2], ["a1.entries", 3], ["a1.entries#2", 3]]);
});

test("bus: at-most-once: nothing is kept for a later subscriber; unsubscribe stops delivery", async () => {
  const bus = memoryBus(), got = [], s = subjects.inbox("t-a", "b-1");
  await bus.publish(s, "early"); await bus.flush();
  const off = bus.subscribe(s, m => got.push(m));
  await bus.publish(s, "one"); await bus.flush();
  off(); off();
  await bus.publish(s, "two"); await bus.flush();
  expect(got).toEqual(["one"]);
  expect(bus.subscriberCount(s)).toBe(0);
});

test("bus: a subscriber that throws or rejects doesn't stop the others or later messages", async () => {
  const errors = [], bus = memoryBus({ onError: (e, s) => errors.push([e.message, s]) }), got = [], s = subjects.entries("t-a", "b-1");
  bus.subscribe(s, m => { if (m === 1) throw new Error("boom"); got.push(["x", m]); });
  bus.subscribe(s, async m => { if (m === 2) throw new Error("async boom"); got.push(["y", m]); });
  for (const m of [1, 2, 3]) bus.publish(s, m);
  await bus.flush(); await Promise.resolve(); await Promise.resolve();
  expect(got).toEqual([["y", 1], ["x", 2], ["x", 3], ["y", 3]]);
  expect(errors).toEqual([["boom", s], ["async boom", s]]);
});

test("bus: messages published from inside a handler arrive after the current ones, in order", async () => {
  const bus = memoryBus(), got = [];
  bus.subscribe("a", m => { got.push(`a${m}`); if (m < 3) bus.publish("b", m); });
  bus.subscribe("b", m => got.push(`b${m}`));
  bus.publish("a", 1); bus.publish("a", 2); bus.publish("a", 3);
  await bus.flush();
  expect(got).toEqual(["a1", "a2", "a3", "b1", "b2"]);
});

// ---- Logs ----

test("logs: one JSON object per line with time, level, msg and fields", () => {
  const lines = [], log = createLogger({ write: l => lines.push(l), now: () => Date.UTC(2026, 10, 11) });
  log.info("server listening", { port: 8080, nested: { a: 1 } });
  log.child({ conn: "c1" }).warn("frame refused", { why: "not-json" });
  log.debug("hidden at info level");
  expect(lines.every(l => l.endsWith("\n") && l.indexOf("\n") === l.length - 1)).toBe(true);
  expect(lines.map(l => JSON.parse(l))).toEqual([
    { port: 8080, nested: { a: 1 }, time: "2026-11-11T00:00:00.000Z", level: "info", msg: "server listening" },
    { conn: "c1", why: "not-json", time: "2026-11-11T00:00:00.000Z", level: "warn", msg: "frame refused" },
  ]);
});

test("logs: credential-looking fields are redacted; errors, bytes and odd values don't break a line", () => {
  const lines = [], log = createLogger({ write: l => lines.push(l) });
  const loop = {}; loop.self = loop;
  const err = Object.assign(new Error("nope"), { code: "conflict" });
  log.error("x", { token: "SECRET-1", hello: { token: "SECRET-2", board: "b" }, Authorization: "SECRET-3", clientSecret: "SECRET-4", err, bytes: new Uint8Array(5), big: 5n, level: "fake", time: "fake" });
  log.error("y", { loop });
  log.error("multi\nline", { s: "a\nb" });
  expect(lines.length).toBe(3);
  expect(lines.join("")).not.toContain("SECRET");
  const first = JSON.parse(lines[0]);
  expect(first.level).toBe("error");                           // a field can't forge level or time
  expect(first.time).not.toBe("fake");
  expect(first.err).toMatchObject({ name: "Error", message: "nope", code: "conflict" });
  expect(first.bytes).toBe("[5 bytes]");
  expect(first.hello).toEqual({ token: "[redacted]", board: "b" });
  expect(JSON.parse(lines[1]).level).toBe("error");
  expect(lines[2].split("\n").length).toBe(2);                 // still one line
});

test("logs: a write that throws doesn't throw into the caller", () => {
  const log = createLogger({ write: () => { throw new Error("EPIPE"); } });
  expect(() => log.info("still fine")).not.toThrow();
});
