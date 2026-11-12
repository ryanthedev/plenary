// p5-load: the gateway over the role cache (server/auth/tenancy.js roleCache), as server/main.js wires it:
// invalidation on `grants` before the hello re-ask and the pass, `{ board, user }` scoped to one user with no pass,
// cached roles dropped when the board's watch is released, and the timed pass batched through auth.rolesFor.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep, until } from "./helpers.js";
import { subjects } from "../../server/bus/port.js";
import { memoryRegistry } from "../../server/auth/registry.js";

afterAll(cleanup);
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
const publish = async (r, msg) => { await r.bus.publish(subjects.grants(r.ids.tenant, r.ids.board), { board: r.ids.board, ...msg }); await r.bus.flush?.(); };

/** A memory Registry that counts `grant` reads (a role lookup that reached the Registry). */
function countingRegistry() {
  const raw = memoryRegistry(), n = { grant: 0, grants: 0 };
  return { n, registry: { ...raw, grant: async (b, u) => { n.grant++; return raw.grant(b, u); }, grants: async b => { n.grants++; return raw.grants(b); } } };
}
const join = async (r, name, extra) => { const s = await r.sock(); s.send(hello(r, name, extra)); return s; };

test("a second hello of a connected user is answered from the cache; a `{ board }` revoke still closes and refuses", async () => {
  const { n, registry } = countingRegistry();
  const r = await rig({ cache: {}, registry });
  const a = await join(r, "editor"); await a.next(m => m.t === "welcome");
  const before = n.grant;
  const b = await join(r, "editor", { client: "tab2" }); await b.next(m => m.t === "welcome");
  expect(n.grant).toBe(before);                                    // cached
  await r.registry.setGrant(r.ids.board, "dev:editor", null);
  await publish(r, {});
  expect((await a.whenClosed(5000)).code).toBe(1008);
  expect((await b.whenClosed(5000)).code).toBe(1008);
  const c = await join(r, "editor", { client: "tab3" });
  expect((await c.whenClosed(5000)).code).toBe(1008);
  await r.stop();
}, 20000);

test("`{ board, user }` (a share-link use) drops that user's cached role and runs no re-check pass", async () => {
  const r = await rig({ cache: {} });
  const v = await join(r, "viewer"); await v.next(m => m.t === "welcome");
  const passes = (await r.health()).body.gateway.rechecks.passes;
  await r.registry.setGrant(r.ids.board, "dev:viewer", "editor");   // as if a link raised them: no `{ board }` message
  await publish(r, { user: "dev:viewer" });
  await sleep(50);
  expect((await r.health()).body.gateway.rechecks.passes).toBe(passes);
  expect(v.closed).toBe(null);                                      // their open socket keeps its role until the timed pass
  const again = await join(r, "viewer", { client: "after-link" });
  expect(await again.next(m => m.t === "welcome")).toMatchObject({ role: "editor" });
  await r.stop();
}, 20000);

test("the board's cached roles go when its last socket closes (no watch, no invalidations): a later revoke is seen", async () => {
  const r = await rig({ cache: { ttlMs: 3_600_000 } });
  const a = await join(r, "editor"); await a.next(m => m.t === "welcome");
  await a.close();
  await until(async () => (await r.health()).body.gateway.conns === 0, "socket gone");
  await r.registry.setGrant(r.ids.board, "dev:editor", null);       // no message reaches anyone
  const b = await join(r, "editor", { client: "later" });
  expect((await b.whenClosed(5000)).code).toBe(1008);
  await r.stop();
}, 20000);

test("the timed pass reads through auth.rolesFor in chunks (no per-user role calls) and closes a lost-message revoke", async () => {
  const r = await rig({ cache: { ttlMs: 3_600_000 }, limits: { roleRecheckMs: 200, recheckBatch: 2 } });
  const names = ["editor0", "editor1", "editor2", "editor3", "editor4"];
  const socks = [];
  for (const nm of names) { const s = await join(r, nm); await s.next(m => m.t === "welcome"); socks.push(s); }
  const roleCalls = r.calls.role;
  await r.registry.setGrant(r.ids.board, "dev:editor3", null);       // the `grants` message was lost
  expect((await socks[3].whenClosed(5000)).code).toBe(1008);
  expect(r.calls.role).toBe(roleCalls);                              // the pass made no per-user call
  expect(r.cacheCalls.rolesFor).toBeGreaterThanOrEqual(3);           // 5 users in chunks of 2
  const again = await join(r, "editor3", { client: "back" });        // and the cache didn't keep the old role
  expect((await again.whenClosed(5000)).code).toBe(1008);
  for (const s of [0, 1, 2, 4]) expect(socks[s].closed).toBe(null);
  await r.stop();
}, 20000);

// ---- p5-load3: gap tests from p5-loadv / p5-load2v (GAP-M4, GAP-M6), M7, and the bounded rolesFor (finding 1) ----

/** A memory Registry whose named reads can be held at a gate (the next call of that name waits until `open()`). */
function gated() {
  const raw = memoryRegistry();
  const gates = {};
  const hold = name => { let open; const p = new Promise(r => { open = r; }); let entered; const inP = new Promise(r => { entered = r; }); gates[name] = { p, open, entered, inP }; return gates[name]; };
  const wrap = name => async (...a) => { const g = gates[name]; if (g) { delete gates[name]; g.entered(); await g.p; } return raw[name](...a); };
  const registry = { ...raw };
  for (const k of ["grant", "grants", "invitesFor", "linkUses", "linkUsesFor", "links", "link"]) registry[k] = wrap(k);
  return { raw, registry, hold };
}
const outcome = s => Promise.race([s.next(m => m.t === "welcome").then(() => "welcome"), s.whenClosed(5000).then(c => "closed " + c.code)]);

test("GAP-M4: a revoke message arriving while a timed pass runs: a NEW hello in that window is refused", async () => {
  const g = gated();
  const r = await rig({ cache: { ttlMs: 3_600_000 }, registry: g.registry, limits: { roleRecheckMs: 300 } });
  const a = await join(r, "editor"); await a.next(m => m.t === "welcome");
  const h = g.hold("grants");
  await h.inP;                                                     // a timed pass is inside rolesFor
  const warm = await join(r, "editor", { client: "warm" }); await warm.next(m => m.t === "welcome");   // refills the cache after the pass began
  await r.registry.setGrant(r.ids.board, "dev:editor", null);
  await publish(r, {});                                            // the grants pass queues behind the held one
  const b = await join(r, "editor", { client: "window" });
  const got = await outcome(b);
  h.open();
  expect(got).toBe("closed 1008");
  await r.stop();
}, 20000);

test("GAP-M6 (LOW A): a cached user who left (others stay), revoke message lost: after one timed pass their new hello is refused", async () => {
  const r = await rig({ cache: { ttlMs: 3_600_000 }, limits: { roleRecheckMs: 300 } });
  const keep = await join(r, "viewer"); await keep.next(m => m.t === "welcome");
  const x = await join(r, "editor"); await x.next(m => m.t === "welcome");
  await x.close();
  await until(async () => (await r.health()).body.gateway.conns === 1, "x gone");
  await r.registry.setGrant(r.ids.board, "dev:editor", null);      // lost
  const p0 = (await r.health()).body.gateway.rechecks.passes;
  await until(async () => (await r.health()).body.gateway.rechecks.passes >= p0 + 1, "a pass");
  const y = await join(r, "editor", { client: "back" });
  expect(await outcome(y)).toBe("closed 1008");
  await r.stop();
}, 20000);

test("M7: hellos waiting on the room when a timed pass runs (one served from the cache) ask again: a lost revoke refuses them", async () => {
  let gatedRoom = true, openRoom;
  const roomGate = new Promise(res => { openRoom = res; });
  const r = await rig({ cache: { ttlMs: 3_600_000 }, limits: { roleRecheckMs: 300 },
    wrapStore: s => ({ ...s, acquire: async (...a) => { if (gatedRoom) await roomGate; return s.acquire(...a); } }) });   // room-host opens a room by lease acquire (p4-host)
  const keep = await join(r, "viewer"); await keep.next(m => m.t === "welcome");   // keeps the board's watch (viewers open no room)
  const a = await join(r, "editor");                               // reads its role (cached), then waits on the room
  await until(() => r.calls.role >= 2, "a's role check");
  const b = await join(r, "editor", { client: "b" });              // served from the cache, waits on the same room
  await until(() => r.calls.role >= 3, "b's role check");
  await r.registry.setGrant(r.ids.board, "dev:editor", null);      // the `grants` message is lost
  const p0 = (await r.health()).body.gateway.rechecks.passes;
  await until(async () => (await r.health()).body.gateway.rechecks.passes >= p0 + 1, "a timed pass (a and b are not live: it can't see them)");
  gatedRoom = false; openRoom();
  expect(await outcome(a)).toBe("closed 1008");
  expect(await outcome(b)).toBe("closed 1008");
  expect(keep.closed).toBe(null);
  await r.stop();
}, 20000);

test("finding 1: a timed pass whose rolesFor never settles is bounded by recheckLookupMs; a revoke still closes", async () => {
  let hang = false;
  const r = await rig({ cache: {}, limits: { roleRecheckMs: 200, recheckLookupMs: 300 }, wrapAuth: a => ({ ...a, rolesFor: (b, ids) => (hang ? new Promise(() => {}) : a.rolesFor(b, ids)) }) });
  const s = await join(r, "editor"); await s.next(m => m.t === "welcome");
  hang = true; await sleep(400);                                    // a timed pass is now stuck in rolesFor
  hang = false;
  await r.registry.setGrant(r.ids.board, "dev:editor", null);
  await publish(r, {});
  expect((await s.whenClosed(4000)).code).toBe(1008);
  expect((await r.health()).body.gateway.rechecks.timeouts).toBeGreaterThanOrEqual(1);
  await r.stop();
}, 20000);

// V1 and V2 adopted from the p5-load3v verifier (docs/m2/reports/p5-load3v.adv.test.js.txt).
test("V1: a timed-out rolesFor chunk whose answer (read BEFORE a lost revoke) lands late never fills the cache: the next hello is refused", async () => {
  const raw = memoryRegistry();
  let hold = false, entered, release;
  const inP = new Promise(res => { entered = res; }), gate = new Promise(res => { release = res; });
  const registry = { ...raw, grants: async b => {
    const snap = await raw.grants(b);                 // read now...
    if (hold) { hold = false; entered(); await gate; } // ...answered late
    return snap;
  } };
  const r = await rig({ cache: { ttlMs: 3_600_000 }, registry, limits: { roleRecheckMs: 1_000, recheckLookupMs: 300 } });
  const keep = await join(r, "viewer"); await keep.next(m => m.t === "welcome");
  const x = await join(r, "editor"); await x.next(m => m.t === "welcome");
  hold = true;
  await inP;                                                       // a timed pass read the rows (editor still granted)
  await r.registry.setGrant(r.ids.board, "dev:editor", null);      // revoke; the `grants` message is lost
  await until(async () => (await r.health()).body.gateway.rechecks.timeouts >= 1, "the chunk timed out");
  release(); await sleep(20);                                      // the stale answer lands now
  const y = await join(r, "editor", { client: "after" });
  expect(await outcome(y)).toBe("closed 1008");
  await r.stop();
}, 20000);

test("V2: a grants pass in chunks: one failed chunk fails closed only ITS identities; the next chunk's unchanged user stays", async () => {
  let failNext = false;
  const r = await rig({ cache: {}, limits: { recheckBatch: 1 },
    wrapAuth: a => ({ ...a, rolesFor: (b, ids) => { if (failNext) { failNext = false; return Promise.reject(new Error("registry blip")); } return a.rolesFor(b, ids); } }) });
  const first = await join(r, "editor"); await first.next(m => m.t === "welcome");
  const second = await join(r, "annotator"); await second.next(m => m.t === "welcome");
  failNext = true;
  await publish(r, {});
  expect((await first.whenClosed(4000)).code).toBe(1013);         // its chunk failed: fail closed
  await sleep(300);
  expect(second.closed).toBe(null);                                // read fine in its own chunk, role unchanged
  await r.stop();
}, 20000);
