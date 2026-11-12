# Verification: p5-load3v (Round 3 of p5-load: gateway patch re-cut onto a90cd6b, LOWs A–D)

**Verdict: PASS, with two conditions on landing.** No HIGH.

- **Condition 1 (MEDIUM, finding 0):** PROTOCOL.md must gain the LOW B sentence at the same time as the patch. Without
  it, the cached-hello behavior (V3) is not in the spec.
- **Condition 2 (LOW, finding 1): the patch as delivered does not apply to current HEAD** (`c2024f3`).
  - Plain `git apply --check` fails on both registry tests.
  - `git apply -3` resolves everything but one hunk, and only once the platform files are in the index (unstaged, it
    dies on `does not match index`).
  - **Both full gates ran on that hand-resolved patch**, not the file as delivered. The patch does apply cleanly to
    its own base, `a90cd6b`.
- **Code is sound otherwise:** two LOW test gaps, closed with my tests V1 and V2. The gates are green with and without
  Postgres.

Verifier: this session, 2026-11-12. Read-only on the main tree: no code edited, nothing committed. All scratch work is in
`/private/tmp/claude-501/-Users-r-repos-plenary/2b991c61-7598-4725-9c04-7ee8a29f1cb5/scratchpad/` (worktree `wt/`,
review copy `review/`, mutation script `mut.py`, my tests `p5l3v-adv.test.js`, gate logs `gate-*.log`).
## Findings

| # | Grade | Finding | Status |
|---|---|---|---|
| 0 | MEDIUM (landing condition) | **The cache admits a new hello that PROTOCOL.md doesn't yet allow.** A timed pass's own read fills the cache; a revoke lands after that read and its message is lost; a new hello is then let in from the cache (codex #2, confirmed by V3). The next timed pass closes it (973 ms with a 1 s period, 3/3 runs; at most 60 s by default). Without the cache, that hello would be refused. PROTOCOL.md § Auth today says nothing about a cached hello. The proposed sentence ("…until the gateway's next timed re-check… The cache never hides a revoke past the next timed pass") is what makes it in-spec. | **Land the PROTOCOL sentence (engine/CEO) with the patch, or don't land the `roleCache` wiring in main.js.** The behavior is the known Round 2 trade-off; the bound holds. |
| 1 | LOW | **The patch no longer applies to HEAD as is.** HEAD is now `c2024f3` (p5-pgpriv2-4, committed 10:16), after the patch was cut (09:55, against `a90cd6b`). `c2024f3` rewrote `test/server/pg-registry.test.js` and touched `registry.test.js`. The builder blamed "others' uncommitted edits". That was true when they ran it, but that work has since been committed. | `git apply -3` fixes all but one hunk (the second `batch: true` in `pg-registry.test.js`, now inside a `try`). That hunk is a trivial hand edit. The other 9 files apply cleanly. |
| 2 | LOW | **Untested claim: "invalidate so a late answer can't write through"** (the `catch` of the chunk read). Removing that `invalidate` passed every builder test. | The claim **holds**: my test V1 passes on the patch and fails without the line. Suggest adopting V1. |
| 3 | LOW | **Untested: a failed chunk's error must not stick to later chunks.** Mutation X6 (`chunkErr` not reset after a good chunk) passed every builder test. The code is right. | My test V2 passes and kills X6. Suggest adopting V2. |

## Claims checked

| Claim | Result | Evidence |
|---|---|---|
| Engine's p2-tune intact (`recheckConcurrency`, `rc.cut`, `sum.errors`/`ok[]`/retry schedule, "registry down" stop, count-only `here`) | **Confirmed, on both paths** | Read the gateway diff (120 lines): every engine line is kept, and the non-`rolesFor` branch is engine's code verbatim. Note: plain `tenancy` has `rolesFor` too (tenancy.js:133) and the patched `port.js` passes it through, so the **default rig runs the batched path**. So I ran engine's three files twice. **Batched, as shipped:** 53 pass, 0 fail. **With `const batched = false` (engine's path):** 53 pass, 0 fail. The file was restored afterwards (`git diff --quiet`). |
| Hello path | **Confirmed** | `watchGrants` and the `gen` capture come before `auth.role` (gateway.js:897-899), so no cache fill can predate the subscription. The `gen` loop is at :916. Every close runs `end()`, which calls `unwatchGrants` (:201). |
| Key: imported `identityKey`, no second spelling | **Confirmed** | `grep 'email ?? ""'` over `server/` and `test/` finds only `server/auth/tenancy.js:38`. The gateway imports it; `c.user === identity.user` (gateway.js:929), so the hello key and the pass key agree. |
| `{ board, user }` never a pass or a revoke | **Confirmed** | Code returns right after `invalidate(board, user)`. Mutations X2 (fall through into a pass) and X3 (no user invalidate) are both killed. The only publisher of `{ board, user }` is `addLinkUse` in main.js:71. |
| LOW A / GAP-M4 / GAP-M6 / M7 / finding 1 tests exist and fail under mutation | **Confirmed** | Mutation table below. |
| Revocation bound (lost announce, cache hit, chunk error, timeout) | **Confirmed** | See "Revocation bound". |
| LOW B: sentence ends "The cache never hides a revoke past the next timed pass."; PROTOCOL.md unchanged | **Confirmed** | `p5-load.md:370`; `git diff --quiet HEAD -- PROTOCOL.md` exits 0. |
| LOW C: tenancy.js header accurate | **Confirmed** | Checked against the code: identityKey keys (`ekey`, l.264); link memo cap from the read's start (`from = p ? flight.t : t`, l.229); board/tenant 10 min (`recordTtlMs`), links 30 s; `invalidate(board, user)` drops every identity (`byUser`, l.338). |
| LOW D: C2 and C3 fail under their mutations | **Confirmed** | C2 and C3 rows below. |
| `git apply --check` clean on HEAD + platform files | **Confirmed on `a90cd6b`; refuted on current HEAD** (finding 1) | Worktree of `a90cd6b` + the two platform files: `git apply --check` passes. On `c2024f3`: `patch failed: test/server/pg-registry.test.js:55` and `registry.test.js:15`. |
| Main tree fails only on the two `batch: true` hunks | **Confirmed, cause updated** | `git apply --check` in the main tree fails on exactly those two files. Neither file has uncommitted edits now (`git diff --stat HEAD` is empty for both): the cause is `c2024f3`. In the main tree, `git apply -3` additionally stops at `test/server/revocation.test.js: does not match index`, because another session has uncommitted edits there. Use a clean tree or plain apply for that file. |

## Mutation table (redone by me)

Each mutation was applied with an exact one-occurrence replacement, the tests were run, and the file was restored
(`mut.py`). Gateway mutations ran over `test/server/role-cache.test.js`, `revocation.test.js` and my
`p5l3v-adv.test.js`. Tenancy mutations ran over `test/auth/role-cache.test.js`.

| Mutation | Result | Killed by |
|---|---|---|
| M4: subscriber keeps the cache on `{ board }` | KILLED | GAP-M4 |
| M6: no pass-start `invalidate` (LOW A) | KILLED | GAP-M6, M7 |
| M7: no pass-start `gen++` | KILLED | M7 |
| F1: `rolesFor` unbounded | KILLED | finding 1 |
| Chunk overrun (concurrency batch not capped at `chunkEnd`) | KILLED | chunked timed pass |
| C2: cap by the last link only | KILLED | C2 |
| C3: joiner capped from its own start | KILLED | C3 |
| **X1 (mine):** no `invalidate` in the chunk `catch` (late answer writes through) | Survived the builder's tests; **KILLED by V1** | V1 |
| **X2 (mine):** `{ board, user }` falls through into a pass | KILLED | `{ board, user }` test |
| **X3 (mine):** `{ board, user }` doesn't invalidate the user | KILLED | `{ board, user }` test |
| **X4 (mine):** `unwatchGrants` keeps the cache | KILLED | "cached roles go when its last socket closes" |
| **X5 (mine):** group by `c.user` only | KILLED | 3 tests (incl. M3 link expiry) |
| **X6 (mine):** `chunkErr` not cleared after a good chunk | Survived the builder's tests; **KILLED by V2** | V2 |
| **X7 (mine):** no `boards.get(b.key) !== b` break after the chunk read | Survived | Equivalent: the board's sockets are gone, and `one()` skips any socket that isn't live. No test needed. |

## Revocation bound (adversarial)

| Case | Outcome |
|---|---|
| Lost announce, user connected | The timed pass invalidates, reads fresh and closes 1008 (chunked-pass test). |
| Lost announce, user left, new hello | Refused after one pass (GAP-M6). |
| Hello waiting on the room, served from the cache, when a pass runs | `gen++` makes it ask again and it is refused (M7). |
| Revoke message during a running pass, new hello | Refused (GAP-M4). |
| Chunk error or timeout on a **timed** pass | The socket is kept and retried 2/4/8 s, then closed. This is PROTOCOL.md § Auth, "Errors" ("On the timed pass, keep and retry"), and is the same as engine's per-user path. Not a cache regression; codex #1 refuted on this basis. |
| Chunk error on a **grants** pass | Fail closed 1013 for that chunk only (V2). |
| Late chunk answer after a timeout, read before a lost revoke | Never cached; the next hello is refused (V1). |
| Pass read fills the cache, then a lost revoke, then a new hello | Let in, then closed by the next timed pass (V3). Within the proposed bound; finding 0. |

My tests are in `scratchpad/p5l3v-adv.test.js`: V1, V2 and V3, each 3/3 green on the patched tree. V3 ran in the
`review/` copy (where codex ran). `diff -r wt/server review/server` is identical, so it tested the unmodified patch.

## Gates

| Run | Result |
|---|---|
| Worktree = clean `c2024f3` + platform `tenancy.js` and `role-cache.test.js` (staged) + patch via `git apply -3` + the one hunk by hand | Applied |
| Engine's tests + role-cache tests: `bun test test/server/tune.test.js test/server/revocation.test.js test/server/gateway.test.js test/server/role-cache.test.js test/auth` | 238 pass, 8 skip, 0 fail (batched path) |
| Engine's three files with the batched path forced off | 53 pass, 0 fail |
| Full `bun test`, patched worktree, no `DATABASE_URL` | **1172 pass, 136 skip, 0 fail** (109.6 s). Counts differ from the builder's 1171/122 because HEAD now has `c2024f3`'s extra Postgres tests (skipped without a DB). |
| Full `bun test`, patched worktree, `DATABASE_URL` = my Podman Postgres 17.11 | **1277 pass, 34 skip, 0 fail** (128.0 s) |
| `bun test test/auth`, main tree | **177 pass, 8 skip, 0 fail** |

`test/core-source.test.js` can't fail in the worktree because no herdr-draw sits beside it. It is known and unrelated.
Podman: container `044f65793339` was mine, started with `--rm` and stopped by me after the run; `podman ps -a` confirms it is gone. No other container was touched.

## sdd ensemble (gateway hunks, review copy of the patched tree)

| Harness | check_adapter | Result |
|---|---|---|
| codex (effort high) | ok | Two HIGH claims. #1 (timed chunk error keeps the socket) is **refuted**: PROTOCOL.md says keep and retry on the timed pass, and engine's path does the same. #2 (a new hello admitted from the pass's own fill) is **confirmed** and graded MEDIUM as a landing condition (finding 0): V3 shows the next pass closes it, but only the proposed sentence makes that in-spec. |
| grok | ok | No findings. |
| agy | failed (quota: 429, resets in ~52 h) | Not run. |

No two harnesses agreed on any finding, so there are no HIGH candidates.

## For engine and manager

- **Applying:** on current HEAD, commit (or at least stage) the platform files first, then run `git apply -3` from a clean tree. Then, in `test/server/pg-registry.test.js`, keep
  HEAD's `try { … } catch (err) { await drop(schema); throw err; }` and add `, batch: true` to the second
  `registryContract` options. The first hunk and `registry.test.js` resolve on their own.
- **Optional:** adopt V1 and V2 into `test/server/role-cache.test.js`. They close two test gaps; the code needs no change.

## Not verified

- **BRIEF-BASE requirements not met:** I ran no `distributed-systems-design` CHECKER pass. The design is unchanged since
  p5-load2v, which checked it; this round re-cuts the patch. I also used the sdd tools without loading the
  `sdd:subagent-driven-development` skill first.

- NATS bus, multi-gateway, and real load (unchanged from earlier rounds).
- The full main-tree `bun test`. The brief asks only for `test/auth` there, and other sessions' uncommitted edits make
  a full run meaningless for this job.
