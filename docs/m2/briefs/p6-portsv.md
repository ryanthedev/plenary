# Brief: p6-portsv (verify web/ ports, adapters and contract tests)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** (you run it in
**CHECKER** mode on the port design; if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/
distributed-systems-design/SKILL.md and its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd
helpers", "Architecture"), CLAUDE.md. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-portsv (client): web ports + contract tests`. Manager: `manager client` (t14k).
- **Where:** main, /Users/r/repos/plenary. Read only. You own docs/m2/reports/p6-portsv.md and your scratchpad.

## The job you check

Builder brief: docs/m2/briefs/p6-ports.md. The work: the untracked `web/ports/**`, `web/adapters/**`,
`test/web/contracts/**`, `test/web/adapters/**` (`git status --short web test/web`). The sign-in shape:
docs/m2/contracts/auth-exchange.md. The transport contract it encodes is p2-land's (top of
/Users/r/repos/plenary-p2/web/sync.js, read only).

## What to check

1. `bun test` passes. No file outside the job's paths changed by it.
2. **Contracts bite:** for each contract (transport, storage, clock, auth), break the adapter or reference transport
   one rule at a time in a scratch copy (old-connection delivery after reopen, onDrop for an old connection, close
   not final, storage silently wrong when unavailable, clock not deterministic, auth error collapsed) and see a
   contract test fail. Run transportContract against p2-land's real `localRoom` (read-only import from
   /Users/r/repos/plenary-p2/web/sync.js) and mutate its generation check (`link.gen === gen`) in a scratch copy:
   the contract must catch it (the builder couldn't run that mutation).
3. **Hexagonal:** ports import nothing from web/; adapters import only ports (and core, if any), never each other;
   no browser globals in ports. The contract test modules follow test/auth/registry-contract.js's shape.
4. **CHECKER on the design:** does each port cover what p2-land's web/ needs (read web/sync.js, web/ui/*.js,
   web/collab/*.js there: storage keys, timers, random, transport events)? The builder flagged: bindEditor's typedef
   has `close?` optional while the port requires it; web/collab/ui.js uses a clock `{ now, setTimer, clearTimer }`
   vs the port's `{ now, set, clear, random }`; in-flight answers after an unasked drop are not pinned; the network
   failure value for auth is its own choice. Judge each and say what p6-hex must change.
5. **Storage security:** the session/local adapters never log values; a token stored through them is not readable
   via another key; quota and unavailable storage are reported, not swallowed.

Builder's NOT verified: no real browser (Chrome storage, private mode, real QuotaExceededError); sharedNet not run
against the contract; the auth HTTP adapter doesn't exist yet (p6-hex).

## sdd, processes

Single harness (codex only): load `sdd:subagent-driven-development`, check `usage`, run codex on the new files in a
scratch git copy, write "single harness", confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p6-portsv.md: **PASS or FAIL** first line, then HIGH / MEDIUM / LOW with file:line, a "Design check
(CHECKER)" section, and what you did NOT check. HIGH = a contract that doesn't catch its rule being broken, an
adapter importing another adapter, a port that can't express what web/ needs, or storage leaking a value. Then stop.
