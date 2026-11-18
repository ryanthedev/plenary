// Scratch dirs for the load tests: made with tmp(), removed by cleanTmp() in each file's afterAll.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];
export const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
export function cleanTmp() { for (const d of made.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
