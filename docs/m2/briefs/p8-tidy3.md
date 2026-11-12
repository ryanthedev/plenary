# Brief: p8-tidy round 3 (close the verifier's round-2 findings)

You are the p8-tidy builder (t1hz), same rules as docs/m2/briefs/p8-tidy.md (same files owned, don't commit, never
message the proxy t1bx). Read the "Round 2" section of docs/m2/reports/p8-tidyv.md in full first.

## Manager rulings

- **R2-M2 is a HIGH.** It is round 1's H3 mechanism on a `connecting` link instead of a `live` one, and its window
  grows under gateway admission backpressure, which is the mass return the jitter exists for. A probe must never
  replace a link whose hello is still waiting for its welcome.
- **R2-L1 is fixed in this round:** "heard" counts only messages from the room, never local actions.
- **R2-L2 (`of` as a variable name):** pre-existing, but you own the file and it hides an import; fix it if the fix is
  small and adds no new evasion. If it isn't small, say so and leave it.

## Fix

1. **R2-M2, probe vs in-flight hello:** the probe also stands down if a hello went out (any reconnect: backoff, pill,
   Retry) since it was armed. Test: the verifier's case (viewer, probe armed for 7.5 s, real drop at 2 s, backoff
   reopens at 2.5 s with every reply held): expect 1 reopen, not 2. Control: nothing sent, nothing heard, it reopens.
2. **R2-H1:** a ui-app case where a room event (`here`) on a live link, after `online`, stops the probe: 0 reopens.
   V-H3c (`heardN++` removed from the room path) must die.
3. **R2-H2:** a case for the L1 guard's 5 s fallback: click, keep the status unchanged, wait past 5 s, and the next
   click reconnects. V-L1c must die.
4. **R2-H3:** pin Retry's route through `reconnectNow()`: double-click Retry, expect 1 reopen; and hold the click's
   welcome past an armed probe's fire time, expect 1 reopen. Round 1's M1e and V-L1d must die.
5. **R2-M1, regex rule:** `++`/`--` is postfix only when what precedes it ends a value (a non-keyword word, `)` or
   `]`); otherwise a regex may start. `++/\//.lastIndex; import(d); Date.now();` and
   `x = --/\//.lastIndex; import(d); Date.now();` must be caught; round 2's `i++ / 2; import(d)` and `a[i]++ / 2`
   cases must still pass. Fix the wrong comment.
6. **R2-L1:** only messages from the room bump the heard stamp; `record()`/`recordsChanged()` and `dismissSetting`
   don't. Test: a local action inside the jitter window on a silent dead link still lets the probe reopen.

## Gates

Each fix has a test that fails before and passes after; each named mutant is killed. test/web green; `bun test`
counts stated (known fail: test/core-source.test.js; name any other track's untracked file). Append a "Round 3"
section to docs/m2/reports/p8-tidy.md. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0.
