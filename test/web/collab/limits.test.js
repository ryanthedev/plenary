// web/collab mirrors protocol constants (it may not import packages/protocol): they must match exactly.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as L from "../../../web/collab/limits.js";
import * as P from "../../../packages/protocol/presence.js";
import { ROLES, CAPS, MAX_ID_CHARS, canWrite, canModerate } from "../../../packages/protocol/envelope.js";

const DIR = join(import.meta.dir, "../../../web/collab");
const sources = () => readdirSync(DIR).filter(f => /\.(js|html)$/.test(f)).map(f => [f, readFileSync(join(DIR, f), "utf8")]);

test("presence table, emote set (order too) and sizes match packages/protocol", () => {
  expect(L.PRESENCE).toEqual(P.PRESENCE);
  expect(L.EMOTES).toEqual(P.EMOTES);
  expect(L.EMOTES).toEqual(["👍", "❤️", "😂", "🎉", "👏", "😮", "🙏", "🔥"]);
  expect([L.MAX_SELECT_IDS, L.MAX_LASER_POINTS, L.PREVIEW_TTL_MS]).toEqual([P.MAX_SELECT_IDS, P.MAX_LASER_POINTS, P.PREVIEW_TTL_MS]);
  expect(L.MAX_ID_CHARS).toBe(MAX_ID_CHARS);
});

test("roles, stream writers and record caps match", () => {
  expect(L.ROLES).toEqual(ROLES);
  for (const r of [...ROLES, "root", null]) for (const s of ["board", "notes", "records", "x"]) expect(L.canWrite(r, s)).toBe(canWrite(r, s));
  for (const r of [...ROLES, "root"]) expect(L.canModerate(r)).toBe(canModerate(r));
  const { chars, ...caps } = CAPS.records;
  expect(L.RECORDS).toEqual(caps);
});

test("the seam: nothing in web/collab imports packages/protocol (or web/sync.js)", () => {
  for (const [f, src] of sources()) {
    for (const m of src.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)) {
      expect(`${f}: ${m[1]}`).not.toMatch(/packages\/protocol|sync\.js/);
    }
  }
});

test("no HTML sinks in web/collab: text only goes in as text", () => {
  for (const [f, src] of sources()) {
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(`${f} ${/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/.test(code)}`).toBe(`${f} false`);
  }
});
