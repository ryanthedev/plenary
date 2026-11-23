# Plenary Performance Benchmark Report

> Reproducible, zero-dependency micro- and macro-benchmarks covering Core Render & Spatial Index, Protocol & F9 Snapshots, and Real-Time Presence Interpolation.

## Summary Highlights

- **10,000-element warm pan/zoom**: **0.409 ms** p50 / **0.976 ms** p95 (60 Hz: **PASS**, 120 Hz: **PASS**), spatial `hitTest` **10.34×** faster than linear scan.
- **25,000-element warm pan/zoom**: **0.910 ms** p50 / **1.412 ms** p95 (60 Hz: **PASS**, 120 Hz: **PASS**), spatial `hitTest` **12.83×** faster than linear scan.
- **Protocol `Room` throughput**: **78,902 ops/s** (0.012 ms p50 / 0.016 ms p95 per op; 3,200 acks, 0 refused; in-memory `MemoryLog`, single connection).
- **`Replica.recordsState()` incremental cache**: **16.15×** faster than cold cache on 1,200 comments (400 threads, 1 pending op).
- **F9 Snapshot (10,000 elements)**: **5.02 MiB** raw JSON → **287.7 KiB** gzip (**17.86×** ratio, **94.4%** smaller); gzip in **14.19 ms**, gunzip in **2.031 ms**.
- **Presence overlay frame (`step() + view()`, 200 concurrent peers + live strokes)**: **48.3 µs** p50 / **57.5 µs** p95 per frame (**0.69%** of 120 Hz budget).

## Environment

| Property | Value |
| :--- | :--- |
| Platform / Arch | `darwin/arm64` |
| CPU | Apple M2 Max (12 logical cores) |
| System Memory | 64.00 GiB |
| Runtime | Bun `1.4.4` |
| Git Commit | `f191019` |
| Timestamp (UTC) | `2026-11-23T13:48:05.751Z` |
| Benchmark Mode | `full` (3194.4 ms wall time) |
| Process Memory Delta (post-GC) | RSS 56.75 MiB (10.73 MiB → 67.49 MiB), Heap 2.96 MiB |

---

## 1. Core Render & Spatial Index

Deterministic mixed-element boards (rectangles, ellipses, diamonds, bound & unbound arrows, container & standalone text labels, frames, pressure freedraw) rendered into a `1280×800` viewport. Frame budgets: **60 Hz = 16.67 ms**, **120 Hz = 8.33 ms** (evaluated at **p95**). Cells marked `—` for p99 indicate sample size `n < 100`.

### Paint & Repaint Latency

| Elements | Operation | n | p50 | p95 | p99 | min | max | mean | 60 Hz (16.67 ms) | 120 Hz (8.33 ms) |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |
| 1,000 | Cold paint (fresh Doc) | 15 | 0.853 ms | 1.738 ms | — | 0.733 ms | 1.765 ms | 1.030 ms | PASS | PASS |
| 1,000 | Warm pan/zoom (~87 visited) | 100 | 0.155 ms | 0.294 ms | 1.010 ms | 0.094 ms | 1.212 ms | 0.191 ms | PASS | PASS |
| 1,000 | 1-element edit repaint | 100 | 0.679 ms | 1.334 ms | 1.499 ms | 0.592 ms | 1.568 ms | 0.756 ms | PASS | PASS |
| 10,000 | Cold paint (fresh Doc) | 15 | 4.472 ms | 6.744 ms | — | 3.564 ms | 6.795 ms | 4.914 ms | PASS | PASS |
| 10,000 | Warm pan/zoom (~543 visited) | 100 | 0.409 ms | 0.976 ms | 1.156 ms | 0.363 ms | 1.519 ms | 0.472 ms | PASS | PASS |
| 10,000 | 1-element edit repaint | 100 | 4.269 ms | 5.887 ms | 6.005 ms | 3.436 ms | 7.387 ms | 4.518 ms | PASS | PASS |
| 25,000 | Cold paint (fresh Doc) | 7 | 12.10 ms | 13.56 ms | — | 10.45 ms | 13.93 ms | 11.92 ms | PASS | FAIL |
| 25,000 | Warm pan/zoom (~1290 visited) | 100 | 0.910 ms | 1.412 ms | 1.770 ms | 0.785 ms | 1.970 ms | 0.992 ms | PASS | PASS |
| 25,000 | 1-element edit repaint | 30 | 11.95 ms | 14.05 ms | — | 9.765 ms | 14.57 ms | 11.99 ms | PASS | FAIL |

> **Note on 25,000-element 1-element edit repaint**: `Doc.apply()` bumps `doc.rev` and clears `doc._sorted`, which triggers a full `SpatialIndex` grid rebuild across all 25,000 elements on the next `paintScene()` call. Consequently, single-edit repaint latency tracks cold-paint latency at 25k elements (passing 60 Hz, exceeding 120 Hz), whereas warm pan/zoom stays under 1.5 ms.

### Spatial `hitTest` vs Linear Scan

| Elements | n | Avg Checked | Spatial p50 | Spatial p95 | Spatial p99 | Linear p50 | Linear p95 | Speedup (p50) | Speedup (mean) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 100 | 54 | 0.025 ms | 0.044 ms | 0.058 ms | 0.182 ms | 0.299 ms | **7.14×** | 7.18× |
| 10,000 | 100 | 504 | 0.147 ms | 0.193 ms | 0.566 ms | 1.519 ms | 2.174 ms | **10.34×** | 9.4× |
| 25,000 | 100 | 1254 | 0.333 ms | 0.496 ms | 1.044 ms | 4.276 ms | 4.983 ms | **12.83×** | 11.32× |

---

## 2. Protocol & F9 Snapshot

### `Room` Op Sequencing Throughput

> **Scope**: In-memory `MemoryLog`, `auto: false` (no periodic checkpoints), single writer connection, no broadcast fan-out. All ops are pre-built before timing and verified (`3,200` acks, `0` refused).

| Throughput Ops | Latency n | Throughput | p50 | p95 | p99 | min | max | mean |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 1000 | **78,902 ops/s** | 0.012 ms | 0.016 ms | 0.028 ms | 0.010 ms | 0.077 ms | 0.013 ms |

### `Replica.recordsState()` Incremental Cache

Dataset: **400 threads** / **1,200 comments** with reactions. Both paths execute the exact same 1-pending-op overlay branch and differ only in per-thread JSON cache state.

| Path | n | p50 | p95 | p99 | min | max | mean | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold cache (first call after snapshot) | 100 | 0.262 ms | 0.336 ms | 0.928 ms | 0.217 ms | 1.001 ms | 0.277 ms | 1.00× |
| Warm incremental cache (1 pending op) | 100 | 0.016 ms | 0.021 ms | 0.026 ms | 0.015 ms | 0.055 ms | 0.017 ms | **16.15×** (16.2× mean) |

### F9 Snapshot Codec & Compression (`Bun.gzipSync`)

| Elements | n | Raw JSON | Gzipped | Ratio | Savings | JSON Encode (p50 / p95) | Gzip (p50 / p95) | Gunzip (p50 / p95) | JSON Decode (p50 / p95) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 30 | 513.9 KiB | 30.3 KiB | **16.95×** | 94.1% | 1.508 ms / 1.772 ms | 1.435 ms / 1.576 ms | 0.224 ms / 0.247 ms | 0.764 ms / 0.828 ms |
| 10,000 | 15 | 5.02 MiB | 287.7 KiB | **17.86×** | 94.4% | 15.21 ms / 15.95 ms | 14.19 ms / 14.78 ms | 2.031 ms / 2.336 ms | 6.974 ms / 7.854 ms |

---

## 3. Presence Interpolation

Concurrent remote editors with actively moving cursors and live freedraw stroke previews. Each timed frame executes `presence.step(8.33)` + `presence.view()` (full overlay frame cost at **120 Hz**, remote target updates at ~20 Hz).

| Concurrent Peers | n | Cursors + Previews | p50 (µs / ms) | p95 (µs / ms) | p99 (µs / ms) | mean (µs) | % of 120 Hz Budget (p50 / p95) | 120 Hz |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 50 | 300 | 50 + 50 | 20.9 µs (0.021 ms) | 28.3 µs (0.028 ms) | 32.5 µs (0.033 ms) | 19.2 µs | 0.25% / 0.34% | PASS |
| 200 | 300 | 200 + 200 | 48.3 µs (0.048 ms) | 57.5 µs (0.058 ms) | 62.7 µs (0.063 ms) | 52.3 µs | 0.58% / 0.69% | PASS |

---

## Reproduction

```bash
# Full reproducible report
bun scripts/bench.js --out docs/benchmarks/report.md

# Fast CI / smoke run with machine-readable JSON
bun scripts/bench.js --quick --json
```
