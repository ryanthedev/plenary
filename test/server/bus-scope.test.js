// scopeBus (server/bus/port.js, PROTOCOL.md § Bus, Cluster id): the wire subject of a scoped bus is `<cluster>.<subject>`,
// handlers see the subject without it, and two clusters on one bus never hear each other. Memory bus: no server needed;
// the same isolation on a real NATS is test/server/cluster-isolation.test.js.
import { test, expect } from "bun:test";
import { memoryBus } from "../../server/bus/memory.js";
import { subjects, scopeBus } from "../../server/bus/port.js";
import { isClusterId } from "../../server/ids.js";
import { sleep } from "./helpers.js";

const A = "c-aaaaaaaaaaaaaaaa", B = "c-bbbbbbbbbbbbbbbb";
const S = subjects.entries("t-1", "b-1");

test("cluster ids: c- plus 16 of [a-z0-9], nothing else (so none equals an unscoped subject's first token)", () => {
  for (const ok of [A, "c-0123456789abcdef"]) expect(isClusterId(ok)).toBe(true);
  for (const bad of ["plen", "plen-gw", "plen-hosts", "c-short", "c-aaaaaaaaaaaaaaaaa", "C-aaaaaaaaaaaaaaaa", "c-aaaaaaaaaaaaaaa.", "c-aaaaaaaaaaaaaaa*", "", null, 7])
    expect(isClusterId(bad)).toBe(false);
});

test("a scoped bus refuses a bad cluster id", () => {
  const raw = memoryBus();
  for (const bad of ["plen", "c-x", "", undefined, "c-aaaaaaaaaaaaaaa>"]) expect(() => scopeBus(raw, bad)).toThrow(/bad cluster id/);
});

test("DW-iso: the wire subject is <cluster>.<subject>, for publish and subscribe; handlers see the unprefixed subject", async () => {
  const raw = memoryBus(), a = scopeBus(raw, A);
  const wire = [], seen = [];
  raw.subscribe(`${A}.${S}`, (m, subject) => wire.push([m, subject]));
  a.subscribe(S, (m, subject) => seen.push([m, subject]));
  await a.publish(S, { x: 1 });
  await raw.flush();
  expect(wire).toEqual([[{ x: 1 }, `${A}.${S}`]]);
  expect(seen).toEqual([[{ x: 1 }, S]]);
  expect(a.subscriberCount(S)).toBe(2);                      // the raw spy above and this handler: both on the one wire subject
  expect(raw.subscriberCount(S)).toBe(0);                    // nothing under the unscoped name
});

test("DW-iso: two clusters on one bus never hear each other, on any subject the cores use (entries, inbox, remote open, replies)", async () => {
  const raw = memoryBus(), a = scopeBus(raw, A), b = scopeBus(raw, B);
  const heard = { a: [], b: [], old: [] };
  const names = [S, subjects.inbox("t-1", "b-1"), subjects.presence("t-1", "b-1"), subjects.grants("t-1", "b-1"), subjects.gateway("gw-1"), subjects.open, subjects.opened("gw-1")];
  for (const n of names) {
    a.subscribe(n, m => heard.a.push([n, m]));
    b.subscribe(n, m => heard.b.push([n, m]));
    raw.subscribe(n, m => heard.old.push([n, m]));           // a node from before the cluster id: unscoped
  }
  for (const n of names) await a.publish(n, "from-a");
  await raw.flush(); await sleep(20); await raw.flush();
  expect(heard.a).toEqual(names.map(n => [n, "from-a"]));
  expect(heard.b).toEqual([]);
  expect(heard.old).toEqual([]);                             // an unscoped node hears no scoped traffic either
  for (const n of names) await raw.publish(n, "from-old");
  await raw.flush(); await sleep(20); await raw.flush();
  expect(heard.a.length).toBe(names.length);                 // and a scoped node hears nothing unscoped
  expect(heard.b).toEqual([]);
});

test("a scoped bus keeps the underlying bus's flush, close and message cap; unsubscribe works", async () => {
  const raw = memoryBus({ maxBytes: 100 }), a = scopeBus(raw, A), got = [];
  expect(a.maxBytes).toBe(100);
  const off = a.subscribe(S, m => got.push(m));
  await a.publish(S, 1); await a.flush();
  off(); off();
  await a.publish(S, 2); await a.flush();
  expect(got).toEqual([1]);
  await expect(a.publish(S, "x".repeat(200))).rejects.toMatchObject({ code: "too-large" });
  await a.close();
});
