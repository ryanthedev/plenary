// packages/core is herdr-draw's core/, byte for byte (SOURCE.json). Change it there, then re-copy.
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const CORE = new URL("../packages/core/", import.meta.url).pathname;
const src = JSON.parse(readFileSync(CORE + "SOURCE.json", "utf8"));
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");

test("packages/core matches SOURCE.json (no edits here)", () => {
  for (const [f, h] of Object.entries(src.files)) expect([f, sha(CORE + f)]).toEqual([f, h]);
});

test("packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)", () => {
  const theirs = new URL("../../herdr-draw/core/", import.meta.url).pathname;
  if (!existsSync(theirs)) return;   // herdr-draw not checked out next to this repo
  for (const f of Object.keys(src.files)) expect([f, sha(theirs + f)]).toEqual([f, src.files[f]]);
});
