# Brief: p8-readmev (verify p8-readme: repo README)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-readmev.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; start any
server on port 0 from a command that records its PID, and kill only that PID.

## Goal and done-when (docs/m2/briefs/p8-readme.md: read it)

A root README.md for an open-source project, true to what exists today: what it is, status, layout, dev loop,
protocol pointer, the packages/core rule, Docker, license. The product name appears only as the placeholder
`PROJECT_NAME` (CLAUDE.md keeps the real name in CLAUDE.md and package.json only). No claims beyond the code, no
secrets or personal data (no emails, Google Cloud project names, client ids), env vars by name only.

## The job's file

`README.md` (new, untracked). Read it line by line against the repo.

## Try to break it

- Every "works today" claim: find the code or test that backs it; run every command as written (port 0, recorded
  PID). Any claim the code doesn't support is a finding.
- Any path or link that doesn't exist, or exists only untracked (note which track owns it).
- The real product name, an email, a person's name, a Google Cloud project, a private link (claude.ai): grep.
- Anything that implies something is published, hosted, registered or licensed.
- `bun test` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load the `sdd:subagent-driven-development` skill first. Check `usage`, then ask codex + agy + every other harness
that passes `check_adapter` to fact-check README.md against the repo. Two agreeing = HIGH candidate: confirm or
refute it yourself. List which harnesses ran; if only one passes `check_adapter`, say so.

## The builder's not-verified list and risks (only these, not its claims)

- No Docker; image never built. CI never seen running on GitHub.
- `web/dev.html` never opened in a browser; no hand-run WebSocket session.
- "code is v0" lines go stale when phase 2 lands.
- README links to files not yet committed (engine's server/, test/server/; client's web/, test/web/,
  docs/m2/design/).
- No LICENSE file; README says none is granted.
- deploy/README.md, deploy/Dockerfile and deploy/compose.yml carry stale "phase 3" notes; compose sets neither
  `HOST=0.0.0.0` nor dev tokens.
- docs/m2/PLAN.md, linked from the README, names a Google Cloud project and "the CEO".

Grade HIGH: a false claim about what works, a leaked secret or personal detail, the real product name, or a
claim that something is published/licensed. Then stop and leave the session idle.
