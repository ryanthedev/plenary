**PASS.** Verifier report: p8-ignv (verify p8-ign: ignore files, explicit image copies, CI clone of herdr-draw).

No HIGH findings. Nothing in the diff publishes, leaks a secret, ignores a tracked file, or (as far as a local
run can show) fails CI on GitHub. One MEDIUM and seven LOW findings below.

**The ensemble rule could not be met as written.** Only one harness (codex) passed `check_adapter`, so the
"two harnesses agree = HIGH candidate" rule never had a chance to fire. See "sdd ensemble review".

The verifier wrote only this file and its session scratchpad. Nothing committed or pushed. Engram (cross-session
memory) was unreachable, so no recall was done. `test/core-source.test.js` is untouched (`git status` clean
for it).

## What I checked, and how

| Check | Result | How |
|---|---|---|
| Git ignores secrets and databases | Ignored: `.env`, `.env.local`, `deploy/.env`, `x.db`, `x.sqlite-wal`, `x.sqlite-journal`, `server/store/a.sqlite3-shm`, `data/x`, `client_secret_1.json` | `git check-ignore -v --no-index` |
| `.env.example` stays trackable | Not ignored, at the root and in `deploy/`. `-v` prints the negated pattern `!.env.example` and exits 0, so I also ran `git check-ignore -q .env.example`: exit 1 (not ignored) | same |
| No tracked file is ignored | empty | `git ls-files -ci --exclude-standard` |
| No untracked source file is hidden | empty (outside `node_modules`), including `server/`, `web/`, `test/` | `git ls-files -oi --exclude-standard` |
| Source dirs named `data` survive | `server/data/x.js` not ignored (the data rules are anchored with `/`) | `git check-ignore` |
| YAML parses | ci.yml steps: checkout, setup-bun, install, herdr-draw clone, Test. compose keys `name, services, volumes`; `name` = `plenary` | `ruby -ryaml` |
| `${{ }}` in `run:` blocks | none in any of the three `run:` steps; expressions appear only under `concurrency:` | parsed the YAML, searched each `run` |
| Token / push | top-level `permissions: contents: read`; checkout has `persist-credentials: false`; the clone is plain HTTPS with no token; no `git push`, no `secrets.*` anywhere in the file | read |
| `cancel-in-progress` expression | Valid per GitHub's docs: `cancel-in-progress` may be "an expression with any of the allowed expression contexts"; at workflow level those are `github`, `inputs`, `vars`, and this one uses only `github`. The docs' own workflow-level example is `cancel-in-progress: ${{ !contains(github.ref, 'release/')}}`. No `event_name` example exists there, and this has not run on GitHub | docs ("Control workflow concurrency" and workflow-syntax pages) read through a fetch agent |
| Default shell | A `run:` step with no `shell:` uses `bash -e {0}` on Linux (same docs page). The step sets `set -euo pipefail` itself, so it does not depend on that | docs + read |
| Clone step in a runner-shaped layout | `<scratch>/work/plenary` with no sibling. Output: `herdr-draw at 5dfe352686b3333516ed151eee97e4826cb26ea8 (SOURCE.json commit: 5dfe352)`, exit 0 | extracted the step's `run:` text from the YAML, ran it with `bash --noprofile --norc -eo pipefail` |
| Clone is anonymous | Same run had `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, no `GH_TOKEN`/`GITHUB_TOKEN`: no credential helper could have been used | env on the run |
| Short SHA resolves | `5dfe352` is unique in the clone (72 commits) and is on `origin/main`, so `--no-tags` does not hide it | `git rev-parse --disambiguate`, `git branch -r --contains` |
| The second core-source test really ran | Before the clone: 2 pass, 18 `expect()` calls. After: 2 pass, 36. Then I appended one line to the clone's `core/doc.js`: the second test **failed** (1 pass, 1 fail). Restored; passes again | `bun test test/core-source.test.js` in the scratch layout |
| `bun test` | 106 pass, 0 fail, 852 `expect()` calls, both in the repo and in the scratch layout with the clone. (The builder reported 80; other sessions have added tests since) | `bun test` |
| Step failure paths | Second run with `../herdr-draw` present: exit 1, "refusing to reuse it". `{"commit":"$(touch pwned);x"}`, `--upload-pack=x`, `5DFE352`, `5dfe35`: all exit 1 with "commit is missing or is not a hex SHA"; no `pwned` file, no clone made. Unknown SHA `deadbee`: exit 1, **no message** (LOW 4) | edited the scratch copy's SOURCE.json only |
| Volume name claim | `compose.yml` has `name: plenary` and a volume key `plenary-data` with no `name:` of its own, so Compose's default naming gives `plenary_plenary-data`, as the README says. Not run (no Docker) | read the whole file |
| Diff unchanged during the job | The diff at the end is byte-identical to the one saved at the start, so the line numbers below are current | `cmp` against the saved `p8-ign.diff` |
| Image gets what the server needs | No side-effect imports (`import "./x.js"`) exist. All 92 relative imports in `server/`, `web/`, `packages/` (including `server/main.js`, which another session added during this job) resolve to existing files inside those three directories. Bare imports are only `bun:sqlite`, `node:fs`, `node:fs/promises`, `node:path`. No runtime read of `test/`, `docs/`, `deploy/` or `PROTOCOL.md`. `web/dev.html` loads only `./dev.js` | resolved each import with a script; grep |
| Nothing secret in the copied dirs | Non-JS files: `package.json`, `web/dev.html`, `packages/core/SOURCE.json`. No key or secret values (the one `client_secret` hit is a variable name in `server/auth/oidc.js:185`) | `find`, grep |
| CI never builds the image | no `docker` in ci.yml, so a failing `COPY` cannot fail CI | grep |
| Docker claims in the diff | Confirmed against docs.docker.com/build/concepts/context: `**` "matches any number of directories (including zero)", so `**/.env` also matches at the root; `.dockerignore` is read from the context root; an excluded Dockerfile is "still sent to the builder". Confirmed against the Compose docs: `.env` is read from the directory of the first `-f` file, here `deploy/` | docs read through a fetch agent |

## Findings

### HIGH

None.

### MEDIUM

1. **Private keys and other credential files are not covered** (`.gitignore:4-9`, `.dockerignore:25-28`).
   The rules catch `.env*` and `client_secret*.json` only. A `*.pem`, `*.key`, `id_rsa`, or a Google
   service-account JSON dropped in `server/` would be trackable by git and copied into the image by
   `COPY server/`. Raised by codex (high effort); **confirmed by me** by reading the patterns. Not HIGH: no
   such file exists today (repo-wide `find` for `*.pem`, `*.key`, `id_*`, `.envrc`, `.env*`, `*.db`,
   `*.sqlite*`, `client_secret*`, `*credentials*` outside `.git` and `node_modules`: no hits), nothing pushes an image, and a secret only
   leaks if someone adds one. `.envrc` (direnv's file, which often holds exports) is also not ignored:
   `git check-ignore .envrc` finds no match. Suggested: add `*.pem`, `*.key`, `.envrc` to both files.

### LOW

2. **Stale comment** (`.dockerignore:1`): it still says "deploy/Dockerfile does `COPY . .`". The Dockerfile
   now copies four named paths. Raised by codex; confirmed.
3. **"Every push to main keeps its own result" overstates it** (`ci.yml:14`). With `cancel-in-progress` false,
   GitHub keeps one running and one *pending* run per group and cancels the older pending one. Three quick
   pushes to `main` can still drop the middle run, so **p8-civ LOW 3 is only partly fixed**. Raised by codex
   (medium effort); **confirmed from GitHub's docs** ("any existing `pending` job or workflow in the same
   concurrency group will be canceled"), not reproduced on GitHub. The docs offer `queue: max` (up to 100
   pending runs), but say `queue: max` with `cancel-in-progress: true` is a validation error; whether that
   check accepts an expression that is true only on PRs is not stated. Safe fix: soften the comment. Full
   fix: a manager call (for example put the commit SHA in the group name for pushes to `main`).
4. **An unknown SHA fails with no message** (`ci.yml:56`). `git rev-parse --verify --quiet` prints nothing,
   so the step exits 1 with an empty log after the clone. It does fail, which is what matters. Drop
   `--quiet` or add an `|| { echo ...; exit 1; }`.
5. **`.env.example.local` is ignored** (matches `.env.*`). Harmless; noted so nobody is surprised.
6. **`web/dev.html` ships in the image.** It is a dev page. The builder flagged `COPY web/` as a guess until
   phase 3 decides how the client is served. A manager call, not a defect.
7. **Docker claims still partly unverified.** The docs confirm that an excluded *Dockerfile* is still sent
   to the builder; they do not state the case used here, an excluded *parent directory* (`deploy`). I
   believe it works the same way, unverified. Also not found in the docs I could read: what `COPY` does when
   its source is missing or fully excluded (expected: the build fails). No Docker on this machine.
8. **A 7-character SHA can become ambiguous as herdr-draw grows.** The step then fails loudly (rev-parse
   refuses an ambiguous prefix), so the cost is a red CI run, not a wrong result. Storing the full 40
   characters in SOURCE.json would remove it; that file belongs to the herdr-draw copy step, not this job.

## sdd ensemble review

- **Quota:** `usage` showed codex at 5% of its 5-hour window and 1% of its weekly window.
- **`check_adapter` results:** codex **ok**. agy **failed** (quota exhausted, resets in about 70 hours).
  grok, kimi, mistral **failed** (not signed in / no API key). qwen is not installed.
- **What ran:** codex twice on the saved diff, in a scratch copy of the tree so it could not edit the repo:
  once at high effort, once at medium. These are two passes of the **same harness**, so I did not count them
  as agreement. They raised different findings anyway; no finding was raised twice.
- **Codex's findings and my ruling:** MEDIUM 1 (confirmed), LOW 2 (confirmed), LOW 3 (plausible, not
  reproduced). Codex found nothing on injection, tokens, tracked-file ignores, or runner failure.
- **Codex did not edit its copy:** the only differences from the repo are files other sessions added to the
  repo after I made the copy.

## p8-civ follow-ups (the brief's "fix LOW 3/5/7")

| p8-civ finding | Status |
|---|---|
| LOW 3: `cancel-in-progress: true` also cancels runs on `main` | **Partly fixed.** A running `main` run is no longer cancelled; a pending one still can be (LOW 3 above) |
| LOW 5: say where `.env` goes | **Fixed.** README and the compose header both say `deploy/.env`; Compose's docs confirm it reads `.env` from the first `-f` file's directory |
| LOW 7: no top-level `name:` in compose | **Fixed.** `name: plenary` |
| MEDIUM 1: `COPY . .` with no `.dockerignore` | **Fixed** by named copies plus the root `.dockerignore`, within the limits in MEDIUM 1 and LOW 7 above |
| MEDIUM 2: CI skipped the herdr-draw comparison | **Fixed**, shown by the tamper test above |

## The builder's not-verified list

| Item | Status now |
|---|---|
| No Docker build, no `compose config` | **Still not run.** Three claims are now backed by Docker's docs (table above); LOW 7 lists what remains |
| Workflow never run on GitHub; `../herdr-draw` writable on a runner | **Still not run on GitHub.** `../herdr-draw` resolves to `/home/runner/work/<repo>/herdr-draw`, inside the runner user's own work directory; I expect it to be writable, unverified |
| `cancel-in-progress` expression | Valid per GitHub's docs; behaviour not observed |
| No actionlint | Still none (not installed here) |
| CI depends on herdr-draw staying public with that commit | True, accepted risk. The commit is on `origin/main` today |
| `server/` and `web/` untracked, so `COPY` fails from a clean checkout | True today; both are still untracked. CI does not build the image, so it cannot fail CI |

## Notes for the manager

- **Other sessions wrote to the repo during this job:** `docs/m2/proposals/` and `server/main.js`,
  `server/server.js`, `server/gateway.js`, `server/room-host.js` appeared. None is mine.
- **Scratch files** (the saved diff `p8-ign.diff`, the extracted step, the runner-shaped copy and clones) are
  in the session scratchpad and can be deleted.

**Question for the manager:** only codex was usable (agy out of quota for about 70 hours; grok, kimi and
mistral not signed in). Is a single-harness review acceptable for this job, or should the ensemble be rerun
once a second harness is available?

## Re-check (2026-11-11, fix round for MEDIUM 1 and LOW 2-4)

**PASS.** All four fixes hold. No new finding above LOW. Checked only what the manager listed; no new
ensemble (as told). Wrote only this section and the scratchpad; nothing committed.

| Check | Result | How |
|---|---|---|
| MEDIUM 1: key and credential files ignored by git | Ignored: `a.pem`, `server/tls/b.key`, `.envrc`, `deploy/.envrc`, `id_rsa`, `id_rsa.pub`, `id_ed25519`, `credentials.json`, `server/google-credentials.json`. Still ignored: `.env`, `deploy/.env` | `git check-ignore -v --no-index` |
| `.env.example` still trackable | Not ignored at the root or in `deploy/` (`git check-ignore -q` exits 1) | same |
| Source files not caught by the new patterns | Not ignored: `server/auth/credentials.js`, `server/ids.js`, `web/keys.js`, `packages/core/SOURCE.json`, `package.json`, `test/auth/fake-idp.js` | same |
| No tracked file ignored | empty | `git ls-files -ci --exclude-standard` |
| No untracked source file newly hidden | empty outside `node_modules`; no file in the tree matches the new patterns at all | `git ls-files -oi --exclude-standard`, `find` |
| `.dockerignore` has the same six patterns | Present with `**/` (any depth, including the root per Docker's docs). Read only; no Docker here | read |
| LOW 2: stale comment | `.dockerignore:1-2` now describes the four named copies | read |
| LOW 3: `main` comment | `ci.yml:14-15` now says a pending run on `main` can still be dropped. Behaviour unchanged, so p8-civ LOW 3 stays partly fixed (the builder says so too) | read |
| LOW 4: unknown SHA prints a message | `deadbee` in a scratch copy's SOURCE.json: prints "herdr-draw has no single commit matching 'deadbee' (from packages/core/SOURCE.json): unknown or ambiguous.", exit 1 | step text extracted from the YAML, run with `bash -e` (the runner's default) and git credentials disabled |
| The step still works | Real commit: `herdr-draw at 5dfe352686b3333516ed151eee97e4826cb26ea8`, exit 0; `bun test test/core-source.test.js` there: 2 pass, 36 `expect()` calls (both tests ran) | fresh scratch runner layout |
| YAML parses | ci.yml: same five steps, no `${{ }}` in any `run:`; compose keys `name, services, volumes` | `ruby -ryaml` |
| `bun test` | 125 pass, 0 fail, 1102 `expect()` calls | in the repo |
| `test/core-source.test.js` | untouched | `git status` |

### LOW (new, no action needed for PASS)

9. **A Google service-account key with its default file name is still not ignored.** Google names the
   download `<project>-<hex>.json`; neither that nor `service-account.json` matches `*credentials*.json`
   (`git check-ignore service-account.json`: no match). No name pattern can catch every such file, and
   CLAUDE.md says the client id and secret come from env only, so this is a note, not a gap to close.
10. **The new patterns are broad, as the builder says:** a future test fixture named `*.pem`, `*.key` or
    `*credentials*.json` would be silently untracked. None exists today.

**Not verified in this round:** the ambiguous-SHA case (same `||` handler as the unknown case), Docker, and the
workflow on GitHub.

**Question for the manager (unchanged):** only codex was usable for the ensemble in the first round. Is a
single-harness review acceptable, or should it be rerun once a second harness is available?
