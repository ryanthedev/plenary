# Brief: p5-hexv (verify p5-hex)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-hexv.md, PASS or FAIL with HIGH/MEDIUM/LOW. Change nothing in the tree; scratch work in your
scratchpad. Never pkill/killall; kill only PIDs you recorded.

## Job under check

Goal (CEO): "make sure we are doing hexagonal application architecture and use the systems design skill". Rule
(docs/m2/OFFICE.md "Architecture"): core depends only on ports; adapters never import each other; only composition
roots (server/main.js) wire adapters; every adapter passes its port's contract test. Proxy's mapping: Auth, Registry
and the IdP are ports; oidc.js and the fake IdP are adapters; http.js is a driving adapter.
Brief: docs/m2/briefs/p5-hex.md. Diff: `git diff -- server/auth server/admin server/registry/sqlite.js test/auth`
plus the new untracked files (`git status --short server/auth test/auth`), and the two import lines at
server/registry/postgres.js:20 and :38 (that file is engine-untracked; only those lines are this job's).

Builder's not-verified list and risks (not its claims): the Registry "infrastructure failure must reject, never
null" rule is not tested by the contract (a memory adapter can't show it); sqlite.js:32 JSDoc type still references
the memory adapter, excused by a KNOWN list in the test; read the rest of its "Not verified"/"Risks" sections in
docs/m2/reports/p5-hex.md yourself.

## Check

- Behaviour unchanged: runtime exports identical (`mint`, `RegistryError` same objects), main.js and test/server
  untouched, full `bun test` passes (if a full run fails, name the failing tests: `bun test 2>&1 | grep -E '\(fail\)'`).
- The import-rule test: does it really catch violations (try new ones in a scratch copy: dynamic import, re-export,
  a path with `..`, a JSDoc type, a core file reaching an adapter through a port file that re-exports it)? Is the
  file classification right? Is the KNOWN list as narrow as it claims?
- Contract tests: can a broken adapter pass them? Are they the port's semantics or one adapter's quirks?
- Run the `distributed-systems-design` skill in CHECKER mode on the ports (if not listed, read
  /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and `references/`); report what it found.
- sdd ensemble review of the diff (codex + agy + any harness passing check_adapter). Two agreeing = HIGH candidate;
  confirm or refute. Then stop.
