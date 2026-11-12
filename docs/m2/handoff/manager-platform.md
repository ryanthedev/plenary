# Handoff: manager platform (from t14q, 2026-11-11 ~20:10, at ~53% context)

Read docs/m2/briefs/manager-platform.md, docs/m2/OFFICE.md (all of it: start command, cleanup, sdd helpers, no
pkill, reports-to label, keep the train moving) and docs/m2/reports/manager-platform.md (full history and
decisions). Then continue as manager platform. Your parent is the proxy, t14h. Report there by `herdr_agent prompt`
and in docs/m2/reports/manager-platform.md. Label every session you start `plenary.reports-to=<your terminal id>`.

## Committed platform jobs (all verified)

p8-ci 8f89d4f · p8-ign 4fc4c71 · p5-auth 91fb274 · p8-deploy 2225ff1 · p5-fix 4e16752 · p8-cluster-env 33b4cd8 ·
p5-http 4fad32a · p8-deps 723f6c6 · p5-flake c0ff386. First GitHub CI run green (run 43126348872).

## Live sessions you now own

| Terminal | Tab | State | Next |
|---|---|---|---|
| t185 | worker pd-drawh3 (platform): drawh settings, round 3 | RUNNING (brief docs/m2/briefs/pd-drawh3.md) | When done: verifier re-check 3 |
| t155 | verifier pd-drawhv (platform): drawh proposal | idle, ~31%+ context, FAILed re-check 2 | Reuse for re-check 3 if under 60% and idle < 1 h, else a fresh verifier with its report as context |

Arm a watch: `herdr_agent watch targets:["t185","t155"] engine:"core"` into Monitor.

## Open threads

1. **pd-drawh (drawh proposal), round 3 of 3.** Re-check 2 FAILED: board settings carry no version, so the round-2
   10 s window bounces real reverts (R2a, R2b). Round 3 (t185): step 1 checks whether an `appState.herdr` field
   survives drawh commands and pane saves; then option 1 (base-generation marker + three-way merge, preferred) or
   option 2 (settings room → file only while connected, loud line). **Last round:** if re-check 3 fails, ship option
   2. On PASS: commit docs/m2/proposals/drawh-server.{patch,md} + briefs/reports pd-drawh*.md by path, tell the
   proxy it's ready for the CEO (approve/reject; herdr-draw is never edited without the CEO). Then close t155, t185.
   Settled with engine: seeding renumbers only elements absent from the room with version > 1,000, to version 1.
2. **README (p8-readme), parked, verified PASS but now STALE.** Since its PASS: p8-deploy, p8-cluster-env, p5-http
   and engine's lockfile 0d40b86 landed. README.md:34 (sign-in "not wired"), :39 (`POST /boards` 404), :113
   (deploy/README out of date), :118 (compose "sets neither") are now wrong or soon wrong; also check the
   no-dependencies claim. Plan: after engine's p2-swap mounts httpRoutes in main.js, run a refresh job + verifier,
   then commit README.md with its briefs/reports. It links engine/client files that must be committed first.
3. **HTTP wiring:** engine's p2-swap mounts `httpRoutes(...)` in main.js (test: dev-Bearer POST /boards creates a
   board a socket client joins). Engine (t14j) will notify. Nothing for platform to build unless they ask.
4. **Waiting on the CEO (via the proxy only):** the real Google OAuth client (env only). Until then oidc is null and
   /auth routes answer 503 `sign-in-unavailable`.
5. **Sent to engine, no answer needed from platform:** settings versions in the protocol (durable fix for drawh R1);
   v1 `welcome` should carry a room identity.

## Habits that saved time

- Check a worker's footer before reusing it (≤60%, idle < 1 h). zsh doesn't word-split `$P`; use arrays.
- Commit by path only; tree is shared. Re-run `bun test` before every commit.
- Approve permission prompts only inside the brief; "Dangerous rm operation" on read-only commands was always a false
  alarm; pkill/pattern kills: press 2 and steer to `kill $PID`.
- Engram is unreachable from sessions started without the login-shell wrapper; mine was. Nothing stored.
