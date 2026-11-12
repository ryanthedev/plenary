# Brief: p7-audit (architecture audit of web/: hexagonal + systems design vs the NFRs)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode
(if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and
its references/). Read docs/m2/OFFICE.md ("Architecture", "Checking people's work", "sdd helpers"), CLAUDE.md (NFRs,
decisions), PROTOCOL.md (v1.1: § Presence, § Records, § Pacing), docs/m2/reports/p6-hex.md (web/'s design and file
map), docs/m2/reports/p7-wire.md and p7-wirev.md, then all of web/ and test/web/, plus test/arch-scan.js and
server/static.js (read only where web/ depends on them).

- **Your tab:** `worker p7-audit (client) · <your id>: web/ architecture audit`. Name `plenary-p7-audit`. Manager:
  `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **Where:** a clean, read-only snapshot of main, so other sessions' in-flight edits don't mislead you:
  `git -C /Users/r/repos/plenary worktree add --detach <your scratchpad>/audit 001813a` (remove it at the end with
  `git worktree remove --force`). Change nothing in /Users/r/repos/plenary except your report.
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p7-audit.md. Then hc t14k one line, stop, idle.
- **Coming next (don't report what it will change):** p7-tab adds an optional per-tab `tab` id to hello (engine
  decision: viewers counted per (user, tab), writer cap 8 tabs per (user, board) per gateway). It touches only the
  hello/session code in web/core/; note anything there that would make that change awkward, nothing more.

## Goal (CEO: "make sure we are doing hexagonal application architecture and use the systems design skill")

1. **Hexagonal review** beyond what test/web/architecture.test.js checks statically: does web/core/ depend only on
   port *behaviour* (web/ports/), or does it lean on one adapter's quirks (DOM timing, `requestAnimationFrame`,
   WebSocket event order, the fake collab adapter's synchronous delivery)? Is every port's contract written down and
   tested by a shared contract test that every adapter passes (transport, collab, storage, clock/timers, auth/session,
   DOM-facing ports)? Are ports missing (e.g. core reading `Date.now()`, `setTimeout`, `Math.random`, `location`,
   `localStorage`, `crypto` directly)? Are main.js and dev-main.js the only places that pick adapters? Does main.js's
   import graph stay free of dev modules, and is every production file reachable from it (server/static.js serves
   only that graph)? Does architecture.test.js really bite: write throwaway mutants in your worktree (a core file
   importing an adapter, a dev module imported by main.js) and confirm it fails. Name each gap with file:line.
2. **distributed-systems-design skill, CHECKER mode,** for the client side of CLAUDE.md's NFRs:
   - 60–120 fps with a busy board: per-frame work (presence layout, pins, records rebuild, paint), allocations,
     what is O(all elements) or O(all records) per op or per frame;
   - viewers < 1 s, editors < 150 ms: client-side latency added between socket and paint;
   - 100k joins in 2 min: what one client does on join (snapshot size, decode, first paint), reconnect backoff and
     jitter (no thundering herd after a gateway restart), the writer cap and § Pacing;
   - failure modes: drop and resume mid-op, refused op + resync, slow socket (backlog gate ~16 KB), role change,
     token expiry, a gateway that never answers;
   - estimate with numbers from the code (bytes per presence frame, frames/s per user, memory per 1k records).
3. **Next-milestone readiness:** what M3 (smoothing) and M5 (mobile) need from today's web/; propose the job split.

## Output

- Findings as a table: id, severity (HIGH = violates an NFR or the hexagonal rule in a way that will bite in M2;
  MEDIUM = will bite by M4 or makes a port unswappable; LOW), file:line, what, proposed fix, which job should own it.
  Group them into proposed fix jobs with file ownership that doesn't collide (and doesn't collide with p7-tab).
- The skill's CHECKER output (its steps, briefly).
- An sdd ensemble second opinion on your findings (single harness unless more pass check_adapter): confirm or refute
  each finding and mark which were confirmed.
- What you did NOT check.

Processes: never pkill/killall; PIDs only; port 0. Stop.
