# Brief: p7-wire2 (fix round for p7-wirev; builder t1gq continues)

Base: docs/m2/BRIEF-BASE.md (systems design skill, APPLIER). p7-wire is committed (e4cba6c). Verifier report:
docs/m2/reports/p7-wirev.md (PASS; 2 MEDIUM, 3 LOW). You own web/**, test/web/**, and a new "## Round 2" section in
docs/m2/reports/p7-wire.md. Don't commit. Never pkill/killall; PIDs only; port 0.

## Manager decisions (t14k, 2026-11-12)

- **MEDIUM-1 (writer cap never retries): follow PROTOCOL.md § Pacing.** The spec wins over my brief's "no retry".
  A `limit` before welcome counts as a failed attempt under rule 12 and reconnects on rule 12's backoff
  (min(30 s, 0.5 s × 2^k) × [0.5, 1); no extra floor: it settles at one try per 15–30 s, which is not a loop). Use the
  Replica's existing backoff, not a new timer. The banner stays up while limited and says when the next try is; Retry
  still tries at once. Test (virtual clock): after a slot frees, a limited tab goes live within the backoff with no
  click; a tab that stays capped never tries more often than the backoff allows.
- **MEDIUM-2: add the missing tests**, one per surviving non-equivalent mutant in p7-wirev's table (at least the 12).
  The first two rows first: records ops never dropped by the presence gate; an id-less `limit` after welcome (blob) and
  a `limit` with an `id` (rule-5 records refusal) never stop the tab. Show each mutant killed in the report.
- **LOW-1:** a limited tab shows only the cap banner (no "Connecting…"), and the pill tooltip says the cap text.
- **LOW-2:** `mountCollab`'s `destroy()` calls `port.destroy()`, and a frame queued before destroy does nothing. Test it.
- **LOW-3 (emote clicks dropped at 4/s):** leave it; it is p7-collabv's known LOW.
- **Don't send `tab` in hello yet.** Engine (t18m) will ping when the per-tab id is in; that is a separate job.

## Done when

`bun test test/web` passes; full suite no new failures (core-source drift is known). Each change above has a test that
fails under its mutation. Headless Chrome on the production rig: 5 tabs as one user, close one, tab 5 goes live by
itself. Report Round 2, then tell me (t14k) with hc.

## Round 3 (manager, 2026-11-12): verifier R2-M1

Read docs/m2/reports/p7-wirev.md § Round 2, R2-M1. A capped tab whose retry is refused `auth` shows the cap banner
forever, because `refreshStatus()` (web/core/sync.js:107–108) checks `limited` before `replica.needAuth`. Fix: a refusal
wins over the cap (test `needAuth` before `limited`, or clear `limited` when `needAuth` is set; check connect() and goDown()
too). Add a test on the virtual clock: capped, then `auth` on the retry, gives `refused`, the refused banner shows, and no
more hellos go out. Show the mutation that kills it (the old order). Re-run test/web. Append "## Round 3" to
docs/m2/reports/p7-wire.md, then hc t14k. Don't commit.
