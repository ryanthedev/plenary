// Latency statistics for the load client: an exact, mergeable histogram.
//
// Each sample is rounded to RES_MS (0.1 ms) and counted in a map value → count. Percentiles are nearest-rank
// over the counts, so they are exact at that resolution, and two histograms merge by adding counts: a
// percentile of the merged histogram is the percentile of all samples together (never an average of
// percentiles, which is wrong). Distinct keys are bounded by the range / RES_MS (a 60 s spread = 600k keys
// at most; in practice a few thousand).

export const RES_MS = 0.1;
const key = v => Math.round(v / RES_MS);

export class Hist {
  constructor() { this.counts = new Map(); this.n = 0; this.sum = 0; this.min = Infinity; this.max = -Infinity; }

  /** Count one sample (ms). Non-finite or negative values are clamped to 0 (clocks on one machine; never NaN). */
  add(v) {
    if (!Number.isFinite(v) || v < 0) v = 0;
    const k = key(v);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.n++; this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  /** Add another histogram's samples (or its toJSON form) to this one. */
  merge(other) {
    const o = other instanceof Hist ? other : Hist.fromJSON(other);
    for (const [k, c] of o.counts) this.counts.set(k, (this.counts.get(k) ?? 0) + c);
    this.n += o.n; this.sum += o.sum;
    if (o.min < this.min) this.min = o.min;
    if (o.max > this.max) this.max = o.max;
    return this;
  }

  /** Nearest-rank percentile (p in (0, 100]): the smallest sample with at least p% of samples at or below it. */
  percentile(p) {
    if (!this.n) return null;
    const rank = Math.max(1, Math.ceil((p / 100) * this.n));
    const keys = [...this.counts.keys()].sort((a, b) => a - b);
    let seen = 0;
    for (const k of keys) { seen += this.counts.get(k); if (seen >= rank) return round(k * RES_MS); }
    return round(keys[keys.length - 1] * RES_MS);
  }

  /** { n, mean, min, p50, p95, p99, max } in ms (nulls when empty). */
  summary() {
    if (!this.n) return { n: 0, mean: null, min: null, p50: null, p95: null, p99: null, max: null };
    return { n: this.n, mean: round(this.sum / this.n), min: round(this.min), p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99), max: round(this.max) };
  }

  toJSON() { return { n: this.n, sum: this.sum, min: this.n ? this.min : null, max: this.n ? this.max : null, counts: [...this.counts] }; }
  static fromJSON(j) {
    const h = new Hist();
    if (!j) return h;
    h.counts = new Map(j.counts ?? []); h.n = j.n ?? 0; h.sum = j.sum ?? 0;
    h.min = j.min ?? Infinity; h.max = j.max ?? -Infinity;
    return h;
  }
}

const round = v => Math.round(v * 100) / 100;

/** Add counts of b into a: { key: n }. */
export function addCounts(a, b) { for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + v; return a; }
