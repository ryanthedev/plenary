# Brief: p5-tidyv (verify p5-tidy; quick, it blocks the proxy's push)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-tidyv.md, PASS or FAIL
with HIGH/MEDIUM/LOW. Change nothing in the tree. Never print values from .env. Kill only PIDs you recorded.

## Job under check

Goal: (1) test/auth/google-live.test.js failed 2 of 5 in a clean checkout without .env (as CI runs it); make it pass
with and without .env while keeping its teeth (a raw fetch error must still be shown to print the sentinel client
id). (2) Drop server/auth/registry.js's temporary re-export of mint/RegistryError now that engine's registry adapters
import registry-port.js. Diff: `git diff -- test/auth/google-live.test.js server/auth/registry.js`.
Builder's not-verified list and risks (not its claims): one unnamed failure in one of five clean-worktree full runs.

## Check

- In a scratch clean worktree of the current HEAD plus this diff (e.g. `git worktree add --detach <scratch>/wt`,
  apply `git diff` there, `bun install --frozen-lockfile`, no .env): google-live passes; full `bun test` at least 3
  times, naming every failing test (`bun test 2>&1 | grep -E '\(fail\)'`). Remove the worktree when done.
- Shared tree: google-live and test/auth/architecture.test.js pass.
- Teeth: mutate `leaks` to always return false in a scratch copy: which tests still catch a leak? Is that acceptable?
- Nothing imports mint/RegistryError from server/auth/registry.js (grep the whole repo incl. web/, scripts/).
- Skip the sdd ensemble (two-line diff). Then stop.
