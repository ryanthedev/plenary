# Report: p4-wire2v (verify the p4-wire fix round)

Verifier: p4-wire2v (engine). Checked the uncommitted diff in server/main.js, server/room-host.js, server/bus/nats.js,
test/server/main.test.js and test/server/p4-wire2.test.js against p4-wirev (M1, L1-L7) and the builder's report
(p4-wire2.md). Nothing tracked was edited and nothing was committed. Every attack and mutation ran in a scratch copy
made with `rsync -a --exclude .git --exclude node_modules --exclude '.env*'` (0 `.env*` files in it).

## Verdict: PASS (0 HIGH, 0 MEDIUM, 4 LOW)

- **All 8 findings are fixed** as claimed, and each fix's test fails its mutation.
- **Gates are green:** `bun test test/server` 5 of 5 runs with 0 failures; the full suite fails only the known
  core-source drift; on Postgres + NATS with auth, 399 pass and 0 fail.
- **The 4 LOWs:** the new redacting logger can throw where the plain logger never did; the CLI's redacting logger
  is untested; raw `/ ? # ,` in a NATS password is mis-parsed (fails closed); field keys are not redacted.

## Findings

### LOW

**L1. The redacting logger throws on some Error objects, where log.js never throws, and the line is lost.**
- **Where:** server/main.js:186-200 (`redactingLogger`'s `scrub`). It runs outside log.js's `try` (server/log.js:33-37),
  which turns any serialisation failure into a "fields could not be serialised" line.
- **Repro (scratch `test/attack/l2throw.test.js`):** log `{ err }` through both loggers, where `err` is one of:
  - an Error with a throwing `code` getter;
  - an Error whose `message` is `Object.create(null)` (`String()` throws "No default value");
  - a field object with a throwing getter;
  - a Proxy whose `ownKeys` throws.

  Plain log.js: no throw, 1 line each. Redacting logger: throws each time, 0 lines.
- **Why it matters:** every node's log goes through this wrapper now, including the `uncaughtException` /
  `unhandledRejection` handlers (main.js:399-400), the bus `onError` callback and the `.catch` handlers in room-host.
  A throw there escapes the last line of defence. No real driver is known to produce such an Error, so this is LOW.
- **Fix idea:** wrap `scrub` in try/catch and fall back to logging the message with
  `{ logError: "fields could not be redacted" }`.

**L2. The CLI's redacting logger (main.js:397) is untested.**
- **Mutation:** replace it with a plain `createLogger(...)`. It **survives** p4-wire2, main, main-cluster, roles,
  room-host-lease and nats-bus: 74 pass without PG/NATS, and 92 pass with live PG + NATS.
- **Impact:** that logger covers uncaught exceptions and unhandled rejections. "start refused" also redacts
  explicitly (main.js:404), so only uncaught errors that quote a URL would leak if it regressed.

**L3. A raw `/`, `?`, `#` or `,` in a NATS password is mis-parsed, and part of the secret goes into `servers`.**
- **Where:** server/bus/nats.js:91 (the comma split) and :99 (the authority ends at the first `/?#`).
- **Repro (scratch `test/attack/m1.test.js`):**

  | Input | Result |
  |---|---|
  | `nats://u:SEC/RETpw@h:4222` (and the `?` and `#` variants) | `servers: ["nats://u:SEC/RETpw@h:4222"]`, no credentials |
  | `nats://u:SEC,RETpw@h:4222` | `servers: ["nats://u:SEC", "h:4222"]`, `token: "RETpw"` |
  | `nats://us:pw@h/?token=SECRETq` | the query `token` is kept in `servers` |

- **Through `start()`** (scratch `m1live.test.js`, 9 cases, 127.0.0.1 and a `.invalid` host): every
  malformed case is refused with `could not open the NATS bus (NATS_URL) [ERR_INVALID_URL]: Invalid URL`. No
  fragment of the secret appears in the error, its stack or any line. So it fails closed and nothing leaks.
- **Why only LOW:** these characters must be percent-encoded in a URL, and percent-encoded `@`, `:` and `/` decode
  correctly (`u%40x:p%3Aw%40d` → user `u@x`, pass `p:w@d`).
- **Fix idea:** refuse a server element whose authority still contains `:` after the host's port, or document "encode
  reserved characters".

**L4. Field keys are not redacted.**
- **Where:** server/main.js:198 scrubs values only.
- **Repro:** `log.error("probe", { ["k_" + PW]: 1 })` prints the key as is (scratch `l2.test.js` "keyHoldsSecret").
- **Impact:** no caller builds keys from a URL today, so this is LOW.

### Checked and holding (no finding)

| Attack | Result |
|---|---|
| **M1 parsing** | Percent-encoded `@`/`:` in user and pass; IPv6 `[::1]:4222`; `tls://`; no scheme (`host:4222`, `u:p@host`, `tok@host`); a comma list with the same credentials, with credentials on only one element (either order), and an array: credentials go to the options and `servers` holds none. `nats://u:@h` gives `pass: ""` and `nats://@h` gives no auth. `nats://:p@h`, mixed token/user and differing passwords are all refused `bad-config`, and no message carries a value. A malformed `%zz` is kept raw, with no throw. |
| **M1 live** | NATS with `authorization { user, password }`: the whole `test/server` contract ran on it with the password only in `NATS_URL` (gate below). |
| **L1/L2 redaction** | Each of these is redacted, and the line stays valid JSON: a non-string Error message, a numeric `code`, `name`, a stack-only secret, a plain error-like object with a nested `cause`, a thrown string, a DOMException, a child logger's fields, the message itself, the whole URL and a bare token. `cause` and AggregateError `errors` are dropped (log.js never prints them). Objects deeper than log.js's depth 4 print `[deep]`. Map and URL objects print `{}`. A secret split across two fields is not caught; that is unavoidable. |
| **Over-redaction** | Passwords `"`, `\`, `{`, `:`, `,`, `e` and `l` blank characters inside values and messages only. Keys, `level` and `time` stay intact and every line parses, because redaction runs before JSON encoding. This is noisy for 1-character passwords, as the builder said. |
| **Postgres bare user** | `postgres://name@h`: the bare name is not blanked by design. The generic `scheme://…@` rule still blanks it whenever the URL appears whole. libpq has no form where a password-less userinfo is a secret; a password goes in `:pw@` or `?password=`, and both are covered. |
| **L4/L5 timers** (scratch `l4.test.js`, fake clock, ttl 800, grace 200) | `watching` at 799 resolves `watching` at 999, which is within ttl + grace. Repeated `watching` does not extend the grace (resolves at first + 200). `held` after `watching` resolves at once. Late `held`/`watching` after a settle or reject leave 0 timers and `opening` 0. A publish rejection with 3 dedup waiters rejects all 3 at once, with 0 timers left. No case was unbounded. |
| **L6/L7 env** | `-`, `a-`, `-a`, `A`, `a_b`, 33 × `x`, `""`, `" a"`, `"a\n"` and `é` are refused, and the message carries no value. Default ids from `---`, `ÉCOLE`, `.host.` and `_…_b` are all valid ids. `""`, `"\t"` and NBSP URLs are refused and name the variable, with no value, even with a secret in the other URL. A zero-width-space URL is treated as set: it is cluster mode and then fails to open, which is acceptable. |
| **L3 sweep** | The builder's test fails the sweep-only mutant (below). The p4-wirev survivor is now killed. |

## Mutations (scratch copies, removed after each run)

Run against p4-wire2, main, room-host-lease, roles, nats-bus (and main-cluster for the last one).

| Mutation | Origin | Result |
|---|---|---|
| m1-servers-url: `connect({ servers: url, …})` | builder (M1) | caught: 3 fail |
| l4-ttl-kept: ttl timer not cancelled on `watching` | builder (L4) | caught: 1 fail |
| l5-no-identity: `inflight.get(key) !== r` check removed | builder (L5) | caught: 1 fail |
| l3-sweep: sweep's `drop` back to `slot.conns.delete(ck)` | builder (L3) | caught: 1 fail |
| mine-stack-raw: Error stack not redacted | mine | caught: 2 fail |
| mine-mixed-creds: differing credentials accepted | mine | caught: 1 fail |
| mine-regex-crosses: generic regex may cross `"` `'` `,` | mine | caught: 1 fail |
| mine-cli-unredacted: CLI logger not wrapped | mine | **survives** (74 pass; with live PG + NATS, 92 pass): finding L2 |

## Gates

| Gate | Result |
|---|---|
| `bun test test/server` × 5 | 5 of 5: 276 pass, 136 skip, 0 fail |
| `bun test` once | 1533 pass, 155 skip, **1 fail: test/core-source** (the known drift). The tab/tune tests did not fail. |
| test/architecture.test.js | 16 pass, 0 fail |
| `bun test test/server` on Postgres + NATS with auth | **399 pass, 11 skip, 0 fail**. Postgres 17 scram with a fake password. NATS had `authorization { user, password }` with a fake password, passed only via `NATS_URL=nats://plen:…@127.0.0.1:<port>`. The output has 0 occurrences of either password. |

## Processes and cleanup

- **Postgres 17:** PID 85454, 127.0.0.1, TCP only, data dir in the scratchpad. Stopped with `pg_ctl stop -m fast`.
- **nats-server:** PID 85493, `max_payload: 2MB`, user/password auth. Stopped by that PID (`kill`).
- **Check:** both PIDs confirmed gone. No pkill, killall, kill -9 or ipcrm.
- **`ipcs -m | wc -l`:** 11 before, 12 during, 10 after. The drop below the starting count is another process
  releasing a segment. No segment was removed by me.
- **Secrets:** `.env` was never read. The only passwords were fakes generated in the scratchpad.
- **Scratchpad: NOT deleted, because `rm` was denied in this session.** It holds the tree copy (`tree/`, no `.env`,
  `node_modules` a symlink), the attack tests in `tree/test/attack/` (m1, m1live, l2, l2throw, l4, l67), the stopped
  Postgres data dir (`pg/`), `logs/`, `nats.conf`, `ports`, `pg.pid`, `nats.pid`, and `pgpw`/`natspw` (fake
  passwords only). Deleting it is the manager's call.
