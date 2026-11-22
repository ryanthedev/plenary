// @ts-check
// Store latency (PROTOCOL.md § Metrics): a decorator over the Store port that times every call and counts rejections.
// Core: it sees only the port's method names and the Metrics port. The caller (main.js) wraps the Store once, so the
// room host, the gateway's feeds and everything else are measured the same way. Behaviour is unchanged: same results,
// same rejections, same `this`-free calls; members that are not port methods (adapter-only diagnostics) pass through.

import { STORE_METHODS } from "./store/port.js";
import { STORE_BUCKETS } from "./metrics/port.js";

/**
 * @param {object} store  a Store adapter
 * @param {import("./metrics/port.js").Metrics} metrics
 * @param {() => number} [clock]  ms, monotonic (default performance.now); tests inject one
 */
export function instrumentedStore(store, metrics, clock = () => performance.now()) {
  const seconds = metrics.histogram("plenary_store_seconds", "Store call duration by operation, until it settled.", { buckets: STORE_BUCKETS, labelNames: ["op"] });
  const errors = metrics.counter("plenary_store_errors_total", "Store calls that rejected, by operation.", ["op"], STORE_METHODS.filter(op => op !== "close").map(op => ({ op })));
  const wrapped = Object.create(store);
  for (const op of STORE_METHODS) {
    if (op === "close" || typeof store[op] !== "function") continue;
    const labels = { op };
    wrapped[op] = (...args) => {
      const t0 = clock();
      const done = () => seconds.observe((clock() - t0) / 1000, labels);
      let p;
      try { p = store[op](...args); } catch (err) { done(); errors.inc(1, labels); throw err; }
      return Promise.resolve(p).then(v => { done(); return v; }, err => { done(); errors.inc(1, labels); throw err; });
    };
  }
  return wrapped;
}
