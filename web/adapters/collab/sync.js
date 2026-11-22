// @ts-check
// The collab port's production adapter (web/ports/collab.js): core's policy (web/core/collab/port.js, p7-audit C-13)
// with the browser's frame scheduler, which core may not read. The fake (./fake.js) is the other adapter; both pass
// test/web/contracts/collab-contract.js.
import { collabPort } from "../../core/collab/port.js";

/**
 * @param {ReturnType<typeof import("../../core/session.js").createSession>} session
 * @param {{ name: string, frame?: (fn: () => void) => any, jumpTo?: (p: { x: number, y: number }) => void }} o
 *   frame: schedules one call (default requestAnimationFrame, else a 16 ms timeout). The rest: collabPort's.
 */
export function syncCollabPort(session, { frame = null, ...o }) {
  const next = frame ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : fn => setTimeout(fn, 16));
  return collabPort(session, { ...o, frame: next });
}
