# Plenary

A live infinite canvas for enterprise all-hands: a few presenters draw, thousands annotate and react,
100k+ watch live, in several regions, smooth as butter. Open source. Grown out of herdr-draw
(github.com/ryanthedev/herdr-draw), whose core it shares.

Name: **Plenary** (decided 2026-11-11). The person may add "Omni" (their LLC); `omniplenary` was free on
GitHub, npm and .com on 2026-11-11. The name lives only here and in package.json until it is settled:
nothing is registered or published yet. Do not create GitHub repos, orgs, npm packages or domains unasked.

## Decisions (2026-11-11, from the design conversation and the design doc)

- End goal = non-functional requirements, not the first build. Iterate milestone by milestone and adopt
  infrastructure only when a measurement says so. Design doc: https://claude.ai/artifact/UGGaj27ZqojZmVSDUqz8Mu
- NFRs: per board a handful of editors, ~2k annotators, **100k live viewers (today's ceiling, confirmed)**;
  editors < 150 ms in the home region, viewers < 1 s worldwide; 60–120 fps client; 100k joins in 2 min;
  an acknowledged op is never lost; multi-region with a home region per tenant; enterprise SSO/SCIM/audit.
- Our own real-time tier (rooms, a bus, gateways). No Teams/Zoom/Slack integration. No managed real-time
  service required (self-hosted SignalR or similar may sit behind the transport port).
- Self-hosting means open source, not a one-process product.
- The server never runs layout; clients do (as herdr-draw does).

## Decisions (2026-11-11, M2 scope, from the person)

- **M2 is a scale-ready product**, replacing "adopt infrastructure only when measured" for M2: one program,
  two roles (gateways hold sockets and fan out; room hosts sequence one board each, sharded by board, with a
  lease and takeover). One process on one machine; many behind a load balancer.
- **Eventually consistent is fine** for delivery; still one sequencer per board, and an acknowledged op is
  never lost. Presence (cursors, laser, emotes) is never saved and may drop.
- **Swappable adapters:** single-node = SQLite (`synchronous=FULL`), in-memory bus, local disk; cluster =
  **Postgres + NATS**, S3-compatible blobs. Logs go to the terminal (structured).
- **Sign-in:** dev tokens, then Google (OIDC) with the OAuth client in the maintainer's Google Cloud
  project; client id/secret from env only. **Tenant = Google Workspace domain; anyone else by invite or
  share link.** Boards are created by an admin endpoint (`POST /boards`), never by a hello.
- **Full canvas UI** over core's Editor (design mock approved before building) and **full collaboration**:
  annotations, cursors, avatars, selections, laser, draw, highlighter, emotes, reactions, comment threads,
  a connection status pill.
- **drawh** gets the protocol by byte-identical copy + SOURCE.json for now; maybe a published package later
  (nothing published until the person says so).

## Milestones

M0 herdr-draw today · M1 core package + protocol v0 (done) · **M2 scale-ready product: server (single
node and cluster), Google sign-in, multi-tenant, full canvas + collaboration, ~10k-client load test** ·
M3 smoothing · M4 load test to 100k and tuning · M5 mobile · M6 enterprise (SCIM, audit) ·
M7 multi-region · M8 hardening. Each milestone's gate becomes a CI check.

## Shape

```
packages/core/       herdr-draw's core/, copied byte-identical (SOURCE.json: commit + sha256 per file)
packages/protocol/   PROTOCOL.md v0 as code: envelope + codec, Replica (client), Room (reference sequencer), ports
test/                bun test
```

- **packages/core is not edited here.** Change it in herdr-draw (its tests, its scripts/release.sh), then
  re-copy and update SOURCE.json. `test/core-source.test.js` fails on drift. Moving herdr-draw onto this
  package is a separate step the person approves.
- **Plain JS + JSDoc, no build step**: Herdr loads .js as copied, and its QuickJS runtime lacks some
  globals (no TextDecoder). packages/protocol imports only core's doc.js/model.js and its own files;
  `test/purity.test.js` checks it.
- Herdr mods can open WebSockets (`import { WebSocket } from "websocket"`, capability-gated) but refuse
  credential headers, so the token goes in the first message (`hello`), never a header. Untested live.

## Dev loop

`bun test`. Protocol changes start in PROTOCOL.md, then code, then a convergence test.
