# Brief: p-serve round 2 (fix the import scanner; p-servev FAIL H1)

You are the p-serve builder, resumed. Same base, ownership and rules as docs/m2/briefs/p-serve.md.

- **Your tab:** `worker p-serve r2 (engine) · <your id>: import scanner fix`. Manager: `manager engine`, terminal
  `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main). Don't commit. You own server/static.js,
  server/server.js (route mount only), test/server/static.test.js. Nothing else.
- **Read:** docs/m2/reports/p-servev.md (the verifier's report: H1 and L1-L3).
- **Report:** append a "Round 2" section to docs/m2/reports/p-serve.md. Then stop, idle.

## Fix

1. **H1 (HIGH):** a comment containing the word `import` swallows the next real import (`server/static.js:90-98`,
   `STAT` + `onComment`), so `web/ports/storage.js` is off the allowlist and the page can't boot. Make the scanner
   exact: either skip comments and string/template literals before matching, or use Bun's own
   `new Bun.Transpiler({ loader: "js" }).scanImports()` (static.js is an HTTP adapter, so Bun-specific code is
   allowed there) plus whatever it misses that the brief requires (`new Worker(new URL("literal", import.meta.url))`).
   Your choice; say why in the report.
2. **Tests:** the two-line comment shape from the report; and a test that the real-tree allowlist equals an
   independent crawl of web/main.js's graph (for example with `Bun.Transpiler.scanImports`), minus the deny list.
   Each new test fails when the fix is undone (mutation check in a scratch copy; say which).
3. **L2:** document in static.js (one comment) and the report that an absolute `src`/`href` in index.html is
   skipped and logged. L1 and L3: no change (Bun's parser; M4 lever).

## Not yours

`test/arch-scan.js` has the same grammar bug (the verifier's note). Don't touch it; I queue it separately.

## Done when

`bun test` green in the shared tree; test/server/static.test.js and test/architecture.test.js green; a manual
`bun server/main.js` run (port 0, PID recorded, killed after) shows `/ports/storage.js` at 200 and the start-up
`files:` count matches your independent crawl.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.
