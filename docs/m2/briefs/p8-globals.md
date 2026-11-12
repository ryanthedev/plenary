# Brief: p8-globals (client: the globals check onto Bun's parser)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, then docs/m2/reports/p-scan.md (engine's same move for imports, committed e4b8cea),
then the "Round 4" sections of docs/m2/reports/p8-tidy.md and docs/m2/reports/p8-tidyv.md, then the files you own.

- **Your tab:** `worker p8-globals (client) · <your id>: globals on the parser`. Name `plenary-p8-globals`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** test/web/architecture.test.js, test/web/core-runtime-globals.test.js (only if needed), new files under
  test/web/, docs/m2/reports/p8-globals.md. test/arch-scan.js is engine's: import from it, don't edit it. Don't touch
  web/, packages/, server/ or any other file. Don't commit. No new npm dependency without asking t14k first.
- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter).

## Why

The proxy's call: hand-written scanners keep leaking (four verifier rounds on p8-tidy found lexer evasions). The globals
check in test/web/architecture.test.js still runs on the hand-written `codeOnly` lexer (comments, strings, regex and
template literals blanked, then regexes in `CORE_GLOBALS` over the result), and `computedImports` runs a regex over the
same output. Move both onto Bun's parser, as p-scan did for imports.

## Job

1. **Decide globals with the parser.** A core file reads a forbidden global (every entry in `NAMES` and `CORE_GLOBALS`:
   the DOM and storage names, `Date(`, `Function(`, `eval`, `import.meta`) only when the parser says so. How is your
   call; verify before relying on it. Leads, unverified: Bun.Transpiler's `define` may rewrite only free (unbound)
   references, so defining each name to a sentinel and looking for the sentinel in the output may give exactly the bare
   reads; p-scan's sentinel re-parse is the other model. Prove your method on shadowed names, member access, property
   keys, strings, comments, regex and template literals.
2. **Computed imports with the parser.** `computedImports` finds every `import(` whose specifier is not a literal; move
   it off `codeOnly` too.
3. **A file the parser rejects is a loud failure**, never "no globals" (p-scan's `parse` rule).
4. **Delete `codeOnly`** and its helpers (`regexMayStart`, `endsValue`, `inForHead`, `isLT`, …) once nothing uses them.
   That closes R4-L1 (U+2028/2029 inside a string) and R4-L2 (`endsValue`'s `}` untested) by removal; add a case for
   R4-L1 that the new check gets right.

## Keep

- Every rule, name list, allowlist and DEV_MODULES entry, unchanged in meaning.
- Every synthetic case in the file, including all round 1–4 evasion cases (regex after `)`, prefix `++`/`--` after a
  line break or `}`, `of` in and out of a `for` head, CR/U+2028/U+2029 in code and `//` comments, `${}` inside
  templates). They stay as tests and must pass on the new check.
- If an expected result changes (for example the strict-on-purpose `{ self: 1 }` property key, or a shadowed local
  `const document = …`), don't flip it quietly: list each one in the report with the reason and whether it loosens the
  rule. A case that is a real global read must never stop being caught. t14k rules on each.

## Gates (the verifier will check each)

- Mutants: break the new check in at least 6 distinct ways (wrong sentinel, a name dropped, parse failure swallowed,
  computed-import check skipped, …); each must fail a test. List them.
- Compare to HEAD: run old and new checks over every real file in web/core/ and list any difference with the reason.
- test/web green; `bun test` counts stated (known fail: test/core-source.test.js; name any other track's untracked file).

Report docs/m2/reports/p8-globals.md (method, how you proved it, changed expectations, mutants, HEAD comparison, what you
did NOT check). hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
