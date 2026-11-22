import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmarks, formatMarkdown } from "../../scripts/bench.js";

function assertStats(stats) {
  expect(stats).toBeDefined();
  expect(stats.n).toBeGreaterThan(0);
  for (const k of ["min", "p50", "p95", "p99", "max", "mean"]) {
    expect(typeof stats[k]).toBe("number");
    expect(Number.isFinite(stats[k])).toBe(true);
    expect(stats[k]).toBeGreaterThanOrEqual(0);
  }
  expect(stats.min).toBeLessThanOrEqual(stats.p50);
  expect(stats.p50).toBeLessThanOrEqual(stats.p95);
  expect(stats.p95).toBeLessThanOrEqual(stats.p99);
  expect(stats.p99).toBeLessThanOrEqual(stats.max);
}

function assertReportShape(report) {
  expect(report.meta).toBeDefined();
  expect(typeof report.meta.platform).toBe("string");
  expect(typeof report.meta.arch).toBe("string");
  expect(typeof report.meta.bunVersion).toBe("string");
  expect(typeof report.meta.timestamp).toBe("string");
  expect(Number.isFinite(report.meta.totalDurationMs)).toBe(true);
  expect(Number.isFinite(report.meta.memory.rssDeltaBytes)).toBe(true);

  // Section 1: Core Render & Spatial Index
  expect(report.renderSpatial.map(r => r.elements)).toEqual([1_000, 10_000, 25_000]);
  for (const r of report.renderSpatial) {
    assertStats(r.coldPaint);
    assertStats(r.warmPanZoom);
    assertStats(r.editRepaint);
    assertStats(r.hitTest.spatial);
    assertStats(r.hitTest.linear);
    expect(Number.isFinite(r.hitTest.speedupP50)).toBe(true);
    expect(r.hitTest.speedupP50).toBeGreaterThan(0);
    expect(typeof r.budgets.warmPan60Hz).toBe("boolean");
    expect(typeof r.budgets.warmPan120Hz).toBe("boolean");
  }

  // Section 2: Protocol & F9 Snapshot
  const ps = report.protocolSnapshot;
  expect(ps.roomThroughput.opsPerSec).toBeGreaterThan(0);
  expect(ps.roomThroughput.acks).toBeGreaterThan(0);
  expect(ps.roomThroughput.refused).toBe(0);
  assertStats(ps.roomThroughput.latencyMs);
  expect(ps.recordsIncremental.comments).toBeGreaterThanOrEqual(1_000);
  assertStats(ps.recordsIncremental.coldFullRebuildMs);
  assertStats(ps.recordsIncremental.warmIncrementalMs);
  expect(ps.recordsIncremental.speedupP50).toBeGreaterThan(1);

  expect(ps.f9Snapshots.map(s => s.elements)).toEqual([1_000, 10_000]);
  for (const s of ps.f9Snapshots) {
    expect(s.rawBytes).toBeGreaterThan(s.gzipBytes);
    expect(s.compressionRatio).toBeGreaterThan(1);
    assertStats(s.jsonEncode);
    assertStats(s.gzip);
    assertStats(s.gunzip);
    assertStats(s.jsonDecode);
  }

  // Section 3: Presence Interpolation
  expect(report.presence.map(p => p.peers)).toEqual([50, 200]);
  for (const p of report.presence) {
    expect(p.sinkCount).toBeGreaterThan(0);
    assertStats(p.stepMs);
    expect(Number.isFinite(p.pctOf120HzBudgetP95)).toBe(true);
    expect(typeof p.pass120Hz).toBe("boolean");
  }
}

describe("scripts/bench.js", () => {
  test("programmatic runBenchmarks({ quick: true }) produces complete valid report and markdown", () => {
    const t0 = performance.now();
    const report = runBenchmarks({ quick: true });
    const elapsedMs = performance.now() - t0;

    expect(report.meta.mode).toBe("quick");
    expect(elapsedMs).toBeLessThan(10_000);
    assertReportShape(report);

    const md = formatMarkdown(report);
    expect(md).toContain("# Plenary Performance Benchmark Report");
    expect(md).toContain("## 1. Core Render & Spatial Index");
    expect(md).toContain("## 2. Protocol & F9 Snapshot");
    expect(md).toContain("## 3. Presence Interpolation");
    expect(md).toContain("MemoryLog");
    expect(md).toContain("bun scripts/bench.js --out docs/benchmarks/report.md");
  });

  test("CLI --quick --json --out exits 0 with valid JSON and markdown file", () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-bench-"));
    const outPath = join(dir, "report.md");
    try {
      const res = spawnSync(process.execPath, ["scripts/bench.js", "--quick", "--json", "--out", outPath], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      const parsed = JSON.parse(res.stdout);
      assertReportShape(parsed);

      const md = readFileSync(outPath, "utf8");
      expect(md).toContain("# Plenary Performance Benchmark Report");
      expect(md).toContain("| 25,000 |");
      expect(md).toContain("| 200 |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI exits 2 on usage errors without raw stack trace", () => {
    const badFlag = spawnSync(process.execPath, ["scripts/bench.js", "--bogus"], { encoding: "utf8" });
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain("Unknown flag: --bogus");
    expect(badFlag.stderr).not.toContain("at parseArgs");

    const badOut = spawnSync(process.execPath, ["scripts/bench.js", "--out", "--json"], { encoding: "utf8" });
    expect(badOut.status).toBe(2);
    expect(badOut.stderr).toContain("--out requires a file path");
    expect(badOut.stderr).not.toContain("at parseArgs");
  });
});
