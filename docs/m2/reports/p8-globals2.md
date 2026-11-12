# Report: p8-globals2 (fix round for p8-globals, the verifier's 4 LOWs)

**Status: DONE, all four LOWs fixed and tested.** A `with` statement in a checked file is now a loud failure, decided
by the parser. `Date`/`Function` count in any use except a member access, `typeof` or `instanceof`. `Date?.()` is
pinned. All 11 new mutants are killed.

- **Base:** main at 9473b86 plus the shared tree's uncommitted work.
- **Not committed.** Only test/web/architecture.test.js and this report changed.
- **No `.env` used:** mutants and repros ran in a `git worktree` at HEAD (no `.env`), now removed. No review tool was used.
- **Systems design skill (APPLIER):** as in p8-globals, only the failure behaviour applies to a static test tool. It
  stays fail-closed: `with` is now refused loudly instead of documented.

## Fixes

| LOW | Fix |
|---|---|
| L1: `with` in a type-only port went unseen | **New `refuseWith(file, src, base)`, called by both `globalsIn` and `computedImports`.** A `with` statement throws `"<file>: a \`with\` statement (line N): names inside it are unknown to the parser, and no ES module may hold one"`. |
| L2: `new (0, Date)()`, `(0, Date)()`, `new (0, Function)(…)()` | **Call rule inverted:** a `Date`/`Function` sentinel counts in every use, except as the object of `.`, `[` or `?.` (when `?.` is not followed by `(`), or as the operand of `typeof`/`instanceof`. |
| L3: `` Date`x` ``, `` Function`return this`() `` | Covered by the same inversion. |
| L4: `Date?.()` untested (V5 survived) | `expect(hits("Date?.();")).toEqual(["Date("])`, plus `Function?.("x")`.<br>**This test caught a real bug in my first draft of the inversion:** `?.(` began with `?.`, so the optional call was exempt. The exemption is now `?.` not followed by `(`. Mutant W9 (V5's equivalent on the new rule) is killed. |

## How `refuseWith` decides (the parser, never the text)

- **Candidates:** every raw word `with`. Each is swapped for a token `<pre>w<n>`, defined to `<pre>v<n>`.
  - **The token printed as `<pre>v<n>`:** it is a free reference. Only the `with` keyword in code can become one,
    because `with` is reserved and is never a name.
  - **In a comment, string, template text or regex, or as a property, member or method name:** `v` is never printed.
  - **A `with` statement whose body starts on the next line** (`with (o)\n{ … }`) parses as a call, so `v` is printed.
- **When the identifier swap breaks the parse:** `with (o) { … }` on one line breaks it. So does an import attribute
  (`import j from "./a.json" with { type: "json" }`). Such a candidate is probed again, swapped for `if`.
  - **A `with` statement always parses as an `if`:** `with ( Expression ) Statement` has the grammar of an `if` with
    no `else`.
  - **An import attribute never parses as an `if`.**
  - **Probed in Bun 1.4.4 before coding:** both behave as stated, including a dangling `else` and a labelled `with`.
- **Probing order:** all candidates are swapped at once first, and one at a time only if that copy doesn't parse.

## Tests added (3)

- **L2/L3/L4:**
  - **Caught:** `new (0, Date)()`, `(0, Date)()`, `new (0, Function)("return this")()`, `` Date`x` ``,
    `` Function`return this`() ``, `Date?.()` alone, and `Function?.("x")`.
  - **Aliases caught** (tightened): `const D = Date`, `f(Function)`, `[Date]`.
  - **Unchanged:** `Date.UTC`, `Date?.x`, `Date[k]`, `Date?.[k]`, `typeof Date`, `x instanceof Function` and
    `new Date.Sub()` give `[]`. `Date.now()`, `Date?.now()` and `Date["now"]()` give `Date.now`.
- **L1:** eight `with` statements, each loud in both checks with the file named:
  - same line, next-line body, single statement
  - inside `${}` in a template, inside a function
  - labelled, under `if … else`, in a class static block
  - after `with` in a comment and a string
  
  The reported line number is pinned. **Not tripped:** `with` in comments, strings, templates and a regex; as an object
  key, member, optional member, computed member, or class method, field, private name or getter; in import/export
  attributes; in `import(…, { with: … })`; and in names containing it (`withX`, `$with`, `with_`).
- **Every existing expectation is unchanged** (25 tests in the file, all pass).

## Mutants (new code; each alone, in a HEAD worktree)

| # | Mutant | Result |
|---|---|---|
| W1 | `refuseWith` not called in `globalsIn` | killed |
| W2 | `refuseWith` not called in `computedImports` | killed |
| W3 | No `if` fallback (an identifier probe that fails means "not a with") | killed |
| W4 | Any failed identifier probe counts as a with (import attributes trip) | killed |
| W5 | `free()` looks for the swapped token (`w`), not the defined one (`v`) | killed (4) |
| W6 | A failed batch probe gives no with (no one-at-a-time) | killed |
| W7 | Call rule: `typeof`/`instanceof` exemption dropped | killed (2) |
| W8 | Call rule: member-access exemption dropped | killed (2) |
| W9 | Call rule: `?.(` exempt like a member access (V5 / L4) | killed |
| W10 | Call rule reverted to 9473b86's (call or `new` only: L2/L3) | killed |
| W11 | `with` candidates only where `with` is directly followed by `(` | killed |

**Old mutants (p8-globals):**
- **Still killed:** M1–M7, M10–M12 and M14–M17.
- **No longer apply as written:** M8 and M9 targeted the old call rule, which is replaced (W7–W10 cover the new one).
- **Re-made:** M13's pattern now occurs twice, so I re-made it on `computedImports` alone. It is killed.

## Compared with HEAD

A three-way run over all 53 script files under web/ and packages/protocol/: the e4b8cea lexer, the 9473b86 parser
check, and this fix.

- **New against 9473b86: identical on every file.** No new hit in web/core or web/ports, and no real file holds a
  `with` statement (none threw).
- **Against the e4b8cea lexer:** the same 4 adapter/root false positives as p8-globals reported (object keys and an
  injected `fetch`). None is in the rule's scope.
- **The verifier's L1 repro:** I appended `export function wz(o, d) { with (o) { return import(d); } }` to
  web/ports/clock.js in a worktree. "core has no computed import()" now fails with
  `web/ports/clock.js: a \`with\` statement (line 34): …`. Before the fix, test/web gave 0 failures.

## Gates

| Gate | Result |
|---|---|
| test/web/architecture.test.js | 25 pass, 0 fail |
| test/web | 815 pass, 0 fail (34 files) |
| `bun test` | 1,478 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift). 1,634 tests, 87 files. |

## Report corrections asked for in p8-globalsv

- **Two more looser computed-import forms:** p8-globals.md's changed-expectations table also leaves out
  `import('./a.js',)` (a trailing comma) and `import(/* c */ './a.js' /* d */)`. For each, HEAD gave 1 and the new
  check gives 0. Both are single literals, and `importsOf` reports the edge (the verifier checked).
- **Tracked, not untracked:** test/server/main-cluster.test.js and roles.test.js are tracked since 7bf171b. p8-globals.md
  wrongly called them untracked.

## What I did NOT check

- **Every ASI shape for the `with` identifier probe.** The `if` fallback covers any probe that fails, so a with
  statement can't hide that way. But a `with` swap that parses as something other than a free reference would read as
  "not a with". I found no such form: `with` is reserved, so in code it is only a statement or an import attribute.
- **Tightened `Date`/`Function` aliases** (`const D = Date`, `f(Function)`) now fail the rule. No file in web/core uses
  them (the comparison shows no new hit).
- **No ensemble review:** this is a builder job.

# Round 2 (p8-globals2v FAIL: H1; L1 ruled)

**Status: H1 fixed, every row pinned, and the guard's mutant dies.** My round-1 inversion exempted any `Date`/`Function`
sentinel after `typeof`/`instanceof`. In `typeof Date()` the operand is the call, so 9473b86's catches regressed.
That was my miss: no round-1 test called the sentinel after `typeof`.

- **Fix:** the verifier's tested line, as given (test/web/architecture.test.js, the call rule in `globalsIn`).
  - **The exemption now holds only for the bare name:** it applies only when the sentinel is not itself called (`(`),
    optionally called (`?.(`) or tagged (`` ` ``).
  - **Comment:** updated to say so, citing p8-globals2v H1.
- **L1 (ruled by t14k):** the tightening stays. `x.constructor === Date`, `extends Date` and `Reflect.construct(Date)`
  remain forbidden in core.

## Tests (new: "p8-globals2v H1: typeof / instanceof exempt the bare name only, …")

- **Caught,** each on its own line:
  - `typeof Date()`, `typeof Date?.()`
  - `typeof Function('return this')()`, `typeof Function('globalThis.fetch(1)')()`
  - `x instanceof Date()`
  - `typeof\nDate()`, `typeof (Date)()`, `typeof /*c*/ Date()`
  - `` typeof Date`x` ``, `` typeof Function`return this` ``
- **Still `[]`:**
  - `typeof Date; x instanceof Function; typeof Date === 'function';` (the verifier's line)
  - `typeof Date`, `x instanceof Function` and `if (typeof Date === 'function') …`, each alone

## Mutants (each alone, in a HEAD worktree, no .env)

| # | Mutant | Result |
|---|---|---|
| X1 | **The new guard dropped** (round 1's line: exempt even when called) | killed (the H1 test) |
| X2 | The guard ignores tagged templates | killed |
| X3 | The guard ignores optional calls (`?.(`) | killed |
| X4 | The `typeof`/`instanceof` exemption dropped entirely | killed (3) |
| X5 | Only `typeof` exempt, not `instanceof` | killed (3) |

- **Round 1's W1–W6, W8, W9 and W11:** still killed.
- **W7 and W10:** their pattern is gone, because the line changed. X4 and X1 replace them.

## Compared with 9473b86

- **Identical on all 53 files** under web/ and packages/protocol/.
- **No new hit in web/core or web/ports.**
- **Against the e4b8cea lexer:** the same 4 adapter/root false positives as before.

## Gates

| Gate | Result |
|---|---|
| test/web/architecture.test.js | 26 pass, 0 fail |
| test/web | 816 pass, 0 fail |
| `bun test` | 1,494 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift). 1,650 tests, 88 files. Other tracks' test count grew since round 1. |

## Not checked

- **Other prefix operators before a call** (`void Date()`, `!Date()`, `-Date()`, `delete Date()`): they were never
  exempt, so they are caught by construction.
