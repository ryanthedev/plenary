# Brief: p-servev2 (re-verify p-serve after round 2: the import scanner fix)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture"), CLAUDE.md,
the job's briefs docs/m2/briefs/p-serve.md and docs/m2/briefs/p-serve-r2.md, and the first verifier's report
docs/m2/reports/p-servev.md (H1, L1-L3).

- **Your tab:** `verifier p-servev2 (engine) · <your id>: static serving, round 2`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the job is uncommitted in the shared tree /Users/r/repos/plenary (main): server/static.js,
  test/server/static.test.js, server/server.js (the static route mount only). Other sessions are editing other
  files there right now: ignore them. **Change nothing in /Users/r/repos/plenary** except your report. Run attacks
  and mutations in a copy in your scratchpad (`rsync -a --exclude .git --exclude node_modules --exclude .env`;
  never copy `.env`).
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p-servev2.md: PASS or FAIL, findings HIGH/MEDIUM/LOW, each with
  a repro. Then stop, idle.
- Don't read the builder's report docs/m2/reports/p-serve.md beyond its "Not verified" / risks text; test the code.

## How to check (minimum)

1. **H1 is gone:** the comment shapes that swallowed an import (line comment, two-line comment, block comment, JSDoc,
   a string or template literal mentioning `import`) neither add nor hide an import. Then the real tree: the start-up
   allowlist must equal an independent crawl of web/main.js's graph that you build yourself (not the test's
   Bun.build crawl and not static.js's code), minus the deny list, plus index.html and style.css.
2. **New code paths:** `transformSync` + the regex for `new URL("lit", import.meta.url)` and computed `import()`:
   can a string literal, a template, or a regex literal add a file outside the mounts or past the deny list? An
   unparseable module: logged, nothing it imports served, server still starts?
3. **Round 1's guarantees still hold:** deny list (each path 404 even when imported), traversal forms, symlinks,
   headers exact, ETag/304, HEAD, /ws and /health precedence, `static: false`. Rerun the first verifier's attacks.
4. **Mutation checks:** undo the fix in the copy (restore the regex scanner) and confirm the new tests fail; say which.
5. **Manual:** `PORT=0 bun server/main.js` with dev tokens and a scratch data dir (PID recorded, killed by PID): GET /
   and every file of the page's module graph with curl, all 200; `/ports/storage.js` 200; the start-up `files:` count
   equals your crawl.
6. **Hexagonal:** static.js imports no room host, gateway or driven adapter; test/architecture.test.js green.
7. **sdd ensemble** of `git diff -- server/server.js` plus server/static.js and test/server/static.test.js (new files):
   codex + every harness that passes check_adapter; confirm or refute each two-harness finding.
8. `bun test` in the shared tree. A failure in a file this job doesn't own is noted, not counted against it, if it
   also fails with static.js's mount removed (show that in the copy).

Process: never pkill/killall; port 0; record PIDs and kill only those; delete your scratch data at the end.
