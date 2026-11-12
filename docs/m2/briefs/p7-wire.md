# Brief: p7-wire — make the sync layer provide the collab port; mount the collab UI in both roots

Base: docs/m2/BRIEF-BASE.md (incl. Architecture and the systems design skill: APPLIER before coding). Runs on main after the p2-land merge; your manager commits; never touch packages/protocol, server/, test/*.js.

Inputs: the port doc (web/ports/collab.js), p7-collab.md "Risks and notes for p7-wire",
p7-collabv.md (MEDIUM M1–M4, LOW, Design check), engine's additive Replica API `previewEntries(stream)` and
`pendingOf(stream)` (ping from engine with the p2-land commit), and the v1.1 delta (welcome.room, `stale-setting`
soft refusal, writer-connection cap `limit` close shown to the user, not retried in a loop).

Must close: p7-collabv M1 (every port gap: presence in/out, here, emotes, records + pending overlay, noteAuthor,
role during resync), M2 (a test for role change mid-session), M3 (+N on phones), M4 (coalesce records changes; no
O(all records) per entry), and decide which of the two per-tab connections carries presence and records (one only;
`me.client` = that one; merged status). The sync-side implementation is a second adapter of the collab port and must
pass the same contract tests as the fake port.

Also (engine, v1.1 code 5d55112 on p2-land): `replica.previewEntries(stream)` and `replica.pendingOf(stream)` exist.
Engine's verifier LOW for the client: `refusedSettings` / `retryReady` (the soft `stale-setting` refusal path) need a
consumer in web/: show the dropped setting, and offer or perform the retry when `retryReady` says so.

## From engine (t18m, 2026-11-12)

- **`here` may come without a list** (p2-tune round 2; spec in PROTOCOL.md § Presence): the writer list comes only on a
  writer change or to a joiner; a viewer-count change sends a count-only `here`. Keep the last writer list and update only
  the count; test that a count-only `here` never clears avatars. Exact shape (t18m): `{t:'here', writerCount, viewers}` with
  **no `writers` field**. Today web/core/collab/presence-model.js:73 swaps in `[]` when `writers` is absent: fix it to keep
  the last list (and `writerBy`) and update only `writerCount`/`viewers`.
- **Static serving (ea978ac):** server/static.js serves only web/main.js's import graph plus index.html and style.css. A new
  production web file must be reachable by import from main.js, or it 404s.

## State at start (manager, 2026-11-12)

- main at 06bf267 (p6-hex: web/ is hexagonal; docs/m2/reports/p6-hex.md has the design and file map). Collab pieces:
  port web/ports/collab.js; models web/core/collab/; renderers web/adapters/dom/collab/; fake web/adapters/collab/fake.js;
  dev page web/collab/dev.{html,js}. **No collab contract test exists yet:** write test/web/contracts/collab-contract.js
  (`collabContract(name, makeAdapter)`, the transportContract shape) and run it against the fake and your sync-side adapter.
- **Neither root mounts collab today.** Wire it in web/main.js (production: ws.js, `/ws`) and web/dev-main.js (dev rooms).
  The production graph must stay free of dev modules (test/web/architecture.test.js) and every new file must be reachable
  from main.js to be served (server/static.js).
- **Presence gate (from p6-hex):** presence and transient ops go out only when `backlogBytes()` ≤ ~16 KB; `congested()` is
  for the status pill, which you now wire.
- Name `plenary-p7-wire`; tab `worker p7-wire (client) · <id>: collab over sync`. Manager `manager client` (t14k); report to
  it only. You own web/**, test/web/**, docs/m2/reports/p7-wire.md. Don't commit.

## Done when

- `bun test test/web` passes and the full suite has no new failures (test/core-source.test.js fails on main today: not yours).
- Every Must-close item has a test; each new rule fails under a mutation (list them in the report).
- Headless Chrome: the dev page (web/dev-main.html) with three tabs (presenter, annotator, viewer) shows cursors, avatars,
  selections, laser, emotes, reactions, comment threads and the status pill across tabs; the production page boots through
  the server rig (test/server/rig.js, port 0) with no 404 and collab over `/ws`.
- Report: design section (APPLIER), files, tests, mutations, NOT verified, risks. Processes: never pkill/killall; PIDs only; port 0.
