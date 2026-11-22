#!/usr/bin/env bun
// Reproducible performance benchmark suite for Plenary.
// Zero external dependencies: Bun/Node built-ins + workspace core/protocol/collab modules.
//
// Usage:
//   bun scripts/bench.js                              # full run, markdown to stdout
//   bun scripts/bench.js --out docs/benchmarks/report.md
//   bun scripts/bench.js --quick --json               # fast CI/smoke run, JSON to stdout

import os from "node:os";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { Doc } from "../packages/core/doc.js";
import { makeElement, clone, emptyScene } from "../packages/core/model.js";
import { paintScene } from "../packages/core/render.js";
import { hitTest, hits, outlineDistance, bbox } from "../packages/core/geometry.js";
import { Room, snapshotOf } from "../packages/protocol/room.js";
import { Replica } from "../packages/protocol/replica.js";
import { MemoryLog } from "../packages/protocol/ports.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { PROTOCOL_VERSION } from "../packages/protocol/envelope.js";
import { createPresence } from "../web/core/collab/presence-model.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUDGET_60HZ_MS = 16.67;
const BUDGET_120HZ_MS = 8.33;
const LIGHT_THEME = { bg: "#ffffff", fg: "#1e1e1e", dim: "#868e96", accent: "#1971c2" };
const VIEWPORT = { w: 1280, h: 800 };

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// ── Deterministic PRNG & Statistics ─────────────────────────────────────────

/** Mulberry32 deterministic PRNG returning values in [0, 1). */
function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile via linear interpolation on a sorted ascending array. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Summarize millisecond samples into standard latency statistics. */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i];
  const round = v => Number(v.toFixed(4));
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.length ? sum / sorted.length : 0),
  };
}

/** Run `warmup` discarded iterations followed by `iters` timed iterations. */
function measure(warmup, iters, fn, { beforeEach, afterEach } = {}) {
  for (let i = 0; i < warmup; i++) {
    const ctx = beforeEach ? beforeEach(i, true) : undefined;
    fn(i, true, ctx);
    if (afterEach) afterEach(i, true, ctx);
  }
  const samples = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const ctx = beforeEach ? beforeEach(i, false) : undefined;
    const t0 = performance.now();
    fn(i, false, ctx);
    samples[i] = performance.now() - t0;
    if (afterEach) afterEach(i, false, ctx);
  }
  return summarize(samples);
}

// ── Environment Metadata ────────────────────────────────────────────────────

function readGitShaFast() {
  try {
    let gitDir = join(REPO_ROOT, ".git");
    if (!existsSync(gitDir)) return null;
    if (!statSync(gitDir).isDirectory()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = resolve(REPO_ROOT, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const commonDir = existsSync(join(gitDir, "commondir"))
        ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
        : gitDir;
      for (const base of [gitDir, commonDir]) {
        const refPath = join(base, ref);
        if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim().slice(0, 7);
      }
      const packed = join(commonDir, "packed-refs");
      if (existsSync(packed)) {
        for (const line of readFileSync(packed, "utf8").split("\n")) {
          if (line.endsWith(" " + ref)) return line.split(" ")[0].slice(0, 7);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function collectEnv() {
  const cpus = os.cpus();
  let gitSha = readGitShaFast();
  if (!gitSha) {
    try {
      gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 300,
      }).trim() || "unknown";
    } catch {
      gitSha = "unknown";
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCores: cpus.length,
    totalMemBytes: os.totalmem(),
    bunVersion: typeof Bun !== "undefined" ? Bun.version : process.version,
    gitSha,
    timestamp: new Date().toISOString(),
  };
}

// ── Deterministic Board Generator ───────────────────────────────────────────

const FILLS = ["transparent", "#a5d8ff", "#b2f2bb", "#ffec99", "#ffc9c9", "#d0bfff"];
const STROKES = ["#1e1e1e", "#1971c2", "#2f9e44", "#e03131", "#9c36b5"];

/**
 * Generate a deterministic, realistic mixed-element board of exactly `count` elements:
 * rectangles, ellipses, diamonds, bound arrows, text labels (container + standalone), frames, and freedraw.
 */
function generateBoardElements(count, seed = 42) {
  const rand = createRng(seed);
  const cols = Math.max(10, Math.ceil(Math.sqrt(count)));
  const cellSpacing = 220;
  const elements = [];
  const shapeIds = [];

  for (let i = 0; i < count; i++) {
    const gx = i % cols;
    const gy = Math.floor(i / cols);
    const x = gx * cellSpacing + Math.round((rand() - 0.5) * 30);
    const y = gy * cellSpacing + Math.round((rand() - 0.5) * 30);
    const id = `el-${i}`;
    const elSeed = i + 1;
    const fill = FILLS[i % FILLS.length];
    const stroke = STROKES[i % STROKES.length];
    const bucket = i % 20;
    let el;

    if (bucket === 0) {
      // Frame (5%)
      el = makeElement("frame", {
        id, x: x - 20, y: y - 20, width: 380, height: 280,
        name: `Section ${Math.floor(i / 20) + 1}`, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    } else if (bucket <= 6) {
      // Rectangle (30%)
      el = makeElement("rectangle", {
        id, x, y, width: 110 + (i % 4) * 15, height: 64 + (i % 3) * 12,
        backgroundColor: fill, strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
      shapeIds.push(id);
    } else if (bucket <= 9) {
      // Ellipse (15%)
      el = makeElement("ellipse", {
        id, x, y, width: 96, height: 72,
        backgroundColor: fill, strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
      shapeIds.push(id);
    } else if (bucket <= 11) {
      // Diamond (10%)
      el = makeElement("diamond", {
        id, x, y, width: 100, height: 80,
        backgroundColor: fill, strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
      shapeIds.push(id);
    } else if (bucket === 12 && shapeIds.length >= 2) {
      // Bound arrow (5%)
      const fromId = shapeIds[shapeIds.length - 2];
      const toId = shapeIds[shapeIds.length - 1];
      el = makeElement("arrow", {
        id, x, y, width: 140, height: 40,
        points: [[0, 0], [140, 40]],
        startBinding: { elementId: fromId, focus: 0, gap: 6 },
        endBinding: { elementId: toId, focus: 0, gap: 6 },
        endArrowhead: "arrow", strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    } else if (bucket <= 14) {
      // Unbound arrow (5–10%)
      el = makeElement("arrow", {
        id, x, y, width: 120, height: 30,
        points: [[0, 0], [60, -15], [120, 30]],
        endArrowhead: "arrow", strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    } else if (bucket <= 16 && shapeIds.length >= 1) {
      // Container-bound text label (10%)
      const hostId = shapeIds[shapeIds.length - 1];
      el = makeElement("text", {
        id, x, y, width: 100, height: 32,
        text: `Node ${i}`, originalText: `Node ${i}`, fontSize: 16, containerId: hostId,
        strokeColor: "#1e1e1e", seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    } else if (bucket === 17) {
      // Standalone text (5%)
      el = makeElement("text", {
        id, x, y, width: 140, height: 28,
        text: `Note #${i}`, originalText: `Note #${i}`, fontSize: 18,
        strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    } else {
      // Freedraw stroke with pressure (10%)
      const pts = [];
      const pressures = [];
      for (let p = 0; p < 12; p++) {
        pts.push([p * 9, Math.round(Math.sin(p * 0.6 + i) * 18)]);
        pressures.push(Number((0.3 + 0.5 * Math.abs(Math.sin(p * 0.4))).toFixed(2)));
      }
      el = makeElement("freedraw", {
        id, x, y, width: 100, height: 36,
        points: pts, pressures, strokeColor: stroke, seed: elSeed, version: 1, versionNonce: elSeed, updated: 1700000000000,
      });
    }

    el.customData = { layer: "base", z: i };
    elements.push(el);
  }
  return { elements, worldSpan: cols * cellSpacing };
}

/** Reference linear-scan hitTest matching geometry.js semantics (for speedup baseline). */
function linearHitTest(doc, p, tol = 6) {
  const els = doc.visible();
  for (let i = els.length - 1; i >= 0; i--) if (hits(doc, els[i], p, tol)) return els[i];
  let best = null, area = Infinity;
  for (const el of els) {
    if (el.type === "frame" || !["rectangle", "diamond", "ellipse"].includes(el.type) || outlineDistance(el, p) > 0) continue;
    const b = bbox(el), a = b.w * b.h;
    if (a < area) { best = el; area = a; }
  }
  return best;
}

// ── Section 1: Core Render & Spatial Index ──────────────────────────────────

function benchCoreRender(quick) {
  const scales = [1_000, 10_000, 25_000];
  const results = [];

  for (const count of scales) {
    const { elements: baseElements, worldSpan } = generateBoardElements(count, 1000 + count);
    const centerWorld = Math.floor(worldSpan * 0.4);
    const baseView = { x: -centerWorld, y: -centerWorld, scale: 1 };

    // 1a. Cold paint: fresh Doc + shallow-copied elements built per-iteration in beforeEach (outside timer).
    const coldWarmup = quick ? 1 : 2;
    const coldIters = quick ? 3 : (count >= 25_000 ? 7 : 15);
    let lastColdItems = 0;
    const coldPaint = measure(
      coldWarmup,
      coldIters,
      (_i, _w, coldDoc) => {
        const items = paintScene(coldDoc, baseView, LIGHT_THEME, { clip: VIEWPORT });
        lastColdItems = items.length;
      },
      {
        beforeEach: () => new Doc({ elements: baseElements.map(el => ({ ...el })) }),
      },
    );

    // 1b. Warm pan/zoom paint across shifting viewports (simulating 60/120 Hz panning).
    const doc = new Doc({ elements: baseElements });
    paintScene(doc, baseView, LIGHT_THEME, { clip: VIEWPORT });
    const panWarmup = quick ? 3 : 10;
    const panIters = quick ? 15 : 100;
    let panVisitedSum = 0;
    const warmPanZoom = measure(panWarmup, panIters, (i, isWarmup) => {
      const step = isWarmup ? i : i + 1;
      const vx = -centerWorld - (step % 12) * 18;
      const vy = -centerWorld - ((step * 7) % 12) * 14;
      const scale = 0.85 + ((step % 5) * 0.12);
      const stats = {};
      paintScene(doc, { x: vx, y: vy, scale }, LIGHT_THEME, { clip: VIEWPORT, stats });
      if (!isWarmup) panVisitedSum += stats.visited ?? 0;
    });

    // 1c. 1-element edit repaint: mutate 1 visible element and repaint viewport.
    const visibleSample = paintScene(doc, baseView, LIGHT_THEME, { clip: VIEWPORT });
    const editId = visibleSample.find(it => it.id && !it.id.includes(":") && doc.get(it.id)?.type === "rectangle")?.id
      ?? baseElements.find(e => e.type === "rectangle").id;
    let editVer = 2;
    const editWarmup = quick ? 3 : 8;
    const editIters = quick ? 10 : (count >= 25_000 ? 30 : 100);
    const editRepaint = measure(editWarmup, editIters, () => {
      const cur = clone(doc.get(editId));
      cur.x += (editVer % 2 === 0 ? 4 : -4);
      cur.version = editVer++;
      cur.versionNonce = editVer * 31;
      doc.apply({ elements: [cur] });
      paintScene(doc, baseView, LIGHT_THEME, { clip: VIEWPORT });
    });

    // 1d. Spatial hitTest vs linear scan speedup.
    const queryRand = createRng(9000 + count);
    const queryCount = quick ? 12 : 100;
    const queryPoints = Array.from({ length: queryCount }, () => ({
      x: Math.floor(queryRand() * Math.max(400, worldSpan - 200)) + 20,
      y: Math.floor(queryRand() * Math.max(400, worldSpan - 200)) + 20,
    }));
    const hitWarmup = quick ? 2 : 5;
    let spatialCheckedSum = 0;
    const spatialHit = measure(hitWarmup, queryCount, (i, isWarmup) => {
      const pt = queryPoints[i % queryCount];
      const stats = {};
      hitTest(doc, pt, 6, { stats });
      if (!isWarmup) spatialCheckedSum += stats.checked ?? 0;
    });
    const linearHit = measure(hitWarmup, queryCount, i => {
      linearHitTest(doc, queryPoints[i % queryCount], 6);
    });
    const speedup = spatialHit.p50 > 0 ? Number((linearHit.p50 / spatialHit.p50).toFixed(2)) : 0;
    const meanSpeedup = spatialHit.mean > 0 ? Number((linearHit.mean / spatialHit.mean).toFixed(2)) : 0;

    results.push({
      elements: count,
      coldDisplayItems: lastColdItems,
      avgPanVisited: Math.round(panVisitedSum / panIters),
      avgSpatialChecked: Math.round(spatialCheckedSum / queryCount),
      coldPaint,
      warmPanZoom,
      editRepaint,
      hitTest: {
        spatial: spatialHit,
        linear: linearHit,
        speedupP50: speedup,
        speedupMean: meanSpeedup,
      },
      budgets: {
        coldPaint60Hz: coldPaint.p95 <= BUDGET_60HZ_MS,
        coldPaint120Hz: coldPaint.p95 <= BUDGET_120HZ_MS,
        warmPan60Hz: warmPanZoom.p95 <= BUDGET_60HZ_MS,
        warmPan120Hz: warmPanZoom.p95 <= BUDGET_120HZ_MS,
        editRepaint60Hz: editRepaint.p95 <= BUDGET_60HZ_MS,
        editRepaint120Hz: editRepaint.p95 <= BUDGET_120HZ_MS,
      },
    });
  }

  return results;
}

// ── Section 2: Protocol & F9 Snapshot ───────────────────────────────────────

function benchProtocolAndSnapshot(quick) {
  // 2a. Room op throughput (MemoryLog, auto: false, single connection, no broadcast fan-out).
  // Pre-build all op messages before timed loops so ops/s measures bare room.receive() throughput.
  let nowMs = 1_700_000_000_000;
  const log = new MemoryLog();
  const room = new Room({ board: "bench-board", tenant: "bench-tenant", log, now: () => ++nowMs, auto: false });
  let acks = 0;
  let refused = 0;
  let firstError = null;
  const conn = room.connect(msg => {
    if (msg.t === "ack") acks++;
    else if (msg.t === "error") {
      refused++;
      if (!firstError) firstError = msg;
    }
  });
  room.receive(conn, { t: "hello", v: PROTOCOL_VERSION, board: "bench-board", client: "c-bench", since: 0 }, { user: "u1", role: "owner", name: "Bench" });

  const opWarmup = quick ? 25 : 200;
  const throughputIters = quick ? 150 : 2000;
  const latencyIters = quick ? 150 : 1000;
  const totalOps = opWarmup + throughputIters + latencyIters;
  const opPool = 200;
  const versions = new Int32Array(opPool);
  let counter = 0;

  const makeOpMsg = idx => {
    const slot = idx % opPool;
    const ver = ++versions[slot];
    const el = makeElement(slot % 2 === 0 ? "rectangle" : "ellipse", {
      id: `op-el-${slot}`,
      x: (slot % 20) * 120 + ver,
      y: Math.floor(slot / 20) * 90,
      width: 100,
      height: 60,
      seed: slot + 1,
      version: ver,
      versionNonce: ver * 17 + slot,
      updated: 1_700_000_000_000 + idx,
    });
    return { t: "op", id: `c-bench:${++counter}`, sentAt: 0, stream: "board", op: { elements: [el] } };
  };

  const warmupMsgs = Array.from({ length: opWarmup }, (_, i) => makeOpMsg(i));
  const throughputMsgs = Array.from({ length: throughputIters }, (_, i) => makeOpMsg(opWarmup + i));
  const latencyMsgs = Array.from({ length: latencyIters }, (_, i) => makeOpMsg(opWarmup + throughputIters + i));

  for (let i = 0; i < warmupMsgs.length; i++) room.receive(conn, warmupMsgs[i]);

  // Bare throughput loop (zero per-op allocation or per-op timer overhead).
  const tAllStart = performance.now();
  for (let i = 0; i < throughputMsgs.length; i++) room.receive(conn, throughputMsgs[i]);
  const tAllMs = performance.now() - tAllStart;
  const roomOpsPerSec = Math.round(throughputIters / (tAllMs / 1000));

  // Separate per-op sampled loop for latency percentiles.
  const opSamples = new Array(latencyIters);
  for (let i = 0; i < latencyMsgs.length; i++) {
    const msg = latencyMsgs[i];
    const t0 = performance.now();
    room.receive(conn, msg);
    opSamples[i] = performance.now() - t0;
  }
  const roomOpLatency = summarize(opSamples);

  if (refused > 0 || acks !== totalOps) {
    throw new Error(`Room benchmark op verification failed: acks=${acks}/${totalOps}, refused=${refused}${firstError ? ` (${firstError.code}: ${firstError.message})` : ""}`);
  }

  // 2b. Replica.recordsState() cache speedup on 1,200 comments across 400 threads.
  // Both cold and warm runs take the exact same 1-pending-op overlay branch and differ only in cache state.
  const threadCount = 400;
  const commentsPerThread = 3;
  const totalComments = threadCount * commentsPerThread;
  const baseThreads = [];
  for (let t = 0; t < threadCount; t++) {
    const comments = [];
    for (let c = 0; c < commentsPerThread; c++) {
      comments.push({
        id: c === 0 ? `th-${t}` : `th-${t}-c-${c}`,
        by: `u${(t + c) % 5}`,
        name: `User ${(t + c) % 5}`,
        at: 1_700_000_000_000 + t * 1000 + c * 100,
        text: `Benchmark comment ${c} on thread ${t} with realistic review feedback.`,
        reactions: c === 0 ? { "👍": ["u1", "u2"] } : {},
      });
    }
    baseThreads.push({
      id: `th-${t}`,
      anchor: { x: (t % 20) * 150, y: Math.floor(t / 20) * 120 },
      by: `u${t % 5}`,
      name: `User ${t % 5}`,
      at: 1_700_000_000_000 + t * 1000,
      comments,
    });
  }

  const snapForRecords = {
    t: "snapshot",
    seq: 100,
    streams: { board: { elements: [], appState: emptyScene().appState.herdr }, notes: { elements: [], appState: emptyScene().appState.herdr } },
    appSeq: { board: {}, notes: {} },
    records: { threads: baseThreads },
    noteAuthor: [],
  };

  const recWarmup = quick ? 2 : 5;
  const recIters = quick ? 10 : 100;
  let coldReplySeq = 0;

  // Cold cache (first call after snapshot) with 1 pending local op.
  const coldRecords = measure(
    recWarmup,
    recIters,
    (_i, _w, rep) => { rep.recordsState(); },
    {
      beforeEach: i => {
        const rep = new Replica({ client: "rec-cold", session: "s1", now: () => 1_700_000_100_000 });
        rep.connectMessages("tok", "b1");
        rep.receive({ t: "welcome", seq: 100, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
        rep.receive(snapForRecords);
        const targetThread = `th-${i % threadCount}`;
        rep.local("records", { do: "reply", thread: targetThread, id: `cold-r-${++coldReplySeq}`, text: "Looks good!" });
        return rep;
      },
    },
  );

  // Warm incremental cache: snapshot already loaded & per-thread _json primed; 1 pending local op.
  const warmRep = new Replica({ client: "rec-warm", session: "s2", now: () => 1_700_000_100_000 });
  warmRep.connectMessages("tok", "b1");
  warmRep.receive({ t: "welcome", seq: 100, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
  warmRep.receive(snapForRecords);
  warmRep.recordsState(); // prime per-thread _json cache

  let replySeq = 0;
  const warmRecords = measure(
    recWarmup,
    recIters,
    () => { warmRep.recordsState(); },
    {
      beforeEach: i => {
        const targetThread = `th-${i % threadCount}`;
        return warmRep.local("records", { do: "reply", thread: targetThread, id: `local-r-${++replySeq}`, text: "Looks good!" });
      },
      afterEach: (_i, _w, msg) => {
        warmRep.pending.delete(msg.id);
        warmRep.recordsRev++;
      },
    },
  );

  const recordsSpeedupP50 = warmRecords.p50 > 0 ? Number((coldRecords.p50 / warmRecords.p50).toFixed(2)) : 0;
  const recordsSpeedupMean = warmRecords.mean > 0 ? Number((coldRecords.mean / warmRecords.mean).toFixed(2)) : 0;

  // 2c. F9 Snapshot JSON encode + Bun.gzipSync / gunzipSync / decode at 1,000 and 10,000 elements.
  const snapScales = [1_000, 10_000];
  const f9Snapshots = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (const count of snapScales) {
    const { elements } = generateBoardElements(count, 2000 + count);
    const snap = snapshotOf({
      seq: count,
      streams: {
        board: { elements, appState: emptyScene().appState.herdr },
        notes: { elements: [], appState: emptyScene().appState.herdr },
      },
      appSeq: { board: {}, notes: {} },
      records: { threads: baseThreads.slice(0, count >= 10_000 ? 100 : 20) },
      noteAuthor: [],
    });

    const snapWarmup = quick ? 1 : 3;
    const snapIters = quick ? 4 : (count >= 10_000 ? 15 : 30);

    let encodedStr = "";
    const jsonEncode = measure(snapWarmup, snapIters, () => {
      encodedStr = jsonCodec.encode(snap);
    });
    const rawUint8 = encoder.encode(encodedStr);
    const rawBytes = rawUint8.byteLength;

    let gzipped = new Uint8Array(0);
    const gzip = measure(snapWarmup, snapIters, () => {
      gzipped = Bun.gzipSync(rawUint8);
    });
    const gzipBytes = gzipped.byteLength;

    let gunzipped = new Uint8Array(0);
    const gunzip = measure(snapWarmup, snapIters, () => {
      gunzipped = Bun.gunzipSync(gzipped);
    });

    const jsonDecode = measure(snapWarmup, snapIters, () => {
      jsonCodec.decode(decoder.decode(gunzipped));
    });

    f9Snapshots.push({
      elements: count,
      rawBytes,
      gzipBytes,
      compressionRatio: Number((rawBytes / gzipBytes).toFixed(2)),
      savingsPct: Number(((1 - gzipBytes / rawBytes) * 100).toFixed(1)),
      jsonEncode,
      gzip,
      gunzip,
      jsonDecode,
    });
  }

  return {
    roomThroughput: {
      opsMeasured: throughputIters,
      latencySamples: latencyIters,
      acks,
      refused,
      opsPerSec: roomOpsPerSec,
      latencyMs: roomOpLatency,
      scope: "MemoryLog, auto: false (no checkpoints), single connection, no broadcast fan-out",
    },
    recordsIncremental: {
      threads: threadCount,
      comments: totalComments,
      coldFullRebuildMs: coldRecords,
      warmIncrementalMs: warmRecords,
      speedupP50: recordsSpeedupP50,
      speedupMean: recordsSpeedupMean,
    },
    f9Snapshots,
  };
}

// ── Section 3: Presence Interpolation ───────────────────────────────────────

function benchPresence(quick) {
  const peerCounts = [50, 200];
  const results = [];

  for (const peers of peerCounts) {
    let t = 1_000;
    const presence = createPresence({
      now: () => t,
      me: { user: "me", client: "c-me" },
      role: "editor",
    });

    const writers = [];
    const initBatch = [];
    for (let i = 0; i < peers; i++) {
      const user = `u-${i}`;
      const client = `c-${i}`;
      writers.push({ user, name: `Peer ${i}`, role: "editor" });
      initBatch.push({ k: "cursor", user, client, x: i * 15, y: i * 10 });
      initBatch.push({
        k: "preview",
        user,
        client,
        stream: "board",
        elements: [{ id: `live-stroke-${i}`, type: "freedraw", x: i * 15, y: i * 10, width: 80, height: 40, points: [[0, 0], [40, 20], [80, 40]] }],
      });
    }
    presence.here({ writers, writerCount: peers, viewers: 0 });
    presence.ingest(initBatch);

    const makeTickBatch = tick => {
      const batch = new Array(peers * 2);
      for (let i = 0; i < peers; i++) {
        const user = `u-${i}`;
        const client = `c-${i}`;
        const nx = i * 15 + Math.cos(tick * 0.25 + i) * 180;
        const ny = i * 10 + Math.sin(tick * 0.25 + i) * 140;
        batch[i * 2] = { k: "cursor", user, client, x: nx, y: ny };
        batch[i * 2 + 1] = {
          k: "preview",
          user,
          client,
          stream: "board",
          elements: [{ id: `live-stroke-${i}`, type: "freedraw", x: nx, y: ny, width: 80 + (tick % 20), height: 40 + (tick % 12), points: [[0, 0], [40, 20], [80, 40]] }],
        };
      }
      return batch;
    };

    const warmup = quick ? 10 : 40;
    const iters = quick ? 60 : 300;
    let tick = 0;
    let sinkCount = 0;
    presence.ingest(makeTickBatch(++tick));

    // Time step() + view() together (real overlay frame cost), sinking view lengths to prevent DCE.
    const stepMs = measure(
      warmup,
      iters,
      () => {
        presence.step(BUDGET_120HZ_MS, { scale: 1 });
        const v = presence.view();
        sinkCount += v.cursors.length + v.previews.length;
      },
      {
        beforeEach: i => {
          if (i % 6 === 0) presence.ingest(makeTickBatch(++tick));
          t += BUDGET_120HZ_MS;
        },
      },
    );

    const toUs = v => Number((v * 1000).toFixed(1));
    results.push({
      peers,
      activeCursors: peers,
      activeStrokePreviews: peers,
      sinkCount,
      stepMs,
      stepUs: {
        min: toUs(stepMs.min),
        p50: toUs(stepMs.p50),
        p95: toUs(stepMs.p95),
        p99: toUs(stepMs.p99),
        max: toUs(stepMs.max),
        mean: toUs(stepMs.mean),
      },
      pctOf120HzBudgetP50: Number(((stepMs.p50 / BUDGET_120HZ_MS) * 100).toFixed(2)),
      pctOf120HzBudgetP95: Number(((stepMs.p95 / BUDGET_120HZ_MS) * 100).toFixed(2)),
      pass120Hz: stepMs.p95 <= BUDGET_120HZ_MS,
    });
  }

  return results;
}

// ── Runner & Markdown Report Formatter ──────────────────────────────────────

function runGc() {
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
}

export function runBenchmarks({ quick = false } = {}) {
  runGc();
  const memBefore = process.memoryUsage();
  const env = collectEnv();
  const startedAt = performance.now();

  const renderSpatial = benchCoreRender(quick);
  const protocolSnapshot = benchProtocolAndSnapshot(quick);
  const presence = benchPresence(quick);

  const totalDurationMs = Number((performance.now() - startedAt).toFixed(1));
  runGc();
  const memAfter = process.memoryUsage();

  return {
    meta: {
      ...env,
      mode: quick ? "quick" : "full",
      totalDurationMs,
      budgetsMs: { hz60: BUDGET_60HZ_MS, hz120: BUDGET_120HZ_MS },
      memory: {
        rssBeforeBytes: memBefore.rss,
        rssAfterBytes: memAfter.rss,
        rssDeltaBytes: memAfter.rss - memBefore.rss,
        heapUsedBeforeBytes: memBefore.heapUsed,
        heapUsedAfterBytes: memAfter.heapUsed,
        heapUsedDeltaBytes: memAfter.heapUsed - memBefore.heapUsed,
      },
    },
    renderSpatial,
    protocolSnapshot,
    presence,
  };
}

function fmtBytes(b) {
  const abs = Math.abs(b);
  if (abs >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (abs >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${b} B`;
}

function fmtMs(v) {
  return v >= 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(3)} ms`;
}

function fmtP99Ms(stats) {
  return stats.n < 100 ? "—" : fmtMs(stats.p99);
}

const badge = ok => (ok ? "PASS" : "FAIL");

export function formatMarkdown(report) {
  const { meta, renderSpatial, protocolSnapshot, presence } = report;
  const r10k = renderSpatial.find(r => r.elements === 10_000) ?? renderSpatial[0];
  const r25k = renderSpatial.find(r => r.elements === 25_000) ?? renderSpatial[renderSpatial.length - 1];
  const snap10k = protocolSnapshot.f9Snapshots.find(s => s.elements === 10_000) ?? protocolSnapshot.f9Snapshots[0];
  const p200 = presence.find(p => p.peers === 200) ?? presence[presence.length - 1];

  const lines = [
    "# Plenary Performance Benchmark Report",
    "",
    "> Reproducible, zero-dependency micro- and macro-benchmarks covering Core Render & Spatial Index, Protocol & F9 Snapshots, and Real-Time Presence Interpolation.",
    "",
    "## Summary Highlights",
    "",
    `- **10,000-element warm pan/zoom**: **${fmtMs(r10k.warmPanZoom.p50)}** p50 / **${fmtMs(r10k.warmPanZoom.p95)}** p95 (60 Hz: **${badge(r10k.budgets.warmPan60Hz)}**, 120 Hz: **${badge(r10k.budgets.warmPan120Hz)}**), spatial \`hitTest\` **${r10k.hitTest.speedupP50}×** faster than linear scan.`,
    `- **25,000-element warm pan/zoom**: **${fmtMs(r25k.warmPanZoom.p50)}** p50 / **${fmtMs(r25k.warmPanZoom.p95)}** p95 (60 Hz: **${badge(r25k.budgets.warmPan60Hz)}**, 120 Hz: **${badge(r25k.budgets.warmPan120Hz)}**), spatial \`hitTest\` **${r25k.hitTest.speedupP50}×** faster than linear scan.`,
    `- **Protocol \`Room\` throughput**: **${protocolSnapshot.roomThroughput.opsPerSec.toLocaleString("en-US")} ops/s** (${fmtMs(protocolSnapshot.roomThroughput.latencyMs.p50)} p50 / ${fmtMs(protocolSnapshot.roomThroughput.latencyMs.p95)} p95 per op; ${protocolSnapshot.roomThroughput.acks.toLocaleString("en-US")} acks, ${protocolSnapshot.roomThroughput.refused} refused; in-memory \`MemoryLog\`, single connection).`,
    `- **\`Replica.recordsState()\` incremental cache**: **${protocolSnapshot.recordsIncremental.speedupP50}×** faster than cold cache on ${protocolSnapshot.recordsIncremental.comments.toLocaleString("en-US")} comments (${protocolSnapshot.recordsIncremental.threads} threads, 1 pending op).`,
    `- **F9 Snapshot (10,000 elements)**: **${fmtBytes(snap10k.rawBytes)}** raw JSON → **${fmtBytes(snap10k.gzipBytes)}** gzip (**${snap10k.compressionRatio}×** ratio, **${snap10k.savingsPct}%** smaller); gzip in **${fmtMs(snap10k.gzip.p50)}**, gunzip in **${fmtMs(snap10k.gunzip.p50)}**.`,
    `- **Presence overlay frame (\`step() + view()\`, 200 concurrent peers + live strokes)**: **${p200.stepUs.p50} µs** p50 / **${p200.stepUs.p95} µs** p95 per frame (**${p200.pctOf120HzBudgetP95}%** of 120 Hz budget).`,
    "",
    "## Environment",
    "",
    "| Property | Value |",
    "| :--- | :--- |",
    `| Platform / Arch | \`${meta.platform}/${meta.arch}\` |`,
    `| CPU | ${meta.cpuModel} (${meta.cpuCores} logical cores) |`,
    `| System Memory | ${fmtBytes(meta.totalMemBytes)} |`,
    `| Runtime | Bun \`${meta.bunVersion}\` |`,
    `| Git Commit | \`${meta.gitSha}\` |`,
    `| Timestamp (UTC) | \`${meta.timestamp}\` |`,
    `| Benchmark Mode | \`${meta.mode}\` (${meta.totalDurationMs} ms wall time) |`,
    `| Process Memory Delta (post-GC) | RSS ${fmtBytes(meta.memory.rssDeltaBytes)} (${fmtBytes(meta.memory.rssBeforeBytes)} → ${fmtBytes(meta.memory.rssAfterBytes)}), Heap ${fmtBytes(meta.memory.heapUsedDeltaBytes)} |`,
    "",
    "---",
    "",
    "## 1. Core Render & Spatial Index",
    "",
    `Deterministic mixed-element boards (rectangles, ellipses, diamonds, bound & unbound arrows, container & standalone text labels, frames, pressure freedraw) rendered into a \`${VIEWPORT.w}×${VIEWPORT.h}\` viewport. Frame budgets: **60 Hz = ${BUDGET_60HZ_MS} ms**, **120 Hz = ${BUDGET_120HZ_MS} ms** (evaluated at **p95**). Cells marked \`—\` for p99 indicate sample size \`n < 100\`.`,
    "",
    "### Paint & Repaint Latency",
    "",
    "| Elements | Operation | n | p50 | p95 | p99 | min | max | mean | 60 Hz (16.67 ms) | 120 Hz (8.33 ms) |",
    "| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |",
  ];

  for (const r of renderSpatial) {
    const rows = [
      ["Cold paint (fresh Doc)", r.coldPaint, r.budgets.coldPaint60Hz, r.budgets.coldPaint120Hz],
      [`Warm pan/zoom (~${r.avgPanVisited} visited)`, r.warmPanZoom, r.budgets.warmPan60Hz, r.budgets.warmPan120Hz],
      ["1-element edit repaint", r.editRepaint, r.budgets.editRepaint60Hz, r.budgets.editRepaint120Hz],
    ];
    for (const [label, s, b60, b120] of rows) {
      lines.push(`| ${r.elements.toLocaleString("en-US")} | ${label} | ${s.n} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtP99Ms(s)} | ${fmtMs(s.min)} | ${fmtMs(s.max)} | ${fmtMs(s.mean)} | ${badge(b60)} | ${badge(b120)} |`);
    }
  }

  lines.push(
    "",
    "> **Note on 25,000-element 1-element edit repaint**: `Doc.apply()` bumps `doc.rev` and clears `doc._sorted`, which triggers a full `SpatialIndex` grid rebuild across all 25,000 elements on the next `paintScene()` call. Consequently, single-edit repaint latency tracks cold-paint latency at 25k elements (passing 60 Hz, exceeding 120 Hz), whereas warm pan/zoom stays under 1.5 ms.",
    "",
    "### Spatial `hitTest` vs Linear Scan",
    "",
    "| Elements | n | Avg Checked | Spatial p50 | Spatial p95 | Spatial p99 | Linear p50 | Linear p95 | Speedup (p50) | Speedup (mean) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const r of renderSpatial) {
    const h = r.hitTest;
    lines.push(`| ${r.elements.toLocaleString("en-US")} | ${h.spatial.n} | ${r.avgSpatialChecked} | ${fmtMs(h.spatial.p50)} | ${fmtMs(h.spatial.p95)} | ${fmtP99Ms(h.spatial)} | ${fmtMs(h.linear.p50)} | ${fmtMs(h.linear.p95)} | **${h.speedupP50}×** | ${h.speedupMean}× |`);
  }

  const rt = protocolSnapshot.roomThroughput;
  const rec = protocolSnapshot.recordsIncremental;

  lines.push(
    "",
    "---",
    "",
    "## 2. Protocol & F9 Snapshot",
    "",
    "### `Room` Op Sequencing Throughput",
    "",
    `> **Scope**: In-memory \`MemoryLog\`, \`auto: false\` (no periodic checkpoints), single writer connection, no broadcast fan-out. All ops are pre-built before timing and verified (\`${rt.acks.toLocaleString("en-US")}\` acks, \`${rt.refused}\` refused).`,
    "",
    "| Throughput Ops | Latency n | Throughput | p50 | p95 | p99 | min | max | mean |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${rt.opsMeasured.toLocaleString("en-US")} | ${rt.latencyMs.n} | **${rt.opsPerSec.toLocaleString("en-US")} ops/s** | ${fmtMs(rt.latencyMs.p50)} | ${fmtMs(rt.latencyMs.p95)} | ${fmtP99Ms(rt.latencyMs)} | ${fmtMs(rt.latencyMs.min)} | ${fmtMs(rt.latencyMs.max)} | ${fmtMs(rt.latencyMs.mean)} |`,
    "",
    "### `Replica.recordsState()` Incremental Cache",
    "",
    `Dataset: **${rec.threads} threads** / **${rec.comments.toLocaleString("en-US")} comments** with reactions. Both paths execute the exact same 1-pending-op overlay branch and differ only in per-thread JSON cache state.`,
    "",
    "| Path | n | p50 | p95 | p99 | min | max | mean | Speedup |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| Cold cache (first call after snapshot) | ${rec.coldFullRebuildMs.n} | ${fmtMs(rec.coldFullRebuildMs.p50)} | ${fmtMs(rec.coldFullRebuildMs.p95)} | ${fmtP99Ms(rec.coldFullRebuildMs)} | ${fmtMs(rec.coldFullRebuildMs.min)} | ${fmtMs(rec.coldFullRebuildMs.max)} | ${fmtMs(rec.coldFullRebuildMs.mean)} | 1.00× |`,
    `| Warm incremental cache (1 pending op) | ${rec.warmIncrementalMs.n} | ${fmtMs(rec.warmIncrementalMs.p50)} | ${fmtMs(rec.warmIncrementalMs.p95)} | ${fmtP99Ms(rec.warmIncrementalMs)} | ${fmtMs(rec.warmIncrementalMs.min)} | ${fmtMs(rec.warmIncrementalMs.max)} | ${fmtMs(rec.warmIncrementalMs.mean)} | **${rec.speedupP50}×** (${rec.speedupMean}× mean) |`,
    "",
    "### F9 Snapshot Codec & Compression (`Bun.gzipSync`)",
    "",
    "| Elements | n | Raw JSON | Gzipped | Ratio | Savings | JSON Encode (p50 / p95) | Gzip (p50 / p95) | Gunzip (p50 / p95) | JSON Decode (p50 / p95) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const s of protocolSnapshot.f9Snapshots) {
    lines.push(`| ${s.elements.toLocaleString("en-US")} | ${s.gzip.n} | ${fmtBytes(s.rawBytes)} | ${fmtBytes(s.gzipBytes)} | **${s.compressionRatio}×** | ${s.savingsPct}% | ${fmtMs(s.jsonEncode.p50)} / ${fmtMs(s.jsonEncode.p95)} | ${fmtMs(s.gzip.p50)} / ${fmtMs(s.gzip.p95)} | ${fmtMs(s.gunzip.p50)} / ${fmtMs(s.gunzip.p95)} | ${fmtMs(s.jsonDecode.p50)} / ${fmtMs(s.jsonDecode.p95)} |`);
  }

  lines.push(
    "",
    "---",
    "",
    "## 3. Presence Interpolation",
    "",
    "Concurrent remote editors with actively moving cursors and live freedraw stroke previews. Each timed frame executes `presence.step(8.33)` + `presence.view()` (full overlay frame cost at **120 Hz**, remote target updates at ~20 Hz).",
    "",
    "| Concurrent Peers | n | Cursors + Previews | p50 (µs / ms) | p95 (µs / ms) | p99 (µs / ms) | mean (µs) | % of 120 Hz Budget (p50 / p95) | 120 Hz |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
  );
  for (const p of presence) {
    const p99Cell = p.stepMs.n < 100 ? "—" : `${p.stepUs.p99} µs (${fmtMs(p.stepMs.p99)})`;
    lines.push(`| ${p.peers} | ${p.stepMs.n} | ${p.activeCursors} + ${p.activeStrokePreviews} | ${p.stepUs.p50} µs (${fmtMs(p.stepMs.p50)}) | ${p.stepUs.p95} µs (${fmtMs(p.stepMs.p95)}) | ${p99Cell} | ${p.stepUs.mean} µs | ${p.pctOf120HzBudgetP50}% / ${p.pctOf120HzBudgetP95}% | ${badge(p.pass120Hz)} |`);
  }

  lines.push(
    "",
    "---",
    "",
    "## Reproduction",
    "",
    "```bash",
    "# Full reproducible report",
    "bun scripts/bench.js --out docs/benchmarks/report.md",
    "",
    "# Fast CI / smoke run with machine-readable JSON",
    "bun scripts/bench.js --quick --json",
    "```",
    "",
  );
  return lines.join("\n");
}

// ── CLI Entrypoint ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { quick: false, json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") opts.quick = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--out") {
      const val = argv[++i];
      if (!val || val.startsWith("--")) throw new UsageError("--out requires a file path");
      opts.out = val;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: bun scripts/bench.js [--quick] [--json] [--out <path>]");
      process.exit(0);
    } else {
      throw new UsageError(`Unknown flag: ${a}`);
    }
  }
  return opts;
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.out) mkdirSync(dirname(opts.out), { recursive: true });
    const report = runBenchmarks({ quick: opts.quick });
    const md = formatMarkdown(report);
    if (opts.out) writeFileSync(opts.out, md, "utf8");
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (opts.out) {
      process.stdout.write(`Benchmark report written to ${opts.out} (${report.meta.totalDurationMs} ms)\n`);
    } else {
      process.stdout.write(md);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
