# p5-load4v: verify Round 4 of p5-load (re-cut patch, V1/V2, PROTOCOL hunk)

**Verdict: PASS.** No HIGH or MEDIUM findings. Two LOW notes, neither blocks landing.

- **Base:** HEAD `426757daef8f03275368cd926603cf17cf041b09`, clean detached worktree in my scratchpad, main tree's
  `node_modules` symlinked in.
- **Patch under check:** `docs/m2/reports/p5-load.patch` (uncommitted), sha256
  `68f93df7625d38790b97c77a2b8d1110748772752ce7271c549544aeaa01aa25`. Compared against HEAD's committed (Round 3) copy.
- **I edited no code and committed nothing.** The only file I wrote in the main tree is this report.

## Findings

| # | Grade | Finding | Evidence |
|---|---|---|---|
| 1 | LOW | **The main tree's `git apply -3 --check` fails** on `test/server/revocation.test.js: does not match index`. Another session has uncommitted edits to that file (it shows `M` in `git status`). The plain `git apply --check` passes, so the hunk fits textually. Nobody has run the tests on that combination. This matches the builder's claim and their "Not verified" item. | rc 1 with `-3`; rc 0 without |
| 2 | LOW (informational) | **The PROTOCOL hunk adds a `**Role cache.**` label** in front of the LOW B quote. The quoted text itself is verbatim. The label follows the sub-bullet style of § Auth (`**One pass at a time per board.**`, `**Errors …**`). It is not a behaviour change. | `p5-load.md:366-370` vs the hunk |

## Checks

### Only intended changes: confirmed

The old and new patches have the same 11 files plus one new file, `PROTOCOL.md` (12 in all). I diffed only their `+`/`-` lines
(file headers excluded):

```
diff <(grep -E '^[+-]' old.patch | grep -vE '^(\+\+\+|---) ') <(… new.patch …)
0a1,4      → the PROTOCOL.md "Role cache." sub-bullet (4 lines)
285a290,326 → V1 and V2 appended to test/server/role-cache.test.js
```

Nothing else differs. Both re-cut `batch: true` hunks have identical `+`/`-` lines and changed context only:

- **`pg-registry.test.js`, two hunks:** the owner contract at line 37, and the runtime-role contract at line 65. That
  one now sits after the `try { … } catch (err) { await drop(schema); throw err; }` that c2024f3 added.
- **`registry.test.js`, one hunk:** the sqlite contract. Its trailing context is now the pragmas test with
  `busy_timeout`.

### Applies: confirmed

| Check | Result |
|---|---|
| `git apply --check`, clean HEAD worktree | rc 0, no output |
| `git apply --check`, main tree | rc 0, no output |
| `git apply -3 --check`, main tree | rc 1: `error: test/server/revocation.test.js: does not match index` (finding 1) |
| Applied in the worktree, then `git add -N` the new test file, then `git diff HEAD \| cmp - patch` | IDENTICAL |

### V1 and V2: match the verifier's tests in substance, and each fails under its mutation

- **V1:** byte-for-byte the same body as `p5-load3v.adv.test.js.txt` lines 12–32.
- **V2:** the same, except it calls the file's own `publish(r, {})` helper (`role-cache.test.js:12`). That helper
  publishes `{ board: r.ids.board }` on `subjects.grants(tenant, board)` and then flushes, which is the same call
  the original inlined.
- **The `outcome` helper:** the file already has one (`role-cache.test.js:90`), identical to the verifier's, so the
  builder dropped the duplicate.

| Mutation in `server/gateway.js` (restored after each; `cmp` clean) | `bun test test/server/role-cache.test.js` |
|---|---|
| None | 10 pass, 0 fail |
| Line 673: drop `auth.invalidate?.(b.board)` from the chunk `catch` | **(fail) V1** … 9 pass, 1 fail |
| Line 671: drop `chunkErr = null` after a good chunk | **(fail) V2** … 9 pass, 1 fail |

### PROTOCOL hunk: verbatim, well placed, accurate

- **Verbatim:** the hunk's text matches the quote at `p5-load.md:366-370` word for word. It ends "The cache never
  hides a revoke past the next timed pass." (LOW B, from p5-load2v).
- **Placement:** the hunk goes in § Auth, under "Re-checking live connections", as the last sub-bullet after
  "Errors". That is where the timed-pass timing is described, and it matches the report's "after the timed-pass
  bullet".
- **Accurate to the code:**
  - **"Reads the Registry fresh":** each pass calls `auth.invalidate?.(b.board)` at its start (`gateway.js:639`, patched),
    so a pass that stops early has still cleared the cache.
  - **"At most 30 s":** `roleCache` defaults to `ttlMs = 30_000` (`server/auth/tenancy.js:203`). The patched
    `main.js` wires `roleCache({ registry, now: Date.now })` without overriding it.
  - **A timed-out chunk's late answer cannot refill the cache:** V1 covers this, and the line-673 mutation shows the
    test has teeth.

### Gates on the patched worktree: green

| Run | Result |
|---|---|
| Full `bun test`, `DATABASE_URL` unset | **1174 pass, 136 skip, 0 fail** (1310 tests, 67 files, 112 s), rc 0 |
| Full `bun test`, `DATABASE_URL` = my Podman Postgres 17.11 | **1279 pass, 34 skip, 0 fail** (1313 tests, 131 s), rc 0 |

- **Container:** `5e85cf1659d5`, started by me with `--rm`, bound to 127.0.0.1 on a random port, with a random
  password that was never printed. I stopped it, and `podman ps -a` no longer lists it. I touched no other container.
- **`grep -E '\(fail\)'`:** empty for both runs.
- **`test/core-source.test.js`:** this known unrelated failure did not appear in either run.
- **Same as the builder:** the counts match the builder's Round 4 numbers exactly.

## Not done / not verified

- **The patch on the main tree:** I did not run tests there with other sessions' uncommitted edits, including
  `revocation.test.js`. See finding 1.
- **No sdd ensemble review:** the brief says "this round is small; keep it so". The only behavioural delta is one
  documentation sentence and two tests copied from the previous verifier, and I checked those against the source
  directly. Round 3's ensemble (p5-load3v) covered the gateway code, which is unchanged since then.
- **No NATS run and no real load.**
- **No CHECKER design pass:** this round has no new design, only a re-cut, tests and documentation.

## For t187

- **Landing:** PASS. The landing condition from p5-load3v still holds. Land the PROTOCOL hunk together with the
  `roleCache` wiring in `main.js`, or drop both.
- **Before engine applies:** re-run `git apply --check` and then the `revocation.test.js` tests on the main tree,
  because another session is still editing that file.
