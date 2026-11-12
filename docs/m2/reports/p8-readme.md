# Report: p8-readme (repo README)

**Status: done. `README.md` written at the repo root; every path in it exists, the one server command in it was
run as written, `bun test` passes (143 pass, 0 fail). Nothing committed.**

**Do not commit README.md ahead of the engine and client tracks' uncommitted files** (list below): it links to
them and describes them as existing.

## What changed

| File | What |
|---|---|
| `README.md` (new) | What it is (as a goal), status table (M1 done, M2 in progress, M3–M8 planned), "what works today" table with a code/test pointer per row, "not there yet" list, repo layout, dev loop, local server command, protocol pointer, the packages/core rule, Docker, design pointers, license. |

**Tests added:** none (documentation only).

## Product name

- **Placeholder used:** `PROJECT_NAME` on lines 1, 3 and 5 (title, a note saying it is a placeholder, and the
  opening paragraph). One find/replace swaps it; then delete the note on line 3.
- **Surviving "plenary" hits (all real identifiers, must stay):** `PLENARY_DATA_DIR` (line 79) and
  `PLENARY_DEV_TOKENS` (lines 80, 87, 115). No other case-insensitive hit.
- **Outside my file:** two files the README links use the name: `deploy/README.md` (prose and `plenary:dev`) and
  `docs/m2/design/README.md` (its title).

## How I checked

- **Paths:** extracted every backticked path and relative link from the README and ran `test -e` on each. All
  exist. Two bare mentions are not repo paths on purpose: herdr-draw's `core/` and the short form `SOURCE.json`.
- **External links:** the two in the README (bun.sh and the herdr-draw GitHub repo) both answered HTTP 200.
- **`bun test`:** 143 pass, 0 fail, Bun 1.4.4 (same as `.github/workflows/ci.yml`). `../herdr-draw` exists on this
  machine, so the herdr-draw comparison in `test/core-source.test.js` ran rather than skipped.
- **Server command:** ran the README's block exactly (`PORT=0`, `PLENARY_DATA_DIR="$(mktemp -d)"`, a dev token):
  it logs the dev board and the port, `GET /health` answers 200. In an earlier run with the same variables, `POST /boards` and `/` answered 404. Without
  `PLENARY_DEV_TOKENS` it starts and logs "every hello will be refused". Stopped by recorded PID each time.
- **Protocol v0 vs v1:** `packages/protocol/envelope.js` still has `STREAMS = ["board", "notes"]` and
  `ports.js` a sync `Auth.check`, while `PROTOCOL.md` is titled v1. The README says the code is v0.
- **Personal data:** no `@`, no email, no cloud project name, no client id. "Google" appears only as "Google
  sign-in". The herdr-draw GitHub URL is the one already in `ci.yml` and `SOURCE.json`.
- **Ignored files:** none of the linked paths is git-ignored.

## README links that depend on uncommitted files

| Path | Owner track |
|---|---|
| `server/main.js` (and gateway, room host, store, bus, blobs) | engine |
| `test/server/` | engine |
| `web/`, `web/dev.html`, `test/web/` | client |
| `docs/m2/design/` | client |

## Not verified

- **Docker:** no Docker on this machine; the image was never built or run. The README says so.
- **CI on GitHub:** I read the workflow; I did not see a run.
- **`web/dev.html` in a browser:** not opened. The README describes it from the source and `test/web/`, and gives
  no command to open it (the server does not serve it; ES modules do not load from `file://`).
- **A WebSocket session by hand:** not done by me; `test/server/main.test.js` covers it and passes.
- **Protocol phase 2 is being built now:** the "code is v0" lines go stale when it lands.

## Risks and requests (files I don't own)

- **No LICENSE file.** The README says "Not yet chosen. Until a LICENSE file is added, no license is granted."
  An open-source project needs one; this is the CEO's choice.
- **`deploy/README.md` is stale:** it says `server/main.js` and `/health` "come in phase 3" and the container
  exits at start. The entry exists and runs now. Same stale notes in `deploy/Dockerfile` (lines 32, 37) and
  `deploy/compose.yml` (line 29).
- **Compose would not work as is:** `server/main.js` binds `127.0.0.1` by default (its header says a container
  needs `HOST=0.0.0.0`), and without `PLENARY_DEV_TOKENS` it refuses every hello. Compose sets neither. Read from
  the files, not tested in a container.
- **"Nothing is published" lines:** the brief says "nothing about public packages, registries, domains or hosted
  instances". I read that as "claim none", so the README states that none exist (intro and Docker section). Cut
  those lines if the rule meant "don't mention them".
- **Opening line:** says "meant to be open source (the license is not chosen yet)" rather than "open-source",
  because no license is granted yet.
- **Docker section:** tells the reader that `deploy/README.md`'s "not runnable yet" note is out of date. Remove
  that sentence once `deploy/README.md` is fixed.
- **Design doc link left out:** CLAUDE.md's claude.ai link is private, so a newcomer could not open it. The README
  points to `PROTOCOL.md`, `docs/m2/PLAN.md` and `docs/m2/design/` instead.
- **`docs/m2/PLAN.md` is linked from a public README** and names the Google Cloud project and "the CEO". Worth a
  look before the repo goes public.
- **README sections that will need updates:** "What works today" and "Not there yet" (phases 2, 3 wiring, 4, 6, 7),
  and the Docker section once the image is built.
- **Engram** (cross-session memory) was unreachable (name resolver error); no recall, nothing written.

## Fix round (from docs/m2/reports/p8-readmev.md, relayed by manager platform)

**Status: done. Four README edits, paths re-checked, `bun test` passes (148 pass, 0 fail; the count rose from 143
because other sessions added tests). Nothing committed.**

| Finding | What I did | README line |
|---|---|---|
| HIGH 1 (name in env vars) | Manager's ruling: identifiers defined in code keep their real names; only prose uses `PROJECT_NAME`. No rename. Added one bullet: variable names use the current working prefix (`PLENARY_`), which may change when the name is settled. | 90 |
| MEDIUM 2 (tenancy "not wired") | Used the verifier's wording: OIDC, sessions, invites, share links and the admin API are not wired in; roles are resolved through the tenancy module, from the in-memory registry. Confirmed in `server/main.js:25,44`. | 34 |
| LOW 3 (blobs) | Now "local-disk blob store (not served yet)". Confirmed in `server/gateway.js:134` (`blob` is refused). | 33 |
| LOW 4 (purity) | Now says the test checks statically (import paths and a fixed list of global names) and does not load the code in such a runtime. | 73-74 |
| LOW 5-8 | Left as they are, per the manager. | |

- **Name hits now:** `PROJECT_NAME` on lines 1, 3, 5. Case-insensitive "plenary" on lines 80, 81, 88, 90, 118: the
  two env var names plus the `PLENARY_` prefix in the new bullet. Line 90 is a new hit, added on the manager's
  instruction.
- **Paths:** every backticked path and relative link exists (`test -e`), same method as before.
- **Correction to my earlier list:** `docs/m2/design/` is tracked (the verifier is right); the README does not
  depend on an uncommitted file there. The other untracked targets stand (`server/main.js` and the rest of the
  engine's `server/` files, `test/server/`, `web/`, `test/web/`).
- **Not re-run:** the server command (unchanged in this round) and the external links.
- **No servers started** in this round.
