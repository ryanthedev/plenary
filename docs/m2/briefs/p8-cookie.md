# Brief: p8-cookie (COOKIE_KEY for the cluster compose and CI)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy. Never pkill/killall; servers on port 0 (or the port a rule fixes) from a command that records the PID; kill only those PIDs. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p8-cookie.md.

## Goal

Since phase 2 (main dcbdae6), server/main.js refuses cluster mode (DATABASE_URL or NATS_URL set) without
`COOKIE_KEY` (>= 32 bytes; signs login/exchange cookies and sessions unless SESSION_KEY is set). deploy/cluster.compose.yml
sets none, so its nodes won't start; check the CI cluster job (.github/workflows/ci.yml) too. Read main.js's env header.

- Compose: every node gets the SAME `COOKIE_KEY` from the environment (a required variable, e.g. `${COOKIE_KEY:?…}`),
  never a value in the repo. Same for anything else main.js now requires in cluster mode (PUBLIC_URL, OIDC_REDIRECT_URI:
  check and say). Single-node compose: say whether it should set one (a restart signs everyone out otherwise).
- CI: generate a throwaway random key in the job (e.g. `openssl rand -hex 32`), never a literal in the YAML.
- deploy/README.md: how to set it (one line to generate it), and that all nodes must share it.
- Validate: `docker compose -f … config` with and without COOKIE_KEY (the error must name it); YAML parses; if Docker
  is available, bring the cluster up long enough to see every node start, then down (record what you started).

## Files you own

deploy/, .github/workflows/ci.yml. Nothing else.

## Done when

The above, full `bun test` passes, report (what changed, what ran, not verified). Then stop. Do not commit.
