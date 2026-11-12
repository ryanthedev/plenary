# Brief: p8-tidy round 4 (close the verifier's round-3 findings)

You are the p8-tidy builder (t1hz), same rules as docs/m2/briefs/p8-tidy.md (same files owned, don't commit, never
message the proxy t1bx). Read the "Round 3" section of docs/m2/reports/p8-tidyv.md in full first.

## Manager rulings

- **R3-H1 is downgraded to MEDIUM** (timing only: no extra hello, no lost op), but it is fixed this round because the
  fix is one test.
- **R3-M1 (MEDIUM) and R3-L1 (LOW) are fixed this round** with one rule: a line break between an operand and `++`/`--`
  (or `of`) means what follows starts a new expression.

## Fix

1. **R3-H1, onHeard order:** a ui-app case: send a resync so the client goes down (backoff armed), deliver a room
   message on the old socket while down, and expect an armed probe to still reopen. Mutant V-R3a (`onHeard()` moved
   above `if (closed || down) return;` in web/core/sync.js) must die.
2. **R3-M1, prefix `++`/`--`:** in test/web/architecture.test.js, `++`/`--` is postfix only when the value it follows
   ends on the same line; a line break before it means prefix, so a regex may start. `}` never ends a value for this
   rule. All five of the verifier's lines must be caught (0 imports / no globals is a fail):
   `x\n++/\//.lastIndex; import(d); Date.now();`, `if (x) { x = 2 } ++/\//.lastIndex; …`,
   `const a = [1]\n--/\//.lastIndex; …`, `x = { a: 1 }\n++/\//.lastIndex; …`, `const f = () => {}\n++/\//.lastIndex; …`.
   Round 2's and 3's postfix cases (`i++ / 2; import(d)`, `a[i]++ / 2`) still pass. V-ev2 must die.
3. **R3-L1, `of` after a line break:** `const z = y\nof / 2; import(d); …; const w = 1 / 3;` must be caught; the `for…of`
   cases from round 3 (`for (const x of /\//…)` and the rest) must still not be misread.

## Gates

Each fix has a test that fails before and passes after; each named mutant is killed; try one new evasion of your own
rule and say what happened. test/web green; `bun test` counts stated (known fail: test/core-source.test.js; name any
other track's untracked file). Append a "Round 4" section to docs/m2/reports/p8-tidy.md. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.
