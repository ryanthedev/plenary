// @ts-check
// The Metrics port (PROTOCOL.md § Metrics): how the domain records what an operator watches. Core code imports this
// and never an adapter; the adapter (prometheus.js) owns the exposition format. THE contract:
//   counter(name, help, labelNames?, seed?)           -> { inc(n = 1, labels?) }   seed: label sets to show as 0 from the start
//   gauge(name, help, read)                           read: () => number, sampled when the adapter is scraped
//   histogram(name, help, { buckets?, labelNames? })  -> { observe(value, labels?) }
// Every call is non-throwing and never waits (a metric must not take down the hot path). Labels: only the declared
// names, a fixed small set of values, never a board, user or tenant.

/** @typedef {{ inc(n?: number, labels?: Record<string, string>): void }} Counter */
/** @typedef {{ observe(value: number, labels?: Record<string, string>): void }} Histogram */
/** @typedef {{ counter(name: string, help: string, labelNames?: string[], seed?: Record<string, string>[]): Counter,
 *   gauge(name: string, help: string, read: () => number): void,
 *   histogram(name: string, help: string, o?: { buckets?: readonly number[], labelNames?: string[] }): Histogram }} Metrics */

const noCounter = Object.freeze({ inc() {} });
const noHistogram = Object.freeze({ observe() {} });

/** The Metrics adapter for "off": records nothing, costs a function call. @type {Metrics} */
export const noopMetrics = Object.freeze({
  counter: () => noCounter,
  gauge() {},
  histogram: () => noHistogram,
});

/** Bucket upper bounds (seconds) shared by the domain's histograms. */
export const STORE_BUCKETS = Object.freeze([0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
export const FANOUT_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
