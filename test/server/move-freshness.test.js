// Move board #53, freshness end to end: moving a board announces `{ board }` through the announcing Registry, an OPEN socket whose access came from the old Space is
// told `unavailable` and closed within one re-check pass (no 60 s timer waited for), the reconnect is refused, and a person who gains access through the new Space is let in.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { createServer } from "../../server/server.js";
import { createLogger } from "../../server/log.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus } from "../../server/bus/memory.js";
import { subjects } from "../../server/bus/port.js";
import { authPort } from "../../server/auth/port.js";
import { devAuth } from "../../server/auth/dev.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy, roleCache } from "../../server/auth/tenancy.js";
import { spaceService } from "../../server/auth/spaces.js";
import { moveService } from "../../server/auth/move.js";
import { announcingRegistry } from "../../server/main.js";
import { sock } from "./rig.js";
import { tempDir, cleanup, until } from "./helpers.js";

afterAll(cleanup);
const tok = n => `S3CR3T-move-${n}`;
const who = n => ({ user: `dev:${n}`, name: n, email: `${n}@acme.test`, domain: "acme.test" });

test("DW-53.4: a move cuts a socket whose access came from the old Space within one pass; the new Space's people get in", async () => {
  const dir = tempDir(), bus = memoryBus(), raw = memoryRegistry(), store = sqliteStore({ path: join(dir, "plenary.db") });
  const registry = announcingRegistry(raw, bus, { warn() {} });
  const tenant = await registry.createTenant({ domain: "acme.test", admins: ["dev:root"] });
  const a = await registry.createSpace({ tenant: tenant.id, name: "A", generalRole: null, owner: "dev:own" });
  const b = await registry.createSpace({ tenant: tenant.id, name: "B", generalRole: null, owner: "dev:own" });
  await registry.setScopedGrant({ scope: { type: "space", id: a.id }, subject: { type: "user", id: "dev:old" }, role: "editor" });
  await registry.setScopedGrant({ scope: { type: "space", id: b.id }, subject: { type: "user", id: "dev:new" }, role: "editor" });
  const board = await registry.createBoard({ tenant: tenant.id, title: "b", space: a.id, owner: "dev:own" });
  const ten = tenancy({ registry });
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(["old", "new", "own"].map(n => [tok(n), { name: n, domain: "acme.test", email: `${n}@acme.test` }])) });
  const server = createServer({ auth: authPort({ dev, tenancy: roleCache({ registry }) }), registry, store, bus, log: createLogger({ write: () => {}, level: "error" }), port: 0, static: false, limits: { opRate: 1e6, opBurst: 1e6 } });
  const mv = moveService({ registry, tenancy: ten, spaces: spaceService({ registry, tenancy: ten }) });
  const open = async n => {
    const s = await sock(server.wsUrl);
    s.send({ t: "hello", v: 1, token: tok(n), board: board.id, since: 0, client: n });
    const got = await until(() => s.msgs.find(m => m.t === "welcome" || m.t === "error") ?? (s.closed ? "closed" : null), "an answer", 15_000);
    return { s, got };
  };
  try {
    const old = await open("old");
    expect(old.got).toMatchObject({ t: "welcome", role: "editor" });
    expect((await open("new")).got.t).toBe("error");                                   // not yet
    const seen = [];
    bus.subscribe(subjects.grants(tenant.id, board.id), m => seen.push(m));
    await mv.move(who("own"), board.id, { from: a.id, to: b.id });
    await until(() => (seen.length ? true : null), "the announcement", 5_000);
    expect(seen).toEqual([{ board: board.id }]);
    const t0 = Date.now();
    const closed = await old.s.whenClosed(10_000);
    expect(Date.now() - t0).toBeLessThan(10_000);                                      // never the 60 s timer
    expect(closed.code).toBe(1008);                                                    // access gone: a policy close (a lowered step is 1012)
    expect((await open("old")).got).toMatchObject({ t: "error" });                     // the reconnect is refused: the old Space no longer reaches the board
    const fresh = await open("new");
    expect(fresh.got).toMatchObject({ t: "welcome", role: "editor" });                 // and the new Space's people get in at once
    fresh.s.close();
  } finally { await server.stop(); await bus.close(); await store.close(); }
}, 40_000);
