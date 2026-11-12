# Report: p5-tidy

Both goals done. Not committed (manager commits).

## 1. Clean-checkout failure in test/auth/google-live.test.js

**Cause:** the `leaks` helper was `s => (ID && s.includes(ID)) || (SECRET && s.includes(SECRET))`. With no `.env`,
`ID` and `SECRET` are `undefined`, so the expression returns `undefined`, not `false`, and
`expect(leaks(r.out)).toBe(false)` fails (`Expected: false, Received: undefined`, line 157). In the shared tree Bun
auto-loads `.env`, `ID` is a string, and the helper returns a real boolean, so it passed there. Not a safeFetch bug:
the earlier assertions in those tests (exit code, "google unreachable: ", no SENTINEL, no host) all passed.

**Fix:** wrap the helper in `Boolean(...)` (one line plus a comment). The check keeps its teeth: the SENTINEL and host
assertions are unchanged, and both control cases ("a raw fetch does print it") still pass, i.e. a raw fetch's error
still prints the sentinel.

**Evidence:**
- Reproduced in a clean detached worktree of main at bbdae0e (`git worktree add --detach`, because `main` is checked
  out in the shared tree), `bun install --frozen-lockfile`, no `.env`: 3 pass, 8 skip, 2 fail, both at line 157 with
  `Received: undefined`.
- After the fix, same worktree: 5 pass, 8 skip, 0 fail.
- Shared tree (`.env` present): 5 pass, 8 skip, 0 fail.

## 2. Re-export dropped from server/auth/registry.js

Removed `export { mint, RegistryError }` and its comment. The `import { mint, RegistryError }` stays: the adapter uses
both. Grep of server/, test/, web/, scripts/: no file imports `mint` or `RegistryError` from registry.js; every
importer takes only `memoryRegistry`; server/registry/sqlite.js and postgres.js import `mint` from registry-port.js.

## Test runs

| Where | google-live | architecture | full `bun test` |
|---|---|---|---|
| clean worktree, no .env | 5 pass, 0 fail | (in full run) | 510 pass, 78 skip, 0 fail on 4 of 5 runs |
| shared tree, .env | 5 pass, 0 fail | 11 pass, 0 fail | 573 pass, 78 skip, 0 fail |

The shared tree runs more tests because it has other sessions' untracked test files.

## Not verified / risks

- **One unnamed flake:** the first full run in the clean worktree had 1 failure. I only captured the totals, not
  which test, and 4 more full runs (one grepping for `(fail)`) were all green. So a test in main may be flaky; I
  could not name it. Worth watching in CI.
- The live Google cases (`PLENARY_LIVE_GOOGLE=1`) were not run; they are untouched.
- scripts/dev-google.js needed no change.
- No design-bearing change, so the distributed-systems-design skill was not applied.
