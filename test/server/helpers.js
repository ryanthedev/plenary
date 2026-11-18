// Shared by test/server: temp dirs outside the repo, small waits, a fake image.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const made = [];
/** A fresh temp directory (never inside the repo). Call cleanup() in afterAll. */
export function tempDir(name = "plenary-test-") { const d = mkdtempSync(join(tmpdir(), name)); made.push(d); return d; }
export function cleanup() { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); }

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Polls until `fn()` is truthy; throws with `what` after `ms`. */
export async function until(fn, what = "condition", ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes that start like a PNG, `size` long, varied by `fill`. */
export function fakePng(size = 64, fill = 1) { const b = new Uint8Array(size).fill(fill); b.set(PNG); return b; }
export const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");

/** A promise you resolve or reject from outside. */
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

/** test/preload.js's registries (bunfig.toml preload). Without it no safety net runs at all, so refuse loudly. */
export function testNets() {
  const nets = globalThis.__plenaryTestNets;
  if (!nets) throw new Error("test/preload.js is not loaded: run `bun test` from the repo root (bunfig.toml preloads it)");
  return nets;
}

/**
 * Bun.spawn whose child is killed (SIGKILL) and reaped after the test that started it, pass or fail (test/preload.js's
 * afterEach, which runs for every test file): a test that threw before its own finally used to leave a
 * `bun server/main.js` (or a nats-server) running for hours.
 */
export function spawnTracked(...args) {
  const { children } = testNets();
  const child = Bun.spawn(...args);
  children.add(child);
  child.exited.finally(() => children.delete(child)).catch(() => {});
  return child;
}
