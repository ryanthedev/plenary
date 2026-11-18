// scripts/clean.js against fixture dirs in a private temp root only (never the real temp dir, never another worktree).
// "Old" is simulated by passing a `now` three hours ahead; processes that hold things open are our own, killed by pid.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { clean, summarize, measure, openPaths } from "../../scripts/clean.js";

const made = [], kids = [];
const sandbox = mkdtempSync(join(tmpdir(), "plenary-cleantest-"));
made.push(sandbox);
afterAll(() => { for (const k of kids) try { process.kill(k.pid); } catch {} for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fresh private root with a temp/ dir inside (the "system temp dir") and a rigs/ dir. */
function world({ real = false } = {}) {
  const root = mkdtempSync(join(sandbox, "w-"));
  const tempDir = join(root, "temp"), rigRoot = join(root, ".rig");
  mkdirSync(tempDir); mkdirSync(rigRoot);
  // `lsof` is the real one only where a test needs a process to hold something (real: true); a fixed answer elsewhere (the real one takes ~0.5 s)
  const lsof = join(root, "lsof-none");
  writeFileSync(lsof, "#!/bin/sh\necho n/dev/null\n"); chmodSync(lsof, 0o755);
  return { root, tempDir, rigRoot, lsof: real ? "lsof" : lsof };
}
const entry = (base, name, bytes = 5000) => { const d = join(base, name); mkdirSync(join(d, "sub"), { recursive: true }); writeFileSync(join(d, "sub/f"), "x".repeat(bytes)); return d; };
/** The pid of a process that has just exited: dead now, and not reused within the test. */
const DEAD = spawnSync("true").pid;
const LATER = () => Date.now() + 3 * 3_600_000;
const byName = (r, n) => r.items.find(i => i.path.endsWith("/" + n));
const holder = (script, cwd) => { const p = Bun.spawn(["sh", "-c", script], { cwd, stdout: "ignore", stderr: "ignore" }); kids.push(p); return p; };
const failingLsof = (w, code) => { const f = join(w.root, `lsof-${code}`); writeFileSync(f, `#!/bin/sh\nexit ${code}\n`); chmodSync(f, 0o755); return f; };
const rigDir = (w, name) => { const d = join(w.rigRoot, name); mkdirSync(d); writeFileSync(join(d, "rig.json"), "{}"); writeFileSync(join(d, "blob"), "y".repeat(3000)); return d; };

test("old, unused plenary entries are removed; other names and young entries stay (--yes)", () => {
  const w = world();
  const old = entry(w.tempDir, "plenary-load-aaa"), run = entry(w.tempDir, `plen-run-${DEAD}-x`), other = entry(w.tempDir, "omniloop-life-zzz");
  const young = clean({ ...w, yes: true });                       // everything is young now
  expect(young.items.map(i => i.why)).toEqual(["too young", "too young"]);
  expect(existsSync(old)).toBe(true);
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(r.items.map(i => [i.target, i.status])).toEqual([["temp", "removed"], ["temp", "removed"]]);
  expect(existsSync(old) || existsSync(run)).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(r.items[0].bytes).toBeGreaterThan(0);
});

test("a dry run lists and sizes but deletes nothing", () => {
  const w = world();
  const d = entry(w.tempDir, "plenary-dry-1"); rigDir(w, "stopped");
  const r = clean({ ...w, now: LATER(), rigAlive: () => false });
  expect(r.items.map(i => i.status)).toEqual(["would-remove", "would-remove"]);
  expect(existsSync(d) && existsSync(join(w.rigRoot, "stopped"))).toBe(true);
  expect(summarize(r.items, false)).toMatch(/^would remove 2 entries, [\d.]+ MB \[temp: 1 .*rig: 1 .*scratch: 0 .*\]; kept 0; dry run/);
});

test("an entry a process holds open (a file, or its cwd) is kept", () => {
  const w = world({ real: true });
  const a = entry(w.tempDir, "plenary-held-file"), b = entry(w.tempDir, "plenary-held-cwd"), free = entry(w.tempDir, "plenary-free");
  holder(`exec 3<${a}/sub/f; exec sleep 60`, w.root);
  holder("exec sleep 60", b);
  Bun.sleepSync(300);
  const r = clean({ ...w, now: LATER(), yes: true });
  expect([byName(r, "plenary-held-file").why, byName(r, "plenary-held-cwd").why]).toEqual(["in use", "in use"]);
  expect(existsSync(a) && existsSync(b)).toBe(true);
  expect(existsSync(free)).toBe(false);
});

test("a plen-run root is kept while its owner pid lives (owner.json or the name), removed once it is gone", () => {
  const w = world();
  const live = entry(w.tempDir, `plen-run-${process.pid}-a`), named = entry(w.tempDir, `plen-run-${process.pid}-b`);
  writeFileSync(join(live, "owner.json"), JSON.stringify({ pid: process.pid }));
  const dead = entry(w.tempDir, `plen-run-${DEAD}-c`); writeFileSync(join(dead, "owner.json"), JSON.stringify({ pid: DEAD }));
  const odd = entry(w.tempDir, `plen-run-${DEAD}-d`); writeFileSync(join(odd, "owner.json"), "{not json");
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(byName(r, `plen-run-${process.pid}-a`).why).toMatch(/owner pid .* alive/);
  expect(byName(r, `plen-run-${process.pid}-b`).why).toMatch(/alive/);
  expect(byName(r, `plen-run-${DEAD}-d`).why).toBe("owner unreadable");
  expect(existsSync(live) && existsSync(named) && existsSync(odd)).toBe(true);
  expect(existsSync(dead)).toBe(false);
});

test("a failing or missing lsof keeps everything", () => {
  for (const code of [null, 2, 3]) {
    const w = world(), d = entry(w.tempDir, "plenary-x");
    const r = clean({ ...w, now: LATER(), yes: true, lsof: code === null ? "/nonexistent/lsof" : failingLsof(w, code) });
    expect(r.items[0].status).toBe("kept");
    expect(r.items[0].why).toMatch(/in-use check failed/);
    expect(existsSync(d)).toBe(true);
  }
  expect(() => openPaths(failingLsof(world(), 1))).toThrow();   // exit 1 with no output is no answer either
});

test("a symlink to outside is skipped at the top level and never entered inside an entry", () => {
  const w = world();
  const outside = entry(w.root, "outside-precious");
  symlinkSync(outside, join(w.tempDir, "plenary-link"));
  const inner = entry(w.tempDir, "plenary-with-link");
  symlinkSync(outside, join(inner, "escape"));
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(byName(r, "plenary-link").why).toBe("symlink");
  expect(existsSync(join(w.tempDir, "plenary-link"))).toBe(true);
  expect(existsSync(inner)).toBe(false);
  expect(existsSync(join(outside, "sub/f"))).toBe(true);
});

test("refuses a base that is / or $HOME (or a parent of the repo or home)", () => {
  expect(() => clean({ tempDir: "/", rigRoot: null })).toThrow(/refusing/);
  expect(() => clean({ tempDir: process.env.HOME, rigRoot: null })).toThrow(/refusing/);
  expect(() => clean({ tempDir: tmpdir(), scratch: "/Users", rigRoot: null })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "missing"), rigRoot: null }).items).not.toThrow();
});

test("stopped rigs are removed, live or unknown ones kept (the rig's own liveness verdict decides)", () => {
  const w = world();
  const stopped = rigDir(w, "stopped"), live = rigDir(w, "live"), fresh = rigDir(w, "fresh");
  const noJson = entry(w.rigRoot, "half-up");
  const verdict = { stopped: false, live: true, fresh: false };
  const r = clean({ ...w, now: LATER(), yes: true, rigAlive: d => verdict[d.split("/").pop()] });
  expect(existsSync(stopped)).toBe(false);
  expect(existsSync(live) && existsSync(noJson)).toBe(true);
  expect(byName(r, "half-up").why).toMatch(/no rig.json/);
  // a rig touched in the last minute is left to its `up`
  const w2 = world(), busy = rigDir(w2, "busy");
  expect(clean({ ...w2, rigAlive: () => false, yes: true }).items[0].why).toBe("too young");
  expect(existsSync(busy)).toBe(true);
});

test("the default rig check is cluster-rig's own status: dead or reused pids are removed, a live rig process keeps it", () => {
  const w = world();
  const sleeper = holder("exec sleep 60", w.root);
  const started = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(sleeper.pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).stdout.trim().replace(/\s+/g, " ");
  const mk = (name, pid, at = "Mon Jan  1 00:00:00 2001") => {
    const d = join(w.rigRoot, name); mkdirSync(d);
    writeFileSync(join(d, "rig.json"), JSON.stringify({ version: 1, name, dir: d, startedClock: "lstart TZ=UTC LC_ALL=C", state: "up", nodes: [],
      procs: [{ name: "svc", pid, started: at }] }));
    return d;
  };
  const gone = mk("gone", DEAD), reused = mk("reused", sleeper.pid), live = mk("live", sleeper.pid, started);
  const r = clean({ tempDir: join(sandbox, "none"), rigRoot: w.rigRoot, lsof: w.lsof, now: LATER(), yes: true });
  expect(byName(r, "gone").status).toBe("removed");
  expect(existsSync(gone)).toBe(false);
  expect(byName(r, "reused").status).toBe("removed");   // the pid lives but is another process than the rig's: not the rig's
  expect(existsSync(reused)).toBe(false);
  expect(byName(r, "live").why).toBe("rig alive or unknown");
  expect(existsSync(live)).toBe(true);
});

test("--scratch: direct children, old and unused, are removed; held ones stay; symlinks stay", () => {
  const w = world({ real: true });
  const scratch = join(w.root, "scratch"); mkdirSync(scratch);
  const old = entry(scratch, "copy-1"), held = entry(scratch, "copy-2");
  symlinkSync(w.root, join(scratch, "lnk"));
  holder("exec sleep 60", held);
  Bun.sleepSync(300);
  const r = clean({ ...w, scratch, now: LATER(), yes: true });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(join(scratch, "lnk"))).toBe(true);
  expect(existsSync(w.root)).toBe(true);
  expect(summarize(r.items, true)).toMatch(/^removed 1 entries.*scratch: 1/);
});

test("measure counts a tree without following links", () => {
  const w = world(), d = entry(w.root, "m");
  symlinkSync(w.root, join(d, "up"));   // a loop back to the parent: following it would never end
  expect(measure(d).bytes).toBeGreaterThan(0);
});
