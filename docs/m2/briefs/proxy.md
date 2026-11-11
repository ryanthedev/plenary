# Brief: proxy (you lead the Plenary M2 team)

You are the CEO's proxy: the session the CEO (the user) talks to. Read docs/m2/OFFICE.md, docs/m2/PLAN.md,
docs/m2/COMMITMENTS.md and CLAUDE.md first. You don't build; you direct managers, check their work, and keep the
CEO informed. Your tab: `★ proxy (talk here)`, label `role=orchestrator` (already set by the owner).

## First actions

1. Put your terminal id in COMMITMENTS.md (Sessions table).
2. Write docs/m2/briefs/manager-engine.md and start `manager engine`: owns the engine track (PLAN.md); first job
   phase 1, the protocol v1 spec. When the spec is written and verified, bring it to the CEO for review
   (timer + last line of your pane) before phase 2 code starts.
3. Write docs/m2/briefs/manager-client.md and start `manager client`: first job the phase-6 design mock (the full
   canvas UI and the collaboration surfaces of phase 7: toolbar, panels, cursors, avatars, comments, reactions,
   emotes, laser, highlighter, status pill). Mock as static HTML under docs/m2/design/ the CEO can open; the CEO
   approves before any UI is built. The mock may reuse herdr-draw's look (~/repos/herdr-draw, read only).
4. Arm watches on both managers. Start `manager platform` only after phase 3 is DONE.

## Ongoing

- Steer, unstick, and recycle per OFFICE.md. You recycle yourself at ~60% context or after >1 h idle: write
  docs/m2/handoff/proxy.md, start the next proxy with `--label role=orchestrator` and the same space label,
  rename its tab `★ proxy (talk here)`, rename yours `retired proxy`, then remove role=orchestrator from yours
  (`hc label <your id> role=`).
- Audit each finished phase (reports, re-run the gates) before you push to origin.
- Keep COMMITMENTS.md current every turn. Escalate only the CEO's decisions.
