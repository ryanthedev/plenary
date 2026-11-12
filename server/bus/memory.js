// The Bus port in memory (PROTOCOL.md § Bus), for a single node. Same contract as the cluster bus (NATS core):
//   - exact subjects, no wildcards;
//   - at-most-once: a message published with no subscriber is gone; a subscriber that throws loses that message;
//   - per subject, subscribers get messages in publish order;
//   - delivery is asynchronous (a publisher is never re-entered by its own subscribers).
// Messages are passed by reference here; a network bus serialises them, so publish only plain data and never
// change a message after publishing it.

import { subjects, busBytes, MAX_BUS_BYTES } from "./port.js";
import { PortError } from "../ids.js";

export { subjects };

/**
 * @param {{ onError?: (err: unknown, subject: string) => void, maxBytes?: number }} [o]
 *   maxBytes: the message cap (§ Bus, 2 MB by default, as NATS); a bigger publish is refused like NATS refuses it
 *   (the promise rejects with PortError "too-large", and onError hears of it). Tests pass a small one.
 */
export function memoryBus({ onError = () => {}, maxBytes = MAX_BUS_BYTES } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  let queue = [], draining = false, closed = false;
  const idle = [];

  const drain = () => {
    draining = false;
    const batch = queue; queue = [];
    for (const [subject, msg] of batch) {
      const set = subs.get(subject);
      if (!set) continue;                       // nobody listening: dropped (at-most-once)
      for (const fn of [...set]) {
        if (!set.has(fn)) continue;             // unsubscribed while this batch ran
        try {
          const r = fn(msg, subject);
          if (r && typeof r.then === "function") r.then(undefined, err => onError(err, subject));
        } catch (err) { onError(err, subject); }
      }
    }
    if (queue.length) schedule(); else for (const f of idle.splice(0)) f();
  };
  const schedule = () => { if (!draining) { draining = true; queueMicrotask(drain); } };

  return {
    /** Resolves once the message is queued (not once it is delivered: there is no delivery receipt). */
    async publish(subject, msg) {
      if (closed || typeof subject !== "string") return;
      if (maxBytes !== Infinity) {
        const size = busBytes(msg);
        if (size > maxBytes) { const err = new PortError("too-large", `a bus message is limited to ${maxBytes} bytes (this one is ${size})`); onError(err, subject); throw err; }
      }
      queue.push([subject, msg]); schedule();
    },
    /** @returns {() => void} unsubscribe */
    subscribe(subject, fn) {
      if (typeof subject !== "string" || typeof fn !== "function") throw new TypeError("subscribe(subject, fn)");
      if (!subs.has(subject)) subs.set(subject, new Set());
      subs.get(subject).add(fn);
      return () => { const set = subs.get(subject); if (!set) return; set.delete(fn); if (!set.size) subs.delete(subject); };
    },
    /** Resolves when everything published so far has been handed to subscribers (tests, clean shutdown). */
    flush() { return queue.length || draining ? new Promise(res => idle.push(res)) : Promise.resolve(); },
    subscriberCount: subject => subs.get(subject)?.size ?? 0,
    maxBytes,
    async close() { closed = true; queue = []; subs.clear(); },
  };
}
