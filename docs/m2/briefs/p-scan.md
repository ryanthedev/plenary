# Brief: p-scan (import scanning moves onto Bun's parser)

You are the p-scan builder. Don't commit; the manager commits by path. Tab: `worker p-scan (engine) · <id>: parser scan`.
Manager: `manager engine`, terminal `t18m`. Report to t18m only; never message the proxy (t1bx).
Report: docs/m2/reports/p-scan.md, then one short `hc send` to t18m and stop.

## Why

The regex import scanners keep leaking (a comment hid an import in p-serve; p8-tidy rounds 3-4 hit line breaks and
`++`/`--` before a regex). Bun's parser removes the whole class: `new Bun.Transpiler({ loader: "js" }).scanImports(src)`
(server/static.js:95-105 already uses it; read its header note on what scanImports does not report).

## Ownership (edit only these)

test/arch-scan.js, test/auth/architecture.test.js (platform agreed; terms below), new test/arch-scan.test.js.
**Not** test/web/architecture.test.js's globals check (client's next job) and not test/web/core-runtime-globals.test.js.
test/architecture.test.js and test/web/architecture.test.js only if a call site must change (say why in the report).

## Do

1. `importsOf(file, src, root, { urls })` and `packagesOf` keep their API and output (`{spec,to,kind}` /
   `{spec,kind}`), built on the parser: `import-statement`, `export ... from`, `dynamic-import`, `require-call` are
   kind `runtime`. Two edges scanImports doesn't report must stay:
   - **JSDoc type imports** `import("…")` inside a comment are kind `type` (a JSDoc import of an adapter must still fail
     the boundary checks). Find them only inside real comments (take comment spans from a parse, e.g. compare
     `transformSync` output or a small comment walker that skips strings, templates and regex literals; justify the choice
     with tests), never in strings.
   - **`new URL("lit", import.meta.url)`** (with `urls: true`) is kind `url`, only in code, never in comments/strings.
   Delete the regex grammar and `onComment`. A file the parser rejects fails loudly (a finding naming the file), never 0 imports.
2. **test/auth/architecture.test.js** (t187's terms): delete its local `importsOf` and `onComment` (~lines 44-66), call
   arch-scan.js's `importsOf(file, src)`. Keep SCOPE, CLASSES, COMPOSITION_ROOTS, the inbound rule and the runtime vs
   type split exactly. Gate: the file is green, and each mutation applied alone fails it: (a) a server/auth adapter
   importing another adapter; (b) a JSDoc `import("…")` type of an adapter.
3. **test/arch-scan.test.js:** every known evasion is a case and caught: an import after a comment that mentions
   "import" (p-serve H1); imports after `++/\//.lastIndex;`, `x = --/\//.lastIndex;`, `i++ / 2;`, `a[i]++ / 2;`, a
   prefix `++`/`--` after a newline or `}`, `of` after a newline (the p8-tidy cases, docs/m2/reports/p8-tidyv.md); string
   and template literals containing `import "x"` add nothing; multi-line import lists; `export * from`; the JSDoc type and
   URL kinds above. HEAD's results equal the new ones on every real file under server/, web/, packages/protocol/, test/
   (print any difference and explain each one in the report).
4. Mutations (scratch copy): JSDoc type edges dropped; URL edges dropped; comment-span check removed (an import in a
   comment counts as runtime); parser error swallowed as 0 imports. Each caught.
5. Gates: `bun test` (name any failure besides test/core-source), test/architecture.test.js, test/web/architecture.test.js,
   test/auth/architecture.test.js green.

Process: never pkill/killall; never read or print `.env`; read big files in ranges (≤ 200 lines); delete scratch at the end.
