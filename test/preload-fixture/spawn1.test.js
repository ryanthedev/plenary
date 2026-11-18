// A fixture for test/preload.test.js (skipped unless it runs them): a test that fails before reaping its child.
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { spawnTracked } from "../server/helpers.js";
const on = !!process.env.PLEN_PRELOAD_FIXTURE, t = on ? test : test.skip;
let pid;
t("spawn1: starts a child and fails before its own cleanup", () => {
  pid = spawnTracked(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] }).pid;
  appendFileSync(process.env.PLEN_PRELOAD_FIXTURE, `child ${pid}\n`);
  expect("failed on purpose").toBe("");
});
t("spawn1: the child is gone before the next test", () => { expect(() => process.kill(pid, 0)).toThrow(); });
