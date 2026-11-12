# Plenary M2 office manual (every session on the team reads this first)

The team builds docs/m2/PLAN.md. Sessions are Claude Code sessions in Herdr app tabs, started with `hc run`.
**No Workflow tool, no dynamic workflows** (CEO, 2026-11-11: "use herdr app panes and hc"). In-process Agent
subagents are fine only for quick read-only lookups inside one session.

## Who is who

| Role | Tab label | Does |
|---|---|---|
| CEO | (the user) | Goals and decisions. Talks to the proxy. |
| Owner | `owner (audits)` | Started the team. Audits the proxy's commits on request. Mostly idle. |
| Proxy | `★ proxy · <id> (talk here)`, `role=orchestrator` | The CEO's contact. Runs the managers, owns COMMITMENTS.md, audits every phase before it's pushed, asks the CEO only for decisions that are theirs. |
| Manager | `manager <track> · <id>` | Runs one track (PLAN.md). Writes briefs, starts builders and verifiers, unsticks them, re-runs tests, commits by path, reports to the proxy. |
| Builder | `worker <job> (<track>) · <id>: <what>` | Builds one job from its brief. |
| Verifier | `verifier <job>v (<track>) · <id>: <what>` | Checks one job adversarially. Never the builder. |

Tabs are never left as a bare number. When a session finishes its turn, rename its tab `done <job>` or
`retired <role>` until its parent cleans it up (below). Labels: every session gets `--label herdr.space=sp21a427967d02459948b4c10156ff82ae` (the
plenary space), `--label plenary=<role-or-job>` and `--label plenary.reports-to=<parent terminal id>` (owner
2026-11-11: make the hierarchy visible; managers report to the proxy, workers and verifiers to their manager); only the proxy gets `role=orchestrator` (see
~/repos/herdr-stage/ROLES.md).

## Starting a session

```
hc run --bg --no-parent --cwd /Users/r/repos/plenary --name <name> \
  --label herdr.space=sp21a427967d02459948b4c10156ff82ae --label plenary=<job> \
  --label plenary.reports-to=<your terminal id> \
  -- zsh -lic 'exec "$@"' zsh claude -n <name> --model opus --permission-mode auto --settings /Users/r/.config/claude/settings.shared.json --plugin-dir /Users/r/repos/engram \
  --plugin-dir /Users/r/repos/herderp --plugin-dir /Users/r/repos/sdd \
  --plugin-dir /Users/r/repos/systems-design.skill "Read <brief path> and do it."
```

`--model opus --permission-mode auto` are required: under the login shell a session came up as Fable 5.2 in manual
mode and blocked on its first prompt (t15y, 2026-11-11). The `zsh -lic` wrapper gives the session your shell profile's environment (ENGRAM_ADDR/ENGRAM_TOKEN), so Engram
works; without it Engram fails with "name resolver error". **Names** (CEO via owner, 2026-11-11; ~/repos/herdr-office/docs/briefs/names.md): every session gets a proper name
(a-z, 0-9 and `-` only, 32 characters at most): builder `plenary-<job>`, verifier `plenary-<job>v`, manager
`plenary-manager-<track>`, the same in `hc run --name` and `claude -n`. Its tab label carries the terminal id (`<id>`)
as in the table above. Then right away: find its tab (herdr_agent get, engine core) and rename it (herdr_tab rename, engine core).
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

## sdd helpers (CEO, 2026-11-11: "and we have things like sdd. etc to help")

Herdr tabs stay the unit of ownership; the sdd MCP tools (every session has the sdd plugin) are helpers. Load the
`sdd:subagent-driven-development` skill before the first sdd call.

1. **Verifiers** also run an sdd ensemble review of the job's diff (codex + agy + every other harness that passes
   `check_adapter`). A finding two harnesses agree on is a HIGH candidate; the verifier confirms or refutes it
   and says which in its report.
2. **Builders** may hand scoped, file-disjoint sub-tasks (tests, fixtures, boilerplate adapters) to sdd harnesses
   in git worktrees, then own and review the diff before it lands. The builder answers for every line.
3. **Mock assets:** agy or codex image generation where it helps the design mock.
4. **Before a big fan-out**, check `usage` and quota.

## Architecture (CEO, 2026-11-11: "make sure we are doing hexagonal application architecture and use the systems design skill")

- **Hexagonal (ports and adapters), everywhere.** The core (packages/protocol: Room, Replica, codec; the server's
  room host and gateway logic; web/'s sync and UI state) depends only on ports, never on an adapter or a framework.
  - **Driven ports:** Store, Registry, Bus, Blobs, Auth, Clock, Transport, Log. Adapters sit in their own folder
    (`server/store/sqlite.js`, `server/bus/nats.js`, `web/transport/ws.js`, ...).
  - **Driving adapters:** HTTP, WebSocket and the browser's DOM call into the core through its public API.
  - **Composition roots:** `server/main.js` and the web entry are the only files that pick adapters and wire them.
  - **Dependency rule:** an adapter never imports another adapter, and the core never imports an adapter. Every
    port has a contract test that every adapter of it passes (like `registryContract`). A boundary test
    (`test/architecture.test.js`, engine owns it; client adds web/ rules) fails the build on a wrong import.
- **Systems design skill:** every design-bearing brief (new component, port, scaling or failure behaviour) tells the
  builder to apply the `distributed-systems-design` skill (APPLIER mode) before writing code. Every verifier of such
  a job runs it in CHECKER mode against the design and reports what it found. The skill lives at
  `/Users/r/repos/systems-design.skill` (pass `--plugin-dir` for it in the start command); if it doesn't show in the
  skill list, read `skills/distributed-systems-design/SKILL.md` and its `references/` directly.

## Recycling (context efficiency)

A session hands off when **its context reaches ~60%**, or when it **resumes after more than an hour idle** (the
prompt cache is cold, so continuing costs as much as a fresh start): write docs/m2/handoff/<role-or-job>.md
(state, what's next, open threads, terminal ids it owns), commit it by path, start its successor with the same
labels and brief line "Read docs/m2/handoff/<…>.md and continue as <role>.", rename its own tab
`retired <role>`, and stop. Parents check too: the pane footer shows context use (e.g. `Opus 5.5 · medium · 9%`;
read it with `herdr_agent read lines:5`), and a parent tells a child past 60% to hand off. Keep sessions short-lived: one job per worker.

## Cleaning up sessions (CEO, 2026-11-11: "make sure old agent sessions are being cleaned up")

- When a worker's or verifier's job is committed, or a session is retired after its hand-off is committed, its
  **parent** closes that session's tab (`herdr_tab close`, engine core), ends its terminal (`hc kill <id>`, then
  `hc rm <id>`), and removes it from its roster (reports/manager-<track>.md; COMMITMENTS.md for managers).
- Also kill any test servers, scratch terminals or background processes the job started.
- Only terminals the team started, by id. Never kill by name or pattern; never touch another space's terminals.
- **Never kill by pattern** (`pkill`, `killall`, `pkill -f`): a `Bash(pkill *)` ask rule blocks the session on a
  prompt nobody else may answer, and two sessions' processes look alike (2026-11-11: t14r and t14v both ran headless
  Chrome on port 9333). Start browsers and servers from a script that records the PID, then kill that PID only.
  Pick a free port per session (port 0, or read the actual port back), never a hard-coded one.
- Keep no `done` or `retired` tabs around once their work is committed. A verifier whose job came back FAIL may
  be closed once its report is committed; the builder stays only if it is reused for the fix round.

## Don't steal the CEO's focus (CEO, 2026-11-11)

Never create a Herdr space for tests or helpers: creating a space switches the CEO's window to it. Run every
session and test terminal as a tab in the plenary space (`hc run --bg --label herdr.space=<plenary space id>`),
which never switches the window.

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

## The proxy's input is the CEO's (CEO, 2026-11-12: "this input is my space. that's why it says talk here")

- **Nobody types into the proxy's session:** no `herdr_agent prompt`, `hc send`, `hc keys` or SendMessage to the
  proxy. Only the CEO writes there.
- **The owner talks to the proxy through tools too** (CEO, 2026-11-12): it ends its turn with one short message
  (CEO rules it relays: commit them to OFFICE.md first, then say so) and the proxy's watch, which includes the owner,
  delivers it.
- **Managers report through tools:** end the turn with one short message (outcome first, report path) and keep
  docs/m2/reports/manager-<track>.md current. The proxy's `herdr_agent watch` delivers the last message; the
  proxy reads the report. Something urgent: say so in the first words of that last message.
- The proxy still steers managers with `herdr_agent prompt` (their input isn't the CEO's).

## Unsticking and escalating

- A blocked session is its parent's job, not the CEO's: read its screen within a minute. Approve a permission
  prompt that stays inside its brief (`herdr_agent send_keys keys:["1"] engine:"core"`); refuse anything outside
  it (press 2) and steer it to a safe route.
- Only the CEO's decisions go to the CEO (product calls, spending, credentials, anything public). The proxy sets
  a timer (`herdr-app do "time.timer-<n>m @$HC_TERMINAL_ID <the ask>"`; the bare form is refused) and puts the ask as the last line of its own pane. Everything
  reversible: decide, log it under Decisions in COMMITMENTS.md, keep going.
- Reports to the CEO contain **only actions the CEO must take** (CEO, 2026-11-11: "i only really want you to let me
  know now what I need to do. and that's it."): credentials, spending, anything public, or a link to look at. No
  status updates, no FYIs. If nothing needs the CEO, say nothing. When there is an ask: skimmable, plain words.
