# Review: tryit round 3 (530d5a2, base c9f83cb), independent

Worktree `/Users/r/loops/plenary/wt/tryit`, branch `plenary/tryit`. Reviewed `git diff c9f83cb..530d5a2` (server/main.js,
server/server.js, README.md, deploy/README.md, test/server/bad-host.test.js, test/server/dev-menu.test.js) against
round 2's findings (`tryit-v2.md`: H1, L1-L5, TECH-DEBT row 14) and the coordinator's rule. Nothing committed. Probes
in the scratchpad (`tryv3-76182`). Processes I started, each stopped by its recorded pid: the host-only cluster node
(pid 82650, port 55319), the Try it server (pid 84435, port 8099). The rig `tryv3-76182` was brought down with
`--clean`. The three headless Chrome tabs I opened were closed; `tab-1` was there before me and was left alone.

## Executed results

- `bun test` (repo root, once): **1623 pass, 155 skip, 0 fail**, 1778 tests across 99 files, 270.4 s, exit 0.
- `test/server/bad-host.test.js` + `test/server/dev-menu.test.js`, run 5 times: 16 pass / 0 fail each time.
- Mutation: with `const host = "127.0.0.1"` in place of `env.HOST || "127.0.0.1"` (main.js:384), `bun test test/server/`
  still passes, 293/0 (M1 below). main.js was restored from a copy and `git status` is clean.

## Round 2 findings

| # | Round 2 | Now |
|---|---|---|
| H1 | a plain token for a name that also has an admin/domain token was offered and carried tenant-admin power | **Fixed.** main.js:378 collects every name on a token with `admin === true` or a truthy `domain`; main.js:381 skips those names (all their tokens). Probes below. New test dev-menu.test.js:41-51. |
| L1 | reverse proxy: loopback Host from nginx | **Fixed.** devMenuOff takes `publicHost` (main.js:269); a non-loopback PUBLIC_URL turns it off. README and deploy/README say so. Probes below. |
| L2 | half-configured Google silent | **Fixed.** main.js:327-328 warns, naming the missing half; tested (dev-menu.test.js:53-63). |
| L3 | no-gateway node logs at info | **Fixed.** main.js:331 warns with devMenuOff's wording. Seen live (below). |
| L4 | TECH-DEBT rows 12, 13 still OPEN | **Fixed.** Both read `FIXED c9f83cb`; row 14 reads `FIXED 530d5a2`. |
| L5 | a test binds 0.0.0.0 | **Fixed**, but the replacement leaves the HOST wiring untested: M1. |
| row 14 | malformed Host → 500 + stack | **Fixed.** server.js:46-48 answers 400 `{"error":"bad-request"}`; server.js:80-86 logs one debug line per second at most. |

## 1. Same-name and identity variants (through `start()`, `GET /auth/dev`)

Identity rules (server/auth/dev.js:13, 21): a name must match `^[A-Za-z0-9_.@-]{1,64}$` or `start()` throws; the user
is `"dev:" + name`, case-sensitive. Tenant admin is matched on the exact user id (server/admin/boards.js:46); an `email:`
admin matches only `google:` callers (boards.js:47).

| Tokens | Menu |
|---|---|
| round-2 H1: `SECRET-ADM {ann, acme.test, admin}`, `SECRET-PLAIN {ann, editor}`, `tok-a {ada}` | `ada=tok-a` only |
| same, without ada | 404 |
| plain token listed before the admin token | `ada=tok-a` only |
| `Ann` admin+domain, `ann` plain | `ann` offered. `dev:Ann` ≠ `dev:ann`: with `tok-plain`, PUT grant → 403, POST /boards → 403. Correct: a distinct user. |
| `"ann "` (trailing space), `"аnn"` (Cyrillic а) | `start()` throws: `dev: token entry needs a name` |
| `dee` on a domain token (no admin) + plain `dee` | `ada` only |
| `xa` with `admin:true`, no domain, + plain `xa` | `ada` only (conservative: such a token makes no tenant) |
| `st` with `admin:"true"` (string), `domain:""` | `st` offered. Not an admin anywhere (main.js:367 needs `=== true`): PUT grant → 403, POST /boards → 403. Correct. |
| domain `"  "` + plain | `ww` not offered |

Two names mapping to one user id: impossible; the id is `dev:` + the exact name and the name charset is fixed.
No token value appeared in any log line (`/SECRET/` absent in every case).

## 2. PUBLIC_URL and bad Host

PUBLIC_URL (dev tokens on, loopback): `http://127.1:8099`, `http://[::1]:8099`, `http://LOCALHOST:8099`,
`http://0x7f000001/` → 200 (URL normalises all of them to loopback names). `https://localhost.evil.com`,
`http://127.0.0.2/`, `http://plenary.example.com`, `http://user@plenary.example.com` → 404 with the warn
`… is OFF: PUBLIC_URL (plenary.example.com) is not a loopback name`. Values whose hostname is empty or that do not parse
(`plenary.example.com:443`, `file:///x`, `mailto:a@b.c`, `plenary.example.com`, `http://…:99999`) make `start()`
throw: `config.postLoginUrl/publicUrl must be an absolute URL` or `Invalid URL`, also with POST_LOGIN_URL and BOARD_URL
set explicitly. So the `publicHost` falsy branch cannot let a bad PUBLIC_URL through.

Bad Host flood: 1000 raw requests (empty Host, bare `::1`, `evil@localhost`, `localhost:99999`, HTTP/1.0 with no
Host; 50 at a time) against a server at `LOG_LEVEL=debug`: **1000 × `HTTP/1.1 400 Bad Request`**, 48 ms, **1 log line**
(`{"level":"debug","msg":"bad request: the URL (Host header) did not parse"}`), 0 lines with `stack`/`error`/
`Invalid URL`; `/health` 200 afterwards. At `LOG_LEVEL=info`: 1000 × 400, 0 lines. The host-only cluster node also
answered `evil@localhost` with 400.

## 3. No-gateway node (cluster)

`cluster-rig.js up --services-only --name tryv3-76182` (Postgres 55275, NATS 55285, MinIO). A node from wt/tryit with a
minimal env: `DATABASE_URL`, `NATS_URL`, `COOKIE_KEY`, `PLENARY_ROLES=host`, `PLENARY_NODE_ID=tryv3-host`,
`PLENARY_DEV_TOKENS='{"SECRET-ada":{"name":"ada","role":"owner"}}'`. Log:

```
{"…","level":"info","msg":"sign-in"}   devTokens "[redacted]", cluster true
{"level":"warn","msg":"dev tokens are on, but the dev sign-in menu (GET /auth/dev) is OFF: this node has no gateway role (no dev board on this node)"}
{"port":55319,"gateway":null,"roles":{"gateway":false,"host":true},"level":"info","msg":"server listening"}
```

Exactly one warn line. `/auth/dev`, `/auth/dev?x`, `/`, `/?as=ada` → 404 `{"error":"not-found"}`. `SECRET` absent
from the log. Node stopped by pid; `down --name tryv3-76182 --clean` stopped minio, nats, postgres and removed the rig dir.

## 4. README Try it, literally (headless Chrome)

The README command, word for word, on port 8099. Log: `dev sign-in menu is ON … {users:2, host:127.0.0.1}`, `dev tokens are ON:
not for production`, `server listening {port:8099}`; no token value in the log, no error lines.
- `localhost:8099/?as=ada`: canvas loads, the status pill reads "Live", `👁 0 viewers`, the session is in sessionStorage.
- `localhost:8099/?as=bo`: session `{"token":"dev-bo","user":"dev:bo",…}`. I drew a rectangle (R, drag): "1 selected".
- ada's tab then shows the same rectangle, with a dashed remote selection (bo's). Screenshots of both tabs show this,
  so the shape synced.
- `localhost:8099/` with no `?as=`: "Dev sign-in is on: pick a user." with `Continue as ada (owner)` / `Continue as bo
  (editor)` and no Google button.
- `curl 127.0.0.1:8099/auth/dev` → 200; with `Host: evil.example:8099` → 404.

## Single gate

`devMenuOff` is the only producer of `config.devSignIn` on a gateway (main.js:384-389), and http.js serves `/auth/dev`
only from it. On a no-gateway node, the decision is still made by its own `if (dev.enabled && !roles.gateway)` at
main.js:331. That branch calls `devMenuOff` only for the wording, with `users: 1` hardcoded. It is safe either way:
server.js:51 serves nothing but `/health` without a gateway. I accept this as one gate in effect (LOW-1).

## Findings

### HIGH

None.

### MEDIUM

**M1. The L5 fix removed the only end-to-end check that `HOST` reaches the gate, which weakens a test.**
- c9f83cb's dev-menu.test.js:58 ran `start()` with `HOST=0.0.0.0` and expected 404. 530d5a2 replaces it with a comment
  (dev-menu.test.js:82) pointing to the devMenuOff unit line (:118). That line already existed in c9f83cb (:93), so the
  test that was dropped had no replacement.
- Demonstrated: change main.js:384 to `const host = "127.0.0.1";` (the env is ignored). Then a HOST=0.0.0.0 server with
  dev tokens would publish the menu on every interface, and `bun test test/server/` still passes 293/0. No other test
  sets `HOST` (grep `HOST:` over test/).
- Fix: a `start()` case with a host that binds loopback yet is not on the list. Round 2 showed `HOST=127.1` does this
  (binds 127.0.0.1, menu 404 with warn `HOST=127.1 is not a loopback address`). Assert the 404 and the warn line. It
  listens only on loopback, so L5's concern is kept.

**M2. A published token can still be a tenant admin through registry state. This predates the diff, but it is the
same harm as H1.**
- The rule as written holds: the menu checks only the current token table. Tenant admins live in the Registry and
  persist: main.js:372 `bootstrapTenant` adds `dev:<name>`, and scripts/admin-bootstrap.js `--admin dev:<name>` does the
  same, as README.md:151 documents.
- Demonstrated (scratch `probe.test.js`, one data dir):
  - Run 1, `{"SECRET-ADM":{name:"ann",domain:"acme.test",admin:true}}`: POST /boards → 201 (board B).
  - Run 2 is restarted with only `{"tok-plain":{name:"ann",role:"editor"}}`. `GET /auth/dev` → `ann=tok-plain`.
  - With `tok-plain`, `PUT /boards/B/grants/dev%3Amallory {"role":"owner"}` → **204** (`registry.grant` = owner), and
    `GET /boards/B/links` → 200.
- The README Try it uses a fresh `mktemp -d`, so the literal path is not exposed. A reused `PLENARY_DATA_DIR`, or the
  documented admin-bootstrap CLI with `--admin dev:<name>`, is.
- Under the brief's rules this is not a blocker, because the rule is about tokens. It is ranked MEDIUM for the
  coordinator to decide.
- A fix would be to leave out any name whose `dev:<name>` is an admin of any tenant: tenants seen through
  `registry.tenantByDomain` for the token domains are not enough, so this needs a Registry query or a stored list of dev
  admins.

### LOW

**LOW-1. The no-gateway decision sits outside `devMenuOff` (main.js:331), which only supplies the wording.** As covered
above, nothing is served there, so the effect is the same. If "single gate" is meant literally, compute `off` once,
before the `if`, and branch on it.

**LOW-2. `lastBad` is module-global (server.js:82).** Every server in one process shares the one-per-second budget. That
is harmless (one fewer debug line), but a second server's first bad request may go unlogged.

**LOW-3. One cleanup item is left.** The Try it data dir `/var/folders/dy/1lbkhxw51n5fwjypm906j9xh0000gn/T/tmp.B4NVLcAd8l`
(created by the README's `mktemp -d`) could not be removed: the permission was denied. It holds only a dev board and
SQLite files.

## Not findings (checked)

- Name case, whitespace and unicode variants cannot alias a privileged user: probes above.
- `admin` not exactly `true` gives no admin power and is offered. That is correct.
- Empty-host or unparsable PUBLIC_URL values refuse the start rather than slip past the falsy `publicHost`.
- No token value in any log: every probe, the cluster node and the live Try it.
- TECH-DEBT.md: rows 12-14 read FIXED with commits.

## Verdict

**FAIL** on M1: the L5 change dropped the only test that `HOST` reaches the gate, and that is test weakening (shown by
a surviving mutant). H1, L1-L4 and row 14 are fixed and verified, including the cluster no-gateway path and the README
Try it in headless Chrome. M2 (admin power published through persisted registry state) predates this diff and is
outside the rule as worded; the coordinator decides.
