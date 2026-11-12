// Role gating and pacing of everything the collab UI sends, checked against packages/protocol's own rules.
import { test, expect } from "bun:test";
import { createOutbox, mayPresence, recordProblem } from "../../../web/core/collab/gate.js";
import { createFakePort } from "../../../web/adapters/collab/fake.js";
import { presenceProblem, presenceLimiter, PRESENCE, EMOTES } from "../../../packages/protocol/presence.js";
import { ROLES, canWrite } from "../../../packages/protocol/envelope.js";
import { Records } from "../../../packages/protocol/records.js";
import { fakeClock } from "./clock.js";

const drive = (role, status = "live") => {
  const clock = fakeClock(), port = createFakePort({ role, status, now: clock.now });
  return { clock, port, out: createOutbox(port, clock) };
};
const sendAll = out => [out.cursor(1, 2), out.select("board", ["a", "b"]), out.laser(3, 4), out.emote("🎉")];

test("every role sends only what the protocol's role table allows, and every message passes presenceProblem", () => {
  for (const role of ROLES) {
    const { clock, port, out } = drive(role);
    sendAll(out); clock.advance(1000);
    const kinds = port.sent.map(m => m.k).sort();
    const allowed = ["cursor", "select", "laser", "emote"].filter(k => PRESENCE[k].roles.includes(role)).sort();
    expect(`${role}: ${kinds}`).toBe(`${role}: ${allowed}`);
    for (const k of ["cursor", "select", "laser", "emote", "preview", "bogus"]) expect(mayPresence(role, k)).toBe(Object.hasOwn(PRESENCE, k) && PRESENCE[k].roles.includes(role));
    for (const { at, ...m } of port.sent) expect(presenceProblem(m, role)).toBeNull();
  }
});

test("viewers send emotes only; commenters send cursor and select but no laser", () => {
  const v = drive("viewer"); sendAll(v.out); v.clock.advance(500);
  expect(v.port.sent.map(m => m.k)).toEqual(["emote"]);
  const c = drive("commenter"); sendAll(c.out); c.clock.advance(500);
  expect(c.port.sent.map(m => m.k).sort()).toEqual(["cursor", "emote", "select"]);
});

test("nothing is sent while not live, and nothing stale goes out later", () => {
  const { clock, port, out } = drive("editor", "connecting");
  expect(sendAll(out)).toEqual([false, false, false, false]);
  clock.advance(20_000);
  expect(port.sent).toEqual([]);
  port.setStatus("live");
  out.cursor(1, 1); out.cursor(2, 2);    // the second waits for the gap
  port.setStatus("connecting");
  clock.advance(1000);
  expect(port.sent.map(m => [m.x, m.y])).toEqual([[1, 1]]);
});

test("rates: a storm of input never trips the protocol's limiter, and the latest always lands", () => {
  const { clock, port, out } = drive("owner");
  const limiter = presenceLimiter(clock.now), passed = [];
  const send = port.send;
  port.send = (k, f) => { if (limiter.allow(k)) passed.push(k); else passed.push(`DROPPED ${k}`); send(k, f); };
  for (let i = 0; i < 2000; i++) {           // 2 s of 1 kHz pointer input
    out.cursor(i, i); if (i % 3 === 0) out.select("board", [`e${i}`]); out.laser(i, -i); out.emote(EMOTES[i % 8]);
    clock.advance(1);
  }
  clock.advance(1000);
  expect(passed.filter(k => k.startsWith("DROPPED"))).toEqual([]);
  const count = k => port.sent.filter(m => m.k === k).length;
  expect(count("cursor")).toBeLessThanOrEqual(20 * 3 + 1);
  expect(count("cursor")).toBeGreaterThanOrEqual(20 * 2 - 1);
  expect(count("select")).toBeLessThanOrEqual(5 * 3 + 1);
  expect(count("laser")).toBeLessThanOrEqual(30 * 3 + 1);
  expect(count("emote")).toBeLessThanOrEqual(4 * 3 + 1);
  const lastCursor = port.sent.filter(m => m.k === "cursor").at(-1);
  expect([lastCursor.x, lastCursor.y]).toEqual([1999, 1999]);
  expect(port.sent.filter(m => m.k === "select").at(-1).ids).toEqual(["e1998"]);
  // Every laser point made it, in order, in batches of at most 64.
  const pts = port.sent.filter(m => m.k === "laser").flatMap(m => (expect(m.pts.length).toBeLessThanOrEqual(64), m.pts));
  expect(pts.map(p => p[0])).toEqual([...Array(2000).keys()]);
});

test("laser: more than 64 points between sends keeps the newest 64", () => {
  const { clock, port, out } = drive("editor");
  out.laser(0, 0);                       // sent at once
  for (let i = 1; i <= 100; i++) out.laser(i, i);
  clock.advance(100);
  const second = port.sent.filter(m => m.k === "laser")[1];
  expect(second.pts.length).toBe(64);
  expect(second.pts[0][0]).toBe(37); expect(second.pts.at(-1)[0]).toBe(100);
});

test("cursor and selection repeat every 10 s while live, so receivers don't expire a still user", () => {
  const { clock, port, out } = drive("annotator");
  out.cursor(5, 6); out.select("notes", ["n1"]);
  clock.advance(35_000);
  const times = k => port.sent.filter(m => m.k === k).map(m => m.at - port.sent[0].at);
  expect(times("cursor")).toEqual([0, 10_000, 20_000, 30_000]);
  expect(times("select").length).toBe(4);
  for (const { at, ...m } of port.sent) expect(presenceProblem(m, "annotator")).toBeNull();
  port.setStatus("connecting"); clock.advance(30_000);
  expect(times("cursor").length).toBe(4);
  out.close(); expect(clock.pending).toBe(0);
});

test("select holds at most 500 ids, valid ones only", () => {
  const { port, out } = drive("editor");
  out.select("board", [...Array(700).keys()].map(i => `e${i}`).concat(["", "x".repeat(65)]));
  expect(port.sent[0].ids.length).toBe(500);
  expect(out.select("records", ["a"])).toBe(false);
});

// ── records ──
const seed = () => {
  const r = new Records();
  r.apply({ do: "thread", id: "t1", anchor: { point: { x: 1, y: 2 } }, text: "first" }, "ann", 1, "Ann");
  r.apply({ do: "reply", id: "c2", thread: "t1", text: "second" }, "bob", 2, "Bob");
  return r;
};
const OPS = [
  { do: "thread", id: "t9", anchor: { point: { x: 0, y: 0 } }, text: "hi" },
  { do: "thread", id: "t9", anchor: { stream: "board", element: "e1", x: 1, y: 1 }, text: "hi" },
  { do: "thread", id: "t1", anchor: { point: { x: 0, y: 0 } }, text: "reused" },
  { do: "reply", id: "c3", thread: "t1", text: "yo" },
  { do: "reply", id: "c3", thread: "nope", text: "yo" },
  { do: "reply", id: "c2", thread: "t1", text: "reused" },
  { do: "resolve", id: "t1" }, { do: "reopen", id: "t1" }, { do: "resolve", id: "nope" },
  { do: "react", id: "c2", emoji: "👍", on: true }, { do: "react", id: "c2", emoji: "👍", on: false }, { do: "react", id: "zz", emoji: "👍", on: true },
  { do: "delete", id: "c2" }, { do: "delete", id: "t1" }, { do: "delete", id: "zz" },
];

test("record gating agrees with the room (canWrite, then Records.check) for every role and action", () => {
  for (const role of ROLES) for (const me of ["ann", "bob", "cat"]) for (const op of OPS) {
    const r = seed(), threads = r.toJSON().threads;
    const room = !canWrite(role, "records") ? { code: "forbidden" } : r.check(op, me, role);
    const mine = recordProblem(role, me, op, threads);
    expect(`${role} ${me} ${JSON.stringify(op)} → ${mine?.code ?? "ok"}`).toBe(`${role} ${me} ${JSON.stringify(op)} → ${room?.code ?? "ok"}`);
  }
});

test("record caps are refused before sending: empty or long text, long emoji, too many emoji", () => {
  const threads = seed().toJSON().threads;
  expect(recordProblem("editor", "me", { do: "reply", id: "c9", thread: "t1", text: "   " }, threads)?.message).toBe("write something first");
  expect(recordProblem("editor", "me", { do: "reply", id: "c9", thread: "t1", text: "x".repeat(10_001) }, threads)?.code).toBe("limit");
  expect(recordProblem("editor", "me", { do: "reply", id: "c9", thread: "t1", text: "x".repeat(10_000) }, threads)).toBeNull();
  expect(recordProblem("editor", "me", { do: "react", id: "c2", emoji: "x".repeat(33), on: true }, threads)?.code).toBe("bad-op");
  expect(recordProblem("editor", "me", { do: "thread", id: "x".repeat(65), anchor: { point: { x: 0, y: 0 } }, text: "a" }, threads)?.code).toBe("bad-op");
  const full = seed();
  for (let i = 0; i < 20; i++) full.apply({ do: "react", id: "c2", emoji: `e${i}`, on: true }, "ann", 3);
  const ft = full.toJSON().threads;
  expect(recordProblem("editor", "me", { do: "react", id: "c2", emoji: "new", on: true }, ft)?.code).toBe(full.check({ do: "react", id: "c2", emoji: "new", on: true }, "me", "editor").code);
  expect(recordProblem("editor", "me", { do: "react", id: "c2", emoji: "e3", on: true }, ft)).toBeNull();
});

test("the 10 s repeat counts from each kind's own last send: a move mid-interval never leaves a gap over 10 s", () => {
  const { clock, port, out } = drive("editor");
  out.cursor(1, 1); out.select("board", ["a"]);
  clock.advance(5_000); out.cursor(2, 2);
  clock.advance(7_000); out.select("board", ["b"]);
  clock.advance(40_000);
  for (const k of ["cursor", "select"]) {
    const at = port.sent.filter(m => m.k === k).map(m => m.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThanOrEqual(10_000);
    expect(at.length).toBeGreaterThanOrEqual(4);
  }
  expect(port.sent.filter(m => m.k === "cursor").at(-1)).toMatchObject({ x: 2, y: 2 });
});

test("after a reconnect, my last cursor and selection go out again without my moving", () => {
  const { clock, port, out } = drive("annotator");
  out.cursor(4, 4); out.select("notes", ["n"]);
  port.setStatus("connecting"); out.reset(); clock.advance(60_000);
  const before = port.sent.length;
  port.setStatus("live"); out.resume(); clock.advance(100);
  expect(port.sent.slice(before).map(m => m.k).sort()).toEqual(["cursor", "select"]);
  expect(port.sent.slice(before).find(m => m.k === "cursor")).toMatchObject({ x: 4, y: 4 });
});
