// The Bus port's contract (PROTOCOL.md § Bus), as tests any adapter must pass: memory.js and nats.js.
// busContract(label, makeBus) registers the tests; makeBus({ onError }) returns a bus (or a promise of one).
// Delivery is awaited with `until`, not with flush alone, so a network bus passes on the same tests; `quiet()`
// (flush, then a short wait) is how a test says "and nothing else arrived".
import { test, expect, afterAll } from "bun:test";
import { subjects } from "../../server/bus/memory.js";
import { until, sleep } from "./helpers.js";

/** A fresh, valid tenant id per run, so runs sharing one NATS server can't hear each other. */
export const runTenant = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * @param {string} label
 * @param {(o?: { onError?: Function }) => any} makeBus
 * @param {{ skip?: boolean }} [o]
 */
export function busContract(label, makeBus, { skip = false } = {}) {
  const t = skip ? test.skip : test;
  const tenant = runTenant();
  const open = [];
  const make = async o => { const b = await makeBus(o); open.push(b); return b; };
  const quiet = async bus => { await bus.flush(); await sleep(50); await bus.flush(); };
  afterAll(async () => { for (const b of open.splice(0)) await b.close(); });

  t(`${label}: delivers to that subject's subscribers only, in publish order, asynchronously`, async () => {
    const bus = await make(), got = [];
    bus.subscribe(subjects.entries(tenant, "b-1"), m => got.push(["a1.entries", m]));
    bus.subscribe(subjects.entries(tenant, "b-1"), m => got.push(["a1.entries#2", m]));
    bus.subscribe(subjects.presence(tenant, "b-1"), m => got.push(["a1.presence", m]));
    bus.subscribe(subjects.entries(tenant, "b-2"), m => got.push(["a2.entries", m]));
    bus.subscribe(subjects.entries(`${tenant}-x`, "b-1"), m => got.push(["b1.entries", m]));
    bus.publish(subjects.entries(tenant, "b-1"), 1);
    bus.publish(subjects.presence(tenant, "b-1"), 2);
    bus.publish(subjects.entries(tenant, "b-1"), 3);
    bus.publish(subjects.inbox(tenant, "b-1"), 4);              // nobody listens
    expect(got).toEqual([]);                                    // not re-entrant
    await until(() => got.length >= 5, "five deliveries");
    await quiet(bus);
    // Per subject, publish order; each message goes to every local subscriber before the next one.
    expect(got.filter(g => g[0] !== "a1.presence")).toEqual([["a1.entries", 1], ["a1.entries#2", 1], ["a1.entries", 3], ["a1.entries#2", 3]]);
    expect(got.filter(g => g[0] === "a1.presence")).toEqual([["a1.presence", 2]]);
    expect(got.length).toBe(5);
  });

  t(`${label}: at-most-once: nothing is kept for a later subscriber; unsubscribe stops delivery`, async () => {
    const bus = await make(), got = [], s = subjects.inbox(tenant, "b-amo");
    await bus.publish(s, "early"); await quiet(bus);
    const off = bus.subscribe(s, m => got.push(m));
    expect(bus.subscriberCount(s)).toBe(1);
    await bus.flush();
    await bus.publish(s, "one");
    await until(() => got.length === 1, "one");
    off(); off();
    expect(bus.subscriberCount(s)).toBe(0);
    await bus.publish(s, "two"); await quiet(bus);
    expect(got).toEqual(["one"]);
  });

  t(`${label}: unsubscribing one handler leaves the others on that subject`, async () => {
    const bus = await make(), got = [], s = subjects.emotes(tenant, "b-unsub");
    const offA = bus.subscribe(s, m => got.push(["a", m]));
    bus.subscribe(s, m => got.push(["b", m]));
    await bus.flush();
    offA();
    expect(bus.subscriberCount(s)).toBe(1);
    await bus.publish(s, 1);
    await until(() => got.length === 1, "b gets 1");
    await quiet(bus);
    expect(got).toEqual([["b", 1]]);
  });

  t(`${label}: a subscriber that throws or rejects doesn't stop the others or later messages`, async () => {
    const errors = [], bus = await make({ onError: (e, s) => errors.push([e.message, s]) }), got = [], s = subjects.entries(tenant, "b-throw");
    bus.subscribe(s, m => { if (m === 1) throw new Error("boom"); got.push(["x", m]); });
    bus.subscribe(s, async m => { if (m === 2) throw new Error("async boom"); got.push(["y", m]); });
    for (const m of [1, 2, 3]) bus.publish(s, m);
    await until(() => got.length === 4 && errors.length === 2, "deliveries and errors");
    expect(got).toEqual([["y", 1], ["x", 2], ["x", 3], ["y", 3]]);
    expect(errors).toEqual([["boom", s], ["async boom", s]]);
  });

  t(`${label}: messages published from inside a handler arrive after the current ones, in order`, async () => {
    const bus = await make(), got = [];
    const a = subjects.inbox(tenant, "b-nest-a"), b = subjects.inbox(tenant, "b-nest-b");
    bus.subscribe(a, m => { got.push(`a${m}`); if (m < 3) bus.publish(b, m); });
    bus.subscribe(b, m => got.push(`b${m}`));
    bus.publish(a, 1); bus.publish(a, 2); bus.publish(a, 3);
    await until(() => got.length === 5, "five");
    expect(got.filter(x => x[0] === "a")).toEqual(["a1", "a2", "a3"]);
    expect(got.filter(x => x[0] === "b")).toEqual(["b1", "b2"]);
    expect(got.indexOf("b1")).toBeGreaterThan(got.indexOf("a1"));
  });

  t(`${label}: plain data arrives equal, including a top-level byte field`, async () => {
    const bus = await make(), got = [], s = subjects.gateway(tenant, "b-1", `${tenant}-gw`);
    bus.subscribe(s, m => got.push(m));
    await bus.flush();
    const msgs = [
      { conn: "c-1", data: '{"t":"welcome","seq":3}', close: 1008 },
      { n: 1, conn: "c", gateway: "g", user: "u", name: "Zoë ✏️ \u0000 \"quoted\"", role: "editor", client: "k", msg: { t: "op", id: "a:1", op: { elements: [{ id: "e", x: 1.5, y: -2, tags: [null, true, "s"] }] } } },
      { conn: "c-2", data: new Uint8Array([0, 1, 2, 250, 255]) },
      "a bare string", 42, null, [1, [2, { three: 3 }]],
    ];
    for (const m of msgs) bus.publish(s, m);
    await until(() => got.length === msgs.length, "all");
    expect(got).toEqual(msgs);
    expect(got[2].data).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(got[2].data)).toBe(false);                // a plain array, not a view of a client buffer
  });

  t(`${label}: after close, publish resolves and delivers nothing`, async () => {
    const bus = await make(), got = [], s = subjects.presence(tenant, "b-close");
    bus.subscribe(s, m => got.push(m));
    await bus.flush();
    await bus.close();
    await bus.publish(s, "late");
    await sleep(50);
    expect(got).toEqual([]);
  });
}
