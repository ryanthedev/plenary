# Handoff: proxy (t14h -> successor), 2026-11-11

Read first: docs/m2/briefs/proxy.md, docs/m2/OFFICE.md, docs/m2/PLAN.md, docs/m2/COMMITMENTS.md (sessions,
commitments, every decision), CLAUDE.md. COMMITMENTS.md is the source of truth; this file is what isn't in it.

## Team now

| Role | Terminal | Notes |
|---|---|---|
| owner | t13s | relays CEO rules as `<hc from="t13s">`; follow them, write them into OFFICE.md, commit by path |
| manager engine | t18m | took over from t14j (handoff 94b1ae9) |
| manager client | t14k | ~40% context at handoff; recycles itself at 60% |
| manager platform | t187 | took over from t14q (handoff 9266173) |

Watch all three: `herdr_agent watch` targets core:t18m core:t14k core:t187, into Monitor, re-arm every 30 min.

## Where the work is

- **Critical path: engine's scaffold (phase 3).** Fix round 4 by t18c, verifier t17j on round 5. When it
  commits: Postgres (p4-pg) and NATS/S3 (p4-natss3) adapters commit right after (verified, waiting on its
  imports), then p2-land merges to main as ONE green commit: phase 2 + v1.1 spec (cb343b9) and code (5d55112)
  + client p6-sync2/p6-land (3fa2d3a) + p2-swap (room-host/gateway/rig swap, httpRoutes mounted, Google OIDC from
  env, explicit env in tests). Then p-arch (test/architecture.test.js) and the server/protocol architecture audit.
- **Audit before pushing:** for each finished phase read the verifier reports and re-run `bun test` yourself;
  pushes go to origin main (private). Phase 1 was audited and pushed; phases 2 and 3 are not done yet.
- **Client:** p6-ports fix round (t18r, 4 HIGH in contract tests); then p6-hex, p7-wire, and the web/ audit on
  main after the merge. p7-collab is verified on p2-land.
- **Platform:** p5-code (sign-in code exchange, verifier t1bh); drawh scope cut (t185, then t155), then drawh
  round 4 on v1.1; README parked until server/ and web/ are on main.

## Waiting on the CEO (actions only; CEO wants nothing else)

1. One live Google sign-in: `cd ~/repos/plenary && bun scripts/dev-google.js`, open http://localhost:8080/
   (localhost, not 127.0.0.1), sign in with a Test-user account, report "signed in as …" or the /auth/callback
   log line on failure. Steps: docs/m2/reports/p5-google.md "Hand-off".
2. Optional: delete ~/Downloads/client_secret_791180535662-….json (holds the OAuth secret).
3. Optional and non-blocking: 5 product questions (viewer cursors, follow-presenter, viewer reactions, commenter
   scope, tenant-wide blob reads), the design mock (docs/m2/design/index.html), and the drawh proposal once it
   passes.

## Lessons (things that bit this session)

- **CEO reports:** only actions the CEO must take; otherwise one line, "Nothing for you to do" plus any open ask.
- **Permission prompts in other sessions:** the auto-mode classifier refuses send_keys for the proxy and
  managers. A stuck prompt goes to the CEO, with the exact tab and key.
- **Start command:** OFFICE.md's start command needs `zsh -lic` (for Engram env), `--model opus --permission-mode
  auto`, and `-n <name>`/`--name`. Without them, sessions come up as Fable in manual mode and block.
- **Chrome:** never use Claude in Chrome for the CEO's Google work. It's the wrong profile. Use theGrid on the
  Chrome window titled "... – Google Cloud console" (Omniping profile; project gen-lang-client-0027800234).
- **Secrets:** .env (gitignored, 0600) holds GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and COOKIE_KEY. Never print
  them. Bun auto-loads .env, so tests must pass an explicit env.
- **Engram:** it was unreachable from sessions started without `zsh -lic`; this proxy never had it.
