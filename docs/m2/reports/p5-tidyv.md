# Report: p5-tidyv (verify p5-tidy)

**PASS.** No HIGH, no MEDIUM, three LOW. Nothing in the tree changed except this report.

## Checks

| Check | Result |
|---|---|
| Clean detached worktree of e6d33ad + the diff, `bun install --frozen-lockfile`, no `.env` | built; `git status` showed only the 2 diffed files |
| google-live there, **before** the fix (diff stashed) | 3 pass, 2 fail: both "safeFetch rethrows ... with no URL" (reproduces the bug) |
| google-live there, after the fix | 5 pass, 8 skip, 0 fail |
| Full `bun test` there, 5 runs, grepping `(fail)` | 510 pass, 78 skip, 0 fail on all 5; no `(fail)` lines |
| Shared tree: google-live + test/auth/architecture.test.js | 16 pass, 8 skip, 0 fail |
| Importers of server/auth/registry.js (whole repo incl. web/, scripts/, test/) | 10 files, all `import { memoryRegistry }` only; no `mint`/`RegistryError` from it |
| Other `mint`/`RegistryError` hits | only string fixtures in architecture.test.js (lines 153-159) and a JSDoc `mint(...)` in test/web/contracts/auth-contract.js:42; neither imports registry.js |
| Worktree removed | yes (`git worktree remove`); the two other worktrees listed belong to other sessions and were left alone |

## Teeth (scratch copy in the worktree, then restored)

- **M1, `leaks = s => false`:** google-live still 5 pass, 0 fail. Expected: with no `.env`, `leaks` has nothing to look
  for, and the live tests that use it are skipped.
- **M2, M1 plus safeFetch's error carrying the URL:** google-live, dev-google, outbound: 28 pass, **2 fail** (both
  "safeFetch rethrows ... with no URL"). So a URL leak is still caught by the SENTINEL and host assertions, which do
  not depend on `leaks`. The two "raw fetch does print it" controls still pass, so the check has teeth.
- **Acceptable:** yes. `leaks` only guards the real id/secret, which exist only where `.env` exists.

## Findings

- **LOW 1: `leaks` is a no-op in CI.** With no `.env` it is always false, so in CI the non-live tests rely only on
  the SENTINEL/host checks (M2 shows they suffice). The live tests' cookie/response/log leak checks rely only on
  `leaks`; a regression there is caught only when someone runs `PLENARY_LIVE_GOOGLE=1` with `.env`. By design; no
  change asked.
- **LOW 2: the builder's unnamed flake did not reproduce.** 0 failures in 5 clean full runs here (builder: 1 in 5).
  Still unnamed; watch CI.
- **LOW 3 (process, mine):** a stray `cp` wrote a copy of google-live.test.js (no secrets) to `/tmp/x`; I deleted it
  in the same session.

## Not verified

- Live Google cases (`PLENARY_LIVE_GOOGLE=1`): not run, untouched by the diff.
- sdd ensemble skipped per brief (two-line diff). distributed-systems-design not applied: no design-bearing change.
