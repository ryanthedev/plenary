// Revocation and time-based loss of access (fix round 1 of p2-swap; verifier report p2-swapv H1, M1, M2, M3, L2, L6).
// Shapes from the verifier's attack tests (docs/m2/reports/p2-swapv.attack.js.txt).
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep, until, deferred } from "./helpers.js";
import { subjects } from "../../server/bus/port.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { virtualTime } from "./virtual.js";
import { makeElement } from "../../packages/core/model.js";
import { expiryWait } from "../../server/gateway.js";

afterAll(cleanup);
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
const op = (client, n, el) => ({ t: "op", id: `${client}:${n}`, sentAt: 0, stream: "board", op: { elements: [el] } });
const grantsChanged = async r => { await r.bus.publish(subjects.grants(r.ids.tenant, r.ids.board), { board: r.ids.board }); await r.bus.flush?.(); };

/** A rig whose room build waits on a gate (store.acquire), so a hello sits between its role check and going live. */
async function gatedRig(o = {}) {
  const gate = deferred();
  let gated = true;
  const r = await rig({ ...o, wrapStore: s => ({ ...s, acquire: async (...a) => { if (gated) await gate.promise; return s.acquire(...a); } }) });
  return { r, open: () => { gated = false; gate.resolve(); } };
}

test("H1: grants removed while a hello waits on the room (the board's first connection) → refused `auth`, nothing logged", async () => {
  const { r, open } = await gatedRig();
  const s = await r.sock(); s.send(hello(r, "editor"));
  await until(() => r.calls.role >= 1, "the role check");
  await sleep(100);                                                       // inside rooms.open (gated)
  await r.registry.setGrant(r.ids.board, "dev:editor", null);
  await grantsChanged(r); await sleep(50);
  open();
  expect((await s.whenClosed(5000)).code).toBe(1008);
  expect(s.msgs).toEqual([{ t: "error", code: "auth", message: "not allowed" }]);
  expect(r.calls.role).toBe(2);                                           // asked again because grants changed
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  await r.stop();
}, 20000);

test("H1: a role changed while a hello waits → `unavailable` 1012 (reconnect); unchanged grants cost no second look", async () => {
  const { r, open } = await gatedRig();
  const s = await r.sock(); s.send(hello(r, "editor"));
  await until(() => r.calls.role >= 1, "the role check");
  await sleep(100);
  await r.registry.setGrant(r.ids.board, "dev:editor", "viewer");
  await grantsChanged(r); await sleep(50);
  open();
  expect((await s.whenClosed(5000)).code).toBe(1012);
  expect(s.msgs[0]).toMatchObject({ t: "error", code: "unavailable" });
  // With no grants message in the window, a hello is checked once.
  const before = r.calls.role;
  const ok = await r.sock(); ok.send(hello(r, "annotator")); await ok.next(m => m.t === "welcome");
  expect(r.calls.role - before).toBe(1);
  await r.stop();
}, 20000);

test("H1: grants removed DURING the role lookup (it answered from the old grants) → refused: the watch opens before the check", async () => {
  let r, first = true;
  r = await rig({ wrapAuth: a => ({ ...a, role: async (id, b) => {
    const role = await a.role(id, b);
    if (first) { first = false; await r.registry.setGrant(r.ids.board, "dev:editor", null); await grantsChanged(r); await sleep(20); }
    return role;                                                          // the stale answer: still "editor"
  } }) });
  const s = await r.sock(); s.send(hello(r, "editor"));
  expect((await s.whenClosed(5000)).code).toBe(1008);
  expect(s.msgs).toEqual([{ t: "error", code: "auth", message: "not allowed" }]);
  await r.stop();
}, 20000);

test("M1: a re-check whose role lookup throws fails closed: `unavailable` 1013, and the reconnecting hello is refused", async () => {
  let boom = false;
  const r = await rig({ wrapAuth: a => ({ ...a, role: async (id, b) => { if (boom) throw new Error("registry down"); return a.role(id, b); },
    rolesFor: async (b, ids) => { if (boom) throw new Error("registry down"); return a.rolesFor(b, ids); } }) });   // the pass's batch (p5-load)
  const s = await r.sock(); s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
  await r.registry.setGrant(r.ids.board, "dev:editor", null);
  boom = true;
  await grantsChanged(r);
  expect((await s.whenClosed(5000)).code).toBe(1013);
  expect(s.msgs.at(-1)).toEqual({ t: "error", code: "unavailable", message: "could not re-check your access: reconnect" });
  boom = false;
  const again = await r.sock(); again.send(hello(r, "editor", { client: "again" }));
  expect((await again.whenClosed(5000)).code).toBe(1008);                // the hello does the check: access is gone
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  await r.stop();
}, 20000);

test("M3: a share link passing its expiresAt closes the live connection it let in, on the timed re-check (no grants message)", async () => {
  // The gateway's clock and timers are virtual (frozen until advanced): the link's 800 ms and the 200 ms re-check run out on them.
  const V = virtualTime({ start: Date.now(), settle: () => new Promise(res => setImmediate(res)) });
  const r = await rig({ now: V.now, timers: V.timers, limits: { roleRecheckMs: 200 } });
  const link = await r.registry.createLink({ board: r.ids.board, role: "editor", expiresAt: V.now() + 800, by: "dev:owner" });
  await r.registry.addLinkUse(link.id, "dev:stranger");
  const s = await r.sock(); s.send(hello(r, "stranger"));
  expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "editor" });
  const owner = await r.sock(); owner.send(hello(r, "owner")); await owner.next(m => m.t === "welcome");
  await V.advance(700);
  expect(s.closed).toBe(null);                                            // not yet: the link still has 100 ms
  await V.advance(400);                                                   // past 800, and a re-check (every 200) has run
  expect((await s.whenClosed()).code).toBe(1008);
  expect(s.msgs.at(-1)).toEqual({ t: "error", code: "auth", message: "your access to this board was removed" });
  await V.advance(1_000); await sleep(20);
  expect(owner.closed).toBe(null);                                        // a grant that still holds is left alone
  await r.stop();
}, 20000);

test("M2 end to end: a real session token (sessions() verify, integer exp) closes its socket when it expires", async () => {
  // Virtual gateway clock and timers, frozen until advanced; the session token's 2 s are on the same clock.
  const V = virtualTime({ start: Date.now(), settle: () => new Promise(res => setImmediate(res)) });
  const sess = await makeSessions({ key: "k".repeat(40), ttlSec: 2, now: V.now });
  const token = await sess.issue({ user: "dev:editor", name: "editor" });
  expect(Number.isInteger((await sess.verify(token))?.exp)).toBe(true);
  const r = await rig({ now: V.now, timers: V.timers, wrapAuth: a => ({ ...a, verify: async t => (t === token ? sess.verify(t) : a.verify(t)) }) });
  const s = await r.sock(); s.send({ t: "hello", v: 1, token, board: r.ids.board, since: 0, client: "sx" });
  await s.next(m => m.t === "welcome");
  await V.advance(2_001);
  expect((await s.whenClosed()).code).toBe(1008);
  expect(s.msgs.at(-1)).toEqual({ t: "error", code: "auth", message: "your sign-in expired" });
  const late = await r.sock(); late.send({ t: "hello", v: 1, token, board: r.ids.board, since: 0, client: "late" });
  expect((await late.whenClosed()).code).toBe(1008);                     // and the token no longer opens one
  await r.stop();
}, 20000);

test("L6: an expiry past setTimeout's 24.8-day cap re-arms when the capped wait ends, and closes only once it has passed", () => {
  const CAP = 2 ** 31 - 1, t0 = Date.UTC(2026, 10, 12), exp = t0 / 1000 + 30 * 86400;   // 30 days out
  expect(expiryWait(exp, t0)).toBe(CAP);                                  // first wait: the cap (24.8 days)
  const second = expiryWait(exp, t0 + CAP);
  expect(second).toBe(30 * 86400 * 1000 - CAP);                           // when it fires: not expired, wait the rest
  expect(second).toBeGreaterThan(0);
  expect(expiryWait(exp, t0 + CAP + second)).toBe(0);                     // then: expired, close
  expect(expiryWait(exp, t0 + 31 * 86400 * 1000)).toBe(0);
});

test("L2: a gap in the Store log is logged as an error and a new viewer is refused `unavailable`, not welcomed short", async () => {
  const { Database } = await import("bun:sqlite");
  const r = await rig();
  const w = await r.sock(); w.send(hello(r, "editor")); await w.next(m => m.t === "welcome");
  w.send(op("editor", 1, rect("one"))); await w.next(m => m.t === "ack");
  await r.idle(); await w.close();
  await until(() => r.server.gateway.stats().boards === 0, "the board's feed to close");
  const db = new Database(r.dir + "/plenary.db");
  const e = JSON.parse(db.query("SELECT data FROM entries WHERE seq = 1").get().data); e.seq = 3; e.id = "editor:3";
  db.run("INSERT INTO entries (tenant, board, seq, data) VALUES (?, ?, 3, ?)", [r.ids.tenant, r.ids.board, JSON.stringify(e)]);
  db.close();
  const v = await r.sock(); v.send(hello(r, "viewer"));
  expect((await v.whenClosed(5000)).code).toBe(1013);
  expect(v.msgs).toEqual([{ t: "error", code: "unavailable", message: "this board can't be served right now" }]);
  const errors = r.logs().filter(l => l.level === "error").map(l => l.msg);
  expect(errors).toContain("feed: the Store log has a gap: entries after it are not served");
  expect(errors).toContain("hello refused: the board's log has a gap");
  await r.stop();
}, 20000);
