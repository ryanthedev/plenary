# Brief: p8-globalsv (verify the client globals parser swap)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, docs/m2/briefs/p8-globals.md (the builder's brief), docs/m2/reports/p8-globals.md
(its report), docs/m2/reports/p-scan.md (engine's same move for imports), then test/web/architecture.test.js.

- **Your tab:** `worker p8-globalsv (client) · <your id>: verify globals on the parser`. Name `plenary-p8-globalsv`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **Read only on main.** You write only docs/m2/reports/p8-globalsv.md. Mutants and probes go in a scratch `git worktree`
  (with the builder's uncommitted test/web/architecture.test.js copied in), never in the shared tree. Don't commit.
- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter).

## Manager rulings already made (don't re-litigate; refute only with a counterexample)

- The looser cases in the report (property keys incl. `{ self: 1 }`, shadowed/hoisted locals, destructuring keys, class
  members, shadowed `Math`, `import(("./x.js"))`, escaped literal specifiers, methods named `import`) are accepted:
  none is a real global read or computed import.
- `with` bodies are accepted as a known limit, because `with` is a SyntaxError in a module and the runtime test
  (test/web/core-runtime-globals.test.js) fails on such a file. Verify that claim yourself.

## Check

1. **The method is sound.** Bun.Transpiler `define` rewrites only free references: try to break it. Find a real read of a
   forbidden global (or a non-literal `import(`) in plain module code that the new check misses and HEAD caught, or a
   form plain code writes that the check flags wrongly. Try at least: labels, `arguments`, default parameters,
   class fields and static blocks, getters, `export { document }`, `import { x as document }`, optional calls,
   tagged templates, `new.target`, async/generator functions, sequence expressions, regex/string edge cases near the
   sentinels, and the ASI risk the builder names under "did NOT check".
2. **Sentinel forgery and parse failure** are closed as claimed (escape-only forgery, file named on a loud throw, in both
   checks).
3. **No weakening.** Every synthetic case from HEAD is still present with the same expectation, except the ones the
   report lists; the two wrapped sources still test the same evasion. NAMES, CORE_GLOBALS, allowlists, DEV_MODULES
   unchanged in meaning. codeOnly and its helpers are fully gone.
4. **Mutants.** Re-run the builder's 18 and add at least 6 of your own; list each survivor.
5. **HEAD comparison.** Reproduce "0 differences in web/core and web/ports" and the 4 out-of-scope HEAD false positives.
6. **Gates.** test/web green; `bun test` counts (known fail: test/core-source.test.js; other tracks' untracked files named
   in the report). Only test/web/architecture.test.js changed for this job.

## Report

docs/m2/reports/p8-globalsv.md: **PASS or FAIL** on the first line, then HIGH / MEDIUM / LOW with file:line and a repro,
mutant table, what you did NOT check. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
