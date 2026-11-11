// packages/protocol runs in browsers, phones, servers and Herdr's QuickJS runtime: it imports only the core's
// merge rules and model and its own files, and uses no globals that runtime lacks.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
const DIR = new URL("../packages/protocol/", import.meta.url).pathname;

test("protocol imports only core/doc.js, core/model.js and its own files; no host globals", () => {
  for (const f of readdirSync(DIR).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(DIR + f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, spec] of src.matchAll(/(?:import|export)[^"']*from\s*["']([^"']+)["']/g))
      expect([f, spec].join(" ")).toMatch(/ (\.\/[a-z-]+\.js|\.\.\/core\/(doc|model)\.js)$/);
    for (const g of ["TextDecoder", "TextEncoder", "Buffer", "process", "require(", "window", "document", "setTimeout", "setInterval", "fetch(", "structuredClone"])
      expect([f, src.includes(g) ? g : ""]).toEqual([f, ""]);
  }
});
