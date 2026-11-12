# Brief: p8-cookiev (verify p8-cookie)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-cookiev.md, PASS or FAIL
with HIGH/MEDIUM/LOW. Report only to t187; never message the proxy. Change nothing in the tree. Never print .env
values. Kill or remove only containers/processes you started (by name/id you recorded); other Podman containers
(Engram's) must stay up.

## Job under check

Goal: since phase 2 (main dcbdae6), server/main.js refuses cluster mode without COOKIE_KEY (>= 32 bytes, same on
every node). Make deploy/cluster.compose.yml and the CI cluster job supply it (from the environment; CI a throwaway
random key per run; never a literal secret in the repo), plus whatever else main.js now requires in cluster mode,
and document it in deploy/README.md. Diff: `git diff -- deploy .github`. Brief: docs/m2/briefs/p8-cookie.md.
Builder's not-verified list and risks (not its claims): read the "Not verified" section of docs/m2/reports/p8-cookie.md
yourself (incl. a healthcheck quirk under Podman).

## Check

- No secret value in the repo (grep the diff); compose fails loudly without COOKIE_KEY and names it; every node gets
  the same key; single-node compose behaviour as documented.
- CI YAML parses; the key is generated per run and never echoed; the cluster job's env matches main.js's env header.
- Read main.js's env header: does compose set everything cluster mode needs (PUBLIC_URL, OIDC_REDIRECT_URI, …)?
- If cheap: `docker compose -f deploy/cluster.compose.yml config` with/without COOKIE_KEY (Podman is the runtime here).
- Full `bun test` (name failing tests if any). Then stop.
