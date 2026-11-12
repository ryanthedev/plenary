# Report: p8-globals (the globals check moves onto Bun's parser)

**Status: DONE, all gates green.** The core-globals check and `computedImports` in test/web/architecture.test.js are now
decided by Bun's parser. `codeOnly` and its helpers are deleted (`regexMayStart`, `inForHead`, `endsValue`,
`closesStatementHead`, `wordBefore`, `isLT`, `regex`, `template`, `REGEX_KEYWORDS`). This closes R4-L1 and R4-L2 by
removal. All 18 mutants fail a test.

- **Base:** main at e4b8cea plus the shared tree's uncommitted work.
- **Not committed.** No `.env` was read or copied. The mutant tree was a `git worktree` at HEAD, with no `.env`, and it
  is removed. No review tool was used.
- **Systems design skill (APPLIER):** applied at the scope step only. This is a static test tool: no component, port,
  scaling or failure behaviour. The one design question is how the check fails, and it fails closed: a parse failure
  throws, and an unknown construct is listed below.

## Files

| File | Change |
|---|---|
| test/web/architecture.test.js | **New `globalsIn` and `computedImports`** on Bun.Transpiler, and `codeOnly` deleted. The header (rules list) is rewritten. **Seven new tests** are added. **One expectation changed:** `{ self: 1 }` (below). **Two old synthetic sources were wrapped** in `function f() { … }` (below). The real-file computed-import test now passes the file name, so a parse failure names the file. |

No other file was touched. test/arch-scan.js is unchanged, and core-runtime-globals.test.js didn't need a change.

## Method

### Globals (`globalsIn`)

- **The parser decides.** Bun.Transpiler's `define` rewrites only **free (unbound) references**. Each forbidden name
  is defined to a unique sentinel, and the file is printed (`transformSync`). Every sentinel in the output is then a
  free reference to that global, in code.
- **What define leaves alone (probed, then pinned in tests):**
  - **Bindings:** shadowed locals (parameter, `const`/`let` in a block, a hoisted `var` or function, a `catch` param).
  - **Names that aren't references:** member names (`x.document`), property keys (`{ self: 1 }`, `{ document: d }`),
    and class members.
  - **Literals and comments:** strings, a template's text, regex literals, and comments.
- **What it rewrites:**
  - **References in odd places:** inside `${…}`, `typeof X`, `delete X.y`, assignment to X, shorthand `{ self }`,
    computed keys `{ [self]: 1 }`, and `export default document`.
  - **Dead code:** `if (false) { … }`, because `deadCodeElimination` is off.
  - **Dotted names:** `Date.now`, `Date . now`, `Math.random` and `import.meta`.
- **Only the neighbours of a sentinel are read**, in the printer's canonical output:
  - **`Date(` and `Function(`:** count when followed by `(` or `?.(` (a call), or preceded by `new ` and not followed by
    `.`, `[` or `?.` (a construction).
  - **`Date.now` and `Math.random`:** also count as the object's sentinel followed by `?.prop`, `["prop"]` or `?.["prop"]`.
    `Date` and `Math` are defined for this.
- **Sentinel forgery is closed.** The prefix is lengthened until it is absent from the source **and** from the
  source's printed form. Printing decodes escapes: `"\x5f_arch_g_0"` prints as `"__arch_g_0"`, so the raw-source check
  alone (p-scan's) would not be enough here (mutant M7).
- **Every source is parsed as an ES module.** `\nexport {};\n` is appended before parsing, because that is how the
  browser loads core.
  - **Why:** without it, Bun parses a file with no import/export sloppily. A block's `function fetch() {}` then hoists
    and binds a later `fetch(u)`, which in a real module reads the global. A probe showed it was missed (mutant M17).
  - **Why on its own line:** a trailing `//` comment can't swallow it.
- **Parse failure:** `globalsIn` throws `"<file>: the parser rejects it, so its globals and imports are unknown: <line:col msg>"`.
  It never returns `[]` for such a file.

### Computed imports (`computedImports(src, file?)`)

- **Candidates:** every raw-text word `import`. Each is swapped for a token `<pre>a<n>`, defined to `<pre>b<n>`.
- **Where a token lands after printing:**
  - **In code:** `<pre>b<n>` is printed, because the token is a free reference.
  - **In a comment:** it is gone.
  - **In a string, a template's text or a regex:** it stays `<pre>a<n>`.
  - **As a member or method name** (`x.import(…)`, `{ import(x) {} }`): it stays `<pre>a<n>`, because it isn't free.
- **A printed `<pre>b<n>(` is an import() call in code.** Its printed argument must be a single string, or a template
  with no `${}` and no backslash, followed by `)`. Otherwise the call is flagged. `<pre>b<n>` not followed by `(` is
  `import.meta`, which is not a call.
- **Static imports:** swapping the keyword in `import … from` breaks the parse. When the all-at-once probe fails, each
  candidate is probed alone, as in p-scan. A swap in a comment, a string or a call never breaks a parse, so a candidate
  whose own probe fails is a static import.
- **Parse failure** of the file itself throws, naming the file.

## How I proved it

- **Probes in Bun 1.4.4 (scratchpad, before coding):** define on bound and free references, members, keys, strings,
  comments, regex, templates, `typeof`, `delete`, assignment, hoisting, `catch`, class members, `with`, direct
  `eval`, dotted defines, `Date?.now`, `Date["now"]`, escape decoding, and `scanImports` on literal forms.
- **Every old synthetic case still passes,** including all round 1–4 evasions: regex after `)`, prefix `++`/`--` after
  a line break or `}`, `of` in and out of a for head, CR/U+2028/U+2029 in code and in `//` comments, and `${}` in
  templates. The one exception is `{ self: 1 }` (below).
- **New tests (6):**
  - **Each of the 34 globals, written out** (not derived from `NAMES`, so a dropped name fails): caught as a free
    reference and inside `${}`, and not caught as `o.<name>`, in strings, a template's text, comments or a regex, or
    when shadowed by a parameter or a block `const`.
  - **Shadowing, hoisting, keys, dead code,** and the `Date`/`Math` forms (changed and tightened expectations).
  - **R4-L1:** a raw U+2028/U+2029 inside a string ends nothing, in both checks. A `//` comment still ends at U+2028.
  - **Sentinel forgery:** raw, and escape-only.
  - **Loud parse failure** in both checks, with the file named.
  - **Module parsing:** a block's function doesn't hoist over a global.
  - **Bun's own `import.meta` properties** (`main`, `require`, `resolve`, `env`, `hot`, `dirname`, `path`) all count as `import.meta`.
  - **Computed-import forms:**
    - a comment between `import` and `(` (`import /* c */ (x)`), and a line break there
    - static imports beside a dynamic one
    - `import "./side.js"`
    - the `with` options argument
    - `import.meta`
    - `${import(x)}` inside a template, and `/*! import(x) */` in a legal comment
    - dead code
    - the three changed forms (below)

## Changed expectations (for t14k to rule on)

**Looser.** None of these is a real read of a global or a computed import:

| Case | HEAD | New | Why | A real global read? |
|---|---|---|---|---|
| `const o = { self: 1 };` (the strict-on-purpose test) | `self` | `[]` | A property key isn't a reference. The test is changed to `[]`, and a new line pins that shorthand `{ self }` is still caught. | No |
| Shadowed local: `const document = make(); document.title` | `document` | `[]` | The parser binds it to the local. | No |
| Hoisted `var location` / function name; `catch (performance)` | flagged | `[]` | The same: a local binding. | No |
| Destructuring keys, class members (`{ document: d }`, `class A { fetch() {} static self = 1 }`), object keys | flagged | `[]` | Not references. | No |
| `const Math = {…}; Math.random()` | `Math.random` | `[]` | `Math` is shadowed. | No |
| `with (o) { document.title }` | `document` | `[]` | **A real limit:** define rewrites nothing inside a `with` body. The same limit hides an `import(x)` inside a `with` body from computedImports. Mitigation: `with` is a SyntaxError in every ES module, and Bun's transpiler accepts it even in module mode. **Verified:** with `with ({}) { }` appended to web/core/roles.js (in a HEAD worktree), core-runtime-globals.test.js **fails** ("SyntaxError: 'with' statements are not valid in strict mode."). Documented in `globalsIn`'s comment. | It would be a read, but the file can't load |
| `import(("./x.js"))` | 1 | 0 | The printer drops the parens. It is one literal, and `scanImports` reports it, so arch-scan sees the edge. | No |
| `import("./x.js")` (an escape in the specifier) | 1 | 0 | Still one literal; HEAD rejected any backslash. `scanImports` reports the decoded path. | No |
| A method named import: `{ import(x) {} }`, `class C { import(z) {} }` | 2 | 0 | A method name, not an import() call. | No |

**Tighter.** Each is a real read HEAD missed:

| Case | HEAD | New |
|---|---|---|
| `new Date;` (no parens) | `[]` | `Date(` |
| `Date?.now()`, `Date["now"]`, `Date?.["now"]()`, `Math['random']()`, `Math?.random()` | `[]` | `Date.now` / `Math.random` |
| R4-L1: `const s = 'a<U+2028>'; import(d); Date.now();` | nothing | `Date.now`, 1 computed import |

**Two old synthetic sources rewritten** (the same evasion, now valid module code). A top-level `return` is a
SyntaxError in a module, and the parser now rejects it loudly:

- `const q = s.replace(/\/\//g, ''); return /a/.test(x) && fetch(u);` is now inside `function f() { … }` and still gives `fetch`.
- `return ++/\//.lastIndex; import(d);` is now inside `function f() { … }` and still gives 1.

**Unchanged misses** (HEAD missed them too; the runtime test core-runtime-globals.test.js covers aliases):
`(0, Date)()` and `const D = Date; D.now()`.

## Mutants

Each was applied alone to the new file in a HEAD worktree. The script is in the scratchpad (`mut.js`).

| # | Mutant | Result |
|---|---|---|
| M1 | Wrong sentinel: the output is scanned for a prefix that isn't the defined one | killed (6 tests) |
| M2 | A name dropped from `NAMES` (`document`) | killed (4) |
| M2b | A rarely used name dropped (`matchMedia`) | killed (1: the per-name loop) |
| M3 | A name dropped from `CORE_GLOBALS` (`eval`) | killed (2) |
| M4 | Parse failure swallowed in globalsIn (the printer returns "") | killed (1) |
| M5 | Computed-import check skipped (nothing is ever pushed) | killed (4) |
| M6 | Prefix not made unique | killed (1) |
| M7 | Prefix unique against the raw source only (escape forgery) | killed (1); it **survived** until I added the escape-only case |
| M8 | `Date(`/`Function(`: any reference counts (call check dropped) | killed (1) |
| M9 | `new X` without parens isn't a construction | killed (2) |
| M10 | Dotted forms (`?.prop`, `["prop"]`) dropped | killed (1) |
| M11 | computedImports: a failed batch gives no candidates (no one-at-a-time fallback) | killed (1) |
| M12 | computedImports: a failed solo probe counts as a computed import | killed (2) |
| M13 | computedImports: the file's parse failure is swallowed | killed (1) |
| M14 | computedImports: `import.meta` counts as a call | killed (1) |
| M15 | `deadCodeElimination` left on (Bun's default) | killed (2) |
| M16 | A template specifier with `${}` accepted as a literal | killed (1) |
| M17 | Sources parsed as scripts, not modules (`AS_MODULE` empty) | killed (1) |

## Compared with HEAD, on every real file

A one-off scratch run, not a standing test: once this lands, HEAD is the new check. HEAD's `globalsIn` and
`computedImports` (from `git show HEAD:`) were run against the new ones over all 53 script files under web/ and
packages/protocol/.

- **web/core (12 files) and web/ports, the rule's scope: 0 differences.** Both give no globals and no computed imports.
- **Outside the scope: 4 differences, all HEAD false positives** (the rule never runs on these files):

| File | HEAD only | Why |
|---|---|---|
| web/adapters/transport/ws.js | `WebSocket` | `{ url, WebSocket: WS, … }`: a destructuring key, and `WebSocket: WS` as an object key |
| web/adapters/auth/http.js | `fetch` | `fetch` is a destructured parameter (`httpAuth({ fetch, … })`), so it's local |
| web/main.js | `WebSocket`, `fetch` | Object keys `{ fetch: … }`, `{ WebSocket: globalThis.WebSocket }` (globalThis is still caught by both) |
| web/dev-main.js | `fetch` | Object key `{ fetch: … }` |

## Gates

| Gate | Result |
|---|---|
| test/web/architecture.test.js | 23 pass, 0 fail |
| test/web | 813 pass, 0 fail (34 files) |
| `bun test` | 1,476 pass, 155 skip, **1 fail: test/core-source.test.js** (the known drift). 1,632 tests, 87 files. |

**Other tracks' untracked files in the tree** (all ran green): deploy/cluster/RIG.md, scripts/cluster-rig.js,
test/deploy/, test/server/main-cluster.test.js and test/server/roles.test.js.

## What I did NOT check

- **No Chrome run, no sdd/ensemble review:** this is a builder job, and only a test file changed.
- **`with` is listed, not made loud.** A loud parser check would need a third swap probe. I relied on the runtime
  test instead, and verified that it fails on such a file.
- **TypeScript files:** the transpiler uses the `js` loader. There are no TS files in web/core.
- **ASI edge for computed imports:** a swap could break the parse only where swapping `import` for an identifier
  changes ASI (e.g. after `let` on its own line). Each such form I could think of is already a SyntaxError in a
  module, but none is tested. A candidate whose solo probe fails is judged a static import, so it would be a miss.
- **Bun version coupling:** the method relies on Bun 1.4.4's define semantics (free references only) and its printer's
  canonical forms (`new X` without parens, string quoting). The per-name loop and the synthetic cases would fail if
  either changes, but a Bun upgrade should re-run these tests first.
- **Scratch kept:** the scratchpad (`/private/tmp/claude-501/-Users-r-repos-plenary/aa5ea495-0474-4f28-8068-b13eaeab0531/scratchpad/`)
  holds the probes, HEAD's extracted check, the comparison and the mutant scripts. The worktree is removed.
