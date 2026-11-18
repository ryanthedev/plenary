// hello.tab (PROTOCOL.md § Messages, `hello.tab`; § Presence, `here`): the gateway counts tabs, not connections.
// here.viewers = distinct (user, tab) viewer pairs; writer cap = 8 distinct tabs per (user, board), and 2 writer
// connections per (user, board, tab). A hello without `tab` is a tab of its own.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep } from "./helpers.js";

afterAll(cleanup);
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
const FAST = { limits: { hereMs: 20, herePublishMs: 100 } };
const CAP8 = { t: "error", code: "limit", message: "at most 8 open writer connections per user on a board" };
const CAP_TAB = { t: "error", code: "limit", message: "at most 2 open writer connections per tab on a board" };

async function join(r, name, extra) {
  const s = await r.sock(); s.send(hello(r, name, extra)); await s.next(m => m.t === "welcome", `welcome for ${name}`); return s;
}
async function refused(r, name, extra) {
  const s = await r.sock(); s.send(hello(r, name, extra));
  expect((await s.whenClosed()).code).toBe(1008);
  return s.msgs;
}
/** The latest `viewers` an observer has been told; waits until it equals `n`, then holds it for `holdMs` (five of the 20 ms `here` intervals: a late spurious change would show). */
async function viewersSettle(obs, n, holdMs = 100) {
  const last = () => obs.msgs.filter(m => m.t === "here").at(-1)?.viewers;
  const until = Date.now() + 10_000;
  while (last() !== n) { if (Date.now() > until) throw new Error(`viewers stayed ${last()}, wanted ${n}`); await sleep(10); }
  await sleep(holdMs);
  expect(last()).toBe(n);
}
const allViewers = obs => obs.msgs.filter(m => m.t === "here").map(m => m.viewers);

test("hello.tab format: 1-32 of [A-Za-z0-9_-] accepted; anything else is `bad-op` and closed", async () => {
  const r = await rig();
  for (const tab of ["a", "0123456789abcdef", "A_b-C", "x".repeat(32)]) await (await join(r, "viewer", { tab, client: "ok" })).close();
  for (const tab of ["", "x".repeat(33), "a b", "a:b", "a.b", "é", 7, null, ["a"], { a: 1 }]) {
    const s = await r.sock(); s.send(hello(r, "editor", { tab }));
    expect((await s.whenClosed()).code).toBe(1008);
    expect(s.msgs[0]).toMatchObject({ t: "error", code: "bad-op" });
  }
  expect(r.inbox.some(m => m.msg?.tab !== undefined)).toBe(false);            // the tab is never forwarded to the room
  await r.stop();
});

test("a writer hello with a tab is forwarded to the room without the tab", async () => {
  const r = await rig();
  const s = await join(r, "editor", { tab: "fwd", client: "fwd" });
  const h = r.inbox.find(m => m.msg?.t === "hello" && m.client === "fwd");
  expect(h).toBeTruthy();
  expect(h.msg.tab).toBeUndefined();
  await s.close(); await r.stop();
});

test("here.viewers: two connections of one tab count once, two tabs twice, no-tab connections one each", async () => {
  const r = await rig(FAST);
  const obs = await join(r, "editor");                                        // a writer watching `here`
  const a1 = await join(r, "viewer", { tab: "tabA", client: "v1" });
  const a2 = await join(r, "viewer", { tab: "tabA", client: "v2" });         // a reconnect overlapping a1
  await viewersSettle(obs, 1);
  expect(allViewers(obs).some(v => v >= 2)).toBe(false);                      // never counted the second connection
  const b = await join(r, "viewer", { tab: "tabB", client: "v3" });
  await viewersSettle(obs, 2);
  const n1 = await join(r, "viewer", { client: "n1" }), n2 = await join(r, "viewer", { client: "n2" });
  await viewersSettle(obs, 4);                                                // each no-tab connection is its own tab
  await r.registry.setGrant(r.ids.board, "dev:stranger", "viewer");          // a second viewer user…
  const s1 = await join(r, "stranger", { tab: "tabA", client: "s1" });       // …on the same tab string: another tab
  await viewersSettle(obs, 5);
  await s1.close(); await viewersSettle(obs, 4);
  // Closing one of tabA's two connections keeps tabA counted; closing the last drops it.
  await a1.close(); await viewersSettle(obs, 4);
  await a2.close(); await viewersSettle(obs, 3);
  for (const s of [b, n1, n2]) await s.close();
  await viewersSettle(obs, 0);
  await r.stop();
}, 30_000);

test("writer cap: 8 tabs ok, a 9th tab refused; a 2nd connection of an open tab still gets in at the cap", async () => {
  const r = await rig();
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push(await join(r, "editor", { tab: "t" + i, client: "c" + i }));
  expect(await refused(r, "editor", { tab: "t8", client: "c8" })).toEqual([CAP8]);
  const again = await join(r, "editor", { tab: "t3", client: "c3b" });      // a reconnect of tab t3: not a ninth tab
  expect(await refused(r, "editor", { client: "notab" })).toEqual([CAP8]);  // a no-tab hello is a new tab
  await join(r, "owner", { tab: "t8" });                                      // other users are not counted
  await again.close(); await sleep(30);
  expect(await refused(r, "editor", { tab: "t8", client: "c8" })).toEqual([CAP8]);   // t3 still open: still 8 tabs
  await eight[3].close(); await sleep(30);
  await join(r, "editor", { tab: "t8", client: "c8" });                       // t3's last connection closed: a slot
  await r.stop();
});

test("cap evasion: a 3rd writer connection on one tab is refused `limit`; viewers are not capped per tab", async () => {
  const r = await rig();
  const one = await join(r, "editor", { tab: "same", client: "a" });
  await join(r, "editor", { tab: "same", client: "b" });
  expect(await refused(r, "editor", { tab: "same", client: "c" })).toEqual([CAP_TAB]);
  await join(r, "editor0", { tab: "same", client: "a" });                    // the same tab string from another user is another tab
  for (let i = 0; i < 4; i++) await join(r, "viewer", { tab: "same", client: "v" + i });
  await one.close(); await sleep(30);
  await join(r, "editor", { tab: "same", client: "c" });                      // a slot on the tab frees on close
  await r.stop();
});

test("no tab = its own tab: 8 no-tab writer connections, then the 9th is refused (as before hello.tab)", async () => {
  const r = await rig();
  for (let i = 0; i < 8; i++) await join(r, "editor", { client: "n" + i });
  expect(await refused(r, "editor", { client: "n8" })).toEqual([CAP8]);
  await r.stop();
});

test("churn leaves no count behind: open/close, refusals and sockets closed mid-hello, then 8 fresh tabs and viewers 0", async () => {
  const r = await rig({ ...FAST, verifyDelayMs: 5 });
  const obs = await join(r, "owner");
  for (let round = 0; round < 5; round++) {
    const open = [];
    for (let i = 0; i < 8; i++) open.push(await join(r, "editor", { tab: "r" + i, client: `c${round}-${i}` }));
    open.push(await join(r, "editor", { tab: "r0", client: `d${round}` }));  // a second connection on one tab
    expect(await refused(r, "editor", { tab: "r0", client: `e${round}` })).toEqual([CAP_TAB]);
    expect(await refused(r, "editor", { tab: "r9", client: `f${round}` })).toEqual([CAP8]);
    for (let i = 0; i < 3; i++) open.push(await join(r, "viewer", { tab: i < 2 ? "vt" : undefined, client: `v${round}-${i}` }));
    // Sockets that close while their hello waits on sign-in (verifyDelayMs): never counted, never leaked.
    for (let i = 0; i < 3; i++) { const s = await r.sock(); s.send(hello(r, i ? "viewer" : "editor", { tab: "gone" + i })); s.ws.close(); }
    await Promise.all(open.map(s => s.close()));
  }
  await sleep(50);
  await viewersSettle(obs, 0);
  // The tab whose hellos were cut mid-sign-in (5 times) holds nothing: it takes its 2 connections.
  const g = [await join(r, "editor", { tab: "gone0", client: "g0" }), await join(r, "editor", { tab: "gone0", client: "g1" })];
  for (const s of g) await s.close();
  await sleep(30);
  for (let i = 0; i < 8; i++) await join(r, "editor", { tab: "fresh" + i, client: "z" + i });
  expect(await refused(r, "editor", { tab: "fresh8", client: "z8" })).toEqual([CAP8]);
  await r.stop();
}, 60_000);

test("hellos that wait together are capped in the go-live step: 3 on one tab = 2 in, 9 tabs = 8 in", async () => {
  const r = await rig();
  // Slow the step after the first cap check (writers wait for their room), so every hello passes that check before
  // any goes live: only the re-check in the go-live step can then cap them.
  const open = r.server.rooms.open.bind(r.server.rooms);
  r.server.rooms.open = async (...a) => { await sleep(150); return open(...a); };
  const race = async (n, tabOf) => {
    const socks = [];
    for (let i = 0; i < n; i++) socks.push(await r.sock());
    socks.forEach((s, i) => s.send(hello(r, "editor", { tab: tabOf(i), client: "r" + i })));   // all before any is verified
    await Promise.all(socks.map(s => Promise.race([s.next(m => m.t === "welcome"), s.whenClosed()])));
    return socks;
  };
  const one = await race(3, () => "same");
  expect(one.filter(s => s.msgs.some(m => m.t === "welcome")).length).toBe(2);
  expect(one.flatMap(s => s.msgs.filter(m => m.t === "error"))).toEqual([CAP_TAB]);
  await Promise.all(one.map(s => s.closed ? null : s.close())); await sleep(30);
  const nine = await race(9, i => "t" + i);
  expect(nine.filter(s => s.msgs.some(m => m.t === "welcome")).length).toBe(8);
  expect(nine.flatMap(s => s.msgs.filter(m => m.t === "error"))).toEqual([CAP8]);
  await r.stop();
});
