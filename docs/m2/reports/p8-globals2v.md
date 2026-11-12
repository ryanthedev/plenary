**FAIL**: 1 HIGH (the new `typeof`/`instanceof` exemption hides real calls that 9473b86 caught), 0 MEDIUM, 1 LOW. L1 and L4 are closed. L2 and L3 are closed except after `typeof`/`instanceof` (H1). A one-line fix is tested below.

# Report: p8-globals2v (verify the p8-globals fix round)

- **Verifier:** t1kb (`plenary-p8-globalsv`).
- **Base:** main at 9fca849, plus the shared tree's uncommitted test/web/architecture.test.js, copied into a scratch
  `git worktree`. No .env anywhere, and none created.
- **What I touched:** nothing committed. I wrote only this file in the shared tree.
- **Systems design skill (CHECKER):** as before, only failure behaviour applies to a static test tool. `with` now fails
  closed. The HIGH below is a fail-open hole in the call rule.
- **Ensemble review (sdd):** codex (effort high) and grok each ran on the diff against 9473b86, each in its own
  no-.env worktree. Both were told H1 is already known. Both returned no findings, and neither edited its tree. agy
  was skipped because its quota was exhausted last round.

## HIGH

### H1. `typeof` or `instanceof` before a call of `Date` or `Function` hides the call

- **Where:** test/web/architecture.test.js:191, where `!/(^|[^\w$])(typeof|instanceof)\s+$/.test(before)` exempts any
  sentinel whose preceding token is `typeof`/`instanceof`.
- **Why it's wrong:** in `typeof Date()` the operand of `typeof` is the call `Date()`, not `Date`. The printer
  canonicalises `typeof\nDate()`, `typeof (Date)()` and `typeof /*c*/ Date()` to `typeof Date()`, so every one of them
  is exempted.

**What each version reports:**

| Source | 9473b86 | Now |
|---|---|---|
| `const t = typeof Date();` | `Date(` | `[]` |
| `const t = typeof Date?.();` | `Date(` | `[]` |
| `const t = typeof Function('return this')();` | `Function(` | `[]` |
| `x instanceof Date();` | `Date(` | `[]` |
| `x = typeof\nDate();`, `x = typeof (Date)();`, `x = typeof /*c*/ Date();` | `Date(` | `[]` |
| `typeof Date`x`;` | `[]` | `[]` (L3 not closed under `typeof`) |

**Why HIGH:**
- Both briefs rule that a real global read must never stop being caught, and 9473b86 caught these.
- `typeof Function("…any code…")()` runs arbitrary code. That is the C-14 door, and core-runtime-globals.test.js says
  itself (line 3) that `Function("return this")()` slips past the runtime check. So this static rule is the only
  guard.

**Repro:**
```js
globalsIn("web/core/x.js", "const t = typeof Function('globalThis.fetch(1)')();")  // [] (9473b86: ["Function("])
```

**H1 is the whole regression.** The 9473b86 rule counted three things: a call, an optional call, and a non-member
`new`. The new rule still counts all three, except a call or optional call preceded by `typeof` or `instanceof`.
Closing that one case restores everything 9473b86 caught.

**Fix (tested in a scratch worktree):** keep the `typeof`/`instanceof` exemption only when the sentinel isn't itself
called or tagged. Line 191 becomes:

```js
else if (!/^\s*(\?\.(?!\s*\()|\.|\[)/.test(after) && !(/(^|[^\w$])(typeof|instanceof)\s+$/.test(before) && !/^\s*(\?\.\s*)?[(`]/.test(after))) seen.add(k);
```

**Result with that line:**
- Every row in the table above gives `Date(` or `Function(`, including `` typeof Date`x` ``.
- `typeof Date; x instanceof Function; typeof Date === 'function'` still gives `[]`.
- The file's own 25 tests pass.

Pin the table's rows as tests.

## LOW

| # | Where | Finding |
|---|---|---|
| L1 | :191 | **Tightening has a cost: comparisons and reflection now count as uses of `Date`/`Function`.** Any reference that isn't a member access, `typeof` or `instanceof` now counts, including plain code that never calls them: `x.constructor === Date`, `class X extends Date {}`, `'now' in Date`, `isType(x, Date)`, `Reflect.construct(Date, [])` (that one is a real construction).<br>No web/core file is affected (0 differences, below), and the report states the alias tightening. Listed so t14k can rule on whether a comparison like `x.constructor === Date` should stay forbidden. |

## Check 1: L1 closed (a `with` statement is loud, decided by the parser)

**Caught.** Each throws, naming the file, in both checks:

| Form | Example |
|---|---|
| ASI | `x\nwith (o) {…}`, `x = a\nwith (o) y;` |
| Next-line body | `with (o)\n(y);` |
| Empty statement | `with (o) ;` |
| Nested | `with ((o)) { if (a) with (b) c; }` |
| In a function, with `'use strict'` | `function f() { 'use strict'; with (o) {} }` |
| Under a label | `label: { with (o) {} }` |
| As the body of a loop or case | `for (;;)`, `do … while`, `switch … case` |
| After an import attribute | `import a from './a.json' with {…}; with (o) {…}` |
| Beside regexes | `/x/; with (o) {} /with/.test(s)` |

- **Escaped keywords:** `with (o) {}` and `with (o) {}` are rejected by the parser. They throw loudly (the
  "parser rejects it" error), which is correct.
- **Not tripped:**
  - **Members:** `obj.with(1)`, `obj?.with?.(2)`, `obj['with'](3)`, and `a.\nwith` / `a?.\nwith(1)` across a line break.
  - **Names:** the identifier `wit`; `with` as an object key, an async, generator or computed method, or a class
    `static async *with` or `'with'()`; `export { x as with }`; `import { with as w }`.
  - **Text:** strings with escaped quotes, a regex `/[/]with (o) {}/`, a template holding `with (o) {}` after nested
    `${}`, and a `//` comment ending at U+2028.
  - **Attributes:** `export * from`/`export * as q from … with { type: 'json' }`.
- **Result:** no way found to slip one past, and no false trip.
- **The p8-globalsv repro, end to end:** I appended `export function wz(o, d) { with (o) { return import(d); } }` to
  web/ports/clock.js in a worktree. test/web now fails 1 test, with
  `web/ports/clock.js: a \`with\` statement (line 34)`. Before the fix, it failed 0.

## Check 2: L2/L3 closed, nothing loosened

- **Caught now:** `new (0, Date)()`, `(0, Date)()`, `new (0, Function)("return this")()`, `` Date`x` `` and
  `` Function`return this`() ``. The builder's new test pins them.
- **Loosened:** the `typeof`/`instanceof` forms in H1, which 9473b86 caught.
- **9473b86's own cases:** the diff against 9473b86 removes no test line. Every case keeps its expectation, and all
  25 tests pass. `typeof Date.now()` and `typeof Math.random()` are still caught, because the dotted rules don't use
  the exemption.

## Check 3: L4 closed

- **V5 is dead:** `expect(hits("Date?.();")).toEqual(["Date("])` is present. Mutant W9, V5's form on the new rule
  (`?.(` exempt as a member), is killed.

## Check 4: mutants

- **Builder's 11:** re-run in my worktree; all killed.
- **Mine:** 8 more. 5 killed, 3 survived, and all 3 survivors are equivalent.

| # | Mutant | Result |
|---|---|---|
| W1–W11 | the builder's (see p8-globals2.md) | all killed |
| X1 | refuseWith ignores the batch hit (always probes one at a time) | survived, equivalent: same answer, only slower |
| X2 | `with` line number off by one | killed |
| X3 | `v<n>` lookahead dropped (`v1` matches `v10`) | survived, equivalent: a `v10` is only printed when a real `with` statement exists, so the file throws either way; only the reported line could differ |
| X4 | `before` window back to 8 chars (`instanceof` no longer seen) | killed (2) |
| X5 | only `typeof` exempt | killed (2) |
| X6 | refuseWith skips files with a single `with` word | killed |
| X7 | refuseWith probes without `define` | killed |
| X8 | the `if` fallback probes with `while` | survived, equivalent: `while ( Expression ) Statement` has the same grammar |

No mutant targets H1, because H1 is a missing case, not a weakened check. The fix should come with tests that kill a
mutant re-adding the bare exemption.

## Comparison with 9473b86 over the real files

- **Scope:** 53 script files under web/ and packages/protocol/, run through both versions of `globalsIn` and
  `computedImports` side by side.
- **Result:** 0 differences, and no real file holds a `with` statement. This matches the builder's report.

## Gates (shared tree)

| Gate | Result |
|---|---|
| test/web/architecture.test.js alone | 25 pass, 0 fail |
| test/web | 815 pass, 0 fail |
| `bun test` | 1,478 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift); 1,634 tests, 87 files |
| Files changed by this job | Since 9473b86, only test/web/architecture.test.js. The other modified files belong to other tracks. |

## What I did NOT check

- **agy, kimi, qwen and mistral reviews:** none ran. agy's quota is exhausted, and the other three weren't tried.
- **ASI shapes for the `with` probe:** sampled, not exhaustive.
- **Other Bun versions:** none tested; the method is tied to Bun 1.4.4's printer.

# Round 2

**PASS**: H1 is closed and nothing is loosened compared with 9473b86. No HIGH, MEDIUM or LOW findings. L1 (the
tightening) was ruled on by t14k and is not re-raised.

- **What I verified:** the builder's round 2 (t1jj): the guarded line at test/web/architecture.test.js:191-193 (the call
  rule in `globalsIn`), plus the new test "p8-globals2v H1".
- **Setup:** a scratch `git worktree` at 9fca849 with the shared test file copied in. No .env anywhere. Nothing
  committed, and only this file was written in the shared tree.

## H1 closed

**My round-1 table, every row:** each one is now caught, including `` typeof Date`x` ``, which 9473b86 also missed:
- `typeof Date()`, `typeof Date?.()`
- `typeof Function('return this')()`, `typeof Function('globalThis.fetch(1)')()`
- `x instanceof Date()`
- `typeof\nDate()`, `typeof (Date)()`, `typeof /*c*/ Date()`

**The bare-name cases stay `[]`:** `typeof Date; x instanceof Function; typeof Date === 'function';`.

## New evasions tried around typeof/instanceof

Each probe was run through both the new check and 9473b86's. Nothing the new check misses was caught by 9473b86.

| Kind | Probes | New check |
|---|---|---|
| Parentheses | `typeof ((Date))()`, `typeof (0, Date)()`, `typeof (Date ?? 0)()`, `typeof (Date)`x`` | caught |
| Comments and newlines | `typeof Date /* c */ ()`, `typeof Date\n()`, `typeof Date\n`x``, `x instanceof Date\n(1)` | caught |
| Optional calls | `typeof Date ?.  ()`, `x instanceof Date?.()` | caught |
| Tagged templates | `x instanceof Function`x`` | caught (9473b86 missed it) |
| Nested and other prefixes | `typeof typeof Date()`, `typeof void Date()`, `typeof !Date()`, `typeof await Date()`, `typeof new Date`, `typeof new Function`, `typeof Date() + typeof Date` | caught |
| `typeof`/`instanceof` as property names | `{typeof: 1}.typeof\nDate()`, `a.instanceof\nDate()` | caught (no false exemption) |
| Bare name, correctly `[]` | `typeof typeof Date`, `(typeof Date)()` (calls a string, not Date), `x instanceof (Date)` | `[]` |
| Still missed, as at 9473b86 | `typeof Date.call(null)`, `typeof Date?.call?.()` | `[]` |

**Why the last row isn't a finding:** a call through a member of `Date` was never in the rule. The runtime test owns
aliases. It is not a regression.

**Why the guard is safe without its own whitespace handling:** Bun's printer canonicalises the forms the guard reads.
`typeof Date ?.  ()` prints as `typeof __S?.()`, `typeof Date\n()` as `typeof __S()`, `` typeof Date /*c*/ `x` `` as
`` typeof __S`x` ``, and `x instanceof Date  (1)` as `x instanceof __S(1)`.

## Nothing loosened

- **Comparison with 9473b86:** 0 differences across all 53 files under web/ and packages/protocol/.
- **Test file:** compared with 9473b86, the diff removes no test line.
- **Report check:** the round-2 report's claims match what I re-ran.

## Mutants

- **Round 1 (W1–W6, W8, W9, W11):** all still killed. W7 and W10 no longer apply, because their target line changed.
- **My round-1 X mutants:** X2 and X4–X7 are killed. X1, X3 and X8 survive, all equivalent, as in round 1.
- **The builder's 5 mutants of the new guard, re-made by me as R1–R5:** all killed.

| # | Mutant | Result |
|---|---|---|
| R1 | Guard dropped (round 1's line) | killed |
| R2 | Guard ignores tagged templates | killed |
| R3 | Guard ignores optional calls | killed |
| R4 | `typeof`/`instanceof` exemption dropped entirely | killed (3) |
| R5 | Only `typeof` exempt | killed (3) |

**Mine, on the new guard:**

| # | Mutant | Result |
|---|---|---|
| Y1 | Guard ignores plain calls (only `?.(` and tags) | killed |
| Y2 | Guard without whitespace tolerance (`/^(\?\.)?[(`]/`) | **survived**, equivalent: the printer emits no space before `(`, `?.(` or a backtick (shown above) |
| Y3 | Guard only for `instanceof` (`typeof` calls exempt) | killed |
| Y4 | `before` window back to 8 chars | killed (3) |

## Gates (shared tree)

| Gate | Result |
|---|---|
| test/web/architecture.test.js | 26 pass, 0 fail |
| test/web | 816 pass, 0 fail |
| `bun test` | 1,525 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift); 1,681 tests, 91 files |

**Other tracks' work in the shared tree:**
- **Files:** server/, packages/protocol/, scripts/load/ and their tests carry other tracks' uncommitted edits. Their
  test counts have grown since round 1.
- **A transient failure:** my first full run also failed about 9 server gateway tests on timeouts, while those files
  were mid-edit and the load average was about 6. The second full run, minutes later, gave only the core-source fail.
  None of them touch test/web.
- **This job's file:** only test/web/architecture.test.js changed for this job.

## What I did NOT check

- **No ensemble review this round:** it's a one-line guard, and probes and mutants cover it directly.
- **Other Bun versions:** none tested; the guard relies on Bun 1.4.4's canonical printing (mutant Y2).
