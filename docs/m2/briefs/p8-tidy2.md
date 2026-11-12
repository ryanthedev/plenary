# Brief: p8-tidy round 2 (fix the verifier's HIGHs)

You are the p8-tidy builder (t1hz), same rules as docs/m2/briefs/p8-tidy.md (same files owned, don't commit, never
message the proxy t1bx). Read docs/m2/reports/p8-tidyv.md in full first.

## Manager rulings

- **H3 is a HIGH.** "Link" means the tab's one link (sync.js `openLink`), so a probe that replaces a link the backoff
  already restored is two hellos on one live link, and it doubles a correlated return wave.
- L2 (sign-in user vs first welcome) and L5 (pill while catching-up): no action.
- The verifier's design items 2 (server retry-after on admission) and 3 (window scaled by audience) are not this job;
  the manager takes them to engine (t18m) and M4.

## Fix

1. **H3, resume probe:** at fire time, skip the probe when the link has been heard (welcome or any room event, the
   `heard` stamp) since the probe was armed. Test: arm a probe, deliver a welcome before it fires, expect 0 reopens;
   and the control (nothing heard, it reopens). Reproduce the verifier's Chrome case (viewer, random 0.99, `online`
   then `dropConnection()`): one hello for one return.
2. **H1, pill gate:** a ui-app case that clicks the pill while refused, while limited (capped) and mid-gesture, each
   expecting 0 reopens, plus one where it does reopen. Mutant V-1g must die.
3. **H2, regex heads:** add `while (go) /\//.test(s); import(spec)`, `for (;;) /\//.test(c); import(d)` (both must be
   caught) and `x.if(a) / 2; // import(y)` (must stay 0). Replace or fix the vacuous `while` case at :392. V-4c/d/e
   must die.
4. **M1, `for await`:** when the word before `(` is `await`, accept a preceding `for`. Test the report's line.
5. **L1:** a double-click on the pill while a reconnect is in flight opens one socket. Test it.
6. **L3 and L4:** one sync test pinning "a bind whose stream is absent from a snapshot is not reloaded" (V-L5b dies),
   and one app test for saving before the first welcome (V-2g dies), if it can be made to fail; say if it can't.
7. **L6 (pre-existing, you own the file):** `i++ / 2; import(d)` must be caught (postfix `++`/`--` ends an
   expression). Test it.

## Gates

Each fix has a test that fails before and passes after; each named mutant is killed. test/web green; `bun test`
counts stated (known fails: test/core-source.test.js, and any other track's untracked file: name it). Append a
"Round 2" section to docs/m2/reports/p8-tidy.md. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0.
