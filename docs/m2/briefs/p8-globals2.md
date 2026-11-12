# Brief: p8-globals2 (fix round for p8-globals, committed 9473b86)

Same base, ownership and rules as docs/m2/briefs/p8-globals.md (APPLIER mode). Read docs/m2/reports/p8-globalsv.md
(the verifier's 4 LOWs). Own only test/web/architecture.test.js and docs/m2/reports/p8-globals2.md. Don't commit.

- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter).

## Fix

1. **L1:** make a `with` statement in any checked file (web/core and web/ports) a loud failure that names the file, not
   a silent skip. The parser itself must decide it is a `with` statement (not a regex over text): a `with` inside a
   string, comment, regex, template or property name must not trip it. Add tests for both.
2. **L2 + L3:** invert the `Date`/`Function` call rule: a sentinel counts unless it is the object of `.`, `?.` or `[`, or
   the operand of `typeof`/`instanceof` (pick the exact exemptions from the existing allowed cases; every current case
   keeps its expectation). Cases: `new (0, Date)()`, `(0, Date)()`, `new (0, Function)("return this")()`,
   `` Date`x` ``, `` Function`return this`() `` all caught; `Date.now`, `Date?.now`, `Date["now"]`, `x instanceof Date`,
   `typeof Date` still as today. Re-run the HEAD comparison over web/core and web/ports and list any new hit.
3. **L4:** add `expect(hits("Date?.();")).toEqual(["Date("])` (or the file's equivalent) and confirm mutant V5 now dies.

## Gates

At least 4 mutants for the new code, each killed; test/web green; `bun test` counts (known fail core-source).
Report docs/m2/reports/p8-globals2.md. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
