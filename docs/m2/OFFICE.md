# Plenary M2 office manual (every session on the team reads this first)

The team builds docs/m2/PLAN.md. Sessions are Claude Code sessions in Herdr app tabs, started with `hc run`.
**No Workflow tool, no dynamic workflows** (CEO, 2026-11-11: "use herdr app panes and hc"). In-process Agent
subagents are fine only for quick read-only lookups inside one session.

## Who is who

| Role | Tab label | Does |
|---|---|---|
| CEO | (the user) | Goals and decisions. Talks to the proxy. |
| Owner | `owner (audits)` | Started the team. Audits the proxy's commits on request. Mostly idle. |
| Proxy | `★ proxy (talk here)`, `role=orchestrator` | The CEO's contact. Runs the managers, owns COMMITMENTS.md, audits every phase before it's pushed, asks the CEO only for decisions that are theirs. |
| Manager | `manager <track>` | Runs one track (PLAN.md). Writes briefs, starts builders and verifiers, unsticks them, re-runs tests, commits by path, reports to the proxy. |
| Builder | `worker <job>: <what>` | Builds one job from its brief. |
| Verifier | `verifier <job>v: <what>` | Checks one job adversarially. Never the builder. |

Tabs are never left as a bare number. When a session is done or recycled, rename its tab `done <job>` or
`retired <role>`. Labels: every session gets `--label herdr.space=sp21a427967d02459948b4c10156ff82ae` (the
plenary space) and `--label plenary=<role-or-job>`; only the proxy gets `role=orchestrator` (see
~/repos/herdr-stage/ROLES.md).

## Starting a session

```
hc run --bg --no-parent --cwd /Users/r/repos/plenary \
  --label herdr.space=sp21a427967d02459948b4c10156ff82ae --label plenary=<job> \
  -- claude --settings /Users/r/.config/claude/settings.shared.json --plugin-dir /Users/r/repos/engram \
  --plugin-dir /Users/r/repos/herderp --plugin-dir /Users/r/repos/sdd "Read <brief path> and do it."
```

Then right away: find its tab (herdr_agent get, engine core) and rename it (herdr_tab rename, engine core).
Record the terminal id in COMMITMENTS.md. Steer a running session with `herdr_agent prompt`; watch with
`herdr_agent watch` piped into Monitor, re-armed whenever it expires. Kill only terminals you started.

## Briefs

docs/m2/briefs/<job>.md = docs/m2/BRIEF-BASE.md + the job: goal in the CEO's words, files the session owns
(disjoint from every other running session), done-when (from PLAN.md), tests to add, where to report
(docs/m2/reports/<job>.md). Workers write their report there and stop.

## Checking people's work (every job, no exceptions)

1. The builder reports: what changed, tests added, what it did NOT verify, risks.
2. The manager starts a SEPARATE verifier session. Its brief: the job's goal and done-when, `git diff` of the job,
   and only the builder's not-verified list and risks, never its claims. The verifier tries to break it: runs
   `bun test`, writes extra tests in a scratch dir, reads the diff against PROTOCOL.md. Report: PASS or FAIL with
   HIGH/MEDIUM/LOW findings in docs/m2/reports/<job>v.md.
3. A HIGH sends the job back to a builder (a fresh one if the old one is past 60%).
4. The manager re-runs `bun test` itself before committing. Say FIXED only when checked; say where.
5. The proxy audits each finished phase (reads the reports, re-runs the gates) before it pushes.

## Recycling (context efficiency)

A session hands off when **its context reaches ~60%**, or when it **resumes after more than an hour idle** (the
prompt cache is cold, so continuing costs as much as a fresh start): write docs/m2/handoff/<role-or-job>.md
(state, what's next, open threads, terminal ids it owns), commit it by path, start its successor with the same
labels and brief line "Read docs/m2/handoff/<…>.md and continue as <role>.", rename its own tab
`retired <role>`, and stop. Parents check too: the pane footer shows context use (e.g. `Opus 5.5 · medium · 9%`;
read it with `herdr_agent read lines:5`), and a parent tells a child past 60% to hand off. Keep sessions short-lived: one job per worker.

## Commits and pushes

- Commit by path only, never `git commit -a` (other sessions' files are in the tree). Message style: see git log.
  End messages with the attribution line in git log's recent commits.
- One commit per finished, verified job; the proxy pushes to origin (private repo) after its phase audit.
- Never: make anything public, register names/domains/packages, publish to npm, edit herdr-draw or
  packages/core, put secrets in the repo or in chat.

## Keep the train moving (CEO, 2026-11-11: "you need to keep the train moving...choo choo")

- **The CEO is never a gate.** Spec reviews and mock approvals are shown to the CEO but nobody waits for them:
  once a job passes verification, the next phase starts. CEO feedback arrives as change requests, handled like
  any other job.
- **Always have the next job running.** When a job is committed, its manager starts the next one the same turn.
  Run every job whose files and dependencies allow it in parallel (PLAN.md ownership); nobody sits idle.
- **Only these wait for the CEO:** credentials (the Google OAuth client), spending money, anything public. Work
  around them (dev tokens, stubs) and keep going.

## Unsticking and escalating

- A blocked session is its parent's job, not the CEO's: read its screen within a minute. Approve a permission
  prompt that stays inside its brief (`herdr_agent send_keys keys:["1"] engine:"core"`); refuse anything outside
  it (press 2) and steer it to a safe route.
- Only the CEO's decisions go to the CEO (product calls, spending, credentials, anything public). The proxy sets
  a timer (`herdr-app do time.timer-<n>m`) and puts the ask as the last line of its own pane. Everything
  reversible: decide, log it under Decisions in COMMITMENTS.md, keep going.
- Reports to the CEO: skimmable, outcome first, plain words, tables.
