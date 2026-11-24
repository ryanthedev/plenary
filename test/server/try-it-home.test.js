// The README "Try it" path end to end on the Home screen (#47): the exact dev tokens the README gives, `?as=ada` (the page asks
// GET /auth/dev for ada's token), then Home must list the dev board (dev users have no Unit, so they are guests) and the card's
// board must open over the socket; opening it puts it in Recent; the same for bo as "Shared with me".
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";
import { sock } from "./rig.js";
import { until } from "./helpers.js";

const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const README_TOKENS = '{"dev-ada":{"name":"ada","role":"owner"},"dev-bo":{"name":"bo","role":"editor"}}';   // README.md "Try it", verbatim

test("README Try-it: ada lands on Home with the dev board under 'Your boards', bo under 'Shared with me', both can open it, and it shows in Recent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plenary-tryit-")); made.push(dir);
  const app = await start({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: README_TOKENS });
  try {
    const base = app.server.url;
    const menu = await (await fetch(base + "/auth/dev")).json();                              // what web/main.js asks for `?as=ada`
    const tok = name => menu.users.find(u => u.name === name).token;
    const home = async name => (await fetch(base + "/home", { headers: { authorization: `Bearer ${tok(name)}` } })).json();

    const ada = await home("ada");
    expect(ada).toMatchObject({ guest: true, user: { user: "dev:ada" } });
    expect(ada.owned.map(c => [c.id, c.role])).toEqual([[app.devBoard, "owner"]]);
    expect(ada.shared).toEqual([]);
    const bo = await home("bo");
    expect(bo.shared.map(c => [c.id, c.role])).toEqual([[app.devBoard, "editor"]]);
    expect(bo.owned).toEqual([]);

    // The card's link is ?board=<id>: that board opens (a welcome), and the Home link back then shows it under Recent.
    const s = await sock(base.replace("http", "ws") + "/ws");
    s.send({ t: "hello", v: 1, token: tok("ada"), board: ada.owned[0].id, since: 0, client: "web" });
    expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "owner", user: "dev:ada" });
    await until(async () => (await home("ada")).recent.length === 1, "the dev board in Recent");
    expect((await home("ada")).recent[0]).toMatchObject({ id: app.devBoard, role: "owner" });
    s.close();
  } finally { await app.stop(); }
});

test("web/main.js: a signed-in link with no board mounts Home (not the old 'No board in this link' gate), for dev users too", async () => {
  const src = (await Bun.file(new URL("../../web/main.js", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
  expect(src).not.toContain("No board in this link");
  expect(src).not.toContain("devBoard");
  expect(src).toMatch(/\} else \{[^]*?if \(!board\) \{[^]*?mountHome\(/);
  expect(src).toMatch(/const board = asked \?\? back;/);
});
