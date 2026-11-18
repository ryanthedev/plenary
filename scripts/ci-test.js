#!/usr/bin/env bun
// CI test runner: `bun test` with JUnit output; on failure, reruns ONLY the failed files once and labels each failing
// test FLAKY (failed, then passed on the rerun) or FAILING (failed both times). The run fails either way: a flake is
// reported, never absorbed. Writes a Markdown summary to $GITHUB_STEP_SUMMARY (and stdout).
//   bun scripts/ci-test.js [--cluster] [--no-skips] [--out DIR] [test files...]
//   --cluster   run the files in scripts/cluster-files.json (the gated ones) and imply --no-skips
//   --no-skips  a skipped test fails the run (a gated test that skips means its service was not reachable)
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = s => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ENTITIES[n] ?? m);
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)); return m ? unescapeXml(m[1]) : ""; };

/** JUnit XML (bun's) -> [{ file, name, status: "pass" | "fail" | "skip", message }]. */
export function parseJunit(xml) {
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] ?? "", fail = body.match(/<(?:failure|error)\b([^>]*)/);
    out.push({
      file: attr(m[1], "file"), name: attr(m[1], "name"),
      status: fail ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass",
      message: fail ? attr(fail[1], "message").split("\n")[0] : "",
    });
  }
  return out;
}

/** First-run and rerun cases -> { flaky, failing } (each a list of { file, name, message }). */
export function classify(first, rerun) {
  const key = c => `${c.file}\0${c.name}`, again = new Map(rerun.map(c => [key(c), c]));
  const flaky = [], failing = [];
  for (const c of first.filter(c => c.status === "fail")) (again.get(key(c))?.status === "pass" ? flaky : failing).push(c);
  return { flaky, failing };
}

export function renderSummary({ title, total, skipped, flaky, failing, other }) {
  const row = (label, c) => `| ${label} | \`${c.file}\` | ${c.name.replace(/\|/g, "\\|")} | ${(c.message || "").replace(/\|/g, "\\|").slice(0, 160)} |`;
  const lines = [`### ${title}`, "", `${total} tests, ${skipped} skipped, ${flaky.length} FLAKY, ${failing.length} FAILING.`];
  if (flaky.length || failing.length) lines.push("", "| Verdict | File | Test | First failure |", "|---|---|---|---|",
    ...failing.map(c => row("FAILING (failed twice)", c)), ...flaky.map(c => row("FLAKY (passed on rerun)", c)));
  for (const o of other) lines.push("", `- ${o}`);
  if (flaky.length && !failing.length && !other.length) lines.push("", "Every failure passed on rerun, but the job still fails: a flake is a bug to fix, not a pass.");
  return lines.join("\n") + "\n";
}

async function bunTest(files, junit) {
  const p = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${junit}`, ...files], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  let cases = [];
  try { cases = parseJunit(readFileSync(junit, "utf8")); } catch {}
  return { code, cases };
}

/** Runs the whole flow; returns { exit, summary }. */
export async function run({ files, out, noSkips, title = "Tests" }) {
  mkdirSync(out, { recursive: true });
  const first = await bunTest(files, join(out, "junit.xml"));
  const failed = first.cases.filter(c => c.status === "fail"), skipped = first.cases.filter(c => c.status === "skip").length;
  const other = [];
  let flaky = [], failing = [];
  if (failed.length) {
    const refiles = [...new Set(failed.map(c => "./" + c.file.replace(/^\.\//, "")))];
    console.error(`\n[ci-test] ${failed.length} failed; rerunning ${refiles.length} file(s) once: ${refiles.join(" ")}\n`);
    ({ flaky, failing } = classify(first.cases, (await bunTest(refiles, join(out, "junit-rerun.xml"))).cases));
  }
  if (first.code !== 0 && !failed.length) other.push(`bun test exited ${first.code} with no failed test in the JUnit file (a file failed to load, or the run crashed): FAILING, not rerun.`);
  if (noSkips && skipped) other.push(`${skipped} test(s) skipped, which is not allowed here (a service was not reachable).`);
  if (!first.cases.length) other.push("no tests ran.");
  const summary = renderSummary({ title, total: first.cases.length, skipped, flaky, failing, other });
  return { exit: first.code !== 0 || failed.length || other.length ? 1 : 0, summary, flaky, failing };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = f => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  const cluster = take("--cluster"), noSkips = take("--no-skips") || cluster;
  let out = "test-results";
  const oi = args.indexOf("--out"); if (oi >= 0) [out] = args.splice(oi, 2).slice(1);
  const files = cluster ? JSON.parse(readFileSync(new URL("cluster-files.json", import.meta.url), "utf8")).map(f => "./" + f) : args;
  const { exit, summary } = await run({ files, out, noSkips, title: cluster ? "Cluster tests (gated files)" : "Tests" });
  process.stdout.write("\n" + summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exit(exit);
}
