# Report: p-scan (import scanning moves onto Bun's parser)

**Status: DONE, all gates green.** test/arch-scan.js has no regex grammar, no `onComment` and no hand lexer. Bun's
parser decides every edge. test/auth/architecture.test.js now calls the shared scanner. Every mutation in the brief,
applied alone, fails a test.

- **Base:** main at 9494fd2 plus the shared tree's uncommitted work.
- **Not committed.** No secrets were read or printed.
- **Scratch NOT deleted:** the delete was refused by the permission check (twice). It lives outside the repo in this
  session's scratchpad (`/private/tmp/claude-501/-Users-r-repos-plenary/475dbefc-7fef-4b1f-9f40-bc519956fd45/scratchpad/`:
  a tree copy, HEAD's two scanners, probe and mutation scripts). Delete it by hand if wanted; nothing reads it.

## Files

| File | Change |
|---|---|
| test/arch-scan.js | The scanner core is rewritten on `Bun.Transpiler`; header "How" block. API and output shape are unchanged. `checkBoundaries` gains rule `"parse"`. |
| test/arch-scan.test.js (new) | 10 tests: every known evasion, the type and url kinds, the probe's two traps, the TS loader, and loud parse failure. |
| test/auth/architecture.test.js | Its local `importsOf` and `onComment` are deleted. `violations()` calls `importsOf(path, src)` from arch-scan.js. A parse failure is a violation. Two synthetic sources are fixed (below). |
| test/web/architecture.test.js | **One line, a call site that had to change:** line 329's synthetic source was a bare ` * @property {…import("./transport.js")…}` line. That isn't valid JS, so the parser rightly rejects it. It is now wrapped in `/** … */`, and the case still asserts `[]`. The globals check (`codeOnly`) is untouched. |

## How the scanner works

- **runtime:** `scanImports` (Bun's parser). It reports import-statement, `export … from`, `export * from`,
  dynamic-import and require-call. Any other kind it reports also counts as runtime and is never dropped.
- **type** (JSDoc `import("…")`) uses a **sentinel oracle**, not a comment walker:
  - **Candidates:** every raw-text `import("lit")` in the file.
  - **Probe:** each candidate's specifier is swapped for a unique token (`__arch_scan_N__`), and the copy is parsed
    again, once for all candidates.
  - **Token reported by `scanImports`:** the candidate was code, so it is already a runtime edge.
  - **Token printed by `transformSync`:** the candidate was in a string, template or regex literal, so no edge.
  - **Token in neither:** the parser dropped it as a comment, so it is a `type` edge.
- **url:** each raw `new URL("lit", import.meta.url)` is swapped for `import("<token>")`, using the same quote
  character. It is an edge only if `scanImports` reports the token, so only when it sits in code.
  - **Why the same quote matters:** a candidate can't sit inside a string of its own quote character, so the swap
    never moves text into or out of a string.
- **Two probe traps, closed and tested:**
  - **A file that already holds a token's text:** e.g. `"__arch_scan_0__"` in a string would read as "printed" and
    hide a comment's type edge. The token prefix is lengthened until it occurs nowhere in the file.
  - **A match that spans code, in valid JS:** e.g. `"import(" + x + ")"` matches from one string's closing quote to
    the next string's opening quote, and the swap breaks the parse. When the batch probe won't parse, candidates are
    probed one at a time. A swap inside a comment never breaks a parse, so a candidate whose own probe fails is
    neither comment nor code and gives no edge.
- **Parse failure:** `importsOf` and `packagesOf` throw `"<file>: the parser rejects it, so its imports are unknown:
  <line:col message>"`. `checkBoundaries` turns that into a `parse` finding, and auth's `violations()` turns it into a
  violation string. A rejected file never comes back as 0 imports.
- **Why not a comment walker:** a walker has to judge regex versus division, and that judgment is the leak this brief
  removes.
- **Why not compare printed output:** two probes showed the trap.
  - **Default options drop strings in dead code** (`if (false) { "…" }`), so a string there would read as a comment.
    The transpilers run with `deadCodeElimination: false`. A test pins this (`if (false) { const s = 'import("./a.js")' }`
    gives no edge).
  - **Legal comments (`/*! … */`, `//! …`) survive printing.** So an `import()` in one reads as a string and gives no
    edge. That is accepted and documented, because they aren't JSDoc and carry no types. A test pins it.
- **Loader:** `.ts`, `.mts` and `.cts` files use the `ts` loader; everything else uses `js`. A test pins it. The repo has no TS files today.

## Evasion cases (test/arch-scan.test.js), all caught

- **p-serve H1:** a real import directly after a comment that mentions "import", in several forms.
- **p8-tidyv cases, each followed by `import("./a.js")`:**
  - `++/\//.lastIndex;`
  - `x = --/\//.lastIndex;`
  - `i++ / 2;`
  - `a[i]++ / 2;`
  - prefix `++` or `--` after a newline, or after `}` (five R3-M1 forms)
  - `of` after a newline (R3-L1), and `of` as a variable (R2-L2)
  - `for await (…) /re/` (M1)
  - U+2028 inside a string (R4-L1)
- **Strings, templates and regex literals** containing `import "x"`, `require(…)`, `import("…")` or `new URL(…)` add
  nothing. Code inside a template's `${}` still counts.
- **Multi-line import lists**, including a comment and an apostrophe inside the list (an old known miss); also
  `export * from` and `export * as ns from`.
- **JSDoc types:** found in `/** */` and `//` comments. Also found after a string holding `"*/"`, and after a division.
- **URL kind:** found only in code, only with `{ urls: true }`, and never returned by `packagesOf`.
- **Parse failure:** loud from `importsOf`, from `packagesOf`, and as a `checkBoundaries` finding.

## HEAD versus new, on every real file

**A one-off scratch run, not a test in arch-scan.test.js.** Once this lands, HEAD *is* the new scanner, so a
standing test would compare it with itself. The cases it surfaced are pinned in arch-scan.test.js instead.

**What was compared:** all 201 script files under server/, web/, packages/protocol/ and test/.

- **Sides:** HEAD's `test/arch-scan.js` (taken with `git show`) against the new one.
- **Calls:** `importsOf` with `urls: true`, plus `packagesOf`, compared as sorted sets.
- **Auth too:** for server/ files, HEAD's auth-local `importsOf` against the new `importsOf`.
- **Result:** 12 differences. None hides a violation.

| File | HEAD only | New only | Why |
|---|---|---|---|
| server/bus/nats.js (also the auth comparison) | none | runtime `server/ids.js` | **HEAD missed a real import (p-serve H1 class).** The header comment line "(dynamic import), so a process …" matched `import`, and the lazy `…from` ran on to the real `import { PortError } from "../ids.js"`. The keyword sat on a comment line, so the whole match was dropped. ids.js is shared, so no rule was broken. |
| web/adapters/storage/local.js and session.js | none | runtime `web/ports/storage.js` | **Same HEAD miss:** "adapters never import each other" in the header swallowed the real port import. It's a port, so it's allowed. |
| test/web/collab/limits.test.js, test/web/ui-chrome.test.js | none | runtime `bun:test` | **Same HEAD miss:** "may not import packages/protocol" on line 1. These are test files, which are never in `files`. |
| test/arch-scan.js | runtime `<sentinel>`, `lit` | runtime `node:fs` | HEAD read the new header's examples as imports, and missed `node:fs` the same H1 way. This file is never scanned by a rule. |
| test/architecture.test.js, test/auth/architecture.test.js, test/web/architecture.test.js, test/server/static.test.js, test/arch-scan.test.js | 4 to 11 edges each | none | **HEAD false positives:** synthetic sources and expected values in string literals, such as `one("…", \`import { x } from "./b.js"\`)`. Test files are never in `files`. |

## Mutations (a scratch copy of the tree)

Each mutation was applied alone. Each run covered arch-scan.test, test/architecture, test/web/architecture and
test/auth/architecture (53 tests). With no mutation, all 53 pass.

| Mutation | Result |
|---|---|
| S1: JSDoc type edges dropped | **9 fail** (arch-scan.test, test/architecture, auth) |
| S2: URL edges dropped | **5 fail** (arch-scan.test, test/architecture planted, web ×2) |
| S3a: comment-span check removed (an import in a comment counts as runtime) | **11 fail** |
| S3b: the comment-versus-string half removed (a string reads as a type) | **2 fail** (arch-scan.test) |
| S4: parser error swallowed as 0 imports | **2 fail** (arch-scan.test "fails loudly", TS case) |
| S5: token prefix not made unique | **1 fail** (arch-scan.test "probe can't be fooled") |
| S6: no one-at-a-time fallback (a failed batch gives no edges) | **1 fail** (same test) |
| S6b: a failed batch throws instead | **1 fail** (same test) |
| Auth (a): server/auth/session.js adds `import * as dev from "./dev.js"` (adapter imports adapter) | **2 fail** (auth rule, plus repo-wide rule) |
| Auth (b): server/auth/tenancy.js (core) adds `/** @typedef {import("./registry.js").MemoryRegistry} R */` | **2 fail** (auth rule, plus repo-wide rule) |

## Gates

| Gate | Result |
|---|---|
| test/architecture.test.js | green |
| test/web/architecture.test.js | green |
| test/auth/architecture.test.js | green (11 pass) |
| test/arch-scan.test.js | green (10 pass) |
| `bun test` | 1,469 pass, 155 skip, **1 fail: test/core-source** ("packages/core is still herdr-draw's core"; the expected drift fail). Nothing else fails. |

## For t187 (platform): auth test terms

- **Kept exactly:** SCOPE, CLASSES, COMPOSITION_ROOTS, the inbound rule, and the runtime versus type split. The
  `[runtime]`/`[type]` violation strings are unchanged.
- **Synthetic sources rewritten:** two were not valid JavaScript (bare ` * …` lines), and both are now real block
  comments.
  - **"Directly below a comment line":** this source would now be a parse error. As a block comment it still asserts
    a hit, and the assertion is tightened from `toHaveLength(1)` to the exact violation string, so a parse-error
    violation can't pass it by accident.
  - **"Commented out":** the commented-out `export * from` case still asserts `[]`.
- **Rule 2 header:** it now mentions `require()` and the parse-failure violation.

## Known limits (documented in arch-scan.js)

- **Specifiers the scanner can't read:** `import.meta.resolve`, computed specifiers, and a specifier containing `$`
  or a line break. These were misses before too.
- **Legal comments:** an `import()` inside `/*! … */` or `//! …` gives no type edge.
- **Candidates are text patterns, so two forms are missed:** `new URL ("…", import.meta.url)` with a space before
  "(", and a JSDoc `@import … from` tag. HEAD missed both too, and a grep finds neither anywhere in the repo.
- **TypeScript:** in a .ts file, `scanImports` drops `import type` lines, so they give no edge. There are no TS
  files today. A test names this as a known miss.
