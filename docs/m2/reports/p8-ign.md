# Report: p8-ign (root ignore files, p8-civ follow-ups, explicit COPY, herdr-draw in CI)

**Status: done. Nothing committed. Docker and GitHub Actions were not run (no Docker here; the workflow has
never run on GitHub).** `bun test`: 80 pass, 0 fail. The brief's five items are done, plus two items the
manager (t14q) added mid-job: explicit `COPY` lines in the Dockerfile, and a CI step that puts herdr-draw
beside the checkout.

## What changed

| File | Change |
|---|---|
| `.gitignore` | Kept `node_modules`, `.DS_Store`. Added `.env`, `.env.*`, `!.env.example`; `client_secret*.json`; `*.db`, `*.sqlite`, `*.sqlite3` and each one's `-wal`, `-shm`, `-journal`; `/data/`, `/blobs/`, `/deploy/data/`, `/deploy/blobs/`. |
| `.dockerignore` (new, root) | Drops `.git`, `.github`, `.gitignore`, `.dockerignore`, `docs`, `CLAUDE.md`, `deploy`, `test`, `**/node_modules`, `**/.DS_Store`, `**/.env`, `**/.env.*`, `**/client_secret*.json`, the same database patterns with `**/`, root `data` and `blobs`. |
| `deploy/Dockerfile` | `COPY . .` replaced by four explicit copies: `package.json`, `packages/`, `server/`, `web/`. |
| `.github/workflows/ci.yml` | `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; new step "Check out herdr-draw at the commit in SOURCE.json" before `bun test`. |
| `deploy/compose.yml` | Top-level `name: plenary`; header comment says `.env` is read from `deploy/`. |
| `deploy/README.md` | Where `.env` goes (`deploy/.env`), that `.env*` is git-ignored, what the image leaves out, the volume name, the CI clone. |

**Tests added:** none (config only).

## Decisions

- **Two defences for the image (security review, MEDIUM, `COPY --chown=bun:bun . .`).** First: the Dockerfile
  copies four named paths, so a stray root file (`.env`, a database, `.git`) cannot be copied at all. Second:
  `.dockerignore` still filters *inside* those directories (`server/.env`, `web/x.db`) and keeps the build
  context small. Cost: a new top-level runtime directory must be added to the Dockerfile; a comment says so.
- **`test/` is not in the image.** Tests run in CI from a checkout, never from the image. `test/` holds fakes
  (`fake-idp.js`, `fake-store.js`) that should not ship, and nothing in `server/`, `web/` or `packages/`
  imports from `test/` (grep for `from ".../test/"`: no hits).
- **`web/` is copied** because the brief lists it as needed at runtime. Nothing serves it yet (no
  `server/main.js`); if phase 3 serves the client some other way, drop that line.
- **`PROTOCOL.md` is not in the image.** `.dockerignore` does not exclude it, but no code reads it (it appears
  only in comments), so the Dockerfile does not copy it. `CLAUDE.md` is excluded outright.
- **`.env.example` is allowed in git but excluded from the image** (the image does not need a template).
- **`client_secret*.json` is ignored** (my addition): it is the file name Google Cloud gives a downloaded OAuth
  client, the likeliest way the Google secret lands in the tree.
- **No editor/OS noise added.** Nothing obvious exists in the tree beyond `.DS_Store`.
- **Data directories are anchored** (`/data/`, not `data/`), so a source directory such as `server/data/` is
  not ignored. Compose uses a named volume, so no host directory is created by it; these cover someone
  pointing `PLENARY_DATA_DIR` at the repo.
- **herdr-draw clone:** full clone (not shallow) because SOURCE.json holds the short SHA `5dfe352`. The step
  reads the commit with `bun`, rejects anything that is not 7 to 40 hex characters, resolves it with
  `git rev-parse --verify` (fails if unknown or ambiguous), and checks out detached. Anonymous HTTPS, no
  token (`persist-credentials: false` already), nothing pushed. No `${{ }}` in the `run:` block.
  `test/core-source.test.js` was not touched.

## How I checked

- **`git check-ignore -v`:** ignored: `.env`, `.env.local`, `deploy/.env`, `server/.env.production`, `x.db`,
  `x.sqlite-wal`, `a/b/y.sqlite3-journal`, `data/blob`, `blobs/x`, `deploy/data/x`, `client_secret_123.json`.
  Not ignored: `.env.example`, `deploy/.env.example` (matched by `!.env.example`), `server/data/x.js`,
  `package.json`, `web/sync.js`.
- **No tracked file newly ignored:** `git ls-files -ci --exclude-standard` prints nothing.
- **`.dockerignore`, SIMULATION ONLY (my own matcher in a scratch script, not Docker's):** fed
  `git ls-files -co --exclude-standard` through it. Kept: `package.json`, `PROTOCOL.md`, `packages/` (24
  files), `server/` (8), `web/` (4). Dropped: `docs/` (66), `test/` (13), `deploy/` (3), `.github/` (1),
  `CLAUDE.md`, `.gitignore`, `.dockerignore`. Hostile samples all dropped: `.git/config`, `.env`,
  `deploy/.env`, `server/.env.local`, `web/.env.example`, `server/store/plenary.db`, `server/x.sqlite3-wal`,
  `data/blobs/a`, `server/node_modules/x.js`, `web/.DS_Store`, `server/client_secret_1.json`. Kept as
  intended: `server/data/ok.js`, `bun.lock`, `packages/core/SOURCE.json`.
- **YAML:** `ruby -ryaml` loads both files; ci.yml steps are checkout, setup-bun, install, herdr-draw, Test;
  compose keys are `name, services, volumes`, `name` = `plenary`.
- **CI step, run locally:** copied the tree to a scratch folder shaped like the runner
  (`work/plenary/` with room for a sibling), extracted the step's `run:` text from the YAML and ran it with
  `bash -e`. Output: `herdr-draw at 5dfe352686b3333516ed151eee97e4826cb26ea8 (SOURCE.json commit: 5dfe352)`.

  | `bun test` in the scratch copy | pass | fail | expect() calls |
  |---|---|---|---|
  | Without the clone | 80 | 0 | 655 |
  | With the clone | 80 | 0 | 673 |

  The difference is 18, the file count in SOURCE.json, so the second core-source test really ran.
- **Step failure paths:** `{}` and `{"commit":"$(id);x"}` in SOURCE.json both exit 1 with "commit is missing
  or is not a hex SHA"; a second run exits 1 because `../herdr-draw` exists.
- **`bun test` in the repo:** 80 pass, 0 fail (673 expect() calls; herdr-draw sits beside this repo here).

## Not verified

- **Docker:** no `docker build`, no `docker compose config`. The `.dockerignore` result is a simulation. From
  memory, not run: Docker still reads `deploy/Dockerfile` although `.dockerignore` excludes `deploy`; Compose
  reads `.env` from the compose file's directory; `name: plenary` yields the volume `plenary_plenary-data`.
- **GitHub:** the workflow has never run there. Not checked on a runner: that `../herdr-draw` (outside the
  workspace) is writable, and that the `cancel-in-progress` expression behaves as intended. No actionlint.
- **Engram** (cross-session memory) was unreachable at the start, so no recall was done.

## Risks and notes

- **Pinning limit:** the CI check proves `packages/core` equals herdr-draw **at the commit in SOURCE.json**.
  It does not notice newer herdr-draw commits that were not re-copied here; a local run with herdr-draw
  checked out beside this repo still does.
- **CI now depends on github.com/ryanthedev/herdr-draw being public and reachable**, and on that commit
  staying in its history (a force-push that drops it fails CI). A full clone costs a few seconds today.
- **`server/` and `web/` are untracked today.** The Dockerfile's `COPY server/` and `COPY web/` fail the build
  if either directory is missing from the context, so they must be committed before an image build from a
  clean checkout.
- **Lockfile:** `bun.lock` is not ignored by either file; when it appears, add it to the Dockerfile's first
  `COPY` (the existing comment covers this).
- **Volume rename:** anyone who already ran Compose has a `deploy_plenary-data` volume that the new project
  name no longer uses. Nobody has (no Docker here), so no migration note in the README.
- **Still open from p8-civ, not in this brief:** LOW 4 (same-repo PRs run CI twice) and LOW 6
  (`image: plenary:dev` plus `build:`).

## Fix round (2026-11-11, from docs/m2/reports/p8-ignv.md, verifier PASS)

**Status: the four requested findings are fixed. Nothing committed. Docker and GitHub Actions still not run.**
`bun test`: 125 pass, 0 fail (other sessions added tests since the first round). LOW 5 to 8 left as told.

| Finding | Fix | File |
|---|---|---|
| MEDIUM 1: private keys and credential files not covered | Added `.envrc`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*credentials*.json`. The Docker file has the same six with `**/` so they match at any depth | `.gitignore`, `.dockerignore` |
| LOW 2: stale `COPY . .` comment | Header now says the Dockerfile copies four named paths and this file is the second line of defence | `.dockerignore:1-2` |
| LOW 3: comment overstated the `main` guarantee | Comment now says a running run on `main` is never cancelled, but GitHub keeps one pending run per group, so quick pushes can still drop a run that had not started. Behaviour unchanged | `.github/workflows/ci.yml:14-15` |
| LOW 4: unknown SHA failed with no message | `rev-parse` failure now prints "herdr-draw has no single commit matching '<sha>' ...: unknown or ambiguous." to stderr, then exits 1 | `.github/workflows/ci.yml:55-59` |

### How I checked

- **New git patterns** (`git check-ignore -q --no-index`): ignored: `.envrc`, `server/.envrc`, `a.pem`,
  `server/tls/b.key`, `id_rsa`, `id_rsa.pub`, `server/id_ed25519`, `sa-credentials.json`,
  `server/credentials.json`. Still ignored: `.env`, `x.db`, `client_secret_1.json`. Not ignored:
  `.env.example`, `server/auth/oidc.js`, `server/credentials.js`, `web/keyboard.js`, `package.json`.
- **Nothing tracked became ignored:** `git ls-files -ci --exclude-standard` is empty. No untracked source file
  is hidden either: `git ls-files -oi --exclude-standard` (outside `node_modules`) is empty.
- **`.dockerignore`, SIMULATION ONLY (same scratch matcher, not Docker's):** kept `package.json`,
  `PROTOCOL.md`, `packages/` (24), `server/` (17), `web/` (4). Dropped: `.envrc`, `server/.envrc`, `a.pem`,
  `server/tls/b.key`, `server/id_rsa`, `web/id_ed25519.pub`, `server/sa-credentials.json`. Kept:
  `server/credentials.js`, `server/auth/oidc.js`.
- **CI step, extracted again from the YAML and run with `bash -e` in fresh runner-shaped scratch copies:**
  real commit: `herdr-draw at 5dfe352686b3333516ed151eee97e4826cb26ea8`, exit 0, and
  `bun test test/core-source.test.js` there gives 2 pass, 36 expect() calls (both tests ran). SOURCE.json
  edited to `deadbee` in the scratch copy only: the new message prints, exit 1.
- **YAML:** `ruby -ryaml` loads `ci.yml` and `compose.yml`.

### Not verified, and notes

- **Still not run:** Docker, the workflow on GitHub, actionlint. The ambiguous-SHA branch was not exercised
  (only the unknown one); both go through the same `||` handler.
- **`*credentials*.json` is broad on purpose:** any JSON file with "credentials" in its name is now ignored by
  git and left out of the image, including a legitimate fixture or config named that way. No such file exists
  today. `*.key` and `*.pem` likewise rule out committing test key fixtures under those extensions.
- **`id_rsa*` also covers `id_rsa.pub`** (public keys). Harmless.
- **LOW 3 is softened, not solved:** a pending `main` run can still be dropped. A full fix (for example the
  commit SHA in the group name for pushes to `main`) is a manager call.
