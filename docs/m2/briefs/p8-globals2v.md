# Brief: p8-globals2v (verify the p8-globals fix round)

Same rules as docs/m2/briefs/p8-globalsv.md (CHECKER mode, read-only on main, mutants in a scratch `git worktree` with the
builder's uncommitted test/web/architecture.test.js copied in, no .env anywhere). Read docs/m2/briefs/p8-globals2.md and
docs/m2/reports/p8-globals2.md, then diff test/web/architecture.test.js against 9473b86.

- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter). The CEO deleted all scratch .env copies;
  don't re-create one.

## Check

1. **L1 closed:** a `with` statement in web/core and web/ports fails loudly with the file named, decided by the parser.
   Try to slip one past (nesting, labels, ASI, escapes, `with` inside function/class bodies) and to trip it falsely
   (`with` in strings, comments, regex, templates, property names, `obj.with(...)`, an identifier `wit`).
2. **L2/L3 closed and nothing loosened:** the inverted Date/Function rule catches sequence callees, `new (…)`, tagged
   templates; every case from 9473b86 keeps its expectation. Look for new false positives in plain code.
3. **L4 closed:** mutant V5 dies.
4. **Mutants:** re-run the builder's 11 and add at least 4 of your own. HEAD comparison over web/core and web/ports
   (builder says identical to 9473b86).
5. **Gates:** test/web green; `bun test` counts (known fail core-source). Only test/web/architecture.test.js changed.

Report docs/m2/reports/p8-globals2v.md: **PASS or FAIL** first line, HIGH / MEDIUM / LOW with file:line and repro.
hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
