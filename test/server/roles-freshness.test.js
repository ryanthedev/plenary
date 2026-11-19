// Roles #50, freshness end to end: a role edit that lowers what a role gives reaches an OPEN socket through the real announcement scheduler
// (spaces.js announceChange -> boardsIn -> the bus's `.grants` subject -> the gateway's re-check): the socket is told `unavailable` and closed, the
// reconnect gets the lower step, a write is `forbidden`, and the removed management permission is gone from the very next access answer.
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
import { tenancy } from "../../server/auth/tenancy.js";
import { spaceService } from "../../server/auth/spaces.js";
import { rolesService } from "../../server/auth/roles.js";
import { makeElement } from "../../packages/core/model.js";
import { sock } from "./rig.js";
import { tempDir, cleanup, until } from "./helpers.js";

afterAll(cleanup);
const tok = n => `S3CR3T-fresh-${n}`;
const rect = (id, x) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const op = (client, k) => ({ t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`${client}-${k}`, k)] } });
const who = n => ({ user: `dev:${n}`, name: n, email: `${n}@acme.test`, domain: "acme.test" });

test("DW-50.3: a role edit lowers an open socket's step and removes a management permission within one re-check pass", async () => {
  const dir = tempDir(), bus = memoryBus(), registry = memoryRegistry(), store = sqliteStore({ path: join(dir, "plenary.db") });
  const tenant = await registry.createTenant({ domain: "acme.test", admins: ["dev:root"] });
  const space = await registry.createSpace({ tenant: tenant.id, name: "S", generalRole: null, owner: "dev:root" });
  const board = await registry.createBoard({ tenant: tenant.id, title: "b", space: space.id });
  const role = await registry.createRole({ tenant: tenant.id, name: "Presenter", boardRole: "editor", permissions: ["move", "board.create"] });
  await registry.setScopedGrant({ scope: { type: "space", id: space.id }, subject: { type: "user", id: "dev:ed1" }, role: role.id });
  const ten = tenancy({ registry });
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(["ed1", "root"].map(n => [tok(n), { name: n, domain: "acme.test", email: `${n}@acme.test` }])) });
  const server = createServer({ auth: authPort({ dev, tenancy: ten }), registry, store, bus, log: createLogger({ write: () => {}, level: "error" }), port: 0, static: false, limits: { opRate: 1e6, opBurst: 1e6 } });
  const spaces = spaceService({ registry, tenancy: ten, announce: async (t, b) => { await bus.publish(subjects.grants(t, b), { board: b }); } });
  const roles = rolesService({ registry, tenancy: ten, announce: spaces.announceChange });
  const open = async () => {
    const s = await sock(server.wsUrl);
    s.send({ t: "hello", v: 1, token: tok("ed1"), board: board.id, since: 0, client: "ed1" });
    const got = await until(() => s.msgs.find(m => m.t === "welcome") ?? (s.closed ? "closed" : null), "a welcome", 15_000);
    return { s, got };
  };
  try {
    const a = await open();
    expect(a.got).toMatchObject({ t: "welcome", role: "editor" });
    a.s.send(op("ed1", 1));
    await a.s.next(m => m.t === "ack" && m.id === "ed1:1", "the first ack", 10_000);
    expect((await ten.effective(who("ed1"), { type: "space", id: space.id })).permissions.has("move")).toBe(true);

    // The admin lowers the step and drops `move`: one announcement of the Unit, through the scheduler.
    await roles.update(who("root"), role.id, { boardRole: "viewer", permissions: ["board.create"] });
    const t0 = Date.now();
    const closed = await a.s.whenClosed(10_000);                       // the `.grants` pass closes it; no 60 s timer is waited for
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(closed.code).toBe(1012);
    expect(a.s.msgs.filter(m => m.t === "error").map(m => m.code)).toContain("unavailable");
    await spaces.settled();

    const b = await open();                                            // the reconnect reads the lower step
    expect(b.got).toMatchObject({ t: "welcome", role: "viewer" });
    b.s.send(op("ed1", 2));
    expect((await b.s.next(m => m.t === "error" && m.code === "forbidden", "forbidden", 10_000)).code).toBe("forbidden");
    const after = await ten.effective(who("ed1"), { type: "space", id: space.id });
    expect([after.permissions.has("move"), after.permissions.has("board.create"), after.ladder]).toEqual([false, true, "viewer"]);
    b.s.close();
  } finally { spaces.close(); await server.stop(); await bus.close(); await store.close(); }
}, 40_000);
