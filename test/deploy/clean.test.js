// scripts/clean.js against fixture dirs in a private temp root only (never the real temp dir, never another worktree).
// "Old" is simulated by passing a `now` three hours ahead; processes that hold things open are our own, killed by pid.

import { test, expect, afterAll } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync, chmodSync, realpathSync, lstatSync, renameSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { clean, summarize, measure, openPaths, openUnder, resolveOpens, resolveNoOpen, renameExcl, loadNativeRename, resetNativeRenameWarning, ROOT } from "../../scripts/clean.js";

const made = [], kids = [];
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "plenary-cleantest-")));
made.push(sandbox);
afterAll(() => { for (const k of kids) try { process.kill(k.pid); } catch {} for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fresh private root with a temp/ dir inside (the "system temp dir") and a rigs/ dir. */
function world({ real = false } = {}) {
  const root = mkdtempSync(join(sandbox, "w-"));
  const tempDir = join(root, "temp"), rigRoot = join(root, ".rig");
  mkdirSync(tempDir); mkdirSync(rigRoot);
  // `lsof` is a real one only where a test needs a process to hold something (real: true); a fixed answer elsewhere
  const lsof = join(root, "lsof-none");
  writeFileSync(lsof, "#!/bin/sh\ncase \"$*\" in *+D*) exit 1;; esac\necho n/dev/null\n"); chmodSync(lsof, 0o755);
  // real: the real lsof, but asked only about the processes a test started with holder(..., w), not every process on the machine
  // (a system-wide scan takes seconds on a loaded one). Same -F0n output, same +D semantics, same exit codes.
  if (real) {
    writeFileSync(join(root, "holders"), "");
    writeFileSync(lsof, `#!/bin/sh\npids=$(paste -sd, "${root}/holders")\nexec lsof -a -p "\${pids:-$$}" "$@"\n`); chmodSync(lsof, 0o755);
  }
  return { root, tempDir, rigRoot, lsof };
}
const entry = (base, name, bytes = 5000) => { const d = join(base, name); mkdirSync(join(d, "sub"), { recursive: true }); writeFileSync(join(d, "sub/f"), "x".repeat(bytes)); return d; };
/** The pid of a process that has just exited: dead now, and not reused within the test. */
const DEAD = spawnSync("true").pid;
const readdirSyncNames = d => readdirSync(d).sort();
const LATER = () => Date.now() + 3 * 3_600_000;
const byName = (r, n) => r.items.find(i => i.path.endsWith("/" + n));
const holder = (script, cwd, w) => { const p = Bun.spawn(["sh", "-c", script], { cwd, stdout: "ignore", stderr: "ignore" }); kids.push(p); if (w) appendFileSync(join(w.root, "holders"), p.pid + "\n"); return p; };
/** Blocks until the real lsof (scoped to this world's holders) reports a path under `dir`: replaces a fixed sleep that load can outrun. */
function waitHeld(w, dir, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; Bun.sleepSync(40)) if (openPaths(w.lsof).some(p => p.startsWith(dir))) return;
  throw new Error(`no process holding ${dir} after ${ms} ms`);
}
const failingLsof = (w, code) => { const f = join(w.root, `lsof-${code}`); writeFileSync(f, `#!/bin/sh\nexit ${code}\n`); chmodSync(f, 0o755); return f; };
const rigDir = (w, name) => { const d = join(w.rigRoot, name); mkdirSync(d); writeFileSync(join(d, "rig.json"), "{}"); writeFileSync(join(d, "blob"), "y".repeat(3000)); return d; };

test("old, unused plenary entries are removed; other names and young entries stay (--yes)", () => {
  const w = world();
  const old = entry(w.tempDir, "plenary-load-data-aaa111"), run = entry(w.tempDir, `plen-run-${DEAD}-x`), other = entry(w.tempDir, "other-life-zzz");
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
  const d = entry(w.tempDir, "plenary-test-dry111"); rigDir(w, "stopped");
  const r = clean({ ...w, now: LATER(), rigAlive: () => false });
  expect(r.items.map(i => i.status)).toEqual(["would-remove", "would-remove"]);
  expect(existsSync(d) && existsSync(join(w.rigRoot, "stopped"))).toBe(true);
  expect(summarize(r.items, false)).toMatch(/^would remove 2 entries, [\d.]+ MB \[temp: 1 .*rig: 1 .*scratch: 0 .*\]; kept 0; dry run/);
});

test("an entry a process holds open (a file, or its cwd) is kept", () => {
  const w = world({ real: true });
  const a = entry(w.tempDir, "plenary-test-hfile1"), b = entry(w.tempDir, "plenary-test-hcwd11"), free = entry(w.tempDir, "plenary-test-free11");
  holder(`exec 3<${a}/sub/f; exec sleep 60`, w.root, w);
  holder("exec sleep 60", b, w);
  waitHeld(w, a); waitHeld(w, b);
  const r = clean({ ...w, now: LATER(), yes: true });
  expect([byName(r, "plenary-test-hfile1").why, byName(r, "plenary-test-hcwd11").why]).toEqual(["in use", "in use"]);
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
    const w = world(), d = entry(w.tempDir, "plenary-test-xxxxxx");
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
  symlinkSync(outside, join(w.tempDir, "plenary-test-link11"));
  const inner = entry(w.tempDir, "plenary-test-wlink1");
  symlinkSync(outside, join(inner, "escape"));
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(byName(r, "plenary-test-link11").why).toBe("symlink");
  expect(existsSync(join(w.tempDir, "plenary-test-link11"))).toBe(true);
  expect(existsSync(inner)).toBe(false);
  expect(existsSync(join(outside, "sub/f"))).toBe(true);
});

test("refuses a base that is / or $HOME (or a parent of the repo or home)", () => {
  expect(() => clean({ tempDir: "/", rigRoot: null, openPathsFn: () => [] })).toThrow(/refusing/);
  expect(() => clean({ tempDir: process.env.HOME, rigRoot: null, openPathsFn: () => [] })).toThrow(/refusing/);
  expect(() => clean({ tempDir: tmpdir(), scratch: "/Users", rigRoot: null, openPathsFn: () => [] })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "missing"), rigRoot: null, openPathsFn: () => [] }).items).not.toThrow();
});

test("a refused base throws before lsof is run (no system-wide scan for a request that is refused anyway)", () => {
  let scans = 0;
  const spy = () => { scans++; return []; };
  expect(() => clean({ tempDir: "/", rigRoot: null, openPathsFn: spy })).toThrow(/refusing/);
  expect(() => clean({ tempDir: tmpdir(), scratch: "/Users", rigRoot: null, openPathsFn: spy })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: "/", openPathsFn: spy })).toThrow(/refusing/);
  // a symlink to / or $HOME, and a relative path that resolves to one, are refused the same way (as temp, scratch and rig)
  const w = world(), toRoot = join(w.root, "to-root"), toHome = join(w.root, "to-home");
  symlinkSync("/", toRoot); symlinkSync(process.env.HOME, toHome);
  const relRoot = relative(process.cwd(), "/"), relHome = relative(process.cwd(), process.env.HOME);
  for (const bad of [toRoot, toHome, relRoot, relHome]) {
    expect(() => clean({ tempDir: bad, rigRoot: null, openPathsFn: spy })).toThrow(/refusing/);
    expect(() => clean({ tempDir: w.tempDir, scratch: bad, rigRoot: null, openPathsFn: spy })).toThrow(/refusing/);
    expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: bad, openPathsFn: spy })).toThrow(/refusing/);
  }
  expect(scans).toBe(0);
});

// The production lsof path (clean() with no openPathsFn, an unscoped binary): what real lsof does that the scoped wrapper hides.
const fakeLsof = (w, body) => { const f = join(w.root, "lsof-fake"); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };

test("lsof exiting 1 with output (what it does when it could not inspect some process) still answers; exit 1 without output does not", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-ex1111"), free = entry(w.tempDir, "plenary-test-ex2222");
  const lsof = fakeLsof(w, `case "$*" in *+D*) exit 1;; esac\nprintf 'p1\\0n${d}/sub/f\\0\\n'\nexit 1`);
  expect(openPaths(lsof)).toContain(`${d}/sub/f`);
  const r = clean({ ...w, lsof, now: LATER(), yes: true });
  expect(byName(r, "plenary-test-ex1111")).toMatchObject({ status: "kept", why: "in use" });
  expect(byName(r, "plenary-test-ex2222").status).toBe("removed");
  expect(existsSync(d) && !existsSync(free)).toBe(true);
  expect(() => openPaths(fakeLsof(w, "exit 1"))).toThrow(/without an answer/);
});

test("a large lsof answer (50,000 open files, several MB) is read whole, and the entry named at its very end is seen", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-big111");
  const out = Array.from({ length: 50_000 }, (_, i) => `p${i}\0n/nowhere/some/long/path/to/an/open/file/${i}\0\n`).join("") + `p1\0n${d}/sub/f\0\n`;
  writeFileSync(join(w.root, "big.out"), out);
  const lsof = fakeLsof(w, `case "$*" in *+D*) exit 1;; esac\ncat "${w.root}/big.out"\nexit 1`);
  const paths = openPaths(lsof);
  expect(paths.length).toBe(50_001);
  expect(paths.at(-1)).toBe(`${d}/sub/f`);
  expect(byName(clean({ ...w, lsof, now: LATER(), yes: true }), "plenary-test-big111")).toMatchObject({ status: "kept", why: "in use" });
  expect(existsSync(d)).toBe(true);
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
  holder("exec sleep 60", held, w);
  waitHeld(w, held);
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

test("only exact known name patterns are candidates: unknown prefixes and bare-prefix names stay", () => {
  const w = world();
  const keep = ["plenary-unknown-abc123", "plenary-test-", "plenary-test-toolong1", "plen-other", "pl-reg-zzzzzz", "plen-abcdef", "other-life-abc123"].map(n => entry(w.tempDir, n));
  const known = entry(w.tempDir, "plenary-load-sig-aB3dE9");
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(keep.map(existsSync)).toEqual(keep.map(() => true));
  expect(existsSync(known)).toBe(false);
  expect(r.items.map(i => i.path)).toEqual([known]);
});

test("an entry not owned by the current uid is kept", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-other1");
  const r = clean({ ...w, now: LATER(), yes: true, uid: process.getuid() + 1 });
  expect(r.items[0].why).toMatch(/owned by uid/);
  expect(existsSync(d)).toBe(true);
});

test("a dir that becomes in use after the snapshot is renamed, re-checked, put back and kept", () => {
  const w = world({ real: true }), d = entry(w.tempDir, "plenary-test-late11"), other = entry(w.tempDir, "plenary-test-free22");
  const r = clean({ ...w, now: LATER(), yes: true, beforeRemove: p => { if (p === d) { holder("exec sleep 60", d, w); waitHeld(w, d); } } });
  expect(byName(r, "plenary-test-late11")).toMatchObject({ status: "kept", why: "in use (re-check)" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(join(w.tempDir, ".plen-deleting-plenary-test-late11"))).toBe(false);
  expect(existsSync(other)).toBe(false);
});

test("a failing per-path re-check puts the dir back", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-rechk1");
  const lsof = join(w.root, "lsof-recheck-fails");   // answers the snapshot, fails the per-path call
  writeFileSync(lsof, '#!/bin/sh\ncase "$*" in *+D*) exit 2;; esac\necho n/dev/null\n'); chmodSync(lsof, 0o755);
  const r = clean({ ...w, lsof, now: LATER(), yes: true });
  expect(r.items[0].why).toMatch(/re-check failed/);
  expect(existsSync(d)).toBe(true);
  expect(readdirSyncNames(w.tempDir)).toEqual(["plenary-test-rechk1"]);
});

test("a parked entry whose identity or age changes after rename is put back and kept", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-postid");
  const r = clean({ ...w, now: LATER(), yes: true, afterRename: parked => {
    if (parked === join(w.tempDir, ".plen-deleting-plenary-test-postid")) writeFileSync(join(parked, "changed"), "x");
  } });
  expect(byName(r, "plenary-test-postid")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
});

test("a post-park measurement error restores the original entry and keeps it", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-vanis1"), parked = join(w.tempDir, ".plen-deleting-plenary-test-vanis1");
  let deleted = false;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    if (!deleted && p === join(parked, "sub/f")) { deleted = true; rmSync(p); }
    return lstatSync(p);
  } });
  expect(byName(r, "plenary-test-vanis1")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(parked)).toBe(false);
});

test("a changed parked tree is left parked when the original name was recreated", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-recr01");
  const r = clean({ ...w, now: LATER(), yes: true, afterRename: parked => {
    if (parked.endsWith("plenary-test-recr01")) { writeFileSync(join(parked, "changed"), "x"); mkdirSync(d); }
  } });
  expect(byName(r, "plenary-test-recr01")).toMatchObject({ status: "kept", why: "changed while parking; original path exists" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(join(w.tempDir, ".plen-deleting-plenary-test-recr01"))).toBe(true);
});

test("a deep file made young after parking is re-measured and restored", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-young1"), now = LATER();
  const youngTime = new Date(now - 1000);
  const r = clean({ ...w, now, yes: true, afterRename: parked => {
    if (parked.endsWith("plenary-test-young1")) utimesSync(join(parked, "sub/f"), youngTime, youngTime);
  } });
  expect(byName(r, "plenary-test-young1")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(join(w.tempDir, ".plen-deleting-plenary-test-young1"))).toBe(false);
});

test("parking never replaces an empty directory at the destination", () => {
  const w = world(), from = join(w.root, "from"), to = join(w.root, "to");
  mkdirSync(from); mkdirSync(to);
  expect(() => renameExcl(from, to)).toThrow(/target exists/);
  expect(existsSync(from) && existsSync(to)).toBe(true);
  expect(readdirSyncNames(to)).toEqual([]);
});

test("the fallback exclusive rename seam rejects an existing empty destination", () => {
  const w = world(), from = join(w.root, "from-fallback"), to = join(w.root, "to-fallback");
  mkdirSync(from); mkdirSync(to);
  expect(() => renameExcl(from, to, { forceFallback: true })).toThrow(/target exists/);
  expect(existsSync(from) && existsSync(to)).toBe(true);
});

test("a different old directory swapped under the parked name is put back and kept", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-swp111");
  const away = join(w.tempDir, "original-parked-directory");
  const replacementTime = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(d, replacementTime, replacementTime);
  const r = clean({ ...w, now: LATER(), yes: true, afterRename: parked => {
    if (parked === join(w.tempDir, ".plen-deleting-plenary-test-swp111")) {
      renameSync(parked, away);
      mkdirSync(parked);
      utimesSync(parked, replacementTime, replacementTime);
    }
  } });
  expect(byName(r, "plenary-test-swp111")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(away)).toBe(true);
  expect(existsSync(join(w.tempDir, ".plen-deleting-plenary-test-swp111"))).toBe(false);
});

test("a lookalike directory with matching measurements but a different inode is restored and kept", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-inode1");
  const parkedPath = join(w.tempDir, ".plen-deleting-plenary-test-inode1");
  const away = join(w.tempDir, "original-inode-directory");
  const exactTime = new Date(Math.floor(Date.now() - 3 * 3_600_000));
  for (const path of [join(d, "sub/f"), join(d, "sub"), d]) utimesSync(path, exactTime, exactTime);
  const originalStats = [d, join(d, "sub"), join(d, "sub/f")].map(lstatSync);
  const originalInodes = originalStats.map(st => st.ino);
  const originalTimes = originalStats.map(st => [st.atimeMs, st.mtimeMs]);
  const originalMeasure = measure(d);

  const r = clean({ ...w, now: LATER(), yes: true, afterRename: parked => {
    if (parked !== parkedPath) return;
    renameSync(parked, away);
    mkdirSync(join(parked, "sub"), { recursive: true });
    writeFileSync(join(parked, "sub/f"), "x".repeat(5000));
    // Set file and nested directory times before the root, whose mtime changes as children are created.
    for (const [path, index] of [[join(parked, "sub/f"), 2], [join(parked, "sub"), 1], [parked, 0]]) {
      const [atime, mtime] = originalTimes[index];
      utimesSync(path, new Date(atime), new Date(mtime));
    }

    const replacementStats = [parked, join(parked, "sub"), join(parked, "sub/f")].map(lstatSync);
    expect(replacementStats.map(st => st.ino)).not.toEqual(originalInodes);
    expect(replacementStats.map(st => st.mtimeMs)).toEqual(originalStats.map(st => st.mtimeMs));
    expect(replacementStats[2].size).toBe(originalStats[2].size);
    expect(measure(parked)).toMatchObject({ bytes: originalMeasure.bytes, newest: originalMeasure.newest });
    expect(readFileSync(join(parked, "sub/f"), "utf8")).toBe("x".repeat(5000));
  } });

  expect(byName(r, "plenary-test-inode1")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
  expect(readFileSync(join(d, "sub/f"), "utf8")).toBe("x".repeat(5000));
  expect(existsSync(away)).toBe(true);
  expect(readFileSync(join(away, "sub/f"), "utf8")).toBe("x".repeat(5000));
  expect(existsSync(parkedPath)).toBe(false);
});

test("a recreated original name is never overwritten when a parked entry must be restored", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-noclob");
  const lsof = join(w.root, "lsof-recheck-fails");
  writeFileSync(lsof, '#!/bin/sh\ncase "$*" in *+D*) exit 2;; esac\necho n/dev/null\n'); chmodSync(lsof, 0o755);
  const r = clean({ ...w, lsof, now: LATER(), yes: true, afterRename: parked => {
    if (parked.endsWith("plenary-test-noclob")) mkdirSync(d);
  } });
  expect(byName(r, "plenary-test-noclob")).toMatchObject({ status: "kept", why: expect.stringMatching(/original path exists/) });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(join(w.tempDir, ".plen-deleting-plenary-test-noclob"))).toBe(true);
});

test("a directory tree crossing a device boundary is kept", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-mount1");
  const rootStat = lstatSync;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    const st = rootStat(p);
    return p === join(d, "sub") ? new Proxy(st, { get: (target, key) => key === "dev" ? target.dev + 1 : Reflect.get(target, key, target) }) : st;
  } });
  expect(byName(r, "plenary-test-mount1")).toMatchObject({ status: "failed", why: expect.stringMatching(/different device/) });
  expect(existsSync(d)).toBe(true);
});

test("exclusive rename EEXIST is reported as kept with the target collision", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-exist1");
  const r = clean({ ...w, now: LATER(), yes: true, renameExclFn: () => { const e = new Error("target exists"); e.code = "EEXIST"; throw e; } });
  expect(byName(r, "plenary-test-exist1")).toMatchObject({ status: "kept", why: expect.stringMatching(/target exists/i) });
  expect(existsSync(d)).toBe(true);
});

test("a non-installing native loader failure does not leak platform state into clean", () => {
  const warnings = [], w = world(), d = entry(w.tempDir, "plenary-test-nolek1");
  resetNativeRenameWarning();
  loadNativeRename(() => { throw new Error("missing library"); }, "darwin", () => {}, false);
  const r = clean({ ...w, now: LATER(), yes: true, platform: "linux", nativeRenameAvailable: false, warn: message => warnings.push(message) });
  expect(warnings).toEqual(["exclusive rename unavailable; refusing to remove (pass --allow-racy-rename to use check-then-rename)"]);
  expect(byName(r, "plenary-test-nolek1")).toMatchObject({ status: "kept", why: expect.stringMatching(/exclusive rename unavailable/) });
  expect(existsSync(d)).toBe(true);
  resetNativeRenameWarning();
});

test("a failed darwin native loader warns once and --yes refuses without racy rename consent", () => {
  const warnings = [], w = world(), d = entry(w.tempDir, "plenary-test-loadr1");
  resetNativeRenameWarning();
  loadNativeRename(() => { throw new Error("missing library"); }, "darwin", message => warnings.push(message), false);
  const r = clean({ ...w, now: LATER(), yes: true, platform: "darwin", nativeRenameAvailable: false, warn: message => warnings.push(message) });
  expect(warnings).toEqual(["exclusive rename unavailable; refusing to remove (pass --allow-racy-rename to use check-then-rename)"]);
  expect(byName(r, "plenary-test-loadr1")).toMatchObject({ status: "kept", why: expect.stringMatching(/exclusive rename unavailable/) });
  expect(summarize([{ target: "temp", status: "kept", bytes: 0, why: "exclusive rename unavailable; --allow-racy-rename required to remove" }], true)).toContain("1 refused");
  expect(existsSync(d)).toBe(true);
  const forced = clean({ ...w, now: LATER(), yes: true, force: true, platform: "darwin", nativeRenameAvailable: false });
  expect(byName(forced, "plenary-test-loadr1")).toMatchObject({ status: "kept", why: expect.stringMatching(/exclusive rename unavailable/) });
  expect(existsSync(d)).toBe(true);
  const allowed = clean({ ...w, now: LATER(), yes: true, platform: "darwin", nativeRenameAvailable: false, allowRacyRename: true });
  expect(byName(allowed, "plenary-test-loadr1").status).toBe("removed");
});

test("linux native-loader failure refuses unless check-then-rename is explicitly allowed", () => {
  const warnings = [], w = world(), d = entry(w.tempDir, "plenary-test-loadr2");
  resetNativeRenameWarning();
  loadNativeRename(() => { throw new Error("missing library"); }, "linux", message => warnings.push(message), false);
  const refused = clean({ ...w, now: LATER(), yes: true, platform: "linux", nativeRenameAvailable: false, warn: message => warnings.push(message) });
  expect(warnings).toEqual(["exclusive rename unavailable; refusing to remove (pass --allow-racy-rename to use check-then-rename)"]);
  expect(byName(refused, "plenary-test-loadr2").status).toBe("kept");
  const forced = clean({ ...w, now: LATER(), yes: true, force: true, platform: "linux", nativeRenameAvailable: false });
  expect(byName(forced, "plenary-test-loadr2")).toMatchObject({ status: "kept", why: expect.stringMatching(/exclusive rename unavailable/) });
  expect(existsSync(d)).toBe(true);
  const allowed = clean({ ...w, now: LATER(), yes: true, platform: "linux", nativeRenameAvailable: false, allowRacyRename: true });
  expect(byName(allowed, "plenary-test-loadr2").status).toBe("removed");
  expect(existsSync(d)).toBe(false);
});

test("library clean warnings follow its allowRacyRename option and emit once", () => {
  const warnings = [], w = world();
  resetNativeRenameWarning();
  clean({ ...w, yes: true, platform: "linux", nativeRenameAvailable: false, allowRacyRename: false, warn: message => warnings.push(message) });
  clean({ ...w, yes: true, platform: "linux", nativeRenameAvailable: false, allowRacyRename: true, warn: message => warnings.push(message) });
  expect(warnings).toEqual(["exclusive rename unavailable; refusing to remove (pass --allow-racy-rename to use check-then-rename)"]);
  resetNativeRenameWarning();
  clean({ ...w, yes: true, platform: "linux", nativeRenameAvailable: false, allowRacyRename: true, warn: message => warnings.push(message) });
  expect(warnings.at(-1)).toBe("exclusive rename unavailable; using check-then-rename");
});

test.skipIf(process.platform !== "darwin")("native exclusive rename refuses a recreated target with EEXIST", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-nativ1"), parked = join(w.tempDir, ".plen-deleting-plenary-test-nativ1");
  let recreated = false;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    if (!recreated && p === parked) {
      recreated = true;
      try { return lstatSync(p); } catch (e) { mkdirSync(parked); throw e; }
    }
    return lstatSync(p);
  } });
  expect(byName(r, "plenary-test-nativ1")).toMatchObject({ status: "kept", why: expect.stringMatching(/target.*exists.*EEXIST/i) });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(parked)).toBe(true);
});

test("non-rename EEXIST failures are reported as failed", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-exist2"), rootStat = lstatSync;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    if (p === d) { const e = new Error("injected collision"); e.code = "EEXIST"; throw e; }
    return rootStat(p);
  } });
  expect(byName(r, "plenary-test-exist2")).toMatchObject({ status: "failed", why: "injected collision" });
  expect(existsSync(d)).toBe(true);
});

test("a candidate mount point is refused relative to its parent device", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-mnt001");
  const rootStat = lstatSync;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    const st = rootStat(p);
    return p === d ? new Proxy(st, { get: (target, key) => key === "dev" ? target.dev + 1 : Reflect.get(target, key, target) }) : st;
  } });
  expect(byName(r, "plenary-test-mnt001")).toMatchObject({ status: "failed", why: expect.stringMatching(/mount point/) });
  expect(existsSync(d)).toBe(true);
});

test("lsof timeout is positive when the injected clock reaches the deadline on the next read", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-tmo001"), timeouts = [];
  const ticks = [0, 0, 10]; let i = 0;
  const r = clean({ ...w, now: LATER(), yes: true, maxTimeMs: 10,
    clock: () => ticks[Math.min(i++, ticks.length - 1)],
    openPathsFn: (_lsof, timeout) => { timeouts.push(timeout); return []; },
    openUnderFn: (_path, _lsof, timeout) => { timeouts.push(timeout); return ""; } });
  expect(timeouts.length).toBeGreaterThan(0);
  expect(timeouts.every(t => t >= 1)).toBe(true);
  expect(byName(r, "plenary-test-tmo001").why).toBe("skipped (time limit)");
  expect(existsSync(d)).toBe(true);
});

test("a deadline expiring in one candidate restores the parked path", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-midone"), parked = join(w.tempDir, ".plen-deleting-plenary-test-midone");
  let expired = false;
  const r = clean({ ...w, now: LATER(), yes: true, maxTimeMs: 10,
    clock: () => expired ? 10 : 0,
    afterRename: () => { expired = true; }, openPathsFn: () => [], openUnderFn: () => "" });
  expect(byName(r, "plenary-test-midone")).toMatchObject({ status: "kept", why: "skipped (time limit)" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(parked)).toBe(false);
});

test("a deadline expiring in one candidate keeps the parked copy if original was recreated", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-midtwo"), parked = join(w.tempDir, ".plen-deleting-plenary-test-midtwo");
  let expired = false;
  const r = clean({ ...w, now: LATER(), yes: true, maxTimeMs: 10,
    clock: () => expired ? 10 : 0,
    afterRename: () => { mkdirSync(d); expired = true; }, openPathsFn: () => [], openUnderFn: () => "" });
  expect(byName(r, "plenary-test-midtwo")).toMatchObject({ status: "kept", why: "skipped (time limit); original path exists" });
  expect(existsSync(d) && existsSync(parked)).toBe(true);
});

test("the rig liveness timeout is capped by remaining total time", () => {
  const w = world(), d = rigDir(w, "bounded"), timeouts = [];
  let expired = false;
  const r = clean({ tempDir: join(w.root, "no-temp"), rigRoot: w.rigRoot, now: LATER(), yes: true, maxTimeMs: 20,
    clock: () => expired ? 20 : 0, openPathsFn: () => [],
    rigAlive: (_dir, timeout) => { timeouts.push(timeout); expired = true; return true; } });
  expect(timeouts).toEqual([20]);
  expect(byName(r, "bounded")).toMatchObject({ status: "kept", why: "rig alive or unknown" });
  expect(existsSync(d)).toBe(true);
});

test("the total time limit skips candidates after the deadline", () => {
  const w = world();
  const first = entry(w.tempDir, "plenary-test-time01");
  const second = entry(w.tempDir, "plenary-test-time02");
  const parked = join(w.tempDir, ".plen-deleting-plenary-test-time01");
  const r = clean({ ...w, now: LATER(), yes: true, maxTimeMs: 10,
    clock: () => existsSync(first) || existsSync(parked) ? 0 : 11,
    openPathsFn: () => [], openUnderFn: () => "" });   // no lsof: its timeout comes from this fake clock (10 ms), which a real subprocess cannot meet under load
  expect(r.items.map(i => [i.status, i.why])).toEqual([
    ["removed", ""], ["kept", "skipped (time limit)"],
  ]);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(true);
  expect(existsSync(parked)).toBe(false);
  expect(readdirSyncNames(w.tempDir)).toEqual(["plenary-test-time02"]);
});

test("an expired total time limit keeps every candidate without removing anything", () => {
  const w = world();
  const first = entry(w.tempDir, "plenary-test-time11");
  const second = entry(w.tempDir, "plenary-test-time12");
  const fakeTime = 0;
  const r = clean({ ...w, now: LATER(), yes: true, maxTimeMs: 0, clock: () => fakeTime,
    openPathsFn: () => [], openUnderFn: () => "" });
  expect(r.items.map(i => [i.status, i.why])).toEqual([
    ["kept", "skipped (time limit)"], ["kept", "skipped (time limit)"],
  ]);
  expect(existsSync(first) && existsSync(second)).toBe(true);
  expect(readdirSyncNames(w.tempDir)).toEqual(["plenary-test-time11", "plenary-test-time12"]);
});

test("a stale .env file inside an exact temp candidate does not prevent cleanup", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-env111");
  writeFileSync(join(d, ".env"), "stale copy");
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(byName(r, "plenary-test-env111")).toMatchObject({ status: "removed" });
  expect(existsSync(d)).toBe(false);
});

test("an odd path (a newline in it): lsof -F0 output is parsed whole (escaped by lsof), the holder is seen, and the per-path check agrees", () => {
  const w = world({ real: true }), d = entry(w.tempDir, "plenary-test-nl1111");
  const odd = join(d, "sub", "a\nb x");
  writeFileSync(odd, "z");
  holder(`exec 3<"${odd}"; exec sleep 60`, w.root, w);
  waitHeld(w, d);
  expect(openPaths(w.lsof).some(p => p === odd)).toBe(false);                       // lsof escapes the newline, so the raw path never matches ...
  expect(openPaths(w.lsof).some(p => p === odd.replace("\n", "\\n"))).toBe(true);    // ... but the field is kept whole, escaped, under the entry's prefix
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(r.items[0]).toMatchObject({ status: "kept", why: "in use" });
  expect(existsSync(odd)).toBe(true);
  expect(openUnder(d, w.lsof)).toBe("in use (re-check)");
});

test("ROOT is the real path of the checkout, also with a space in it or behind a symlink", async () => {
  const w = world(), home = join(w.root, "sp ace", "repo"), real = realpathSync(w.root) + "/sp ace/repo";
  mkdirSync(join(home, "scripts"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/clean.js"), join(home, "scripts/clean.js"));
  symlinkSync(join(w.root, "sp ace"), join(w.root, "link"));
  const viaLink = await import(join(w.root, "link", "repo", "scripts", "clean.js") + `?v=${Math.random()}`);
  expect(viaLink.ROOT).toBe(real);
  expect(readFileSync(join(ROOT, "scripts/clean.js"), "utf8")).toContain("fileURLToPath");
});

test("the rig dir is refused like the others when it resolves to / or $HOME", () => {
  expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: "/", openPathsFn: () => [] })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: process.env.HOME, openPathsFn: () => [] })).toThrow(/refusing/);
});

test("--min-age under 10 minutes needs force", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-young1");
  expect(() => clean({ ...w, minAgeMs: 60_000 })).toThrow(/needs --force/);
  expect(clean({ ...w, minAgeMs: 60_000, force: true, now: Date.now() + 120_000 }).items[0].status).toBe("would-remove");
  expect(existsSync(d)).toBe(true);
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/clean.js"), "--min-age", "5m"], { encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stderr).toMatch(/needs --force/);
});

// A hang found 2026-11-19: clean() resolved every path lsof listed with realpathSync, which opens it; a pty slave under /dev
// blocked open(2) in the kernel for good (uninterruptible), freezing every `bun test` run. Tests never touch a real device:
// they use a /dev path that does not exist, and a spy that records what the code stats and resolves.
test("resolveOpens never stats or resolves anything under /dev, and resolves only plain files and directories", () => {
  const w = world(), file = join(w.root, "plain"), fifo = join(w.root, "pipe");
  writeFileSync(file, "x");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const resolved = [], statted = [], realpath = p => (resolved.push(p), p), stat = p => (statted.push(p), lstatSync(p));
  const out = resolveOpens(["/dev/plenary-no-such-device", "/dev/plenary-no-such-pty", fifo, file, w.root, join(w.root, "gone")], stat, realpath);
  expect(resolved).toEqual([file, w.root]);
  expect(statted.some(p => p.startsWith("/dev/"))).toBe(false);
  expect(out).toEqual(expect.arrayContaining(["/dev/plenary-no-such-device", fifo, file, w.root]));   // still reported as lsof printed them
});

test("a FIFO candidate in the temp dir is kept and never opened; a FIFO or missing path as a base is refused or absent without opening", async () => {
  const w = world(), fifo = join(w.tempDir, "plenary-test-fifo11"), pipeBase = join(w.root, "pipe-base");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  expect(spawnSync("mkfifo", [pipeBase]).status).toBe(0);
  // A subprocess with a timer that does not wait after the kill: a regression ends this test at the timer, never the run.
  const script = `import { clean } from ${JSON.stringify(join(ROOT, "scripts/clean.js"))};
    const r = clean({ tempDir: ${JSON.stringify(w.tempDir)}, rigRoot: null, now: Date.now() + 3 * 3_600_000, yes: true, openPathsFn: () => [${JSON.stringify(fifo)}, "/dev/plenary-no-such-device"] });
    let refused = ""; try { clean({ tempDir: ${JSON.stringify(pipeBase)}, rigRoot: null, openPathsFn: () => [] }); } catch (e) { refused = e.message; }
    console.log(JSON.stringify({ items: r.items.map(i => [i.status, i.why]), refused }));`;
  const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "ignore" });
  kids.push(p);
  const out = await Promise.race([new Response(p.stdout).text(), Bun.sleep(15_000).then(() => { p.kill("SIGKILL"); return null; })]);
  expect(out).not.toBeNull();
  const got = JSON.parse(out);
  expect(got.items).toEqual([["kept", "not a regular file or directory"]]);
  expect(got.refused).toMatch(/not a directory \(never opened\)/);
  expect(lstatSync(fifo).isFIFO()).toBe(true);
}, 30_000);

test("a rig.json that is not a regular file keeps the rig (never handed to the status child)", () => {
  const w = world(), d = join(w.rigRoot, "odd");
  mkdirSync(d); expect(spawnSync("mkfifo", [join(d, "rig.json")]).status).toBe(0);
  let asked = 0;
  const r = clean({ ...w, now: LATER(), yes: true, openPathsFn: () => [], rigAlive: () => (asked++, false) });
  expect(asked).toBe(0);
  expect(byName(r, "odd").why).toMatch(/no rig.json/);
});

test("resolveNoOpen: symlink chains, relative links, .. after a link, missing parts and loops, without opening anything", () => {
  const w = world(), r = realpathSync(w.root), at = (...p) => join(w.root, ...p);
  mkdirSync(at("a/b"), { recursive: true }); mkdirSync(at("c"));
  writeFileSync(at("a/b/f"), "x");
  symlinkSync("b", at("a/rel"));                    // relative, same dir
  symlinkSync(at("a/rel"), at("c/abs"));            // absolute, onto a link: a chain
  symlinkSync("../a/b", at("c/up"));                // relative with ..
  symlinkSync("loop2", at("loop1")); symlinkSync("loop1", at("loop2"));
  expect(resolveNoOpen(at("c/abs/f"))).toBe(join(r, "a/b/f"));
  expect(resolveNoOpen(w.root + "/c/up/../b/f")).toBe(join(r, "a/b/f"));   // .. applies to the resolved dir (a/b), not the link's parent
  expect(resolveNoOpen(w.root + "/a/./b/../rel")).toBe(join(r, "a/b"));
  expect(resolveNoOpen(at("a/b"))).toBe(realpathSync(at("a/b")));
  expect(resolveNoOpen("/")).toBe("/");
  expect(() => resolveNoOpen(at("loop1"))).toThrow(/symbolic links/);
  expect(() => resolveNoOpen(at("a/nope/x"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  const fifo = at("pipe"); expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  expect(resolveNoOpen(fifo)).toBe(join(r, "pipe"));                 // a FIFO resolves without being opened
});

// Case-insensitive volumes (default APFS): /USERS/R and /users are $HOME and its parent, and string compares of spellings miss them.
test("a base that is $HOME or a parent of it is refused under any letter case (by identity)", () => {
  const home = process.env.HOME, up = home.toUpperCase();
  const refuse = dir => expect(() => clean({ tempDir: join(sandbox, "none"), scratch: dir, rigRoot: null, maxTimeMs: 0, openPathsFn: () => [] })).toThrow(/refusing/);
  if (existsSync(up)) refuse(up);                                  // only where the volume folds case
  if (existsSync("/users")) refuse("/users");
  if (existsSync(home.toLowerCase())) refuse(home.toLowerCase());
  refuse(home);
});

test("resolveNoOpen restores the stored spelling, so a lsof path matches a differently-cased base", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-case11"), swapped = join(w.root.toUpperCase(), "temp");
  if (!existsSync(swapped)) return;                                // a case-sensitive volume: nothing to fold
  expect(resolveNoOpen(join(swapped, "plenary-test-case11"))).toBe(d);
  const lsof = fakeLsof(w, `case "$*" in *+D*) exit 1;; esac\nprintf 'p1\\0n${d}/sub/f\\0\\n'\nexit 1`);
  expect(byName(clean({ ...w, tempDir: swapped, lsof, now: LATER(), yes: true }), "plenary-test-case11")).toMatchObject({ status: "kept", why: "in use" });
});

test("resolveNoOpen: a trailing slash on a non-directory is ENOTDIR", () => {
  const w = world(), f = join(w.root, "plain");
  writeFileSync(f, "x");
  expect(resolveNoOpen(f)).toBe(join(realpathSync(w.root), "plain"));
  expect(() => resolveNoOpen(f + "/")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  expect(resolveNoOpen(w.root + "/")).toBe(realpathSync(w.root));
});

test("macOS firmlink: /System/Volumes/Data is refused as a base, and its spelling of a path resolves to lsof's", () => {
  const data = "/System/Volumes/Data";
  if (!existsSync(join(data, "Users"))) return;                    // not a firmlinked system
  expect(() => clean({ tempDir: join(sandbox, "none"), scratch: data, rigRoot: null, maxTimeMs: 0, openPathsFn: () => [] })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "none"), scratch: join(data, process.env.HOME), rigRoot: null, maxTimeMs: 0, openPathsFn: () => [] })).toThrow(/refusing/);
  expect(resolveNoOpen(join(data, ROOT))).toBe(ROOT);
});

test("resolveNoOpen keeps the given spelling under a directory that can be entered but not listed", () => {
  const w = world(), dir = join(w.root, "x-only");
  mkdirSync(join(dir, "Sub"), { recursive: true });
  chmodSync(dir, 0o111);
  try { expect(resolveNoOpen(join(dir, "Sub"))).toBe(join(realpathSync(w.root), "x-only", "Sub")); }
  finally { chmodSync(dir, 0o755); }
});

test("resolveNoOpen firmlink prefix: dots ignored, a nested firmlink dropped, a directory that only looks alike kept", () => {
  const data = "/System/Volumes/Data", same = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
  if (!existsSync(join(data, "Users"))) return;                    // not a firmlinked system
  expect(resolveNoOpen(data + "/./Users/./")).toBe(resolveNoOpen("/Users"));
  if (same(data + "/usr/local", "/usr/local")) expect(resolveNoOpen(data + "/usr/local")).toBe("/usr/local");   // nested: /usr itself is not one
  if (existsSync(join(data, "usr")) && !same(data + "/usr", "/usr")) expect(resolveNoOpen(data + "/usr")).toBe(data + "/usr");   // not the same dir: spelling kept
});
