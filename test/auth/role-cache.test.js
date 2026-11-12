// p5-load (p-audit F4, F8): the role cache and the batched lookup in server/auth/tenancy.js, the optional
// Registry batch `linkUsesFor`, and share-link redemption no longer announcing on `grants` (server/main.js).
import { test, expect, beforeEach } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy, roleCache, combine, USE_CHUNK } from "../../server/auth/tenancy.js";
import { memoryBus } from "../../server/bus/memory.js";
import { subjects } from "../../server/bus/port.js";
import { announcingRegistry } from "../../server/main.js";

const T0 = Date.UTC(2026, 10, 12);
let clock, raw, reg, calls, acme, board;
const now = () => clock.t;
const id = (user, domain = "acme.com", email = `${user.split(":")[1]}@${domain ?? "gmail.com"}`) => ({ user, name: user, email, domain });

/** Counts every Registry method call; `drop` lists methods to hide (an adapter without the batch). */
function counting(r, { drop = [] } = {}) {
  const c = {};
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "function" || drop.includes(k)) continue;
    out[k] = (...a) => { c[k] = (c[k] ?? 0) + 1; return v(...a); };
  }
  return { reg: out, calls: c, total: () => Object.values(c).reduce((a, b) => a + b, 0), reset: () => { for (const k in c) delete c[k]; } };
}

beforeEach(async () => {
  clock = { t: T0 };
  raw = memoryRegistry({ now });
  acme = await raw.createTenant({ domain: "acme.com", admins: ["google:root"] });
  board = await raw.createBoard({ tenant: acme.id, title: "All hands", memberRole: "viewer" });
  await raw.setGrant(board.id, "google:root", "owner");
  ({ reg, calls } = counting(raw));
});

// ---- the cache's consistency rules ----

test("a revoke, then invalidate(board, user), then role → null (the cache never grants after it)", async () => {
  const cache = roleCache({ registry: reg, now });
  const gus = id("google:gus", null);
  await raw.setGrant(board.id, gus.user, "editor");
  expect(await cache.role(gus, board.id)).toBe("editor");
  expect(await cache.role(gus, board.id)).toBe("editor");
  expect(cache.stats().hits).toBe(1);
  await raw.setGrant(board.id, gus.user, null);
  cache.invalidate(board.id, gus.user);
  expect(await cache.role(gus, board.id)).toBe(null);
  // the whole-board form too
  await raw.setGrant(board.id, gus.user, "editor");
  expect(await cache.role(gus, board.id)).toBe("editor");
  await raw.setGrant(board.id, gus.user, null);
  cache.invalidate(board.id);
  expect(await cache.role(gus, board.id)).toBe(null);
});

test("a revoke whose `grants` message was lost: the next rolesFor (timed pass) reads fresh and evicts; else the TTL", async () => {
  const cache = roleCache({ registry: reg, now, ttlMs: 30_000 });
  const gus = id("google:gus", null), hal = id("google:hal", null);
  await raw.setGrant(board.id, gus.user, "editor");
  await raw.setGrant(board.id, hal.user, "editor");
  expect(await cache.role(gus, board.id)).toBe("editor");
  expect(await cache.role(hal, board.id)).toBe("editor");
  await raw.setGrant(board.id, gus.user, null);
  await raw.setGrant(board.id, hal.user, null);
  expect(await cache.role(gus, board.id)).toBe("editor");      // stale: no message reached this node
  // rolesFor alone is fresh and writes through for the users it read...
  expect((await cache.rolesFor(board.id, [gus])).get(gus.user)).toBe(null);
  expect(await cache.role(gus, board.id)).toBe(null);
  expect(await cache.role(hal, board.id)).toBe("editor");        // ...hal was not in it
  // the timed pass (the gateway patch): invalidate(board), then rolesFor over its live users (gus only, hal has no
  // socket here): every other entry of the board is gone too
  cache.invalidate(board.id);
  expect((await cache.rolesFor(board.id, [gus])).get(gus.user)).toBe(null);
  expect(await cache.role(gus, board.id)).toBe(null);
  expect(await cache.role(hal, board.id)).toBe(null);
  // and with no pass at all, the TTL ends it
  await raw.setGrant(board.id, gus.user, "editor");
  expect(await cache.role(gus, board.id)).toBe("editor");
  await raw.setGrant(board.id, gus.user, null);
  clock.t += 29_999;
  expect(await cache.role(gus, board.id)).toBe("editor");
  clock.t += 1;
  expect(await cache.role(gus, board.id)).toBe(null);
});

test("expiry without a message: an entry lives no longer than the soonest invite or link it depended on", async () => {
  const cache = roleCache({ registry: reg, now, ttlMs: 30_000 });
  const gus = id("google:gus", null, "gus@gmail.com");
  const link = await raw.createLink({ board: board.id, role: "editor", expiresAt: T0 + 5_000, by: "google:root" });
  await raw.addLinkUse(link.id, gus.user);
  const inv = await raw.createInvite({ board: board.id, email: gus.email, role: "annotator", expiresAt: T0 + 10_000, by: "google:root" });
  expect(await cache.role(gus, board.id)).toBe("editor");
  clock.t = T0 + 4_999;
  expect(await cache.role(gus, board.id)).toBe("editor");
  clock.t = T0 + 5_000;                                           // the link (and the memoized link record) expired
  expect(await cache.role(gus, board.id)).toBe("annotator");
  clock.t = T0 + 10_000;
  expect(await cache.role(gus, board.id)).toBe(null);
  expect(inv.expiresAt).toBe(T0 + 10_000);
  // the same through rolesFor's write-through
  const l2 = await raw.createLink({ board: board.id, role: "viewer", expiresAt: clock.t + 1_000, by: "google:root" });
  await raw.addLinkUse(l2.id, gus.user);
  expect((await cache.rolesFor(board.id, [gus])).get(gus.user)).toBe("viewer");
  expect(await cache.role(gus, board.id)).toBe("viewer");
  const misses = cache.stats().misses;
  clock.t += 1_000;
  expect(await cache.role(gus, board.id)).toBe(null);
  expect(cache.stats().misses).toBe(misses + 1);
});

test("a revoked link (revokeLink announces { board }): invalidate(board) drops the memoized link record too", async () => {
  const cache = roleCache({ registry: reg, now });
  const gus = id("google:gus", null), hal = id("google:hal", null);
  const link = await raw.createLink({ board: board.id, role: "editor", by: "google:root" });
  await raw.addLinkUse(link.id, gus.user);
  await raw.addLinkUse(link.id, hal.user);
  expect(await cache.role(gus, board.id)).toBe("editor");
  await raw.revokeLink(link.id);
  cache.invalidate(board.id);
  expect(await cache.role(hal, board.id)).toBe(null);             // hal was never cached: its read uses the link record
  expect(await cache.role(gus, board.id)).toBe(null);
});

test("a read in flight across an invalidation never fills the cache; a per-user invalidation spares other users", async () => {
  let gate = null;
  const slow = { ...reg, grant: async (b, u) => { const v = await reg.grant(b, u); if (gate) await gate.promise; return v; } };
  const cache = roleCache({ registry: slow, now });
  const gus = id("google:gus", null), hal = id("google:hal", null);
  await raw.setGrant(board.id, gus.user, "editor");
  await raw.setGrant(board.id, hal.user, "editor");
  let open; gate = { promise: new Promise(r => { open = r; }) };
  const pg = cache.role(gus, board.id), ph = cache.role(hal, board.id);
  await new Promise(r => setTimeout(r, 0));
  await raw.setGrant(board.id, gus.user, null);                    // lands after both reads saw "editor"
  cache.invalidate(board.id, gus.user);
  gate = null; open();
  expect(await pg).toBe("editor");                                 // that answer is the hello's (its gen check re-asks)
  expect(await ph).toBe("editor");
  expect(await cache.role(gus, board.id)).toBe(null);             // not cached: re-read
  const s = cache.stats();
  expect(s.discarded).toBe(1);
  expect(await cache.role(hal, board.id)).toBe("editor");
  expect(cache.stats().hits).toBe(s.hits + 1);                     // hal's fill was kept
  // a whole-board invalidation during a read discards it
  gate = { promise: new Promise(r => { open = r; }) };
  cache.invalidate(board.id);
  const p2 = cache.role(hal, board.id);
  await new Promise(r => setTimeout(r, 0));
  await raw.setGrant(board.id, hal.user, null);
  cache.invalidate(board.id);
  gate = null; open();
  expect(await p2).toBe("editor");
  expect(await cache.role(hal, board.id)).toBe(null);
});

test("a reader that starts after an invalidation never joins a link read that began before it", async () => {
  let gate = null;
  const slow = { ...reg, link: async l => { const v = await reg.link(l); if (gate) await gate.promise; return v; } };
  const cache = roleCache({ registry: slow, now });
  const gus = id("google:gus", null), hal = id("google:hal", null);
  const link = await raw.createLink({ board: board.id, role: "editor", by: "google:root" });
  await raw.addLinkUse(link.id, gus.user);
  await raw.addLinkUse(link.id, hal.user);
  let open; gate = { promise: new Promise(r => { open = r; }) };
  const pa = cache.role(gus, board.id);
  await new Promise(r => setTimeout(r, 0));                         // gus's link read is in flight (saw it live)
  await raw.revokeLink(link.id);
  cache.invalidate(board.id);
  gate = null;                                                      // a fresh read from here on is not held
  const pb = cache.role(hal, board.id);                             // began after the invalidation
  expect(await pb).toBe(null);
  open();
  expect(await pa).toBe("editor");                                  // the old answer, only to the reader that began before
  expect(await cache.role(gus, board.id)).toBe(null);              // and it was not cached
});

test("a hello's read in flight during rolesFor never overwrites the fresher write-through", async () => {
  let gate = null;
  const slow = { ...reg, grant: async (b, u) => { const v = await reg.grant(b, u); if (gate) await gate.promise; return v; } };
  const cache = roleCache({ registry: slow, now });
  const gus = id("google:gus", null);
  await raw.setGrant(board.id, gus.user, "editor");
  let open; gate = { promise: new Promise(r => { open = r; }) };
  const hello = cache.role(gus, board.id);                          // reads "editor", held
  await new Promise(r => setTimeout(r, 0));
  await raw.setGrant(board.id, gus.user, "viewer");                 // the message was lost
  expect((await cache.rolesFor(board.id, [gus])).get(gus.user)).toBe("viewer");   // grants(board): not held
  gate = null; open();
  expect(await hello).toBe("editor");
  expect(await cache.role(gus, board.id)).toBe("viewer");          // the write-through stands
});

test("null is never cached; an identity with another email or domain misses; errors are never cached", async () => {
  const cache = roleCache({ registry: reg, now });
  const gus = id("google:gus", null, "gus@gmail.com");
  expect(await cache.role(gus, board.id)).toBe(null);
  await raw.createInvite({ board: board.id, email: gus.email, role: "editor", by: "google:root" });   // no invalidate
  expect(await cache.role(gus, board.id)).toBe("editor");
  expect(await cache.role({ ...gus, email: "other@gmail.com" }, board.id)).toBe(null);
  const ann = id("google:ann");
  expect(await cache.role(ann, board.id)).toBe("viewer");
  expect(await cache.role({ ...ann, domain: "globex.com" }, board.id)).toBe(null);
  let fail = true;
  const flaky = roleCache({ registry: { ...reg, grant: async (b, u) => { if (fail) throw new Error("down"); return reg.grant(b, u); } }, now });
  await expect(flaky.role(ann, board.id)).rejects.toThrow("down");
  fail = false;
  expect(await flaky.role(ann, board.id)).toBe("viewer");
  fail = true;
  await expect(flaky.rolesFor(board.id, [ann])).resolves.toBeInstanceOf(Map);   // rolesFor reads grants(board), not grant()
  expect(await flaky.role(ann, board.id)).toBe("viewer");                         // ...and refilled ann
});

test("maxEntries bounds the cache (oldest dropped)", async () => {
  const cache = roleCache({ registry: reg, now, maxEntries: 3 });
  for (let i = 0; i < 5; i++) await cache.role(id(`google:m${i}`), board.id);
  expect(cache.stats().entries).toBe(3);
  const m = cache.stats().misses;
  await cache.role(id("google:m0"), board.id);
  expect(cache.stats().misses).toBe(m + 1);
});

// ---- one rule: role(), rolesFor() and the cache agree on random registries ----

test("differential: tenancy.role, tenancy.rolesFor (batch and fallback) and roleCache agree on random registries", async () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const ROLE = ["owner", "editor", "annotator", "commenter", "viewer", "bogus", null];
  for (let round = 0; round < 25; round++) {
    clock = { t: T0 };
    const r = memoryRegistry({ now });
    const t = await r.createTenant({ domain: "acme.com" });
    const other = await r.createBoard({ tenant: t.id });
    const b = await r.createBoard({ tenant: t.id, memberRole: ROLE[rnd(ROLE.length)] });
    const people = Array.from({ length: 30 }, (_, i) => id(`google:p${i}`, [null, "acme.com", "globex.com"][rnd(3)], rnd(4) ? `P${i}@x.com` : null));
    const links = [];
    for (let i = 0; i < 6; i++) links.push(await r.createLink({ board: rnd(4) ? b.id : other.id, role: ROLE[rnd(5)], expiresAt: rnd(2) ? T0 + rnd(3) * 1000 - 1000 : null, by: "x" }));
    for (const l of links) if (rnd(3) === 0) await r.revokeLink(l.id);
    for (const p of people) {
      if (rnd(3) === 0) await r.setGrant(b.id, p.user, ROLE[rnd(6)]);
      if (p.email && rnd(3) === 0) { const i = await r.createInvite({ board: b.id, email: p.email.toLowerCase(), role: ROLE[rnd(6)], expiresAt: rnd(2) ? T0 + 500 : null, by: "x" }); if (rnd(4) === 0) await r.revokeInvite(i.id); }
      for (let k = rnd(3); k > 0; k--) await r.addLinkUse(links[rnd(links.length)].id, p.user);
    }
    const ten = tenancy({ registry: r, now });
    const fallback = tenancy({ registry: counting(r, { drop: ["linkUsesFor"] }).reg, now });
    const cache = roleCache({ registry: r, now });
    clock.t = T0 + rnd(2000);
    const batch = await ten.rolesFor(b.id, people), fb = await fallback.rolesFor(b.id, people);
    for (const p of people) {
      const one = await ten.role(p, b.id);
      expect(batch.get(p.user)).toBe(one);
      expect(fb.get(p.user)).toBe(one);
      expect(await cache.role(p, b.id)).toBe(one);
      expect(await cache.role(p, b.id)).toBe(one);
    }
  }
});

test("rolesFor: unknown board → every user null; users deduplicated; chunks of USE_CHUNK", async () => {
  const ten = tenancy({ registry: reg, now });
  const people = Array.from({ length: USE_CHUNK + 1 }, (_, i) => id(`google:c${i}`));
  const m = await ten.rolesFor(board.id, [...people, people[0]]);
  expect(m.size).toBe(USE_CHUNK + 1);
  expect(calls.linkUsesFor).toBe(2);
  expect(m.get("google:c0")).toBe("viewer");
  const none = await ten.rolesFor("b-nope", people.slice(0, 2));
  expect([...none.values()]).toEqual([null, null]);
  expect(combine({ board, tenant: acme, grant: null, invites: [], links: [] }, id("google:z"), T0)).toEqual({ role: "viewer", until: Infinity });
});

// ---- F4: share-link redemption no longer announces ----

test("announcingRegistry: addLinkUse announces nothing; grants, invites and links still announce { board }", async () => {
  const bus = memoryBus();
  const got = [];
  bus.subscribe(subjects.grants(acme.id, board.id), m => got.push(m));
  const log = { warn: () => {} };
  const a = announcingRegistry(raw, bus, log);
  const link = await a.createLink({ board: board.id, role: "editor", by: "google:root" });
  await bus.flush();
  expect(got).toEqual([{ board: board.id }]);
  got.length = 0;
  await a.addLinkUse(link.id, "google:gus");
  await tenancy({ registry: a, now }).redeemLink(id("google:hal"), link.id);
  await bus.flush();
  expect(got).toEqual([]);
  expect(await raw.linkUses(board.id, "google:hal")).toEqual([link.id]);
  await a.setGrant(board.id, "google:gus", "editor");
  await a.revokeLink(link.id);
  const inv = await a.createInvite({ board: board.id, email: "x@y.z", role: "viewer", by: "google:root" });
  await a.revokeInvite(inv.id);
  await bus.flush();
  expect(got.length).toBe(4);
  expect(got.every(m => m.board === board.id && Object.keys(m).length === 1)).toBe(true);
});

test("redemption cost: a share-link use costs 2 Registry queries (link, addLinkUse) once the wave is warm", async () => {
  const link = await raw.createLink({ board: board.id, role: "viewer", by: "google:root" });
  const c = counting(raw);
  const ten = tenancy({ registry: announcingRegistry(c.reg, memoryBus(), { warn: () => {} }), now });
  await ten.redeemLink(id("google:w0"), link.id);
  const first = c.total(); c.reset();
  await ten.redeemLink(id("google:w1"), link.id);
  console.log(`p5-load redemption queries: first ${first}, then ${c.total()} (${JSON.stringify(c.calls)})`);
  expect(c.calls).toEqual({ link: 1, addLinkUse: 1 });
});

// ---- F8: Registry queries, before and after (numbers go in docs/m2/reports/p5-load.md) ----

test("query counts: hello cold/warm and a timed pass over 1,000 users on one board", async () => {
  // 1,000 users: 500 Workspace members (memberRole), 250 guests by invite, 250 guests by one shared link; 50 grants.
  const link = await raw.createLink({ board: board.id, role: "annotator", by: "google:root" });
  const users = [];
  for (let i = 0; i < 1000; i++) {
    let u;
    if (i < 500) u = id(`google:m${i}`);
    else if (i < 750) { u = id(`google:i${i}`, null, `i${i}@guest.com`); await raw.createInvite({ board: board.id, email: u.email, role: "commenter", by: "google:root" }); }
    else { u = id(`google:l${i}`, null, `l${i}@guest.com`); await raw.addLinkUse(link.id, u.user); }
    if (i % 20 === 0) await raw.setGrant(board.id, u.user, "editor");
    users.push(u);
  }
  const n = {};
  const measure = async (label, fn, opts) => { const c = counting(raw, opts); await fn(c.reg); n[label] = c.total(); return c; };

  // before: tenancy.role per hello and per user (today's gateway); the gateway's own registry.board adds 1 per hello
  const linkGuest = users[800];
  await measure("before: hello (link guest)", r => tenancy({ registry: r, now }).role(linkGuest, board.id));
  await measure("before: hello (member)", r => tenancy({ registry: r, now }).role(users[1], board.id));
  await measure("before: timed pass, 1000 users", async r => { const t = tenancy({ registry: r, now }); for (const u of users) await t.role(u, board.id); });

  // after: one cache per gateway process
  const c = counting(raw);
  const cache = roleCache({ registry: c.reg, now });
  const step = async (label, fn) => { c.reset(); await fn(); n[label] = c.total(); };
  await step("after: hello cold, board's first (link guest)", () => cache.role(linkGuest, board.id));
  await step("after: hello cold, board warm (another link guest)", () => cache.role(users[801], board.id));
  await step("after: hello cold, board warm (member)", () => cache.role(users[1], board.id));
  await step("after: hello warm (same user again)", () => cache.role(linkGuest, board.id));
  await step("after: timed pass, 1000 users (linkUsesFor)", () => cache.rolesFor(board.id, users));
  await measure("after: timed pass, 1000 users (no linkUsesFor: SQLite/Postgres today)", r => roleCache({ registry: r, now }).rolesFor(board.id, users), { drop: ["linkUsesFor"] });

  console.log("p5-load query counts\n" + Object.entries(n).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  expect(n["before: hello (link guest)"]).toBe(5);                   // board, grant, invitesFor, linkUses, link
  expect(n["before: timed pass, 1000 users"]).toBeGreaterThanOrEqual(4000);
  expect(n["after: hello cold, board warm (another link guest)"]).toBe(3);  // grant, invitesFor, linkUses
  expect(n["after: hello warm (same user again)"]).toBe(0);
  expect(n["after: timed pass, 1000 users (linkUsesFor)"]).toBeLessThanOrEqual(7);
  expect(n["after: timed pass, 1000 users (no linkUsesFor: SQLite/Postgres today)"]).toBeLessThanOrEqual(1006);
});
