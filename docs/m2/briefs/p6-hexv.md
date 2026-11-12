# Brief: p6-hexv (verify web/ in hexagonal shape)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Architecture"), CLAUDE.md,
PROTOCOL.md. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-hexv (client) · <id>: web ports and adapters`. Name `plenary-p6-hexv`. Manager:
  `manager client` (t14k). Report to your manager only (never message the proxy).
- **Where:** main. Read only. You own docs/m2/reports/p6-hexv.md and your scratchpad.

## The job you check

Builder brief: docs/m2/briefs/p6-hex.md (all of it, including the carried findings and manager decisions at the end).
The work: everything under web/ and test/web/ that differs from HEAD (`git status --short web test/web`, `git diff`;
the builder's §8 lists adds, modifies and deletes). **Goal: no behaviour change**, web/ in core / ports / adapters /
composition roots. Other dirty files in the tree (server/, PROTOCOL.md, deploy/, test/server/static.test.js …) belong
to other tracks' jobs in progress: ignore them; run `bun test test/web` plus the full suite and say which failures are
outside web/.

## Check

1. **No behaviour change:** test/web passes; no test/web assertion was weakened or deleted without a stated reason
   (compare the deleted test/web/ui-token.test.js and modified tests against HEAD). Headless Chrome: web/index.html with
   three tabs on the in-browser room (presenter, annotator, viewer), web/dev.html and the collab dev page behave as
   before (draw with every tool, converge, refused op + resync, drop mid-typing keeps the draft).
2. **Boundaries:** test/web/architecture.test.js runs against engine's test/arch-scan.js (44dd1aa) for real, every rule
   fails under a mutation (core importing an adapter or a browser global, adapter importing another adapter, a non-root
   importing an adapter); the allowlist is explicit, commented and shrink-only. Grep web/core for window, document,
   location, history, localStorage, sessionStorage, fetch, WebSocket, Worker, setTimeout, Date.now, Math.random.
3. **Manager decisions applied:** presence (and v0 transient previews) sent only at backlog ≤ ~16 KB via
   `backlogBytes()`; `congested()` only for the pill; localRoom and sharedNet implement the full transport port and pass
   `transportContract` in-repo; sign-in via web/core/signin.js and the HTTP adapter (docs/m2/contracts/auth-exchange.md),
   fragment cleared first; token never in localStorage, a URL or a log.
4. **Production root vs dev:** web/main.js imports web/core/dev-users.js (the dev `?as=` table). The server will serve
   main.js's whole import graph (engine's p-serve). Judge: should the production root import dev pieces at all, or should
   the dev path be its own root (or opt-in)? Rate it.
5. **CHECKER:** the design section of docs/m2/reports/p6-hex.md: ports complete for what web/ needs, failure behaviour,
   the two-transports-per-tab bottleneck, the blank page while the exchange runs (up to ~22 s).

Builder's NOT verified: real Google sign-in end to end; congested() unused by the pill; no collab contract (p7-wire);
ws.js not wired in a page; Safari/Firefox/mobile. Risks: Replica still on wall `now`; two transports per tab; blank page
during exchange; stale paths in README.md (not client's).

## sdd, processes

Single harness unless more pass check_adapter; confirm or refute each finding. Never pkill/killall; PIDs only; port 0.

## Report

docs/m2/reports/p6-hexv.md: **PASS or FAIL** first line; HIGH / MEDIUM / LOW with file:line; "Design check (CHECKER)";
what you did NOT check. HIGH = a behaviour change, a weakened or deleted test without reason, a boundary rule that
doesn't bite, core using a browser global, a token leak, or a manager decision not applied. Stop.
