# Brief: p6-ports (web/ ports, storage and clock adapters, contract tests) — first half of p6-hex, on main now

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** (hexagonal) and the **systems design skill**. Read
docs/m2/OFFICE.md ("Architecture"), CLAUDE.md, docs/m2/briefs/p6-hex.md (the whole plan; you do only its first half).

- **Your tab:** `worker p6-ports (client): web ports + contract tests`. Manager: `manager client` (t14k).
- **Where:** main, /Users/r/repos/plenary. Don't commit; your manager commits.
- **You own only NEW files:** `web/ports/**`, `web/adapters/storage/**`, `web/adapters/clock/**`,
  `test/web/contracts/**`, `test/web/adapters/**`, your report docs/m2/reports/p6-ports.md.
- **Never touch** (engine's p2-land branch changes them and merges soon): web/sync.js, web/app.js, web/index.html,
  web/ui/**, web/collab/**, web/paint.js, web/dev.*, any existing test/web file. Read them for what the ports must
  cover; the p2-land versions are in /Users/r/repos/plenary-p2 (read only; its transport contract is at the top of its
  web/sync.js).
- **Design first (required):** apply the `distributed-systems-design` skill in **APPLIER** mode (if it isn't in your
  skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and its
  references/). Put it as the first section of your report: each port's contract and failure behaviour.

## Build

1. **Ports** (JSDoc typedefs + one-paragraph contract each), web/ports/:
   - `transport.js`: exactly the p2-land contract (send, onMessage, reopen required, close final, onDrop; a
     generation per connection; no old-connection delivery after reopen).
   - `storage.js`: get/set/remove of strings by key; may be unavailable (private mode, quota): a defined failure value
     or throw, never a silent wrong answer.
   - `clock.js`: now(), set(fn, ms) → handle, clear(handle), random().
   - `auth.js`: `exchange(code) → Promise<{ token, user, name, email, domain, exp } | { error }>` for platform's
     sign-in code exchange. The exact shape is in docs/m2/contracts/auth-exchange.md (errors `invalid-code`,
     `bad-origin`, `unavailable`, plus a network failure value of your choosing). The fake adapter covers each.
2. **Contract tests**, test/web/contracts/, mirroring test/auth/registry-contract.js: `transportContract(name,
   makeAdapter)`, `storageContract`, `clockContract`, `authContract`; each registers describe/test blocks against a
   fresh adapter per test; a real-service adapter skips with `describe.skipIf` when its env is unset.
3. **Adapters** that pass them: `web/adapters/storage/{memory,session,local}.js` (session/local wrap
   `globalThis.sessionStorage`/`localStorage` behind try/catch; under bun test, exercise them with a fake Storage),
   `web/adapters/clock/{browser,virtual}.js` (virtual: deterministic, advance(ms), seeded random).
   `web/adapters/auth/fake.js` passes `authContract`.
4. **Transport contract self-test:** run `transportContract` against a tiny reference transport in test/web/contracts
   (not an app adapter) so the contract itself is tested; p6-hex later runs it against shared-worker and local.
5. Each contract is mutation-checked: break an adapter rule, a contract test fails.

No adapter imports another adapter; ports import nothing from web/.

## Done when

`bun test` passes (all of it). Report: design section (APPLIER), files, tests, mutation check, NOT verified, risks,
and the list p6-hex must do to move existing code onto these ports. Processes: never pkill/killall, PIDs only,
port 0. sdd helpers allowed; you own every line.
