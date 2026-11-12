# Report: p8-readmev (verify p8-readme: repo README)

**FAIL** (one HIGH, under the brief's letter: the real product name appears in README.md, through two env var
names. The README can't fix it alone; it needs a decision. Everything else holds up.)

Checked: `README.md`, sha1 `df8266a28c53d7cccd2f527dbdf5c98925da7387` (untracked, unchanged before and after the
ensemble run). `bun test` (Bun 1.4.4): **143 pass, 0 fail**, 14 files.

## HIGH

1. **The real product name is in README.md, via env var names.** `PLENARY_DATA_DIR` (line 79) and
   `PLENARY_DEV_TOKENS` (lines 80, 87, 115). The brief puts "the real product name" on the HIGH list with no
   carve-out for identifiers. I found no ruling that exempts them: OFFICE.md, COMMITMENTS.md and
   manager-platform.md have none, and manager-platform.md:120 says the name question was "asked the proxy".
   The builder disclosed these hits in p8-readme.md ("real identifiers, must stay").
   - **Why the README can't fix it alone:** the names are defined by `server/main.js:6-7,30,34` (engine track)
     and used in `deploy/`. Writing anything else would make the run command wrong. The name also appears in
     the on-disk file `plenary.db` (`server/main.js:39`), in the `PROTOCOL.md` title and in `deploy/README.md`.
   - **The fix is one of:** (a) the proxy rules that identifiers in code and env vars may carry the name, and
     this becomes a PASS with no README change; or (b) the env prefix is renamed in `server/main.js` and
     `deploy/` (engine and platform tracks), and then the README follows.

## MEDIUM

2. **"Tenancy … not wired into the server" is false (README:34).** `server/main.js:25,44` builds
   `authPort({ dev, tenancy: tenancy({ registry }) })`, and the gateway calls `auth.role` on every hello, so
   tenancy role resolution runs today. What is really not wired: Google sign-in (OIDC), server sessions
   (`authPort` gets no `sessions`), and any HTTP route that creates invites, share links or boards.
   **Suggested wording:** "Google sign-in (OIDC), sessions, invites, share links and the admin API exist as tested
   modules but are not wired in; roles are resolved through the tenancy module, from the in-memory registry."
   This under-claims rather than over-claims, so it is MEDIUM. (grok called this row "exact"; refuted above.)

## LOW

3. **"Local-disk blobs" (README:33) reads as though images work.** `main.js:41` builds the disk adapter and
   `test/server/ports.test.js` tests it, but no client can reach it: `server/gateway.js:134` refuses `blob`
   ("SEAM(p3): not served yet"). Suggest "local-disk blob store (not served yet)".
4. **The purity claim is a static check (README:72-73; codex).** `test/purity.test.js` checks import specifiers
   and does a substring scan for a fixed list of globals. It does not load the code in QuickJS. "checks that" is
   fair for the import rule but slightly overstates "loads in runtimes without … globals".
5. **Untracked targets.** README links or names files that are not committed yet: `server/main.js`, and all of
   `server/` except `auth/` and `admin/`, `test/server/` (engine track); `web/dev.html`, `web/`, `test/web/`
   (client track). The README must be committed with or after them. Correction to the builder's risk list:
   `docs/m2/design/` **is** tracked.
6. **Linked files carry things the README avoids** (not README content; owners noted).
   - `docs/m2/PLAN.md:26` names the Google Cloud project ("Omniping"), and PLAN.md says "the CEO" throughout.
   - `PROTOCOL.md` has the title "Plenary protocol v1" and a section "Open questions for the CEO".
   - `deploy/README.md` uses the name 4 times.

   These matter only once the repo goes public. PLAN.md and PROTOCOL.md belong to the proxy/platform;
   `deploy/` belongs to platform.
7. **Stale soon.** "The code implements protocol v0" (lines 32, 95) goes stale when phase 2 (p2-recovery)
   lands. Today it is true: `server/room-host.js:3` says "Today's Room is v0".
8. **Public GitHub handle in the herdr-draw link (README:8).** This is the public repo URL, which CI clones too.
   Not personal data beyond a public handle; noted only because the brief asks about person names.

## Claims checked and confirmed

| Claim | Evidence |
|---|---|
| Run command works as written (port 0) | Ran it (PID recorded, killed by PID). Log printed the port and the dev board id. |
| `GET /health` 200 + small JSON | `{"ok":true,"uptimeMs":…,"gateway":{…},"rooms":0}` |
| WebSocket at `/ws`, token in the `hello` | Dev token: `welcome` with role editor. Wrong token: `error auth`, close 1008. |
| `POST /boards` returns 404 | `HTTP/1.1 404 Not Found` |
| No `PLENARY_DEV_TOKENS`: server starts and refuses every hello | Ran it: warn log, then `error auth` and close 1008 |
| Boards are not reachable after a restart; the log is durable | Restarted on the same data dir; the old board id was refused (`auth`). `plenary.db` persisted. |
| `HOST` defaults to 127.0.0.1; `LOG_LEVEL` | `server/main.js:5,9,58`; log shows `"hostname":"127.0.0.1"` |
| Bun 1.4.4, CI runs `bun test` on push and PR, no dependencies | `.github/workflows/ci.yml`; no lockfile |
| core-source test: SOURCE.json always checked; `../herdr-draw` only if present | `test/core-source.test.js:9-17` (returns early, so "skipped" means it passes silently) |
| protocol imports only `core/doc.js` and `core/model.js` | grep of `packages/protocol/*.js`, plus the purity test |
| Sign-in modules are tested | `test/auth/port.test.js` imports `session.js` and `admin/boards.js`; `oidc.test.js` and `tenancy.test.js` cover the rest |
| `web/dev.html` uses an in-page Room, not the server | `web/dev.js:6-9` (`localRoom`); `web/sync.js` imports Room; no WebSocket or fetch. The server has no static route. |
| Docker: deploy notes are stale, compose sets neither `HOST` nor dev tokens, nothing published | `deploy/Dockerfile:32,37`, `deploy/compose.yml:29`, `deploy/README.md:15` |
| No LICENSE, and no claim of a license, publication or hosting | `LICENSE` missing; the README says "not yet chosen" and "nothing is published" |
| No emails, client ids, GCP project or claude.ai links in README.md | grep (only the env var names above hit) |
| Every path in the README exists | `test -e` on each one (see 5 for which are untracked) |

## sdd ensemble

- **usage:** codex plus plan, 34% of the 5-hour window and 6% of the weekly window used.
- **check_adapter:**

  | Harness | Result |
  |---|---|
  | codex | ok |
  | grok | ok |
  | agy | failed: quota exhausted, resets in about 69 h |
  | kimi | failed: no model configured or logged in |
  | mistral | failed: no `MISTRAL_API_KEY` |
  | qwen | binary missing |

- **Ran: codex and grok only.** Both got the same read-only fact-check prompt. They left the tree unchanged:
  README sha1 was the same afterwards, and the only new files were other sessions' briefs and reports.
- **codex** raised two LOWs: the name in env vars (finding 1, which I raised to HIGH per the brief) and the
  purity test being static (finding 4).
- **grok** raised three "HIGH"s, all refuted:
  - **v0/v1 mismatch: refuted.** `gateway.js:84` accepts `v: 1` hellos as a bridge, but `packages/protocol`'s
    Room is v0 (`server/room-host.js:3`), and the README scopes "v0" to `packages/protocol/`.
  - **The other two:** their own text says the claims match the code ("Code exactly does this").
  - **Grok missed** both finding 1 and finding 2.
- **Agreement:** no finding had two harnesses agreeing, so there were no HIGH candidates from the ensemble.
  Finding 1 is HIGH from the brief's rule, not from agreement.

## Not verified

- **`web/dev.html`:** never opened in a browser.
- **Docker image:** never built.
- **CI:** never seen running on GitHub.
- **External links:** bun.sh and the herdr-draw repo were not fetched by me (the builder reports HTTP 200).

## Housekeeping

- **Servers:** I started four, all on `PORT=0`, each killed by its recorded PID (31553, 32904, then two more
  on a shared data dir). Each was confirmed gone.
- **Data dirs:** they were created with `mktemp -d` under the system temp dir, outside the scratchpad, as the
  README's command does.
- **Files:** wrote only this report and scratchpad files. No commit.

Decision needed (proxy): may code identifiers (`PLENARY_*` env vars, `plenary.db`) carry the product name, or
should the env prefix be renamed in `server/main.js` and `deploy/`?

## Re-check (after the fix round)

**PASS.** I checked `README.md` sha1 `8c3910aab9dbb6f2e1407c6cc0e8314ae1f60287`. `bun test`: **166 pass, 0 fail**,
15 files. The count rose because other sessions added tests.

| Finding | Re-check |
|---|---|
| HIGH 1 (name in env vars) | **Closed under the manager's ruling** (t14q: identifiers defined in code keep their real names; only prose uses `PROJECT_NAME`). Every case-insensitive "plenary" hit is an identifier in code formatting: `PLENARY_DATA_DIR` and `PLENARY_DEV_TOKENS` (lines 80, 81, 88, 118) and the prefix `PLENARY_` (line 90). The prose never says the name: the title, the placeholder note and the opening paragraph (lines 1, 3, 5) use `PROJECT_NAME`, and no "omni" appears. |
| MEDIUM 2 (tenancy) | **Fixed.** Line 34 now says roles are resolved through the tenancy module, from the in-memory registry, and that OIDC, sessions, invites, share links and the admin API are not wired in. Code agrees: `server/main.js:25,44` wires `tenancy`, and `authPort` gets no `sessions`. `server/admin/boards.js` (createBoard, setGrant, createInvite, …) is imported by neither `main.js` nor `server.js`. |
| LOW 3 (blobs) | **Fixed.** Line 33 now says "local-disk blob store (not served yet)". `server/gateway.js:134` still refuses `blob`. |
| LOW 4 (purity) | **Fixed.** Lines 73-74 now say the check is static (import paths and a fixed list of global names) and does not load the code in such a runtime. That matches `test/purity.test.js:10-12`. |
| LOW 5-8 | Unchanged, per the manager. They still stand as notes. |

- **Paths:** every backticked path and relative link exists (`test -e`). The only misses are `core/` and
  `SOURCE.json`, which are intentional short forms: herdr-draw's `core/` and `packages/core/SOURCE.json`.
  `LICENSE` is still absent, and the README still says "not yet chosen".
- **Docker paragraph:** still true. `deploy/README.md:15` and `deploy/compose.yml:29` still carry the stale
  "phase 3" notes that the README calls out.
- **LOW 9 (new, from the fix round):** line 90 says the variables use "the project's current working prefix
  (`PLENARY_`), which may change when the name is settled". The prefix is in code formatting, so this is allowed
  under the ruling. But the sentence ties the prefix to the unsettled name, so a reader can infer the working
  name from it. Dropping "which may change when the name is settled" would avoid that. Not blocking.
- **Not re-run:** the server command, because the README's command and `server/main.js`'s env handling are
  unchanged since my first run. External links and `web/dev.html` in a browser are still unverified.
- **This round:** no ensemble (per the manager) and no servers started. I wrote only this section. No commit.
