# Report: p4-natss3v (verify the NATS Bus and S3 Blobs adapters)

**Verdict: FAIL, with one HIGH (H1).** The S3 adapter takes credentials from the process env, which breaks the
goal's "never env" clause. Its own test claims the opposite and still passes. There are also two MEDIUMs: an S3
call to a silent store never returns (M1), and a NATS outage buffers publishes in memory without limit (M2).

The rest of done-when holds. Both contracts pass against real NATS and MinIO, they skip cleanly without them,
and `bun test` is green. Bun 1.4.4, @nats-io/transport-node 3.4.0, MinIO from Homebrew.

## How I checked

- **Servers:** run from the session scratchpad on free ports with throwaway credentials, and stopped by PID:
  - nats-server with `max_payload: 2MB`, and a second one with 1 MB;
  - MinIO with bucket `vbucket`, made with `mc --config-dir <scratch>`;
  - the restart and kill scripts each spawned and stopped their own servers.
- **`bun test`, no env:** 315 pass, 69 skip, 0 fail.
  - The first run had 1 failure: `test/server/outbound.test.js` "M1: one writer's burst … /health keeps
    answering", another job's timing test. It ran while codex and three servers were busy.
  - That file passed 12/12 alone, and the whole suite passed on rerun. I'm calling it flaky, but that's unproven.
- **`bun test` with NATS_URL and S3_* set** (what CI sets, plus S3): 340 pass, 44 skip, 0 fail.
- **The job's two test files:** 44 pass, 0 skip against live servers. Without env they give 19 pass, 25 skip,
  0 fail. The memory.js and disk.js runs of the same contracts still run, so the contracts describe the
  single-node adapters too.
- **Scratch break-it tests** live in the session scratchpad under `break/` (`a.test.js`, `restart.js`,
  `nats2.js`, `nats3.js`, `s3.js`, `env.js`, `minio.js`, `hang.js`):

| Check | Result |
|---|---|
| Server with 1 MB `max_payload` | refused with `bad-config`; `/connz` shows 0 connections afterwards (no leak) |
| Open bus, then `close()` | `/connz` 1, then 0 |
| Server that accepts TCP but never sends INFO, `connectTimeoutMs: 1000` | rejects `timeout` after 1026 ms |
| Resubscribe after the last unsubscribe, then call the stale unsubscribe | still delivers once |
| Same handler subscribed twice | one delivery, count 1 (same as memory.js) |
| Unsubscribe, subscribe, flush or close after close | no throws |
| Slow async subscriber (1 s per message) | the other handler gets all 20 messages within 500 ms |
| Foreign publisher, malformed `Plen-Bytes` header (bad JSON, negative or oversize lengths, non-array, bad body) | each goes to `onError`; no crash |
| NATS killed mid-run, then restarted on the same port | resubscribes and delivers again; `flush` rejects while down (no hang); `close` works up or down; 0 unhandled rejections |
| A message published during the outage | not delivered after restart (allowed: at-most-once) |
| **Publishes during the outage: 200 × 1 MB, then 800 × 1 MB** | **all accepted, no `onError`; RSS +208 MB, then +829 MB (M2)** |
| Cross-tenant subject, wildcards, dots | refused by `needId` and the subject regex |
| MinIO killed (SIGKILL) during a 10 MB put, at 5, 30 and 120 ms, then restarted | either put rejects and `get` returns null, or put resolves and `get` returns all 10 MB with the right hash; never a truncated object |
| S3 on a closed port | throws `ConnectionRefused` fast |
| **S3 store that accepts TCP and never answers** | **`get` still pending after 300 s; `put` after 8 s (M1)** |
| **`AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` set in env** | **every S3 call fails (H1)** |

- **Caveat on the MinIO kill test:** locally the 30 ms and 120 ms puts had already finished when the kill landed,
  so a kill mid-transfer is not proven, only "no partial object was seen".
- **No production caller awaits `bus.flush`** (grep of server/), so its rejection during an outage reaches only tests.

## Findings

### HIGH

- **H1. s3.js reads credentials from env, against the goal's "never env".** `server/blobs/s3.js:27` builds
  `Bun.S3Client` with all five settings, but Bun 1.4.4 still reads `S3_SESSION_TOKEN` and `AWS_SESSION_TOKEN`
  from the process env.
  - **Repro:** set either var to `garbage`. Against MinIO with correct keys, `put` fails with `UnknownError` and
    `get` with `InvalidTokenId`. Passing `sessionToken: ""` does **not** block it (checked).
  - **Impact:** on a host with AWS session credentials in env, such as an `aws sso` shell or some AWS runtimes,
    every blob call fails. It fails loudly; it does not silently use another account.
  - **False assurance:** the comment at `s3.js:8-9` says requiring all five settings prevents the env fallback.
    The test "s3: every setting is required from the caller (none read from env)" passes, but it checks only the
    argument checks, never env.
  - **Fix idea (untested):** pass an explicit `sessionToken` from the caller and add a test that sets both env vars.
    If Bun has no way to turn the fallback off, the adapter should refuse to start while either var is set, and
    the limit should be documented.

### MEDIUM

- **M1. No timeout on S3 calls: a store that stops answering hangs `put` and `get`.** `server/blobs/s3.js:40-41`
  and `:47`. `get` was still pending at 300 s, and I didn't measure an upper bound; `put` blocks first in
  `exists()`. The brief asks for errors, not hangs.
  - **Fix idea:** a per-call deadline (for example 30 s for put, 10 s for get) that rejects with a PortError, and
    abort the request if Bun's S3 API allows it.
- **M2. A NATS outage buffers publishes in memory without limit.** `server/bus/nats.js:84` connects with
  `maxReconnectAttempts: -1`, and `publish` keeps accepting while disconnected.
  - **Measured:** 800 × 1 MB published during an outage raised RSS by 829 MB, with no refusal and no `onError`.
  - **Why it matters:** a room host or gateway keeps publishing entries, heartbeats, presence and inbox messages
    through a long outage, and can run out of memory. At-most-once means those messages may be dropped anyway.
  - **Client options:** this version (`core.d.ts`) has no reconnect-buffer cap.
  - **Fix idea:** track `nc.status()` disconnect and reconnect events in the adapter. While disconnected, refuse
    publishes with a PortError (for example "unavailable") through `refuse()`, or cap the buffered bytes.
  - **Not checked:** whether the buffer is flushed after reconnect. That would replay stale presence; my one
    "during" message did not arrive.

### LOW

- **L1. A foreign publisher can set a decoded message's prototype.** `server/bus/nats.js:70` assigns `msg[k]` for
  any key named in the header, so `Plen-Bytes: [["__proto__",2]]` makes that message's prototype a `Uint8Array`.
  - I confirmed it live, and codex found it independently.
  - It affects that one message, not the global prototype, and needs publish rights on NATS, which is trusted.
  - **Fix:** refuse `__proto__`, `constructor` and `prototype` as keys, or decode onto a null-prototype object.
- **L2. "First bytes kept" relies on SHA-1 never colliding** (codex lead, downgraded from MEDIUM).
  `server/blobs/s3.js:40-41` checks then writes, so concurrent puts both write and the last one wins.
  - Both writes passed the same SHA-1 check, so the bytes differ only on a real collision. That is feasible but
    costly, and it only lets an uploader choose which of their own two images is kept.
  - disk.js has no such gap, because `link` keeps the first.
  - An S3 conditional write (`If-None-Match: *`) would close it, if Bun exposes one.
- **L3. Non-plain values change on NATS but not in memory.** Checked: a `Date` arrives as an ISO string,
  `NaN` and `Infinity` as `null`, and a `Map` as `{}`.
  - The adapter documents "plain data only", but the shared contract doesn't stop a caller relying on
    memory.js's pass-by-reference.
- **L4. memory.js is looser on subjects than NATS.** It accepts any string subject, so the shared contract can't
  test the wildcard refusal. Today every subject comes from `subjects.*`, which validates its ids.
- **L5. memory.js keeps handlers that subscribe after close.** This is a codex lead I confirmed by reading
  `server/bus/memory.js:57-61`. Nothing is delivered to them, but they stay in memory. It's another job's file.
- **L6. The gateway subject is still `plen-gw.<gateway>`.** memory.js `subjects.gateway` is tagged SEAM(p4), and
  § Bus says `plen.<tenant>.<board>.gw.<gateway>`. The builder flagged it too. memory.js isn't this job's file, so
  it needs an owner.
- **L7. A NATS server restarted with a smaller `max_payload` isn't re-checked.** The check runs only at connect.
  This is reasoned from the code, not tested; I expect a large publish then to fail inside `try` and reach `onError`.

## sdd ensemble (single harness)

Only codex was available today. It reviewed a copy of the files in scratch at high effort and returned three leads:

| Lead | Verdict |
|---|---|
| S3 put race, "first bytes" | confirmed, downgraded to LOW (L2: needs a SHA-1 collision) |
| `__proto__` byte-field name | confirmed live (L1) |
| memory.js subscribe after close | confirmed by reading; other job's file (L5) |

Codex did not find H1, M1 or M2. All three came from live tests.

## Not verified

- Real AWS S3 (I tested only MinIO), NATS clusters and TLS.
- Performance and the cost of the JSON replacer; ordering across several publishers.
- Whether Bun can turn off its S3 env fallback, and how long a hung S3 call really lasts (over 300 s).
- A MinIO kill truly mid-transfer (see the caveat above).

## Cleanup

Servers I started, all stopped by PID:

- **nats-server:** 73952 (2 MB), 95560 (1 MB), 99722 and 382 (restart test), 50305 and 50330 (connz and outage test).
- **MinIO:** 73953; 71784, an orphan from a failed script run, stopped by its PID; 73714, 74002, 74307 and 74480 from
  the run with a bad bucket name; 76777, 76933, 77012 and 77117 from the kill test.
- `pgrep -fl "minio server <scratch>"` found nothing left.

Nothing in the repo changed except this report.

**Question for the manager:** H1 makes this a FAIL. Send it back to fix H1, plus M1 and M2 if cheap, or accept
H1 as a documented Bun limit?

---

# Round 2 (2026-11-11)

**Verdict: PASS.** H1, M1 and M2 are fixed as specified, each checked live. There is **one new MEDIUM (M3)**: a
NATS server that freezes instead of dying still makes publishes pile up in memory, and replays them when it
resumes. It's the same family as M2 but a different trigger. The builder's round-2 report was not read.

## Gates

| Run | Result |
|---|---|
| The job's two test files, live NATS + MinIO | 50 pass, 0 fail |
| Full `bun test`, NATS_URL + S3_* set | 346 pass, 44 skip, 0 fail |
| Full `bun test`, no env | 320 pass, 70 skip, 0 fail |

## The three findings

- **H1, FIXED.** My env repro (`r2/h1.js` in the scratchpad) covered `S3_SESSION_TOKEN` alone,
  `AWS_SESSION_TOKEN` alone, and both set:
  - In every case `s3Blobs()` refuses to start with `bad-config`, and the message names both variables and the fix.
  - An empty `AWS_SESSION_TOKEN=` is not treated as set, and put and get work.
  - With no env, put and get work.
  - An explicit caller `sessionToken` overrides env, and a bad one fails clearly (`unavailable … 403 InvalidTokenId`).
  - The comment in `s3.js` now tells the truth.
  - The test now checks env for real: it starts a fresh Bun with each variable set, and also tries deleting
    them from `process.env` after start (`test/server/s3-blobs.test.js:67-79`).
- **M1, FIXED.** Requests are now `fetch` calls with an `AbortSignal` deadline (`r2/m1.js`):

| Case | Result |
|---|---|
| Store that never answers, `get` | `timeout` at 1502 ms (1500 ms deadline) |
| Store that never answers, `put` | `timeout` at 2001 ms, while waiting on HEAD |
| Store that sends headers then stalls the body, `get` | `timeout` at 1501 ms |
| Default `get` deadline | `timeout` at 10003 ms |
| Closed port | `unavailable: … ECONNREFUSED`, fast |
| Unhandled rejections | 0 |

- **M2, FIXED for a server that goes away.** `r2/m2.js` killed nats-server by PID, with no wait before the
  publishes, as a busy room host would see it:
  - **During the outage:** 800 × 1 MB publishes were all refused (`unavailable`), RSS grew 0 MB, `onError` heard it
    once, and `isUp()` was false.
  - **After restarting nats-server by PID:** both buses were back after 311 ms. The listener got only
    `["before", "after"]`, so nothing stale replayed. Unhandled rejections: 0.

## New finding

- **M3 (MEDIUM): a frozen NATS server (TCP still open) still buffers without limit and replays stale messages.**
  - **Repro:** `r2/m2.js` in `stop` mode sends `SIGSTOP` to nats-server and then publishes 800 × 1 MB.
  - **Result:** all 800 were accepted, RSS grew 896 MB, there was no `onError`, and `isUp()` stayed true. After
    `SIGCONT`, the listener received 598 messages published during the freeze (stale presence replayed).
  - **Why:** the adapter learns of an outage only from the client's `disconnect` status. A frozen server, or a
    silent network partition, VM pause or a load balancer dropping the flow without a reset, closes no socket.
    The client then notices only by missed pings: `pingInterval` defaults to 2 min and `maxPingOut` to 2
    (`@nats-io/nats-core/lib/options.js:33-34`), so it takes about 4–6 min. Meanwhile, bytes pile up in the
    socket write queue below the adapter. This client version has no cap on that queue.
  - **Fix idea (untested):**
    - Pass `pingInterval` of about 5 s and `maxPingOut: 2`, so a frozen server is noticed in about 10–15 s.
    - Add backpressure in `publish`: after each send, a periodic `flush()` round trip that takes longer than
      about 2 s marks the bus down (`unavailable`) until it returns, or refuse once the socket's buffered bytes
      pass a cap.
    - A test with `SIGSTOP`/`SIGCONT` by PID, like the kill test.

## Still open from round 1 (not re-checked unless noted)

- **L1:** the `__proto__` byte-field key is still assigned in `server/bus/nats.js:76` (checked by reading).
- **L2–L7:** not re-checked.
- **L2 is now documented:** the new `s3.js` comment says MinIO answers a conditional PUT with a bogus 404, so it isn't used.

## Cleanup

Servers I started, all stopped by PID:

- **Shared servers:** nats-server 98795 and MinIO 98796.
- **`m2.js` children:** nats-server 10270, 10411 (kill run) and 10502 (stop run, resumed and then stopped).
- `pgrep` found no `m2.conf` server left.

Scratch scripts are in the session scratchpad under `r2/`. Nothing in the repo changed except this report.

**Question for the manager:** M3 is MEDIUM, so round 2 passes. Fix it now (a ping setting plus backpressure), or
log it for M3 smoothing / M4 load tests?

---

# Round 3 (2026-11-11)

**Verdict: PASS.** M3 is fixed. A frozen NATS server now keeps memory bounded, publishes are refused with
`unavailable` and reported once through `onError`, the stall is caught within seconds, and a stall that lasts
past the ping window replays nothing stale. The M2 kill case and every gate are still green.

## Gates

| Run | Result |
|---|---|
| The job's two test files, live NATS + MinIO | 52 pass, 0 fail |
| Full `bun test`, NATS_URL + S3_* set | 348 pass, 44 skip, 0 fail |
| Full `bun test`, no env | 322 pass, 70 skip, 0 fail |

## M3: the frozen server

I re-ran `r2/m2.js` in `stop` mode (SIGSTOP nats-server, publish 800 × 1 MB, then SIGCONT), extended to time the
detection. I also added `r2/ping.js`, which measures the ping-only detection under light traffic.

| Check | Round 2 | Round 3 |
|---|---|---|
| 800 × 1 MB during a freeze | all 800 accepted | 33 accepted (the 32 MB unacknowledged-bytes cap), 767 refused `unavailable` |
| RSS growth | +896 MB | +63–64 MB, and flat over 100 more publishes while still frozen |
| `onError` | nothing | `unavailable` once when the cap trips, then once more when pings go stale |
| Stall noticed, heavy traffic | never (within the test) | 1.5 s (the cap) |
| Stall noticed, light traffic (one small publish every 100 ms) | 4–6 min (default pings) | 15.0 s (5 s pings, 2 missed) |
| Delivered after resume, freeze held 20 s | 598 stale messages | 1 message (it was already in the server's receive buffer); `during-first` and the rest dropped |
| Unhandled rejections | 0 | 0 |

- **Short freeze, within the ping window (LOW, by design).** With a freeze of about 1.5 s, the 33 accepted
  messages (≤ 32 MB) were delivered when the server resumed. That is a bounded burst of late messages, not a
  flood, and it matches the code's comment. Callers of the bus should expect presence that is a few seconds late
  after a stall.
- **Fragility (LOW, documented in the code).** The socket is destroyed through the client's internals
  (`nc.protocol.transport.socket`). If a client update moves that, the bus still goes down and refuses, but the
  queued bytes would replay on resume. The comment in `nats.js` says so. A test that pins the client version
  would catch it; `package.json` already pins 3.4.0 exactly.
- **`isUp()` changed meaning.** It now also returns false while the bus is congested, not only while it is
  disconnected. That suits a health check; anything that treats `isUp()` false as "reconnecting" should know.

## M2: the kill case, re-checked

The kill case is unchanged from round 2: 800 refused, RSS +0 MB, one report, back after 308 ms, and the listener
got only `["before", "after"]`.

## Still open

- **L1:** the `__proto__` byte-field key (`server/bus/nats.js`, `decodeMessage`) is not part of this round and
  was not re-checked.
- **L2–L7:** as in round 2.

## Cleanup

Servers I started, all stopped by PID:

- **NATS test children:** 61587 and 61728 (kill), 61961 and 63679 (stop), 69096 (ping).
- **Gate servers:** nats-server 73466 and MinIO 73467.
- `pgrep` found nothing left.

Nothing in the repo changed except this report.
