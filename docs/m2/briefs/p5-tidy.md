# Brief: p5-tidy (clean-checkout test failure; drop a temporary re-export)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-tidy.md. Never pkill/killall; port 0; kill only PIDs you recorded. Never print values from .env.

## Goal

1. **Clean-checkout failure (from engine, t18m):** in a clean `git worktree` of main (`bun install --frozen-lockfile`,
   no `.env`), `test/auth/google-live.test.js` fails 2 of 5: "an unreachable Google never prints the client id >
   refused" and "> no such host" (`expect(received).toBe`; the `safeFetch` cases). It passes in the shared tree, so it
   is probably env-dependent (`.env` present, or something else the shared tree has). CI runs a clean checkout, so CI
   would fail. Reproduce it in a scratch worktree under your scratchpad (`git worktree add <scratch>/wt main`; remove
   it with `git worktree remove` when done), find the cause, fix it so the test passes with and without `.env`, and
   keeps its teeth (the control cases must still show a raw fetch printing the sentinel).
2. **Drop the re-export:** engine committed server/registry/postgres.js with the registry-port imports (b804f3b), so
   `server/auth/registry.js` no longer needs `export { mint, RegistryError }` (lines 7-9). Remove it if nothing else
   imports those names from registry.js (grep server/, test/, web/, scripts/); otherwise list who does and stop.

## Files you own

test/auth/google-live.test.js, scripts/dev-google.js, server/auth/registry.js. Nothing else.

## Done when

The google-live test passes in a clean worktree (no .env) and in the shared tree; full `bun test` passes in both (name
failing tests if any: `bun test 2>&1 | grep -E '\(fail\)'`); test/auth/architecture.test.js passes; report with the
cause and evidence. Then stop. Do not commit.
