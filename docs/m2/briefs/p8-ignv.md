# Brief: p8-ignv (verify p8-ign: ignore files, explicit image copies, CI clone of herdr-draw)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-ignv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never push to any repo.

## Goal and done-when (docs/m2/briefs/p8-ign.md, plus two manager additions)

Keep secrets, databases and repo history out of git and out of the Docker image; fix p8-civ LOW 3/5/7.
Added mid-job: (a) deploy/Dockerfile copies only what the runtime needs instead of `COPY . .` (a security review
flagged `COPY . .` MEDIUM); (b) ci.yml clones the public github.com/ryanthedev/herdr-draw into `../herdr-draw`
at the commit in packages/core/SOURCE.json (a short sha) before `bun test`, so test/core-source.test.js's
herdr-draw comparison runs on CI. That test file must be untouched.

## The diff

`git diff -- .gitignore .github deploy` plus the new untracked `.dockerignore`. Save it to your scratchpad as a
file for the ensemble.

## Try to break it

- `git check-ignore -v` on `.env`, `.env.local`, `deploy/.env`, `.env.example` (must NOT be ignored), `x.db`,
  `x.sqlite-wal`, `x.sqlite-journal`; `git ls-files -ci --exclude-standard` must be empty.
- The Dockerfile copies: does the image get everything `server/main.js` (phase 3) will need, and nothing
  secret? What fails if a copied dir is missing?
- The CI clone step: injection via `${{ }}` in `run:`; behaviour when the commit is missing; short-sha
  resolution; that it can't push or use a token; run the step yourself in a scratch layout like the runner
  (`<scratch>/work/plenary` + `<scratch>/work/herdr-draw`) and show test/core-source.test.js's second test ran.
- YAML parses (`ruby -ryaml`); `bun test` passes; `cancel-in-progress` expression is valid.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load the `sdd:subagent-driven-development` skill first. Check `usage`, then run an ensemble review of the saved
diff with codex + agy + every other harness that passes `check_adapter`. A finding two harnesses agree on is a
HIGH candidate: confirm or refute it yourself and say which in the report. List which harnesses ran.

## The builder's not-verified list and risks (only these, not its claims)

- No Docker: no build, no `compose config`; the `.dockerignore` result is a simulation.
- Workflow never run on GitHub; writability of `../herdr-draw` on a runner and the `cancel-in-progress`
  expression unchecked; no actionlint.
- CI now depends on herdr-draw being public and the pinned commit staying in its history.
- `server/` and `web/` are untracked today; the Dockerfile's `COPY server/`/`COPY web/` fail a build from a clean
  checkout until they are committed.

Grade HIGH only if it would publish, leak a secret, ignore a tracked file, or make CI fail on GitHub.
Then stop and leave the session idle.
