// server/store/sqlite.js: several processes opening one brand-new store file at the same moment all start (TECH-DEBT row 64).
// `PRAGMA journal_mode=WAL` on a new file returns BUSY without calling the busy handler while another opener holds the
// write lock; the store retries the switch within busyTimeoutMs. The first test forces the lock; the second races real processes.
import { spawnTracked } from "./helpers.js";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const MOD = new URL("../../server/store/sqlite.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "pl-store-open-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("open while another process holds the new file's write lock: waits for it instead of failing", async () => {
  const db = join(dir, "held.db");
  const holder = spawnTracked(["bun", "-e", `
const { Database } = require("bun:sqlite");
const d = new Database(process.env.DB);
d.run("BEGIN IMMEDIATE");
console.log("held");
await Bun.sleep(300);
d.run("COMMIT"); d.close();`], { env: { ...process.env, DB: db }, stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  const { sqliteStore } = await import(MOD);
  const s = sqliteStore({ path: db });
  try { expect(await s.listBoards?.("t") ?? []).toEqual([]); } finally { await s.close?.(); }
  expect(await holder.exited).toBe(0);
  const check = new Database(db, { readonly: true });
  try { expect(check.query("PRAGMA journal_mode").get().journal_mode).toBe("wal"); } finally { check.close(); }
}, 20_000);

test("several processes opening one fresh store file at once all start (repeated)", async () => {
  for (let round = 0; round < 5; round++) {
    const db = join(dir, `race-${round}.db`);
    const kids = Array.from({ length: 4 }, () => spawnTracked(["bun", "-e", `
const { sqliteStore } = await import(process.env.MOD);
const s = sqliteStore({ path: process.env.DB }); await s.close?.();`], { env: { ...process.env, DB: db, MOD }, stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(kids.map(k => k.exited))).toEqual([0, 0, 0, 0]);
  }
}, 60_000);
