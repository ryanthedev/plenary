# Report: p4-natss3 (NATS Bus and S3 Blobs adapters)

Done. Both contracts pass against a real nats-server 2.15.3 and a real MinIO locally, and skip cleanly without
them. `bun test` is green. Nothing is committed.

## What changed (files)

| File | What |
|---|---|
| server/bus/nats.js (new) | `natsBus({ url, name?, onError?, connectTimeoutMs? }) → Promise<Bus>`. Same surface as memory.js: `publish`, `subscribe → unsubscribe`, `flush`, `subscriberCount`, `close`. Re-exports `subjects` from memory.js (one source of names). Also exports `MAX_BUS_BYTES`, `encodeMessage`, `decodeMessage`. |
| server/blobs/s3.js (new) | `s3Blobs({ endpoint, bucket, region, accessKeyId, secretAccessKey })`. Same `put` and `get` as disk.js. Reuses disk.js's `checkBlob` (size, SHA-1, image type). |
| test/server/bus-contract.js (new) | `busContract(label, makeBus, { skip })`: the § Bus contract as tests. |
| test/server/blobs-contract.js (new) | `blobsContract(label, makeBlobs, { skip })`: the § Blobs contract as tests. |
| test/server/nats-bus.test.js (new) | Runs the contract on memory and NATS, plus wire-format tests and NATS-only tests. |
| test/server/s3-blobs.test.js (new) | Runs the contract on disk and S3, plus S3-only tests. |
| package.json, bun.lock | One dependency added: `@nats-io/transport-node` 3.4.0. This is the maintained client; the old `nats` package is deprecated in its favour. It pulls in `@nats-io/nats-core`, `nkeys` and `nuid`. |

## Design points

**NATS Bus**

- **Core NATS, at-most-once.** No JetStream (NATS's persistent-stream layer).
- **One subscription per subject.** This process's handlers share one NATS subscription and each message is fanned out locally. So, as in memory.js, every local handler gets message 1 before any handler gets message 2, and `subscriberCount` is exact.
- **Subjects checked on publish and subscribe.** A subject must be `[a-z0-9-]` tokens joined by `.`. No `*`, `>`, spaces or empty tokens. A bad subject is refused with `bad-id`.
- **Plain data travels as JSON.** A `Uint8Array` is allowed only as a top-level field (for example `data` from a binary codec). It travels as raw bytes after the JSON, located by a `Plen-Bytes` NATS header. Only our publisher sets headers, so a client-authored `msg` can't forge bytes. Nested bytes, bare bytes and bigints are refused with `bad-entry` rather than silently mangled.
- **2 MB cap.** The cap is on the encoded size, headers included, because NATS counts headers toward `max_payload`. Exactly 2,097,152 bytes passes end-to-end. One byte more is refused with `too-large` before it reaches the wire, and so is a byte field that fits only without its header.
- **Received bytes are plain copies.** A byte field arrives as a plain `Uint8Array`, not a `Buffer` view of the client's read buffer. This was caught late (the first version returned a Buffer view) and is now tested.
- **2 MB server check at connect.** `natsBus` rejects with `bad-config` if the server's `max_payload` is under 2 MB (§ Bus: "must carry 2 MB"). Checked by hand against a default 1 MB nats-server (below).
- **Refusals never crash a fire-and-forget caller.** A refused publish rejects for a caller that awaits it and also goes to `onError`. The returned promise is pre-marked as handled, so `gateway.js` and `room-host.js` (which don't await `publish`) get a log line, not an unhandled rejection. A test checks this.
- **`flush()` covers this process only.** It round-trips to the server. Smoke-tested: afterwards, this process's own handlers have already run for everything it published. It says nothing about other nodes' subscribers. `room-host.idle()` relies on the local case only.
- **Lazy import.** The client library is loaded with a dynamic `import()` inside `natsBus()`. A single-node process never needs `node_modules` (relevant to the Dockerfile, see below).
- **URL from the caller.** Nothing is read from env inside the adapter.

**S3 Blobs**

- **Key layout.** A blob is the object `<tenant>/<sha1>`. Ids are validated first (a bad id always gives `bad-id`), then `checkBlob` runs. The object's Content-Type is its image kind.
- **Idempotent put.** Put checks `exists()` and skips an existing object (a test confirms its `lastModified` is unchanged). Two puts racing on one hash write identical, hash-verified bytes.
- **`get` returns null only for `NoSuchKey`.** A missing bucket, bad credentials or a network error all throw, so an outage never looks like a missing blob.
- **All five settings are required.** Bun's `S3Client` would otherwise fall back to `S3_*`/`AWS_*` env on its own, which the brief forbids.

## Tests added (what they cover)

- **Bus contract** (memory always; NATS when `NATS_URL` is set):
  - delivery per subject and per kind, in publish order, not re-entrant
  - at-most-once delivery, idempotent unsubscribe, and unsubscribing one handler keeps the others
  - a handler that throws or rejects goes to `onError` and doesn't stop the others
  - messages published from inside a handler arrive in order
  - plain data round-trips, including unicode, `\u0000` and a byte field
  - after `close`, `publish` resolves and delivers nothing
- **Blobs contract** (disk always; S3 when `S3_ENDPOINT` is set):
  - put/get, idempotent put, a missing blob is null
  - hash mismatch is refused
  - the 10 MB cap, including exactly 10 MB stored and read back
  - tenant isolation
  - bad ids and hashes give `bad-id`, and the id is checked first
  - SVG, text and empty bytes are refused; JPEG, GIF and WebP are accepted
  - concurrent puts of one hash
- **NATS only:**
  - two connections (two nodes) hear each other, 200 messages in order
  - `flush` semantics
  - the 2 MB edge and 2 MB + 1
  - a refusal nobody awaits produces no unhandled rejection
  - wildcard and malformed subjects are refused
  - tenant A never reaches tenant B
  - an unreachable server rejects within 5 s
- **Always run:** wire-format tests (forged byte markers, nested bytes refused) and "`natsBus` needs a url".
- **S3 only:**
  - the object key layout and Content-Type
  - put doesn't rewrite an existing object
  - missing key gives null; missing bucket and bad credentials throw
  - all five settings required

## How I checked it

- **Installed:** `brew install nats-server` (2.15.3, matching CI's image). `bun add @nats-io/transport-node@3.4.0`. MinIO and `mc` were already installed.
- **Servers (first run):** started from the scratchpad on free ports with throwaway credentials, PIDs recorded:
  - nats-server, PID 81195, temp config with `max_payload: 2MB`
  - MinIO, PID 81196
  - The bucket `plenary-test` was created with `mc` using a scratch `MC_CONFIG_DIR`.
  - Both were stopped by PID afterwards, and `ps` confirmed it.
- **Servers (second run, after the two fixes above):** the same setup again: nats-server PID 51608 and MinIO PID 51609. Both were stopped by PID and `ps` confirmed it.
- **1 MB server:** a second, default-config nats-server (PID 8879, started and killed by PID). `natsBus` refused it: `bad-config NATS max_payload is 1048576; … needs at least 2097152`.
- **Results:**

| Run | Result |
|---|---|
| The two test files, with `NATS_URL`, `S3_*` set | 44 pass, 0 skip, 0 fail; 3 more re-runs had 0 fail; after the fixes, 3 runs of 44 pass, 0 fail |
| The two test files, env unset | 19 pass, 25 skip, 0 fail |
| The two test files, env pointing at a dead port | 22 fail: unreachable fails, it never skips |
| Full `bun test`, env unset | 315 pass, 43 skip, 0 fail; after the fixes, 384 tests, 69 skip, 0 fail (more of another builder's tests skip without env) |
| Full `bun test`, env set | 384 tests, 44 skip, 0 fail (another builder's pg tests appeared in the tree meanwhile) |

## Not verified

- **CI run:** not run. CI sets `NATS_URL`, so the NATS tests will run there. CI sets no `S3_*`, so the S3 tests skip in CI. The CI install step runs `bun install --frozen-lockfile` now that bun.lock exists.
- **Reconnects:** a NATS restart or network blip mid-run is untested. The client reconnects forever (`maxReconnectAttempts: -1`), and messages during the gap may be lost, which is allowed (at-most-once; § Bus repairs entries by heartbeat and poll).
- **Cross-node order:** ordering across publishers on different nodes isn't guaranteed. § Bus doesn't need it (entries carry `seq`).
- **Real AWS S3, Docker images:** tested only against MinIO, not real AWS S3. The cluster compose stack and the Docker image weren't run.
- **Performance:** no measurements (the JSON replacer runs over every message).

## Risks and asks for other owners

- **Room-host frames can exceed the bus cap (room-host's owner; matters once main.js uses NATS):**
  - **The risk:** `server/room-host.js:235` publishes catch-up frames on `.gw.<gateway>`. The snapshot is one frame however large the board is (line 149), and tail chunks are up to `chunkBytes` (1 MB) plus the bus envelope. A group-commit `.entries` batch (line 227) has no byte bound either.
  - **What breaks:** on NATS, any of these over 2 MB is refused with `too-large`. The joiner then waits for a catch-up that never comes, and the only trace is an `onError` log line.
  - **What § Bus says:** "catch-up and snapshots go gateway → client, read from the Store", so this is the existing SEAM(p2/p4) in room-host. It needs to move to the gateway, or be chunked under 2 MB, before cluster mode.

- **main.js (engine/platform, not mine):**
  - `natsBus` is async: `const bus = NATS_URL ? await natsBus({ url: NATS_URL, onError }) : memoryBus({ onError })`.
  - `s3Blobs` takes the five `S3_*` values, passed in explicitly.
  - Import nats.js however you like; the client library loads only when `natsBus()` is called.
- **deploy/Dockerfile (platform):** it has no `bun install` yet ("once a lockfile exists"). A lockfile now exists. The cluster image needs `COPY bun.lock` and `bun install --frozen-lockfile --production`, or `natsBus()` will fail to load its client in the container. Single-node keeps working without it thanks to the lazy import.
- **CI (platform):** to run the S3 tests in CI, add a MinIO step and set `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`; the bucket must already exist.
- **SEAM(p4), owned by memory.js's owner:** `subjects.gateway` is still `plen-gw.<gateway>`, but § Bus names it `plen.<tenant>.<board>.gw.<gateway>`. nats.js re-exports memory.js's `subjects`, so it follows whatever lands there. Either form passes nats.js's subject check.
- **`flush` is weaker than memory's.** It covers only this process's own subscribers. Tests elsewhere that use `bus.flush()` to wait for a remote node's handler would need `until` instead.
- **Quota:** the per-tenant blob quota is still not enforced. Same SEAM(p3) as disk.js.

## Fix round (verifier FAIL, docs/m2/reports/p4-natss3v.md)

All three findings (H1, M1, M2) are fixed and tested, plus L1 and L7. Same files as the brief.

| Finding | Fix | Where |
|---|---|---|
| **H1** session token read from env | s3Blobs takes an optional `sessionToken` and refuses to start (`bad-config`) when Bun would sign with a token the caller didn't give | `server/blobs/s3.js` |
| **M1** S3 call hangs on a silent store | per-call deadlines, put 30 s and get 10 s by default (`putTimeoutMs`, `getTimeoutMs` options); the request is truly aborted | `server/blobs/s3.js` |
| **M2** NATS outage buffers publishes without limit | the bus tracks the connection; while it is down, publish is refused with `unavailable`, reported to `onError` once per outage | `server/bus/nats.js` |
| **L1** `__proto__` byte field | prototype keys and malformed byte-field headers are refused (`bad-entry`) | `server/bus/nats.js` |
| **L7** smaller `max_payload` after a reconnect | re-checked on every reconnect: a server under 2 MB keeps publishes refused (`bad-config`) | `server/bus/nats.js` |

### H1: what Bun does (checked, Bun 1.4.4)

- **Bun reads env at process start.** `S3_SESSION_TOKEN` and `AWS_SESSION_TOKEN` are read when the process starts. Passing `sessionToken: ""`, `null` or `undefined` does not turn this off.
- **Changing env later does nothing.** Deleting the variable from `process.env` at run time changes nothing, and setting it at run time is ignored too.
- **An explicit token overrides it.** A non-empty `sessionToken` replaces the env value; the presigned URL carries the caller's token.
- **So the check uses Bun's own signing.** At construction s3Blobs presigns a dummy key (local signing, no network). If the URL carries `X-Amz-Security-Token` and the caller gave no token, it throws `bad-config` with the remedy in the message. The false-assurance comment is replaced with exactly this.
- **Test:** spawns a fresh `bun` per case, because env must be set at start. Covered cases:
  - each variable alone, and both together
  - both set, then deleted at run time
  - both set, with an explicit token, which starts fine
- **Live:** against MinIO, a caller-given bogus token gets the request rejected, which shows it is what gets signed.

### M1: how the deadline works

- **Presign plus fetch.** Bun's S3 file methods take no abort signal: a pre-aborted signal was ignored (checked). So the client now only presigns, locally, and the HEAD, PUT and GET are `fetch` calls with `AbortSignal.timeout`.
- **Timeouts:** become `PortError("timeout")`.
- **Other failures:** refused connections and S3 errors become `PortError("unavailable")` with the S3 code in the message and the original error as `cause`.
- **Missing blob:** `get` still returns null only for `NoSuchKey`, now read from the 404 body, so a missing bucket throws.
- **Test** (no store needed, so it runs everywhere): a TCP server that accepts and never answers. `get` and `put` time out after 300 and 400 ms, under 2 s, and the server sees every socket closed, so the requests were aborted, not left open. Also tested: a refused port gives `unavailable`, and deadlines must be positive.

### M2: outages

- **State:** comes from `nc.status()`. `disconnect` and `reconnecting` mark the bus down; `reconnect` marks it up after re-checking `max_payload` (L7).
- **Publishing while down:** rejected with `unavailable` (handled, so a fire-and-forget caller can't crash). `onError` is called once, when the outage begins, not per publish. `isUp()` is exposed for /health.
- **No replay:**
  - **The client's code:** nats-core resets its outbound buffer before every dial (`prepare()` calls `resetOutbound()` in `protocol.js`), so anything buffered before the disconnect was noticed is discarded, not replayed.
  - **Live:** a message published right after the kill and another during the outage both never arrived after the restart. Disconnect was noticed about 56 ms after a SIGKILL.
- **Test** (runs when the `nats-server` binary is present; skips otherwise, including in CI). It spawns its own servers on a free port and kills them by their own PID:

| Step | Checked |
|---|---|
| Before the kill | "before" is delivered |
| Kill, outage | `isUp()` goes false; 50 × 1 MB publishes and "during" are all `unavailable`; `onError` was called once |
| Restart on the same port | reconnects; "after" is delivered; the received list is exactly `["before", "after"]` |
| Second kill | reported again |
| Restart with a 1 MB `max_payload` | `bad-config` is reported, publishes are refused, `isUp()` stays false |

- **New option:** `reconnectWaitMs` (default 2000), so the test doesn't wait 2 s per attempt.

### Not fixed (other owners or by design)

- **L2** (racing puts, last write wins): `If-None-Match: *` would close it, but MinIO answered a conditional PUT on a new key with a wrong 404 NoSuchKey (checked). Documented in s3.js; it needs a SHA-1 collision to matter.
- **L3** (Date, NaN and Map change on the wire): "plain data only" is already documented. A caller relying on memory.js's pass-by-reference would break on NATS.
- **L4, L5, L6** are memory.js (another owner): it accepts any subject, keeps handlers subscribed after close, and still has the `plen-gw.<gateway>` SEAM.

### Checks this round

- **Servers:** nats-server PID 54918 (2 MB) and MinIO PID 54919, from a scratch script on free ports, stopped by PID and confirmed gone with `ps`. Probe servers 62518 and 62781 (outage probe) were killed by PID. The outage test's own servers are spawned and killed by the test, and `ps` shows none left.
- **Results:**

| Run | Result |
|---|---|
| The two test files, live NATS + MinIO | 50 pass, 0 fail, 3 runs in a row |
| The two test files, no env | 24 pass, 26 skip, 0 fail (the outage test runs, since nats-server is installed) |
| Full `bun test`, no env | 320 pass, 70 skip, 0 fail (390 tests) |
| Full `bun test`, env set | 346 pass, 44 skip, 0 fail |

### Not verified (this round)

- **Real AWS:** STS session tokens (temporary credentials) were not tried against real AWS; only "the caller's token is what gets signed" was checked.
- **CI:** the outage test skips there, because the runner has no nats-server binary (NATS runs in Docker). To run it in CI, install the binary or add a Docker-based variant.
- **Detection gap:** a publish in the few ms between a socket drop and the `disconnect` event goes into the client buffer, which is then discarded on reconnect (per nats-core's code and the live check). It is not refused, and there's no `onError` for it.
- **Behaviour change for main.js:** `s3Blobs` now throws at construction on a host whose environment has a session token. On such a host, pass `sessionToken` explicitly (for example from `S3_SESSION_TOKEN`).

### Fix round 2: M3, a frozen NATS server (verifier's "New finding")

**Root cause (checked live with SIGSTOP and SIGCONT):**

- **Stale but never disconnected.** With 1 s pings the client flagged the connection `staleConnection` at 3 s, but `disconnect` came only after SIGCONT. nats.js closes a stale transport by first awaiting a socket write (`node_transport.js` `_closed()` calls `_send("")`). Against a frozen server with a full socket that write never completes.
- **Everything replayed.** 40 MB sat in the socket's write queue (`writableLength`), and all 40 messages were delivered on resume.
- **Destroying the socket fixes it.** Destroying it directly gave `disconnect` at once, and on resume only 1 of the 40 arrived. That one was most likely already in the server's kernel receive buffer.

**Fix (`server/bus/nats.js`):**

1. **Short pings.** `pingIntervalMs` (default 5 s) and `maxPingOut` (default 2) are passed to the client, so a frozen server is stale within about 10–15 s.
2. **On `staleConnection`:**
   - the bus goes down (`unavailable`, reported once);
   - the pending count resets;
   - the socket is destroyed (`nc.protocol.transport.socket.destroy()`).

   This drops what is queued in this process, so nothing replays, and makes the client reconnect. It reaches into the client's internals. If an update moves them, the bus still goes down and refuses, but drops nothing until the client's own stale handling ends. The code comment says so.
3. **A cap on unacknowledged bytes, independent of pings.**
   - **Counting:** each published byte counts as pending until a `flush` round trip confirms it. NATS answers a PING only after it has read everything sent before it. Acks run at most every `ackEveryMs` (250 ms) while anything is pending; one per burst, not one per message.
   - **Over the cap:** a publish that would pass `maxPendingBytes` (default 32 MB, at least 2 MB) is refused with `unavailable`, reported once per episode, until acks bring the count under half the cap.
   - **No reconnect for busy connections:** this sheds load without reconnecting, so a healthy but busy connection isn't torn down. Only a stale ping tears the connection down.
4. **Disconnect and reconnect** reset the pending count and congestion. An old flush can't credit a new connection, because an epoch counter changes on every disconnect.
5. **`close()` is bounded.** `nc.close()` also flushes first and could hang against a frozen server, so after 2 s it gives up and destroys the socket.
6. **`isUp()`** is false while down or congested.

**Test** (the verifier's SIGSTOP/SIGCONT repro as a test; runs when the `nats-server` binary is present; spawns its own server and stops it by PID, sending SIGCONT first if still frozen). Settings: 500 ms pings, an 8 MB cap.

| Step | Checked |
|---|---|
| Before the freeze | "before" is delivered |
| SIGSTOP, 60 × 1 MB offered | at most 8 accepted (the cap), the rest `unavailable`; `onError` once (congestion) |
| Pings | stale reported within 5 s (a second `onError`); "during" is refused |
| SIGCONT | the bus reconnects and "after" is delivered |
| Replay | at most 2 of the frozen messages arrive, and fewer than were accepted (1 locally); "during" never arrives |

**Results:**

| Run | Result |
|---|---|
| Outage and stall tests (no env needed) | 3 pass, 0 fail, 3 runs |
| The two test files, live NATS + MinIO | 52 pass, 0 fail, 2 runs |
| Full `bun test`, no env | 322 pass, 70 skip, 0 fail (392 tests) |
| Full `bun test`, env set | 348 pass, 44 skip, 0 fail |

- **Servers:** shared nats-server PID 45289 and MinIO PID 45290, stopped by PID and confirmed with `ps`. Probe servers 26180 and 27963 were killed by PID. Tests spawn and kill their own, and none were left after the full runs (one seen mid-exit once, then gone).

**Not verified (round 2):**

- **Linux and CI:** the stall test skips in CI (no `nats-server` binary). On Linux the server's kernel receive buffer can be larger, so more than 1 message might still arrive, and the test's "at most 2" could be too tight there.
- **Real partitions:** only SIGSTOP was tested, not a real network partition or an LB that drops the flow silently.
- **Throughput:** the extra ack round trips (at most 4 per second while publishing) weren't measured. Neither was the 32 MB default under real load; tune it in M4.
- **Fragility:** the socket destroy relies on nats-core 3.4.0 internals. bun.lock pins the version.
