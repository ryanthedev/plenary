// The served page's dev sign-in menu (GET /auth/dev): present only while PLENARY_DEV_TOKENS is on, with the dev board
// and each dev user's own token; with dev off there is no such route and the page offers nothing.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";

const made = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "plenary-devmenu-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const env = (extra = {}) => ({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "error", ...extra });

test("dev on: GET /auth/dev gives the dev board and every user with its own token and role", async () => {
  const app = await start(env({ PLENARY_DEV_TOKENS: JSON.stringify({ "tok-a": { name: "ada", role: "owner" }, "tok-b": { name: "bo" }, "tok-b2": { name: "bo", role: "viewer" } }) }));
  try {
    const res = await fetch(app.server.url + "/auth/dev");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ board: app.devBoard, users: [{ name: "ada", token: "tok-a", role: "owner" }, { name: "bo", token: "tok-b", role: "editor" }] });
    expect(app.devBoard).toMatch(/^b-/);
    // The token it lists really signs in (a hello welcomes the user on that board).
    expect(await app.registry.grant(app.devBoard, "dev:ada")).toBe("owner");
  } finally { await app.stop(); }
});

test("dev off: no /auth/dev route (404), whatever the query, and the page is still served", async () => {
  const app = await start(env());
  try {
    expect(app.devBoard).toBeNull();
    for (const path of ["/auth/dev", "/auth/dev?as=ada", "/auth/dev/"]) expect((await fetch(app.server.url + path)).status).toBe(404);
    expect((await fetch(app.server.url + "/")).status).toBe(200);
  } finally { await app.stop(); }
});

test("dev tokens set but unusable JSON: dev stays off, so no /auth/dev", async () => {
  const app = await start(env({ PLENARY_DEV_TOKENS: "[1,2]" }));
  try { expect((await fetch(app.server.url + "/auth/dev")).status).toBe(404); } finally { await app.stop(); }
});

test("the served page can load the dev menu adapter (it is in the page's import graph)", async () => {
  const app = await start(env());
  try {
    const res = await fetch(app.server.url + "/adapters/auth/devconfig.js");
    expect(res.status).toBe(200);
    expect((await fetch(app.server.url + "/core/dev-users.js")).status).toBe(404);   // the in-browser dev table stays denied
    expect((await fetch(app.server.url + "/dev-main.html")).status).toBe(404);
  } finally { await app.stop(); }
});
