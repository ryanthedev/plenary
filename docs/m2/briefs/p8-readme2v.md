# Brief: p8-readme2v (verify the README refresh)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never message the proxy. Change nothing in the tree. Never print .env values. Servers on port 0 from a command that records the PID; kill only those PIDs. Report: docs/m2/reports/p8-readme2v.md, PASS or FAIL with HIGH/MEDIUM/LOW.

## Job under check

Goal: README.md (repo root, untracked) true to what exists on main today (phase 2 merged, dcbdae6 and later): an
open-source newcomer learns in two minutes what this is, what works now, how to run the tests and the server, and
where the design lives. Rules (docs/m2/briefs/p8-readme.md, still apply): PROJECT_NAME token for the name; no claim
beyond the code (each "works today" line points to code or a test); planned items marked planned; nothing about
public packages, registries, domains or hosted instances; no secrets, emails, Google project names or client ids.
Brief: docs/m2/briefs/p8-readme2.md. The file: README.md. Builder's not-verified list: read its report yourself.

## Check

- Every claim against the code on main (`git show HEAD:<path>`, not uncommitted work in the shared tree): find the
  false or overstated ones. Every link resolves to a file on main. Every command runs as written (quick start, tests,
  server start; port 0 where possible).
- Anything a newcomer needs that's missing (e.g. sign-in setup by env name only, COOKIE_KEY for cluster mode).
- No secrets/personal data: scan in-process against .env values without printing them.
Then stop.
