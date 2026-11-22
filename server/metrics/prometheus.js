// @ts-check
// The Metrics adapter that keeps instruments in memory and renders them in the Prometheus text format (exposition 0.0.4).
// PROTOCOL.md § Metrics. Never throws and never waits: a bad value, an unknown label, a type clash or a 65th series is
// dropped. Gauges are read at render time, so a scrape costs what the gauge's reader costs (a counter the node keeps).

import { noopMetrics } from "./port.js";

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** At most this many label sets per metric: a label that was meant to be bounded can't grow memory without limit. */
export const MAX_SERIES = 64;
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const escHelp = s => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escVal = s => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const num = v => (v === Infinity ? "+Inf" : v === -Infinity ? "-Inf" : String(v));

/** @returns {import("./port.js").Metrics & { render(): string }} */
export function prometheusMetrics() {
  /** @type {Map<string, { type: string, help: string, labelNames: string[], series: Map<string, any>, buckets?: number[], read?: () => number }>} */
  const families = new Map();

  /** Label values are rendered with String(), so a seed or an inc with the number 1 and one with "1" are the same series. */
  /** The label set as an exposition string ("" for none); null when a label is unknown or the set is too big. */
  const keyOf = (f, labels) => {
    if (!f.labelNames.length) return "";
    if (!labels || typeof labels !== "object") return null;
    const parts = [];
    for (const n of f.labelNames) { const v = labels[n]; if (v === undefined) return null; parts.push(`${n}="${escVal(v)}"`); }
    return parts.join(",");
  };
  const seriesOf = (f, labels, make) => {
    const k = keyOf(f, labels);
    if (k === null) return null;
    let s = f.series.get(k);
    if (!s) { if (f.series.size >= MAX_SERIES) return null; s = make(); f.series.set(k, s); }
    return s;
  };
  /**
   * @param {string} type
   * @param {string} name
   * @param {string} help
   * @param {string[]} [labelNames]
   * @param {object} [extra]
   * @returns {{ type: string, help: string, labelNames: string[], series: Map<string, any>, buckets?: number[], read?: () => number } | null}
   */
  const family = (type, name, help, labelNames = [], extra = {}) => {
    try {
      if (!NAME.test(name) || !Array.isArray(labelNames) || !labelNames.every(n => LABEL.test(n) && n !== "le")) return null;
      const have = families.get(name);
      if (have) return have.type === type && have.labelNames.join() === labelNames.join() ? have : null;
      const f = { type, help: String(help), labelNames: [...labelNames], series: new Map(), ...extra };
      families.set(name, f);
      return f;
    } catch { return null; }
  };

  return {
    counter(name, help, labelNames, seed) {
      let f;
      try {
        f = family("counter", name, help, labelNames);
        if (!f) return noopMetrics.counter("", "");
        if (Array.isArray(seed)) for (const labels of seed) seriesOf(f, labels, () => ({ v: 0 }));   // fixed label values read 0 from the start
      } catch { return noopMetrics.counter("", ""); }
      if (!f.labelNames.length && !f.series.size) f.series.set("", { v: 0 });   // an unlabelled counter reads 0 from the start
      return { inc(n = 1, labels) {
        try { if (!(n >= 0) || !Number.isFinite(n)) return; const s = seriesOf(f, labels, () => ({ v: 0 })); if (s) s.v += n; } catch { /* never into the hot path */ }
      } };
    },
    gauge(name, help, read) {
      try {
        if (typeof read !== "function") return;
        const f = family("gauge", name, help);
        if (f) f.read = read;
      } catch { /* dropped */ }
    },
    histogram(name, help, o) {
      let f;
      try {
        const { buckets = DEFAULT_BUCKETS, labelNames } = o ?? {};
        const bs = Array.isArray(buckets) ? [...buckets].filter(Number.isFinite).sort((a, b) => a - b) : DEFAULT_BUCKETS;
        f = family("histogram", name, help, labelNames, { buckets: bs });
        if (!f) return noopMetrics.histogram("", "");
        if (!f.labelNames.length && !f.series.size) f.series.set("", { counts: new Array(f.buckets.length).fill(0), sum: 0, count: 0 });
      } catch { return noopMetrics.histogram("", ""); }
      return { observe(value, labels) {
        try {
          if (!Number.isFinite(value)) return;
          const s = seriesOf(f, labels, () => ({ counts: new Array(f.buckets.length).fill(0), sum: 0, count: 0 }));
          if (!s) return;
          for (let i = 0; i < f.buckets.length; i++) if (value <= f.buckets[i]) { s.counts[i]++; break; }   // per-bucket; cumulated at render
          s.sum += value; s.count++;
        } catch { /* never into the hot path */ }
      } };
    },
    /** The text of every metric. A gauge whose reader throws or answers a non-number is left out of this scrape. */
    render() {
      const out = [];
      for (const [name, f] of families) {
        const lines = [];
        if (f.type === "gauge") {
          let v; try { v = f.read(); } catch { v = NaN; }
          if (typeof v === "number" && Number.isFinite(v)) lines.push(`${name} ${v}`);
        } else if (f.type === "counter") {
          for (const [k, s] of f.series) lines.push(`${name}${k ? `{${k}}` : ""} ${s.v}`);
        } else {
          for (const [k, s] of f.series) {
            let cum = 0;
            f.buckets.forEach((b, i) => { cum += s.counts[i]; lines.push(`${name}_bucket{${k ? k + "," : ""}le="${num(b)}"} ${cum}`); });
            lines.push(`${name}_bucket{${k ? k + "," : ""}le="+Inf"} ${s.count}`, `${name}_sum${k ? `{${k}}` : ""} ${s.sum}`, `${name}_count${k ? `{${k}}` : ""} ${s.count}`);
          }
        }
        out.push(`# HELP ${name} ${escHelp(f.help)}`, `# TYPE ${name} ${f.type}`, ...lines);
      }
      return out.length ? out.join("\n") + "\n" : "";
    },
  };
}
