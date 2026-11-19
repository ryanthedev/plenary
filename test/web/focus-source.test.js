// Focus restoration matches a control by its KEY alone (web/adapters/dom/focus.js): never by label, title, text or position, because lists repeat
// those (a Lock on every layer, a delete on every note) and the wrong control would get focus. This reads the source so a later "helpful" fallback fails.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/adapters/dom/focus.js", import.meta.url), "utf8");
const body = name => { const i = src.indexOf(`export function ${name}`); const j = src.indexOf("\nexport ", i + 1); return src.slice(i, j < 0 ? undefined : j); };
const code = s => s.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

test("restoreFocus finds the control by data-fk key only", () => {
  const b = code(body("restoreFocus"));
  expect(b).toContain("byKey(");
  for (const bad of ["aria-label", "title", "textContent", "sayText", "innerText", ".nth", "tagName", "indexOf(held.el", "label"])
    expect([bad, b.includes(bad)]).toEqual([bad, false]);
});

test("captureFocus remembers a key and nothing about what the control says", () => {
  const b = code(body("captureFocus"));
  for (const bad of ["aria-label", "title", "textContent", "sayText", "nth"]) expect([bad, b.includes(bad)]).toEqual([bad, false]);
  expect(b).toContain("keyOf(");
});

test("the fallback never yields an action control: no kindOf, and every neutral target is a row or a self-keyed row", () => {
  expect(src).not.toMatch(/kindOf|ACTIONS/);
  const table = src.slice(src.indexOf("const NEUTRAL"), src.indexOf("const neutralFor"));
  const targets = [...table.matchAll(/to: m => `([^`]+)`/g)].map(m => m[1]);
  expect(targets.length).toBeGreaterThan(0);
  for (const t of targets) expect(t).not.toMatch(/delete|edit|lock|visible|react|resolve|jump/);          // a row (`...:row`) or a row that is itself neutral
  expect(table).not.toMatch(/delete|edit\b|lock|visible|react|resolve/);
});

test("automatic keys are only made for a label that is unique in its root, and are never used as a fallback", () => {
  expect(src).toMatch(/count\.get\(k\) === 1/);
  expect(code(body("restoreFocus"))).toMatch(/!held\.key\.startsWith\("auto:"\)/);
});
