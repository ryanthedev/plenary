# Brief: p8-readme (repo README)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p8-readme.md.

## Goal

A README.md at the repo root for an open-source project (CLAUDE.md: "Self-hosting means open source"), true to
what exists **today**, not what's planned. A newcomer should learn in two minutes what this is, what works now,
how to run the tests, and where the design lives.

## Files you own

`README.md` (new, repo root). Nothing else.

## Hard rules

- **Product name:** CLAUDE.md says the name lives only in CLAUDE.md and package.json until it's settled. Until the
  proxy says otherwise, write `PROJECT_NAME` where the name would go (one obvious token so a later find/replace is
  trivial), and say so in the report. If the manager relays a different instruction mid-job, follow it.
- **No claims beyond the code.** Every "works today" line must point to code or a test that exists; mark planned
  items as planned (milestones from CLAUDE.md). Nothing about public packages, registries, domains or hosted
  instances: none exist.
- **No secrets, no personal data:** no emails, no Google Cloud project names, no client ids. Env vars by name only.
- Plain, skimmable: short sections, tables where they help.
- Never pkill/killall; port 0; kill only PIDs you recorded (only if you start anything).

## Contents (suggested)

What it is (one paragraph, from CLAUDE.md's opening); status table (milestone, state, with M2 in progress);
repo layout (only directories that exist: `packages/core`, `packages/protocol`, `server/`, `web/`, `test/`,
`deploy/`, `docs/`; read each to describe it in one line); dev loop (`bun test`, Bun version from
.github/workflows/ci.yml); protocol pointer (PROTOCOL.md); the packages/core rule (copied byte-identical from
herdr-draw, checked by test/core-source.test.js); Docker (deploy/README.md; not runnable until the server entry
exists: check whether `server/main.js` exists and runs now, and say exactly what is true); license: check
whether a LICENSE file exists; if not, say "not yet chosen" and flag it in the report (don't add one).

## How to check

Every path and command in the README exists or runs (`bun test` passes; each linked file exists). List any claim
you could not check.

Done when README.md is written, every link and command checked, `bun test` passes, report written. Then stop.
Do not commit.
