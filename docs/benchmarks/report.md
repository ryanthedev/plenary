# Plenary Performance Benchmark Report

> Reproducible, zero-dependency micro- and macro-benchmarks covering Core Render & Spatial Index, Protocol & F9 Snapshots, and Real-Time Presence Interpolation.

## Summary Highlights

- **10,000-element warm pan/zoom**: **0.386 ms** p50 / **0.963 ms** p95 (60 Hz: **PASS**, 120 Hz: **PASS**), spatial `hitTest` **10.37×** faster than linear scan.
- **25,000-element warm pan/zoom**: **0.946 ms** p50 / **1.254 ms** p95 (60 Hz: **PASS**, 120 Hz: **PASS**), spatial `hitTest` **11.75×** faster than linear scan.
- **Protocol `Room` throughput**: **81,488 ops/s** (0.011 ms p50 / 0.017 ms p95 per op; 3,200 acks, 0 refused; in-memory `MemoryLog`, single connection).
- **`Replica.recordsState()` incremental cache**: **16.46×** faster than cold cache on 1,200 comments (400 threads, 1 pending op).
- **F9 Snapshot (10,000 elements)**: **5.02 MiB** raw JSON → **287.7 KiB** gzip (**17.86×** ratio, **94.4%** smaller); gzip in **13.68 ms**, gunzip in **1.898 ms**.
- **Presence overlay frame (`step() + view()`, 200 concurrent peers + live strokes)**: **49.1 µs** p50 / **58.6 µs** p95 per frame (**0.7%** of 120 Hz budget).

## Environment

| Property | Value |
| :--- | :--- |
| Platform / Arch | `darwin/arm64` |
| CPU | Apple M2 Max (12 logical cores) |
| System Memory | 64.00 GiB |
| Runtime | Bun `1.4.4` |
| Git Commit | `828318e` |
| Timestamp (UTC) | `2026-11-22T15:43:14.488Z` |
| Benchmark Mode | `full` (2973.1 ms wall time) |
| Process Memory Delta (post-GC) | RSS 56.36 MiB (10.09 MiB → 66.45 MiB), Heap 2.84 MiB |

---

## 1. Core Render & Spatial Index

Deterministic mixed-element boards (rectangles, ellipses, diamonds, bound & unbound arrows, container & standalone text labels, frames, pressure freedraw) rendered into a `1280×800` viewport. Frame budgets: **60 Hz = 16.67 ms**, **120 Hz = 8.33 ms** (evaluated at **p95**). Cells marked `—` for p99 indicate sample size `n < 100`.

### Paint & Repaint Latency

| Elements | Operation | n | p50 | p95 | p99 | min | max | mean | 60 Hz (16.67 ms) | 120 Hz (8.33 ms) |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |
| 1,000 | Cold paint (fresh Doc) | 15 | 0.630 ms | 1.319 ms | — | 0.529 ms | 1.756 ms | 0.798 ms | PASS | PASS |
| 1,000 | Warm pan/zoom (~87 visited) | 100 | 0.112 ms | 0.191 ms | 1.000 ms | 0.070 ms | 1.366 ms | 0.146 ms | PASS | PASS |
| 1,000 | 1-element edit repaint | 100 | 0.453 ms | 0.951 ms | 1.162 ms | 0.386 ms | 1.215 ms | 0.542 ms | PASS | PASS |
| 10,000 | Cold paint (fresh Doc) | 15 | 3.801 ms | 5.247 ms | — | 3.532 ms | 5.349 ms | 4.054 ms | PASS | PASS |
| 10,000 | Warm pan/zoom (~543 visited) | 100 | 0.386 ms | 0.963 ms | 1.128 ms | 0.339 ms | 1.272 ms | 0.448 ms | PASS | PASS |
| 10,000 | 1-element edit repaint | 100 | 3.606 ms | 4.858 ms | 5.126 ms | 3.051 ms | 5.243 ms | 3.832 ms | PASS | PASS |
| 25,000 | Cold paint (fresh Doc) | 7 | 10.84 ms | 12.37 ms | — | 9.592 ms | 12.77 ms | 10.83 ms | PASS | FAIL |
| 25,000 | Warm pan/zoom (~1290 visited) | 100 | 0.946 ms | 1.254 ms | 1.964 ms | 0.839 ms | 2.872 ms | 1.017 ms | PASS | PASS |
| 25,000 | 1-element edit repaint | 30 | 11.25 ms | 14.82 ms | — | 9.441 ms | 20.13 ms | 11.60 ms | PASS | FAIL |

> **Note on 25,000-element 1-element edit repaint**: `Doc.apply()` bumps `doc.rev` and clears `doc._sorted`, which triggers a full `SpatialIndex` grid rebuild across all 25,000 elements on the next `paintScene()` call. Consequently, single-edit repaint latency tracks cold-paint latency at 25k elements (passing 60 Hz, exceeding 120 Hz), whereas warm pan/zoom stays under 1.5 ms.

### Spatial `hitTest` vs Linear Scan

| Elements | n | Avg Checked | Spatial p50 | Spatial p95 | Spatial p99 | Linear p50 | Linear p95 | Speedup (p50) | Speedup (mean) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 100 | 54 | 0.022 ms | 0.034 ms | 0.117 ms | 0.175 ms | 0.288 ms | **7.88×** | 6.55× |
| 10,000 | 100 | 504 | 0.140 ms | 0.163 ms | 0.671 ms | 1.450 ms | 1.813 ms | **10.37×** | 9.37× |
| 25,000 | 100 | 1254 | 0.339 ms | 0.478 ms | 1.903 ms | 3.978 ms | 4.639 ms | **11.75×** | 10.23× |

---

## 2. Protocol & F9 Snapshot

### `Room` Op Sequencing Throughput

> **Scope**: In-memory `MemoryLog`, `auto: false` (no periodic checkpoints), single writer connection, no broadcast fan-out. All ops are pre-built before timing and verified (`3,200` acks, `0` refused).

| Throughput Ops | Latency n | Throughput | p50 | p95 | p99 | min | max | mean |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 1000 | **81,488 ops/s** | 0.011 ms | 0.017 ms | 0.023 ms | 0.010 ms | 0.037 ms | 0.012 ms |

### `Replica.recordsState()` Incremental Cache

Dataset: **400 threads** / **1,200 comments** with reactions. Both paths execute the exact same 1-pending-op overlay branch and differ only in per-thread JSON cache state.

| Path | n | p50 | p95 | p99 | min | max | mean | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold cache (first call after snapshot) | 100 | 0.245 ms | 0.310 ms | 0.960 ms | 0.217 ms | 1.026 ms | 0.267 ms | 1.00× |
| Warm incremental cache (1 pending op) | 100 | 0.015 ms | 0.019 ms | 0.023 ms | 0.014 ms | 0.024 ms | 0.015 ms | **16.46×** (17.25× mean) |

### F9 Snapshot Codec & Compression (`Bun.gzipSync`)

| Elements | n | Raw JSON | Gzipped | Ratio | Savings | JSON Encode (p50 / p95) | Gzip (p50 / p95) | Gunzip (p50 / p95) | JSON Decode (p50 / p95) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 30 | 513.9 KiB | 30.3 KiB | **16.95×** | 94.1% | 1.452 ms / 1.710 ms | 1.379 ms / 1.466 ms | 0.220 ms / 0.231 ms | 0.693 ms / 0.863 ms |
| 10,000 | 15 | 5.02 MiB | 287.7 KiB | **17.86×** | 94.4% | 15.19 ms / 16.01 ms | 13.68 ms / 14.28 ms | 1.898 ms / 2.080 ms | 6.872 ms / 7.894 ms |

---

## 3. Presence Interpolation

Concurrent remote editors with actively moving cursors and live freedraw stroke previews. Each timed frame executes `presence.step(8.33)` + `presence.view()` (full overlay frame cost at **120 Hz**, remote target updates at ~20 Hz).

| Concurrent Peers | n | Cursors + Previews | p50 (µs / ms) | p95 (µs / ms) | p99 (µs / ms) | mean (µs) | % of 120 Hz Budget (p50 / p95) | 120 Hz |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 50 | 300 | 50 + 50 | 21.1 µs (0.021 ms) | 29.7 µs (0.030 ms) | 35.5 µs (0.035 ms) | 19.4 µs | 0.25% / 0.36% | PASS |
| 200 | 300 | 200 + 200 | 49.1 µs (0.049 ms) | 58.6 µs (0.059 ms) | 354.8 µs (0.355 ms) | 57.5 µs | 0.59% / 0.7% | PASS |

---

## Reproduction

```bash
# Full reproducible report
bun scripts/bench.js --out docs/benchmarks/report.md

# Fast CI / smoke run with machine-readable JSON
bun scripts/bench.js --quick --json
```
