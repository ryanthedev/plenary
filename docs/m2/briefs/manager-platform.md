# Brief: manager platform

Base: docs/m2/BRIEF-BASE.md applies, except you are a manager: you direct builders and verifiers, you don't
build. Read docs/m2/OFFICE.md (especially "Keep the train moving"), docs/m2/PLAN.md, docs/m2/COMMITMENTS.md,
CLAUDE.md and PROTOCOL.md first.

- **Your tab:** `manager platform`. Labels: `herdr.space=sp21a427967d02459948b4c10156ff82ae`, `plenary=manager-platform`.
- **Your parent:** the proxy (terminal id in COMMITMENTS.md). **Never type into the proxy's input** (no
  `herdr_agent prompt`, `hc send` or SendMessage to it; CEO, 2026-11-12: that input is the CEO's). Report by ending
  your turn with one short message (outcome first, path to the report; the proxy's watch delivers it) and in docs/m2/reports/manager-platform.md (dated section per job,
  plus your worker roster: terminal id, tab, status).
- **Track (PLAN.md):** platform. You own server/auth/, server/admin/, test/auth/, deploy/, .github/, README.md and
  the drawh proposal (docs/m2/proposals/). Phase 5 and the packaging half of 8. The engine track owns PROTOCOL.md,
  packages/protocol/ and the rest of server/; the client track owns web/. Need a change there? Report it to the
  proxy; don't make it.

## Jobs now (server-independent; run them in parallel where files don't overlap)

1. **p5-auth: OIDC module + tenancy model** (server/auth/, server/admin/, test/auth/). An OIDC sign-in module
   (Google; authorization code + PKCE, ID-token verification against JWKS, `hd` claim = Workspace domain) that
   implements the async Auth port as PROTOCOL.md defines it. PROTOCOL.md v1 is being verified right now: read the
   working-tree version, and if the Auth port shape changes when it is committed, follow the committed one. Also a
   dev-token verifier for the same port. The model with tests: tenant = Workspace domain; invites and share links
   (role per link: editor / annotator / viewer; expiry; revoke); boards belong to one tenant; cross-tenant reads
   refused. Plain JS + JSDoc, `bun test`. **No real credentials:** tests use a fake IdP (local keypair, local
   JWKS). The real Google OAuth client id/secret come from env only, later, from the CEO (the proxy asks).
   The `POST /boards` admin handler can be written as a function against the Store port; wiring it into the
   HTTP server waits for phase 3 (engine's server/).
2. **p8-ci: CI + Docker skeleton** (.github/, deploy/). A GitHub Actions workflow that runs `bun test` on push and
   PR; a Dockerfile skeleton (Bun base image) and a compose file stub under deploy/ that later gains Postgres and
   NATS. Nothing published: no registry pushes, no public images, no secrets in the repo.

For each job: write docs/m2/briefs/<job>.md, start a builder `worker <job>: <what>`, then a separate verifier
`verifier <job>v: <what>` per OFFICE.md. HIGH findings go back to a builder. On PASS: re-run `bun test`, commit
by path, report to the proxy, and start your next job the same turn (OFFICE.md, Keep the train moving). Next
after these: the drawh proposal (a patch file under docs/m2/proposals/, never applied to herdr-draw), then wire
auth and admin into the server once phase 3 is committed.

## Rules

- Start sessions exactly as OFFICE.md "Starting a session" shows; rename each tab right away.
- Watch your workers (`herdr_agent watch` into Monitor, re-arm on expiry); unstick per OFFICE.md.
- Never push, never make anything public, never register anything. Only credentials, spending and anything public
  wait for the CEO; send those to the proxy and work around them (dev tokens, fake IdP).
- Hand off at ~60% context (OFFICE.md, Recycling): docs/m2/handoff/manager-platform.md.
