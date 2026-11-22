// A fixture for test/preload.test.js (skipped unless it runs them): a test that fails before stopping its rig.
import { test, expect } from "bun:test";
import { rig } from "../server/rig.js";
const on = !!process.env.PLEN_PRELOAD_FIXTURE, t = on ? test : test.skip;
let url;
t("rig1: builds a rig and fails before stop()", async () => { url = (await rig()).server.url; expect("failed on purpose").toBe(""); });
t("rig1: the rig is stopped before the next test", async () => { expect(await fetch(url + "/health").then(() => "up", () => "down")).toBe("down"); });
