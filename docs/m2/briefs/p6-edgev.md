# Brief: p6-edgev (verify web/ edge adapters and the sign-in core)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode on
the design (if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/
SKILL.md and its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"),
CLAUDE.md, PROTOCOL.md v1. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-edgev (client) · <id>: edge adapters + sign-in`. Name `plenary-p6-edgev`. Manager:
  `manager client` (t14k). Report to your manager only (never message the proxy).
- **Where:** main, /Users/r/repos/plenary. Read only. You own docs/m2/reports/p6-edgev.md and your scratchpad.

## The job you check

Builder brief: docs/m2/briefs/p6-edge.md. The work: `git status --short web test/web` (new web/adapters/auth/http.js,
web/adapters/transport/ws.js, web/core/signin.js, test/web/adapters/{auth-http,transport-ws}.test.js, test/web/core/,
and the modified test/web/contracts/auth-contract.js: `git diff`). Shapes: docs/m2/contracts/auth-exchange.md (platform's
p5-code is on main, 3f6b489: server/auth/http.js, read only); web/ports/*.js.

## What to check

1. `bun test` passes. Every new adapter runs its port's contract. Mutation check in a scratch copy: old-socket delivery
   after reopen, token in the URL or a header, error codes collapsed, `exp` in ms, sign-in token in local storage,
   a retry on `invalid-code`, no jitter on the retry, fragment not cleared first: each must fail a test.
2. **authContract change:** R2-M1 (failure tests no longer pass silently without a forcing hook) and R2-L2 (`exp` in
   seconds) are really closed; no existing contract assertion weakened (`git diff test/web/contracts/auth-contract.js`).
3. **Security:** the code and token are never logged, never in a URL, never in localStorage; hostile fragments
   (huge, two `code=`, percent-encoded, script, odd characters) are rejected before any request; the identity is
   display-only (`name`/`email` may be null).
4. **ws adapter vs the real gateway:** if cheap, drive web/adapters/transport/ws.js against platform+engine's real
   server on main (server/main.js, port 0, dev token) through hello → welcome; at least check the frames the adapter
   writes are what server/gateway.js expects (codec, one hello, token only in hello).
5. **Hexagonal:** web/core/signin.js uses ports only (no globals, no fetch, no Date.now/Math.random); adapters import
   only ports and the codec (ws.js), never each other.
6. **CHECKER:** sign-in at 100k joins in 2 min (the NFR): retry jitter, timeouts, no thundering herd; ws reconnect
   behaviour; backpressure (builder: no `bufferedAmount` watermark).

Builder's NOT verified: no real browser (close/error ordering, binaryType), browser fetch cookie/Origin simulated,
not against the real gateway, replaceState wiring is p6-hex's. Its risks: no backpressure, fragment parsing accepts only
unescaped values (`bad-fragment` if the server ever percent-encodes), AbortController absent → request not cancelled.

## sdd, processes

Single harness unless more pass `check_adapter` (load `sdd:subagent-driven-development`, check `usage`, run in a scratch
git copy), confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p6-edgev.md: **PASS or FAIL** first line, HIGH / MEDIUM / LOW with file:line, a "Design check (CHECKER)"
section, what you did NOT check. HIGH = a token or code leak, an old connection's message delivered after reopen, a
weakened contract, a retry on a non-retryable error, a core file using globals, or an adapter importing another. Stop.
