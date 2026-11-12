**PASS** — p8-globals verified: no HIGH, no MEDIUM, 4 LOWs. The parser-based globals and computed-import checks miss nothing that HEAD caught, in about 120 probes.

# Report: p8-globalsv (verify the client globals parser swap)

- **Verifier:** t1kb (`plenary-p8-globalsv`). Base: main at 7bf171b plus the shared tree's uncommitted
  test/web/architecture.test.js, copied into scratch `git worktree`s (no .env in any of them). Nothing committed. I wrote
  only this file in the shared tree.
- **Systems design skill (CHECKER):** loaded and applied. This is a static test tool, so the infrastructure checklist
  (load balancing, replication, caching and so on) does not apply. The one relevant item is failure behaviour, and it
  fails closed: a file the parser rejects throws with the file named (probed below). The one gap in the stated
  mitigation is L1.
- **Engram recall:** p8-globals' stored facts (define rewrites only free references, escape decoding, `with`, dotted
  defines) match what I observed. I wrote nothing new to Engram.

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW

| # | Where | Finding | Repro | Regression? |
|---|---|---|---|---|
| L1 | test/web/architecture.test.js:140-141 (the `with` limit comment), :490-493 | **The `with` mitigation does not cover web/ports.** The manager's ruling assumes core-runtime-globals.test.js catches a `with` file. That holds for web/core, and I confirmed it: `with` appended to web/core/roles.js fails it with "SyntaxError: 'with' statements are not valid in strict mode". But `computedImports` also runs on web/ports, and web/ports/clock.js and web/ports/net.js are loaded by no test at run time (type-only ports). | Append `export function wz(o, d) { with (o) { return import(d); } }` to web/ports/clock.js (or net.js): test/web gives 0 failures. HEAD's text scan would flag it. For auth.js, collab.js, storage.js and transport.js, other tests fail (5 to 18 failures). | Yes, in a narrow case. **No runtime effect:** a module containing `with` can't load in any engine, and these two ports are type-only. **Fix if wanted:** make `with` loud, e.g. throw when the printed output matches `/\bwith\s*\(/` outside strings, or as a third swap probe. |
| L2 | :153 | **Compound callees of `Date` and `Function` are missed** (found by the codex review, confirmed): `new (0, Date)()`, `new (0, Function)("return this")()`, `(0, Date)()`. Bun prints `new (0, <sentinel>)`, so the sentinel has neither `new` before it nor `(` after it. | `globalsIn("x", "new (0, Function)(\"return this\")();")` returns `[]` | No: HEAD gives `[]` for all three. The report lists `(0, Date)()` among unchanged misses. **Fix if wanted:** invert the call rule. A `Date`/`Function` sentinel counts unless it is the object of `.`, `?.` or `[`, or follows `instanceof` or `typeof`. |
| L3 | :153 | **Tagged-template calls are missed:** `` Date`x` `` (reads the wall clock) and `` Function`return this`() `` (reaches globalThis). The report's unchanged-miss list leaves them out. | `globalsIn("x", "Function`return this`();")` returns `[]` | No: HEAD misses both. **Fix:** count a backtick after the sentinel as a call. The L2 inversion covers this too. |
| L4 | :388 | **Mutant V5 survives:** optional calls `Date?.()` and `Function?.(…)` are no longer covered by a test. The code catches them (`Date?.()` alone gives `Date(`), but the only test case puts `e = Date?.()` next to `new Date(1)`, which already yields `Date(`. | Change the call regex to `/^\s*\(/`: every test still passes | Test gap only. **Fix:** add `expect(hits("Date?.();")).toEqual(["Date("])`. |

Report accuracy (not findings): the changed-expectations table leaves out two more looser computed-import forms:
`import('./a.js',)` (trailing comma) and `import(/* c */ './a.js' /* d */)`. HEAD gave 1 for each; the new check gives 0.
Both are single literals, and `importsOf` reports the edge for each (checked), so neither is a miss. The report also
calls test/server/main-cluster.test.js and roles.test.js untracked; they are tracked now (committed in 7bf171b).

## Check 1: is the method sound?

I ran each probe through both the new and HEAD's `globalsIn`/`computedImports`. HEAD's copy came from
`git show HEAD:` and was imported side by side.

**No case found where HEAD catches a real read and the new check misses it.** The only exception is L1 (a `with`
body in a port).

| Area | Probes | Result |
|---|---|---|
| Labels, `arguments` | `a: { document.title; break a; }`; `document: for(;;) break document;`; `arguments` | Real reads caught. A label named `document` isn't a read; HEAD flagged it. |
| Default parameters | `f(a = fetch)`; `g(fetch, b = fetch)`; `g(b = fetch, fetch)`; `f(a = () => fetch(u)) { var fetch }` | Free reads caught. `b = fetch, fetch` is the TDZ parameter, not the global. |
| Class fields, static blocks, getters | `x = document`, `static { setTimeout(f) }`, `[document] = 1`, getters named `location`/`self` | Caught; member names are not. |
| `export { document }`, `import { x as document }` | | The export throws loudly (not defined in a module). The import alias is a local binding. |
| Optional calls, tagged templates | `fetch?.(u)`, `Date?.()`, `Function?.(…)`, `` fetch`x` ``, `` String.raw`${document}` `` | Caught (tighter than HEAD), except `` Date`x` ``/`` Function`…` `` (L3). |
| `new.target`, async/generators, `using`, `super` | | Caught. |
| Sequence expressions | `(0, fetch)(u)`, `(1, eval)('x')`, `(y, setTimeout)` | Caught. `new (0, Date)()` is missed (L2). |
| Scope ends | named function or class expressions, a `catch` param, `for (let …)`, a block function in a function or `switch`, var hoisting | Each name outside its scope is caught. Each inside is a real local. |
| Assignment targets | `({ document } = o)`, `[fetch] = a`, `for (document of …)`, `document++`, `location +=`, `history ??=` | Caught. |
| Escaped identifiers | `document`, `\u{64}ocument`, `eval`, `Date.now()`, `new Date()` | Caught (**tighter**: HEAD missed all of them). `import(d)` and `import.meta` throw loudly. |
| Spread and dotted forms | `{...document}`, `...navigator`, `(Date).now()`, `` Date[`now`]() ``, `Math . random ()`, `Math?.['random']?.()`, `x = ({...import.meta})` | Caught (tighter than HEAD). |
| Bare `import.meta` | `const m = import.meta`, `f(import.meta)`, `import.meta[k]`, `import.meta['url']` | Caught. |
| Regex and strings near sentinels | `/__arch_g_0/`, `/[/]document/`, `'</script>'`, `/*! document */`, `//! fetch`, a hashbang | Correct. |
| Parse failures | JSX, `<!--` HTML comments, `let` as an identifier, `export { document }`, TS `satisfies` | All throw with the file named, never `[]`. |
| computedImports | `await import(d)`, in an arrow, a static block, a default param, `import(d, )`, `` String.raw`…` ``, folding attempts (`true ? 'lit' : y`, `!0 && 'lit'`, `null ?? 'lit'`, `void 0 \|\| 'lit'`, `` `${'a'}` ``, `'a' + 'b'`), 11 imports with one computed, `x?.import(d)`, `x['import'](d)`, `export { x as import }`, `import { import as y }` | Correct. The printer folds nothing, so every non-literal stays flagged. |

**ASI risk** (the builder's "did NOT check"): I probed `let x = 1\nimport(d)`, `x\nimport(d)`, `const a = b\nimport(d)`,
`let\nimport(d)` (rejected loudly in a module), `a = b\n(import)(d)` (rejected), and `async`, `await` and `yield`
before a line break, worked through by hand.

- **Result:** no form found where swapping `import` for an identifier breaks a parse that the original passes. An
  identifier is valid everywhere `import(` is.
- **Coverage:** this is sampled, not exhaustive.

## Check 2: sentinel forgery and parse failure

- **Forgery:** raw and escape-only forgery are closed in both checks. `prefixFor` checks the source and the printed
  output, and mutants M6 and M7 kill. The raw-source half alone is redundant (mutant V6 survives as equivalent):
  every raw occurrence either prints into the output or sits in a dropped comment, where it can't be read.
- **Parse failure:** loud in both checks, with the file named (V10 kills). The real-file computed-import test now
  passes `f` (line 491).

## Check 3: no weakening

- **Removed expectations:** I listed every removed line in the diff (`git diff -U0`). Only three expectations were
  removed, and they are exactly the three the report lists: `{ self: 1 }`, plus the two top-level-`return` sources,
  which are now wrapped in `function f() { … }`. Each wrapped source still tests the same regex-after-`)`/prefix-`++`
  evasion with the same result (`fetch`, 1).
- **Multi-line case arrays:** no element was removed.
- **Lists:** NAMES and DEV_MODULES are byte-identical to HEAD, and SEAM_ALLOWLIST is unchanged. CORE_GLOBALS has the
  same 34 globals with the same reported names; only the regexes became `name`/`call`.
- **Old helpers:** `codeOnly`, `regexMayStart`, `endsValue`, `inForHead`, `isLT`, `wordBefore` and
  `closesStatementHead` are gone. Nothing under web/, packages/, server/, test/ or scripts/ references `codeOnly`.

## Check 4: mutants

- **Builder's 18:** I re-ran their script in my worktree, and all 18 are killed.
- **Mine:** 13 more. 8 killed, 5 survived (4 equivalent, 1 real test gap).

| # | Mutant | Result |
|---|---|---|
| M1–M17, M2b | the builder's (see p8-globals.md) | all killed (1–7 tests each) |
| V1 | AS_MODULE without its leading line break (a trailing `//` comment eats `export {}`) | killed (3) |
| V2 | computedImports probes parsed without AS_MODULE | **survived**, equivalent: the base print is still a module, so a file that only parses as a script throws first, and the swap token can never be bound |
| V3 | the `b<n>` lookahead dropped (`b1` matches `b10`) | **survived**, equivalent: at worst a candidate is judged on a later call's text, so it can over-report but never miss (the later call is judged on its own) |
| V4 | LITERAL no longer needs the `)` after the literal | killed (2) |
| V5 | optional call `?.(` not counted as a call | **survived: a real test gap (L4)** |
| V6 | prefix checked against the printed output only | **survived**, equivalent (see Check 2) |
| V7 | candidates only where `import` is directly followed by `(` | killed (2) |
| V8 | always probe one candidate at a time | **survived**, equivalent (slower only) |
| V9 | `Date`/`Math` not defined for dotted forms | killed (1) |
| V10 | parse error rethrown without the file name | killed (1) |
| V11 | second print without define | killed (7) |
| V12 | the `new` look-behind window cut to 3 chars | killed (2) |
| V13 | early `[]` for a file with no letters outside comments | killed (1) |

## Check 5: comparison with HEAD over the real files

I reproduced the comparison over 53 files under web/ and packages/protocol/ (12 in web/core, 6 in web/ports).

- **web/core and web/ports:** 0 differences.
- **Outside the scope:** exactly the 4 HEAD false positives the report lists. I checked each against the source:

| File | HEAD only | Cause |
|---|---|---|
| web/adapters/auth/http.js | `fetch` | a destructured parameter |
| web/adapters/transport/ws.js | `WebSocket` | a destructuring key |
| web/main.js | `WebSocket`, `fetch` | object keys |
| web/dev-main.js | `fetch` | an object key |

## Check 6: gates (shared tree)

| Gate | Result |
|---|---|
| test/web | 813 pass, 0 fail (34 files) |
| `bun test` | 1,476 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift); 1,632 tests, 87 files |
| This job's files | Of the modified files, only test/web/architecture.test.js belongs to this job. The rest belong to other tracks (e.g. test/architecture.test.js: platform's p8-rig/p8-load roots). Untracked files of other tracks: deploy/cluster/RIG.md, scripts/cluster-rig.js, test/deploy/, and the docs/m2 briefs and reports. |

## Ensemble review (sdd)

Both reviewers ran in scratch worktrees with no .env. Neither one modified its tree.

| Reviewer | Status | Findings |
|---|---|---|
| codex (effort high) | done | 1 finding: `new (0, Date)()` / `new (0, Function)(…)` missed. Confirmed by probe as L2; not a regression (HEAD misses it too). |
| agy | **failed:** quota exhausted (429, resets in about 46 h). `check_adapter` confirms it. | none |
| grok (`check_adapter` ok; replaces agy) | done | No findings. Its prompt listed aliases, `(0, Date)()` and tagged templates as known limits, so it was not asked to re-find L2 or L3. |

No finding was agreed by two harnesses, so there is no HIGH candidate.

## What I did NOT check

- **Other harnesses:** kimi, qwen and mistral were not run (no `check_adapter` on them), and agy is out of quota.
- **ASI:** sampled by probes and worked through by hand, not proved exhaustively.
- **Bun versions:** the method is tied to Bun 1.4.4's `define` and printer. I tested no other Bun version.
- **TypeScript and JSX:** no TS or JSX loaders were tried; web/core has none.
- **The full `bun test` with a `with` port:** it was not re-run. I relied on test/web plus a grep showing that no
  test or module loads web/ports/clock.js or web/ports/net.js at run time.
- **Browser loading:** no Chrome run.
