# Brief: p8-readme2 (refresh README.md for phase 2)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy. Never pkill/killall; servers on port 0 (or the port a rule fixes) from a command that records the PID; kill only those PIDs. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p8-readme2.md.

## Goal

README.md (repo root, written by p8-readme, verified then, never committed) is stale: since then sign-in (Google OIDC +
code exchange), `POST /boards`, the cluster compose, the server on protocol v1.1 and the web client landed (main
dcbdae6). Rewrite it true to what exists today. Read docs/m2/briefs/p8-readme.md for the original rules: they all
still apply (PROJECT_NAME token for the name, no claims beyond the code: each "works today" line points to code or a
test; no secrets, no emails, no Google project names; plain and skimmable). Check every link and command in it
actually works (run the quick-start commands; start the server once if the README says how, port 0).
Note: another worker is editing deploy/ at the same time (COOKIE_KEY); link to deploy/README.md, don't edit it.

## Files you own

README.md only.

## Done when

README.md is accurate (a table of every claim → file/test in the report), commands verified, report written. Stop.
Do not commit.
