# Brief: p7-wire (DRAFT) — make bindEditor provide the collab port; mount web/collab. Starts after p6-hex passes.

Base: docs/m2/BRIEF-BASE.md (incl. Architecture and the systems design skill: APPLIER before coding). Runs on main after the p2-land merge; your manager commits; never touch packages/protocol, server/, test/*.js.

Inputs: the port doc (web/collab/port.js, or where p6-hex moved it), p7-collab.md "Risks and notes for p7-wire",
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
