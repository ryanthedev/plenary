// p2-tune: re-check passes at scale (R1-R3), the error rule (R2), a foreign entry at seq + 1 (R4) and `here`.
// Waits are on events (the gateway's stats, messages, closes), not on time, except where pacing itself is tested.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep, until, deferred } from "./helpers.js";
import { subjects } from "../../server/bus/port.js";

afterAll(cleanup);
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
const grantsChanged = r => r.bus.publish(subjects.grants(r.ids.tenant, r.ids.board), { board: r.ids.board });
const gw = r => r.server.gateway;
const passes = r => gw(r).stats().rechecks.passes;
const idle = r => until(() => gw(r).stats().rechecks.running === 0, "no re-check pass running");

/**
 * A rig whose `auth.role` can be held at a gate and made to throw. `tok-<name>` tokens are distinct users
 * (`dev:<name>`); `grant(names, role)` gives them a role on the test board.
 */
async function roleRig(limits = {}) {
  const ctl = { gate: null, boom: false, calls: 0, during: 0, hung: 0, hang: new Set(), fail: new Set(), holdAfter: new Set() };
  const r = await rig({ limits: { maxConnsPerUser: 100000, roleRecheckMs: 3_600_000, ...limits }, wrapAuth: a => ({
    // "tok-<name>" or "tok-<name>~<email>": the email lets a test give one user's tabs different identities (LOW 4).
    verify: async t => { if (!t.startsWith("tok-")) return a.verify(t); const [n, email] = t.slice(4).split("~"); return { user: "dev:" + n, name: n, ...(email ? { email } : {}) }; },
    // ctl.hang: that user's next lookup never settles. ctl.fail: that user's lookups throw. ctl.holdAfter: the lookup
    // reads the role, then waits for ctl.gate and answers what it read (an answer that is stale by the time it lands).
    role: async (id, b) => {
      ctl.calls++; ctl.order?.push(id.user); ctl.ids?.push(id);
      if (ctl.hang.delete(id.user)) { ctl.hung++; return new Promise(() => {}); }
      if (ctl.holdAfter.has(id.user) && ctl.gate) { const got = await a.role(id, b); ctl.during++; await ctl.gate.promise; return got; }
      if (ctl.gate) { ctl.during++; await ctl.gate.promise; }
      if (ctl.boom || ctl.fail.has(id.user)) throw new Error("registry down");
      return a.role(id, b);
    },
  }) });
  const grant = async (names, role) => { for (const n of names) await r.registry.setGrant(r.ids.board, "dev:" + n, role); };
  const open = async (names, role = "viewer") => {
    await grant(names, role);
    const socks = await Promise.all(names.map(() => r.sock()));
    socks.forEach((s, i) => s.send({ t: "hello", v: 1, token: "tok-" + names[i], board: r.ids.board, since: 0, client: "c" + i }));
    await until(() => socks.every(s => s.msgs.some(m => m.t === "welcome")), "all welcomed", 30000);
    return socks;
  };
  return { r, ctl, grant, open };
}
const names = (n, p = "u") => Array.from({ length: n }, (_, i) => p + i);

// ---- R1: coalescing, per user ----

test("R1: 10 grants messages during a pass cost exactly one more pass, not 10", async () => {
  const { r, ctl, open } = await roleRig();
  await open(names(5));
  const p0 = passes(r);
  ctl.gate = deferred(); ctl.during = 0;
  await grantsChanged(r);
  await until(() => ctl.during >= 1, "the first pass to reach the Registry");
  for (let i = 0; i < 10; i++) await grantsChanged(r);
  await r.bus.flush?.(); await sleep(20);                                 // the 10 are delivered while the pass is held
  const g = ctl.gate; ctl.gate = null; g.resolve();
  await idle(r);
  expect(passes(r) - p0).toBe(2);
  expect(gw(r).stats().rechecks.running).toBe(0);
  await r.stop();
}, 20000);

test("R1: a user's tabs share one role answer per pass; users with a writer connection are asked first", async () => {
  const { r, ctl, open } = await roleRig({ recheckConcurrency: 1 });
  await open(names(4, "v"));                                              // 4 viewer users
  await open(["w0", "w0", "w0"], "editor");                               // one editor user, 3 tabs
  const c0 = ctl.calls; ctl.order = [];
  await gw(r).recheck(r.ids.board);
  expect(ctl.calls - c0).toBe(5);                                        // 4 viewers + 1 editor user, not 7 connections
  expect(ctl.order[0]).toBe("dev:w0");
  await r.stop();
}, 20000);

// ---- R2: the error rule ----

test("R2: a timed pass whose Registry calls fail keeps the connections, retries with backoff, then closes after the bound", async () => {
  const { r, ctl, open } = await roleRig({ recheckRetries: 2, recheckRetryMs: 40, recheckConcurrency: 20 });   // one batch: everyone is reached
  const socks = await open(names(20));
  ctl.boom = true;
  await gw(r).recheck(r.ids.board, "timed");
  expect(socks.every(s => s.closed === null)).toBe(true);                // kept: one blip closes nobody
  // Two retries (40 ms, 80 ms), both failing, then the third failure closes them all `unavailable`.
  const closes = await Promise.all(socks.map(s => s.whenClosed(5000)));
  expect(closes.every(c => c.code === 1013)).toBe(true);
  expect(socks[0].msgs.at(-1)).toEqual({ t: "error", code: "unavailable", message: "could not re-check your access: reconnect" });
  expect(gw(r).stats().rechecks.retries).toBe(2);
  await r.stop();
}, 20000);

test("R2: a Registry blip during the timed pass closes nobody; a first batch that all fails stops the pass; the retry asks only the failed", async () => {
  const { r, ctl, open } = await roleRig({ recheckRetries: 2, recheckRetryMs: 30, recheckConcurrency: 1 });
  const socks = await open(names(40));
  ctl.boom = true;
  const c0 = ctl.calls;
  await gw(r).recheck(r.ids.board, "timed");
  expect(ctl.calls - c0).toBe(1);                                        // the whole first batch (1 lookup) failed: stop, not 40 calls
  ctl.boom = false;                                                       // the blip is over before the retry
  await until(() => gw(r).stats().rechecks.retries >= 1, "the retry");
  await idle(r);
  expect(ctl.calls - c0).toBe(2);                                        // the retry asked only the user that failed; the
  await sleep(150);                                                       // others, never reached, are left as they were
  expect(socks.filter(s => s.closed).length).toBe(0);
  expect(gw(r).stats().rechecks.retries).toBe(1);                        // a clean retry schedules no more
  await r.stop();
}, 20000);

test("R2: a grants-triggered pass still fails closed on a Registry error, also when the grants message lands during a timed pass", async () => {
  const { r, ctl, open } = await roleRig();
  const socks = await open(names(3));
  ctl.gate = deferred(); ctl.during = 0;
  const timed = gw(r).recheck(r.ids.board, "timed");                    // held at the Registry
  await until(() => ctl.during >= 1, "the timed pass to reach the Registry");
  await grantsChanged(r); await r.bus.flush?.(); await sleep(20);        // queued: the next pass is a grants pass
  ctl.boom = true;
  const g = ctl.gate; ctl.gate = null; g.resolve();
  await timed;
  const closes = await Promise.all(socks.map(s => s.whenClosed(5000)));
  expect(closes.every(c => c.code === 1013)).toBe(true);                 // the timed pass kept them; the grants pass closed them
  expect(gw(r).stats().rechecks.retries).toBe(0);
  await r.stop();
}, 20000);

// ---- R4 ----

test("R4: another board's entry at seq + 1 refuses joins (`unavailable`), like a gap, instead of welcoming them short", async () => {
  let rr;
  const r = rr = await rig({ wrapStore: s => ({ ...s, read: async (t, b, from, ...rest) => {
    if (b === rr?.ids.board && from === 1) return [{ seq: 1, tenant: t, board: rr.ids.otherBoard, stream: "board", op: { elements: [] }, by: "dev:editor", id: "editor:1", at: 1, rv: 1 }];
    return s.read(t, b, from, ...rest);
  } }) });
  const v = await r.sock(); v.send(hello(r, "viewer"));
  expect((await v.whenClosed(5000)).code).toBe(1013);
  expect(v.msgs).toEqual([{ t: "error", code: "unavailable", message: "this board can't be served right now" }]);
  const errors = r.logs().filter(l => l.level === "error").map(l => l.msg);
  expect(errors).toContain("feed: the Store returned another board's entry");
  expect(errors).toContain("feed: the Store log has an entry it can't serve: entries from it on are not served");
  await r.stop();
}, 20000);

// ---- here ----

const lastHere = s => s.msgs.filter(m => m.t === "here").at(-1);
const lastList = s => s.msgs.filter(m => m.t === "here" && Array.isArray(m.writers)).at(-1);   // the last full `here`

test("here: relayed between clients (writers by user, viewers counted), updated on leave, never logged and never sent to the room", async () => {
  const r = await rig({ limits: { hereMs: 30, herePublishMs: 200 } });
  const ed = await r.sock(); ed.send(hello(r, "editor")); await ed.next(m => m.t === "welcome");
  const an = await r.sock(); an.send(hello(r, "annotator")); await an.next(m => m.t === "welcome");
  const vw = await r.sock(); vw.send(hello(r, "viewer")); await vw.next(m => m.t === "welcome");
  const want = { t: "here", writers: [{ user: "dev:editor", name: "editor", role: "editor" }, { user: "dev:annotator", name: "annotator", role: "annotator" }], writerCount: 2, viewers: 1 };
  for (const s of [ed, an, vw]) await s.next(m => m.t === "here" && JSON.stringify(m) === JSON.stringify(want), "the merged here");
  await ed.close();
  await an.next(m => m.t === "here" && m.writerCount === 1 && m.writers?.[0]?.user === "dev:annotator", "here after the editor left");
  // A joiner gets the current `here` right after its catch-up.
  const late = await r.sock(); late.send(hello(r, "viewer", { client: "late" })); await late.next(m => m.t === "welcome");
  const first = await late.next(m => m.t === "here");
  expect(Array.isArray(first.writers)).toBe(true);                         // a joiner always gets the full list first
  expect(r.inbox.some(m => m.msg?.t === "here" || m.writers)).toBe(false);
  expect(r.lines.some(l => l.includes('"here"') || l.includes("writerCount"))).toBe(false);
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  await r.stop();
}, 20000);

test("here: merged across two gateways on one bus (viewers summed, a user on both listed once)", async () => {
  const a = await rig({ limits: { hereMs: 30, herePublishMs: 100 } });
  const b = await rig({ dir: a.dir, registry: a.registry, ids: a.ids, wrapBus: () => a.bus, limits: { hereMs: 30, herePublishMs: 100 } });
  const ed = await a.sock(); ed.send(hello(a, "editor")); await ed.next(m => m.t === "welcome");
  const va = await a.sock(); va.send(hello(a, "viewer")); await va.next(m => m.t === "welcome");
  const vb = await b.sock(); vb.send(hello(b, "viewer", { client: "vb" })); await vb.next(m => m.t === "welcome");
  const vb2 = await b.sock(); vb2.send(hello(b, "commenter")); await vb2.next(m => m.t === "welcome");
  const ok = m => m.t === "here" && m.viewers === 2 && m.writerCount === 2 && m.writers?.map(w => w.user).join() === "dev:editor,dev:commenter";
  await va.next(ok, "gateway A's merged here");
  await vb.next(ok, "gateway B's merged here");
  await b.server.stop(); await a.stop();
}, 20000);

test("here: bounded with many viewers: at most hereMax writers listed (counts past it), bus messages small, slower to a big board", async () => {
  let skew = 0;                                                          // the gateway's clock: real time plus what the churn below adds
  const r = await rig({ now: () => Date.now() + skew, limits: { hereMs: 30, herePublishMs: 100, hereMax: 3, hereBigBoard: 8, hereBigMs: 600 } });
  const onBus = [];
  r.bus.subscribe(subjects.presence(r.ids.tenant, r.ids.board).replace(/presence$/, "here"), m => onBus.push(m));
  const writers = [];
  for (const n of ["owner", "editor0", "editor1", "annotator", "commenter"]) { const s = await r.sock(); s.send(hello(r, n)); await s.next(m => m.t === "welcome"); writers.push(s); }
  const viewers = await Promise.all(Array.from({ length: 12 }, () => r.sock()));
  viewers.forEach((s, i) => s.send(hello(r, "viewer", { client: "v" + i })));
  await until(() => viewers.every(s => s.msgs.some(m => m.t === "welcome")), "viewers welcomed");
  const everyone = await viewers[0].next(m => m.t === "here" && m.viewers === 12 && m.writerCount === 5, "the here with everyone");
  expect(everyone.writerCount).toBe(5);
  // The list is the last message that carries one; its own count may be older (the 4th and 5th writers change the
  // count but not the three listed, so the here with everyone is count-only: a flake when read as `h.writerCount`).
  const h = lastList(viewers[0]);
  expect(h.writers.length).toBe(3);
  expect(h.writers[0]).toEqual({ user: "dev:owner", name: "owner", role: "owner" });   // owners and editors first
  expect(h.writers.slice(1).map(w => w.role)).toEqual(["editor", "editor"]);
  expect(onBus.length).toBeGreaterThan(0);
  expect(onBus.every(m => (m.writers?.length ?? 0) <= 3)).toBe(true);
  // 17 connections > hereBigBoard (8): while viewers come and go (each one welcomed, so counted, then closed),
  // `here` arrives at most every ~600 ms. Each churner waits for its welcome: closed earlier it is never counted
  // and the count would not change, so the test could not tell big-board pacing from small.
  // Eight churners at 80 ms of real time each (about two `here` ticks), with the gateway's clock 200 ms further on each: 2.2 s
  // of its time in all, so a 600 ms pace allows about 4 heres and the 30 ms pace of a small board about 20.
  const watcher = viewers[1], before = watcher.msgs.filter(m => m.t === "here").length;
  let churned = 0;
  while (churned < 8) { const s = await r.sock(); s.send(hello(r, "viewer", { client: "churn" + churned++ })); await s.next(m => m.t === "welcome"); skew += 100; await sleep(40); s.close(); await s.whenClosed(); skew += 100; await sleep(40); }
  const got = watcher.msgs.filter(m => m.t === "here").length - before;
  expect(got).toBeGreaterThanOrEqual(1);
  expect(got).toBeLessThanOrEqual(8);                                    // 2.2 s / 600 ms + slack; one per 30 ms would be ~20
  expect(lastList(watcher).writers.length).toBe(3);
  await r.stop();
}, 30000);

// ---- Round 2 (p2-tunev findings; each test is the verifier's repro) ----

test("H1: a lookup that never settles is cut off at recheckLookupMs; the revoked editor is closed once the stuck timed pass is cut off", async () => {
  const { r, ctl, open } = await roleRig({ recheckLookupMs: 150, recheckConcurrency: 1 });
  const [, victim] = await open(["stuck", "victim"], "editor");
  ctl.hang.add("dev:stuck");
  const timed = gw(r).recheck(r.ids.board, "timed");                    // not awaited: its first lookup never settles
  await until(() => ctl.hung >= 1, "the hung lookup");
  await r.registry.setGrant(r.ids.board, "dev:victim", null);
  await grantsChanged(r);
  // The grants pass waits behind the stuck timed pass, which only the lookup bound ends: without it neither ever finishes
  // (a counted outcome; the backstop is generous, so a loaded machine slows this and cannot fail it).
  expect((await victim.whenClosed(30_000)).code).toBe(1008);
  await timed;
  expect(gw(r).stats().rechecks.timeouts).toBeGreaterThanOrEqual(1);
  await r.stop();
}, 40000);

test("H2: 8 users whose lookups fail are closed after their retries; 300 healthy viewers on the board stay open", async () => {
  const { r, ctl, open } = await roleRig({ recheckRetries: 1, recheckRetryMs: 20 });
  const bad = await open(names(8, "bad"), "annotator");                  // writers: asked first, the whole first batch
  const ok = await open(names(300, "h"));
  for (const n of names(8, "bad")) ctl.fail.add("dev:" + n);
  await gw(r).recheck(r.ids.board, "timed");
  const closes = await Promise.all(bad.map(s => s.whenClosed(5000)));
  expect(closes.every(c => c.code === 1013)).toBe(true);
  await idle(r); await sleep(100);
  expect(ok.filter(s => s.closed).length).toBe(0);
  await r.stop();
}, 60000);

test("M3: the retry backoff is per connection: a second failing user after a close-out is closed as fast as the first", async () => {
  const { r, ctl, open } = await roleRig({ recheckRetries: 3, recheckRetryMs: 20 });
  const [a, b] = await open(["a", "b"]);
  // The waits are read off the retry timers the gateway sets (their delays), not timed: a user's own backoff is
  // 20, 40, 80 ms; a backoff carried over from the first user would show as 160, 320, 640 for the second.
  const realSet = globalThis.setTimeout, delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 15 && ms <= 700) delays.push(ms); return realSet(fn, ms, ...rest); };
  const waitsOf = async (s, user) => {
    delays.length = 0; ctl.fail.add(user);
    await gw(r).recheck(r.ids.board, "timed");
    await s.whenClosed(30_000); ctl.fail.delete(user);
    return delays.filter(ms => [20, 40, 80, 160, 320, 640].includes(ms));
  };
  let wa, wb;
  try { wa = await waitsOf(a, "dev:a"); wb = await waitsOf(b, "dev:b"); } finally { globalThis.setTimeout = realSet; }   // no clean pass in between
  expect(Math.max(...wa)).toBeLessThanOrEqual(80);                        // 20 + 40 + 80 ms of waits
  expect(wb.length).toBeGreaterThan(0);
  expect(Math.max(...wb)).toBeLessThanOrEqual(80);                        // was 160/320/640 ms waits
  await r.stop();
}, 20000);

test("M2/LOW 5: a count change sends the count-only `here` (no writers field); a joiner, also the board's first, gets the full list right after catch-up", async () => {
  const r = await rig({ limits: { hereMs: 30, herePublishMs: 200 } });
  const first = await r.sock(); first.send(hello(r, "editor"));
  await first.next(m => m.t === "welcome");
  const h0 = await first.next(m => m.t === "here", "the first joiner's here");
  expect(Array.isArray(h0.writers)).toBe(true);                           // before any tick: built at the welcome
  const watch = await r.sock(); watch.send(hello(r, "viewer"));
  await watch.next(m => m.t === "welcome");
  const hj = await watch.next(m => m.t === "here", "the joiner's here");
  expect(hj.writers).toEqual([{ user: "dev:editor", name: "editor", role: "editor" }]);
  const v2 = await r.sock(); v2.send(hello(r, "viewer", { client: "v2" })); await v2.next(m => m.t === "welcome");
  const hc = await watch.next(m => m.t === "here" && m.viewers === 2, "the count change");
  expect(hc).toEqual({ t: "here", writerCount: 1, viewers: 2 });
  await r.stop();
}, 20000);

test("LOW 1: past owners and editors, the list is by most recent activity, not by role (an active commenter beats an idle annotator)", async () => {
  const r = await rig({ limits: { hereMs: 30, herePublishMs: 200, hereMax: 2 } });
  const ow = await r.sock(); ow.send(hello(r, "owner")); await ow.next(m => m.t === "welcome");
  const co = await r.sock(); co.send(hello(r, "commenter")); await co.next(m => m.t === "welcome");
  await sleep(5);
  const an = await r.sock(); an.send(hello(r, "annotator")); await an.next(m => m.t === "welcome");
  await ow.next(m => m.t === "here" && m.writers?.map(w => w.user).join() === "dev:owner,dev:annotator", "annotator listed (joined last)");
  await sleep(5);
  co.send({ t: "presence", k: "cursor", x: 1, y: 2 });
  await ow.next(m => m.t === "here" && m.writers?.map(w => w.user).join() === "dev:owner,dev:commenter", "the active commenter listed");
  await r.stop();
}, 20000);

test("LOW 3 (B2): a grants message while a retry pass is queued upgrades it to a grants pass; the revoked writer is closed", async () => {
  const { r, ctl, open } = await roleRig({ recheckRetries: 3, recheckRetryMs: 60 });
  const [w] = await open(["w"], "editor");
  ctl.fail.add("dev:w");
  await gw(r).recheck(r.ids.board, "timed");                             // w fails once: a retry is armed for +60 ms
  ctl.fail.delete("dev:w");
  ctl.gate = deferred(); ctl.during = 0; ctl.holdAfter.add("dev:w");
  await grantsChanged(r);                                                 // a grants pass P, held at w with a stale "editor"
  await until(() => ctl.during >= 1, "P held at w");
  await until(() => gw(r).stats().rechecks.retries >= 1, "the retry timer fires during P (queued)");
  await r.registry.setGrant(r.ids.board, "dev:w", null);
  await grantsChanged(r); await r.bus.flush?.(); await sleep(20);         // must turn the queued retry into a grants pass
  ctl.holdAfter.delete("dev:w");
  const g = ctl.gate; ctl.gate = null; g.resolve();
  expect((await w.whenClosed(3000)).code).toBe(1008);
  await r.stop();
}, 20000);

test("LOW 4: one user's tabs with different identity claims are asked separately", async () => {
  const { r, ctl, grant } = await roleRig();
  await grant(["x"], "editor");
  const s1 = await r.sock(), s2 = await r.sock();
  s1.send({ t: "hello", v: 1, token: "tok-x~a@e.com", board: r.ids.board, since: 0, client: "c1" });
  s2.send({ t: "hello", v: 1, token: "tok-x~b@e.com", board: r.ids.board, since: 0, client: "c2" });
  await s1.next(m => m.t === "welcome"); await s2.next(m => m.t === "welcome");
  ctl.ids = [];
  await gw(r).recheck(r.ids.board);
  expect(ctl.ids.map(i => i.email).sort()).toEqual(["a@e.com", "b@e.com"]);
  await r.stop();
}, 20000);
