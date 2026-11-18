// scripts/ci-test.js: JUnit parsing, FLAKY/FAILING classification, and the real red and FLAKY paths run against
// throwaway fixture test files written into a temp dir (so `bun test` here never discovers them).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJunit, classify, renderSummary } from "../../scripts/ci-test.js";

const SCRIPT = new URL("../../scripts/ci-test.js", import.meta.url).pathname;
const dirs = [];
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ci-test-")); dirs.push(d); return d; };

const XML = `<?xml version="1.0"?><testsuites><testsuite name="a.test.js" file="a.test.js">
<testcase name="ok" file="a.test.js" line="2" />
<testcase name="bad &lt;&amp;&gt; | pipe" file="a.test.js" line="3"><failure type="AssertionError" message="expect(received)&#10;&#10;Expected: 2">x</failure></testcase>
<testcase name="sk" file="a.test.js" line="4"><skipped /></testcase></testsuite></testsuites>`;

test("parseJunit reads pass, fail (entities and first message line decoded) and skip", () => {
  expect(parseJunit(XML)).toEqual([
    { file: "a.test.js", name: "ok", status: "pass", message: "" },
    { file: "a.test.js", name: "bad <&> | pipe", status: "fail", message: "expect(received)" },
    { file: "a.test.js", name: "sk", status: "skip", message: "" },
  ]);
  expect(parseJunit("")).toEqual([]);
});

test("classify: failed then passed is FLAKY; failed twice or missing from the rerun is FAILING", () => {
  const c = (name, status) => ({ file: "f.test.js", name, status, message: "" });
  const first = [c("a", "fail"), c("b", "fail"), c("c", "fail"), c("d", "pass")];
  const r = classify(first, [c("a", "pass"), c("b", "fail"), c("d", "pass")]);
  expect(r.flaky.map(x => x.name)).toEqual(["a"]);
  expect(r.failing.map(x => x.name)).toEqual(["b", "c"]);
});

test("renderSummary labels each verdict and says a flake still fails the job", () => {
  const c = name => ({ file: "f.test.js", name, message: "boom" });
  const md = renderSummary({ title: "T", total: 3, skipped: 0, flaky: [c("x")], failing: [c("y")], other: [] });
  expect(md).toContain("1 FLAKY, 1 FAILING");
  expect(md).toContain("FAILING (failed twice) | `f.test.js` | y");
  expect(md).toContain("FLAKY (passed on rerun) | `f.test.js` | x");
  const only = renderSummary({ title: "T", total: 1, skipped: 0, flaky: [c("x")], failing: [], other: [] });
  expect(only).toContain("still fails");
});

async function runScript(dir, files, extra = [], env = {}) {
  const p = Bun.spawn([process.execPath, SCRIPT, "--out", join(dir, "out"), ...extra, ...files], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, summary: existsSync(join(dir, "summary.md")) ? readFileSync(join(dir, "summary.md"), "utf8") : "" };
}

test("a green run exits 0 and reruns nothing", async () => {
  const d = tmp();
  writeFileSync(join(d, "ok.test.js"), `import {test} from "bun:test"; test("fine", () => {});`);
  const r = await runScript(d, ["./ok.test.js"]);
  expect(r.code).toBe(0);
  expect(r.summary).toContain("0 FLAKY, 0 FAILING");
  expect(existsSync(join(d, "out/junit.xml"))).toBe(true);
  expect(existsSync(join(d, "out/junit-rerun.xml"))).toBe(false);
});

test("red path: an always-failing test is FAILING, the run exits 1, only its file is rerun", async () => {
  const d = tmp();
  writeFileSync(join(d, "ok.test.js"), `import {test} from "bun:test"; test("fine", () => {});`);
  writeFileSync(join(d, "bad.test.js"), `import {test, expect} from "bun:test"; test("always red", () => expect(1).toBe(2));`);
  const r = await runScript(d, ["./ok.test.js", "./bad.test.js"]);
  expect(r.code).toBe(1);
  expect(r.summary).toContain("0 FLAKY, 1 FAILING");
  expect(r.summary).toContain("FAILING (failed twice) | `bad.test.js` | always red");
  const rerun = parseJunit(readFileSync(join(d, "out/junit-rerun.xml"), "utf8"));
  expect(rerun.map(c => c.file)).toEqual(["bad.test.js"]);
});

test("FLAKY path: fails first, passes on rerun (marker file) is FLAKY, and the run still exits 1", async () => {
  const d = tmp(), marker = join(d, "marker");
  writeFileSync(join(d, "flaky.test.js"), `import {test, expect} from "bun:test"; import {existsSync, writeFileSync} from "node:fs";
test("red once", () => { const m = process.env.MARKER; if (!existsSync(m)) { writeFileSync(m, "x"); expect("first").toBe("never"); } });`);
  const r = await runScript(d, ["./flaky.test.js"], [], { MARKER: marker });
  expect(r.code).toBe(1);
  expect(r.summary).toContain("1 FLAKY, 0 FAILING");
  expect(r.summary).toContain("FLAKY (passed on rerun) | `flaky.test.js` | red once");
});

test("a file that fails to load (no failed testcase in JUnit) fails the run as unattributed, with no rerun", async () => {
  const d = tmp();
  writeFileSync(join(d, "broken.test.js"), `import {test} from "bun:test"; test("x", () => {}); throw new Error("load fail");`);
  const r = await runScript(d, ["./broken.test.js"]);
  expect(r.code).toBe(1);
  expect(r.summary).toContain("no failed test in the JUnit file");
  expect(existsSync(join(d, "out/junit-rerun.xml"))).toBe(false);
});

test("--no-skips fails a run with a skipped test; without it the skip is fine", async () => {
  const d = tmp();
  writeFileSync(join(d, "sk.test.js"), `import {test} from "bun:test"; test("a", () => {}); test.skip("b", () => {});`);
  expect((await runScript(d, ["./sk.test.js"])).code).toBe(0);
  const r = await runScript(d, ["./sk.test.js"], ["--no-skips"]);
  expect(r.code).toBe(1);
  expect(r.summary).toContain("1 test(s) skipped");
});
