// scripts/clean.js against fixture dirs in a private temp root only (never the real temp dir, never another worktree).
// "Old" is simulated by passing a `now` three hours ahead; processes that hold things open are our own, killed by pid.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync, chmodSync, realpathSync, lstatSync, renameSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { clean, summarize, measure, openPaths, openUnder, renameExcl, loadNativeRename, ROOT } from "../../scripts/clean.js";

const made = [], kids = [];
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "plenary-cleantest-")));
made.push(sandbox);
afterAll(() => { for (const k of kids) try { process.kill(k.pid); } catch {} for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fresh private root with a temp/ dir inside (the "system temp dir") and a rigs/ dir. */
function world({ real = false } = {}) {
  const root = mkdtempSync(join(sandbox, "w-"));
  const tempDir = join(root, "temp"), rigRoot = join(root, ".rig");
  mkdirSync(tempDir); mkdirSync(rigRoot);
  // `lsof` is the real one only where a test needs a process to hold something (real: true); a fixed answer elsewhere (the real one takes ~0.5 s)
  const lsof = join(root, "lsof-none");
  writeFileSync(lsof, "#!/bin/sh\ncase \"$*\" in *+D*) exit 1;; esac\necho n/dev/null\n"); chmodSync(lsof, 0o755);
  return { root, tempDir, rigRoot, lsof: real ? "lsof" : lsof };
}
const entry = (base, name, bytes = 5000) => { const d = join(base, name); mkdirSync(join(d, "sub"), { recursive: true }); writeFileSync(join(d, "sub/f"), "x".repeat(bytes)); return d; };
/** The pid of a process that has just exited: dead now, and not reused within the test. */
const DEAD = spawnSync("true").pid;
const readdirSyncNames = d => readdirSync(d).sort();
const LATER = () => Date.now() + 3 * 3_600_000;
const byName = (r, n) => r.items.find(i => i.path.endsWith("/" + n));
const holder = (script, cwd) => { const p = Bun.spawn(["sh", "-c", script], { cwd, stdout: "ignore", stderr: "ignore" }); kids.push(p); return p; };
const failingLsof = (w, code) => { const f = join(w.root, `lsof-${code}`); writeFileSync(f, `#!/bin/sh\nexit ${code}\n`); chmodSync(f, 0o755); return f; };
const rigDir = (w, name) => { const d = join(w.rigRoot, name); mkdirSync(d); writeFileSync(join(d, "rig.json"), "{}"); writeFileSync(join(d, "blob"), "y".repeat(3000)); return d; };

test("old, unused plenary entries are removed; other names and young entries stay (--yes)", () => {
  const w = world();
  const old = entry(w.tempDir, "plenary-load-data-aaa111"), run = entry(w.tempDir, `plen-run-${DEAD}-x`), other = entry(w.tempDir, "omniloop-life-zzz");
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
  holder(`exec 3<${a}/sub/f; exec sleep 60`, w.root);
  holder("exec sleep 60", b);
  Bun.sleepSync(300);
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

test("only exact known name patterns are candidates: unknown prefixes and bare-prefix names stay", () => {
  const w = world();
  const keep = ["plenary-unknown-abc123", "plenary-test-", "plenary-test-toolong1", "plen-other", "pl-reg-zzzzzz", "plen-abcdef", "omniloop-life-abc123"].map(n => entry(w.tempDir, n));
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
  const r = clean({ ...w, now: LATER(), yes: true, beforeRemove: p => { if (p === d) { holder("exec sleep 60", d); Bun.sleepSync(300); } } });
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

test("a failed darwin native loader warns once and --yes refuses without force", () => {
  const warnings = [], w = world(), d = entry(w.tempDir, "plenary-test-loadr1");
  loadNativeRename(() => { throw new Error("missing library"); }, "darwin", message => warnings.push(message), false);
  const r = clean({ ...w, now: LATER(), yes: true, platform: "darwin", nativeRenameAvailable: false });
  expect(warnings).toEqual(["exclusive rename unavailable; using check-then-rename"]);
  expect(byName(r, "plenary-test-loadr1")).toMatchObject({ status: "kept", why: expect.stringMatching(/exclusive rename unavailable/) });
  expect(existsSync(d)).toBe(true);
});

test.skipIf(process.platform !== "darwin")("native exclusive rename refuses a recreated target after a post-park stat error", () => {
  const w = world(), d = entry(w.tempDir, "plenary-test-nativ1"), parked = join(w.tempDir, ".plen-deleting-plenary-test-nativ1");
  let deleted = false;
  const r = clean({ ...w, now: LATER(), yes: true, stat: p => {
    if (!deleted && p === join(parked, "sub/f")) { deleted = true; rmSync(p); }
    return lstatSync(p);
  } });
  expect(byName(r, "plenary-test-nativ1")).toMatchObject({ status: "kept", why: "changed while parking" });
  expect(existsSync(d)).toBe(true);
  expect(existsSync(parked)).toBe(false);
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
    openUnderFn: () => "" });
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
    openUnderFn: () => "" });
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
  holder(`exec 3<"${odd}"; exec sleep 60`, w.root);
  Bun.sleepSync(300);
  expect(openPaths().some(p => p === odd)).toBe(false);                       // lsof escapes the newline, so the raw path never matches ...
  expect(openPaths().some(p => p === odd.replace("\n", "\\n"))).toBe(true);    // ... but the field is kept whole, escaped, under the entry's prefix
  const r = clean({ ...w, now: LATER(), yes: true });
  expect(r.items[0]).toMatchObject({ status: "kept", why: "in use" });
  expect(existsSync(odd)).toBe(true);
  expect(openUnder(d)).toBe("in use (re-check)");
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
  expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: "/" })).toThrow(/refusing/);
  expect(() => clean({ tempDir: join(sandbox, "none"), rigRoot: process.env.HOME })).toThrow(/refusing/);
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
