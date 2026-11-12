# Brief: pd-drawh-live (one live run of drawh --server against the real Plenary server)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy. Never pkill/killall; servers on port 0 (or the port a rule fixes) from a command that records the PID; kill only those PIDs. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/pd-drawh-live.md.

## Goal

The drawh proposal (docs/m2/proposals/drawh-server.{md,patch}, patch sha256 f4f9b05a…, against herdr-draw 5dfe352) was
only ever tested against stand-ins. Phase 2 put the real v1.1 server on main (dcbdae6). Before the CEO decides, run it
once against the real thing. ~/repos/herdr-draw is READ-ONLY: work in a fresh `git clone --local` in your scratchpad,
apply the patch there, never a worktree.

- Start the real server from main single-node (`bun server/main.js` or as main.js documents; port 0 or a free port;
  dev tokens enabled per its env header; a temp data dir), create a board with a dev Bearer `POST /boards`.
- Run `drawh --server … --board …` (token via PLENARY_TOKEN, never argv/printed) on a board file: shapes both ways
  (a second client: a second drawh bridge on another file, or a protocol Replica script), settings with `appBase`
  (change in the file → board; a stale one → `stale-setting` with a line), `--once` exit codes, restart and catch-up,
  `welcome.room` epoch read. Kill the server mid-run once and restart it: no acknowledged op lost, the bridge reconnects.
- Compare against the proposal doc's claims; list every mismatch.
- Gates: the patch applies cleanly to a fresh 5dfe352; herdr-draw untouched.

## Files you own

docs/m2/reports/pd-drawh-live.md only (plus your scratchpad). Do not edit the proposal; report mismatches.

## Done when

The run is done and reported (what worked, what didn't, with commands and outputs minus secrets). Then stop.
