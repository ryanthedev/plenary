// The served page's dev sign-in menu (GET /auth/dev): present only while PLENARY_DEV_TOKENS is on, with the dev board
// and each dev user's own token; with dev off there is no such route and the page offers nothing.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, devMenuOff } from "../../server/main.js";
import { run as bootstrap } from "../../scripts/admin-bootstrap.js";

const made = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "plenary-devmenu-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const env = (extra = {}) => ({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "error", ...extra });

const TOK = JSON.stringify({ "tok-a": { name: "ada", role: "owner" }, "tok-b": { name: "bo" }, "tok-b2": { name: "bo", role: "viewer" } });
const get = (app, path = "/auth/dev", headers = {}) => fetch(app.server.url + path, { headers });

test("dev on (loopback, no Google, gateway): GET /auth/dev gives the dev board and each user once, with its own token and the role it is granted", async () => {
  const app = await start(env({ PLENARY_DEV_TOKENS: TOK }));
  try {
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // bo has two tokens: the menu lists the first token, with the HIGHEST role (editor), which is what bo is granted.
    expect(await res.json()).toEqual({ board: app.devBoard, users: [{ name: "ada", token: "tok-a", role: "owner" }, { name: "bo", token: "tok-b", role: "editor" }] });
    expect(await app.registry.grant(app.devBoard, "dev:bo")).toBe("editor");
  } finally { await app.stop(); }
});

test("a token with admin or a domain is never published; if none is left to offer the menu is off", async () => {
  const mixed = JSON.stringify({ "tok-a": { name: "ada", role: "owner" }, "tok-adm": { name: "ann", domain: "acme.test", admin: true }, "tok-dom": { name: "dom", domain: "acme.test" }, "tok-x": { name: "xa", admin: true } });
  const app = await start(env({ PLENARY_DEV_TOKENS: mixed }));
  try {
    const body = await (await get(app)).json();
    expect(body.users).toEqual([{ name: "ada", token: "tok-a", role: "owner" }]);
    expect(JSON.stringify(body)).not.toMatch(/tok-adm|tok-dom|tok-x|ann|acme/);
  } finally { await app.stop(); }
  const only = await start(env({ PLENARY_DEV_TOKENS: JSON.stringify({ "tok-adm": { name: "ann", domain: "acme.test", admin: true } }) }));
  try { expect((await get(only)).status).toBe(404); } finally { await only.stop(); }
});

test("a name with BOTH an admin/domain token and a plain token is never offered (identity is per name), nor are its tokens", async () => {
  const both = JSON.stringify({ "SECRET-ADM": { name: "ann", domain: "acme.test", admin: true }, "SECRET-PLAIN": { name: "ann", role: "editor" }, "tok-d": { name: "dee", domain: "acme.test" }, "SECRET-D2": { name: "dee" }, "tok-a": { name: "ada", role: "owner" } });
  const app = await start(env({ PLENARY_DEV_TOKENS: both }));
  try {
    const body = await (await get(app)).json();
    expect(body.users).toEqual([{ name: "ada", token: "tok-a", role: "owner" }]);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|ann|dee/);
  } finally { await app.stop(); }
  const none = await start(env({ PLENARY_DEV_TOKENS: JSON.stringify({ "SECRET-ADM": { name: "ann", domain: "acme.test", admin: true }, "SECRET-PLAIN": { name: "ann" } }) }));
  try { expect((await get(none)).status).toBe(404); } finally { await none.stop(); }
});

test("PUBLIC_URL on a loopback name keeps the menu on; Google half-configured warns but does not turn dev off", async () => {
  const lines = [];
  const app = await start(env({ PLENARY_DEV_TOKENS: TOK, PUBLIC_URL: "http://localhost:8099", GOOGLE_CLIENT_ID: "id", LOG_LEVEL: "warn" }), { write: l => lines.push(l) });
  try {
    expect((await get(app)).status).toBe(200);
    expect(lines.join("")).toContain("Google sign-in is half configured: GOOGLE_CLIENT_SECRET is missing");
  } finally { await app.stop(); }
  const l2 = [];
  const b = await start(env({ GOOGLE_CLIENT_SECRET: "s", LOG_LEVEL: "warn" }), { write: l => l2.push(l) });
  try { expect(l2.join("")).toContain("GOOGLE_CLIENT_ID is missing"); } finally { await b.stop(); }
});

test("DNS rebinding: a Host header that is not a loopback name gets 404, loopback names (with a port) get 200", async () => {
  const app = await start(env({ PLENARY_DEV_TOKENS: TOK }));
  try {
    for (const host of ["attacker.example:" + app.server.port, "attacker.example", "127.0.0.1.attacker.example", "10.0.0.5"]) {
      // fetch sets Host from the URL; Bun lets a Host header override it.
      const r = await get(app, "/auth/dev", { Host: host });
      expect([host, r.status]).toEqual([host, 404]);
    }
    for (const host of ["localhost", "localhost:8099", "127.0.0.1", "127.0.0.1:1", "LOCALHOST:3"]) expect([host, (await get(app, "/auth/dev", { Host: host })).status]).toEqual([host, 200]);
  } finally { await app.stop(); }
});

// One 404 per config where the route must not exist (dev off, or the menu forbidden).
const GOOGLE = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
const cases = {
  "unset": {}, "empty string": { PLENARY_DEV_TOKENS: "" }, "empty object": { PLENARY_DEV_TOKENS: "{}" }, "not an object": { PLENARY_DEV_TOKENS: "[1,2]" },
  "Google only": { ...GOOGLE }, "Google plus dev tokens": { ...GOOGLE, PLENARY_DEV_TOKENS: TOK },
  // (HOST=0.0.0.0 is proved by the devMenuOff unit test below: a test must not listen on every interface.)
  "a public PUBLIC_URL plus dev tokens": { PUBLIC_URL: "https://plenary.example.com", PLENARY_DEV_TOKENS: TOK },
};
for (const [name, extra] of Object.entries(cases)) {
  test(`no /auth/dev (404) when: ${name}`, async () => {
    const lines = [];
    const app = await start(env({ ...extra, LOG_LEVEL: "warn" }), { write: l => lines.push(l) });
    try {
      expect((await get(app)).status).toBe(404);
      expect((await get(app, "/auth/dev?as=ada")).status).toBe(404);
      expect((await get(app, "/")).status).toBe(200);
      // Dev tokens set but the menu refused: ONE warn line says why (not for plain "off" configs).
      const refused = lines.join("").split("\n").filter(l => l.includes("dev sign-in menu (GET /auth/dev) is OFF"));
      expect(refused.length).toBe(name.includes("plus dev") ? 1 : 0);
      expect(lines.join("")).not.toContain("dev sign-in menu is ON");
    } finally { await app.stop(); }
  });
}

test("the startup log names /auth/dev, how many users it publishes and the bind host when the menu is ON", async () => {
  const lines = [];
  const app = await start(env({ PLENARY_DEV_TOKENS: TOK, LOG_LEVEL: "warn" }), { write: l => lines.push(l) });
  try {
    const on = lines.join("").split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).find(l => l?.msg?.includes("dev sign-in menu is ON"));
    expect(on).toMatchObject({ level: "warn", users: 2, host: "127.0.0.1" });
    expect(on.msg).toContain("/auth/dev");
  } finally { await app.stop(); }
});

test("devMenuOff: every reason, and null only for a local, gateway, Google-less run with someone to offer", () => {
  const ok = { users: 1, host: "127.0.0.1", google: false, gateway: true };
  expect(devMenuOff(ok)).toBeNull();
  for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "LocalHost"]) expect(devMenuOff({ ...ok, host })).toBeNull();
  expect(devMenuOff({ ...ok, gateway: false })).toMatch(/gateway/);        // a host-only cluster node
  expect(devMenuOff({ ...ok, users: 0 })).toMatch(/offerable/);
  expect(devMenuOff({ ...ok, google: true })).toMatch(/Google/);
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", ""]) expect(devMenuOff({ ...ok, host })).toMatch(/not a loopback/);
  expect(devMenuOff({ ...ok, publicHost: "plenary.example.com" })).toMatch(/PUBLIC_URL/);
  for (const publicHost of [null, "localhost", "127.0.0.1", "[::1]"]) expect(devMenuOff({ ...ok, publicHost })).toBeNull();
});

test("the served page can load the dev menu adapter and the favicon; the in-browser dev table stays denied", async () => {
  const app = await start(env());
  try {
    expect((await get(app, "/adapters/auth/devconfig.js")).status).toBe(200);
    const icon = await get(app, "/favicon.svg");
    expect([icon.status, icon.headers.get("content-type")]).toEqual([200, "image/svg+xml"]);
    expect((await get(app, "/core/dev-users.js")).status).toBe(404);
    expect((await get(app, "/dev-main.html")).status).toBe(404);
  } finally { await app.stop(); }
});

test("HOST reaches the gate: HOST=127.1 binds loopback but is not on the allowed list, so the menu is OFF (404 even with a loopback Host header) and the log says why", async () => {
  const lines = [];
  const app = await start(env({ HOST: "127.1", PLENARY_DEV_TOKENS: TOK, LOG_LEVEL: "warn" }), { write: l => lines.push(l) });
  try {
    expect(app.server.url).toContain("127.1");
    for (const host of [undefined, "localhost"]) expect((await get(app, "/auth/dev", host ? { Host: host } : {})).status).toBe(404);
    const got = lines.join("");
    expect(got).toContain("is OFF: HOST=127.1 is not a loopback address");
    expect(got).not.toContain("dev sign-in menu is ON");
  } finally { await app.stop(); }
});

test("a dev name that is a tenant admin in the persistent Registry is never offered, whichever run made it admin", async () => {
  const dir = tempDir();
  const e = tokens => ({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: JSON.stringify(tokens) });
  // Run 1: an admin token makes dev:ann a tenant admin (stored in the Registry).
  let app = await start(e({ "SECRET-ADM": { name: "ann", domain: "acme.test", admin: true } }));
  await app.stop();
  // Run 2: the same data dir, only a plain token for ann plus ada.
  app = await start(e({ "tok-plain": { name: "ann", role: "editor" }, "tok-a": { name: "ada", role: "owner" } }));
  try {
    const body = await (await get(app)).json();
    expect(body.users.map(u => u.name)).toEqual(["ada"]);
    expect(JSON.stringify(body)).not.toContain("tok-plain");
  } finally { await app.stop(); }
});

test("scripts/admin-bootstrap.js --admin dev:<name>, run AFTER the server started, takes that name off the menu at once", async () => {
  const dir = tempDir();
  const app = await start({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: TOK });
  try {
    expect((await (await get(app)).json()).users.map(u => u.name)).toEqual(["ada", "bo"]);
    const out = [];
    expect(await bootstrap(["--domain", "acme.test", "--admin", "dev:bo"], { PLENARY_DATA_DIR: dir }, { out: l => out.push(l), err: l => out.push(l) })).toBe(0);
    expect((await (await get(app)).json()).users.map(u => u.name)).toEqual(["ada"]);
  } finally { await app.stop(); }
});

test("a Registry that cannot answer publishes nothing (fails closed)", async () => {
  const app = await start(env({ PLENARY_DEV_TOKENS: TOK }));
  try {
    app.registry.isTenantAdmin = async () => { throw new Error("down"); };
    expect((await get(app)).status).toBe(503);
  } finally { await app.stop(); }
});
