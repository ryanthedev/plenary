// Issue #42 end to end, as deployed: `bun server/main.js` as a child process, a picture uploaded by the web client's
// wsNet, the process killed (SIGKILL: no shutdown hook runs), a new process on the same data dir, a fresh client that
// gets the bytes back through a signed URL. Also the blob settings main.js refuses at start.
import { test, expect, afterAll } from "bun:test";
import { appClient, restoreAppGlobals } from "../web/app-client.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { tempDir, cleanup, until, spawnTracked, fakePng, sha1 } from "./helpers.js";

afterAll(() => { restoreAppGlobals(); cleanup(); });
const MAIN = new URL("../../server/main.js", import.meta.url).pathname;
const TOKEN = "S3CR3T-blobs-main";

function spawn(env) {
  const child = spawnTracked([process.execPath, MAIN], { cwd: tempDir("plenary-main-cwd-"), env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = { text: "", err: "" };
  const pump = async (stream, key) => { const dec = new TextDecoder(); for await (const chunk of stream) out[key] += dec.decode(chunk, { stream: true }); };
  pump(child.stdout, "text"); pump(child.stderr, "err");
  const line = msg => until(() => out.text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(l => l?.msg === msg), `log line "${msg}" (stderr: ${out.err.slice(0, 300)})`);
  return { child, out, line };
}

const open = (port, board) => appClient({ url: `ws://127.0.0.1:${port}/ws`, board, token: TOKEN, user: "dev:ann" });

test("DW-42.1 DW-42.2 DW-42.3: upload, kill -9, restart on the same data, reload: the app draws the picture's bytes again", async () => {
  const dir = tempDir(), bytes = fakePng(5000, 7), id = sha1(bytes);
  const dataURL = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  const env = { PLENARY_DATA_DIR: dir, COOKIE_KEY: "k".repeat(40), PLENARY_LEASE_TTL_MS: "3000", PLENARY_DEV_TOKENS: JSON.stringify({ [TOKEN]: { name: "ann", role: "editor" } }) };
  let up, down;
  try {
    const p1 = spawn(env);
    const { port } = await p1.line("server listening"), { board, tenant } = await p1.line("dev tokens are ON: not for production");
    up = open(port, board);
    await up.until(() => up.S.role === "presenter", "welcome as a presenter");
    expect(up.upload({ id, mimeType: "image/png", dataURL, width: 100, height: 80 })).toBeTruthy();
    // The bytes on disk and the element in the log (read through a second handle on the same SQLite file).
    const onDisk = () => { try { return [...new Bun.Glob("*/*/*").scanSync(`${dir}/blobs`)].length === 1; } catch { return false; } };
    const peek = sqliteStore({ path: `${dir}/plenary.db` });
    try { await up.until(async () => onDisk() && (await peek.lastSeq(tenant, board)) >= 1, "the blob on disk and the element in the log"); }
    finally { await peek.close(); }
    up.close();
    p1.child.kill("SIGKILL"); await p1.child.exited;

    const p2 = spawn(env);
    const { port: port2 } = await p2.line("server listening"), again = await p2.line("dev tokens are ON: not for production");
    expect(again.board).toBe(board);
    down = open(port2, board);
    // After a kill -9 the dead host's lease holds the board for its ttl: the app's own reconnect (rule 12) gets in when it runs out.
    await down.until(() => down.S.eds.board.doc.files[id]?.dataURL === dataURL, "the picture's bytes in the reloaded page", 30_000);
    expect(down.wanted).toContain(id);
    p2.child.kill("SIGTERM"); expect(await p2.child.exited).toBe(0);
  } finally { up?.close(); down?.close(); }
}, 60_000);   // two process starts and a lease ttl; a loaded machine slows them, it is not a bug

test("main.js refuses a half-set S3 config and a bad quota, naming the variables and never a secret", async () => {
  for (const [env, said] of [
    [{ S3_ENDPOINT: "http://127.0.0.1:1", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "hush-secret" }, "S3_BUCKET, S3_REGION"],
    [{ PLENARY_BLOB_QUOTA_BYTES: "ten" }, "PLENARY_BLOB_QUOTA_BYTES"],
    [{ PLENARY_BLOB_QUOTA_BYTES: "0" }, "PLENARY_BLOB_QUOTA_BYTES"],
    // A cluster node must name its picture storage: S3, or the explicit single-gateway opt-in. Refused before any URL is used.
    [{ DATABASE_URL: "postgres://u:hush-pw@127.0.0.1:1/p", NATS_URL: "nats://127.0.0.1:1", COOKIE_KEY: "k".repeat(32) }, "S3_ENDPOINT"],
    [{ DATABASE_URL: "postgres://u:hush-pw@127.0.0.1:1/p", NATS_URL: "nats://127.0.0.1:1", COOKIE_KEY: "k".repeat(32) }, "PLENARY_BLOBS=local-disk"],
    [{ PLENARY_BLOBS: "s3" }, "PLENARY_BLOBS must be"],
    [{ PLENARY_BLOBS: "local-disk", S3_ENDPOINT: "http://127.0.0.1:1" }, "pick one"],
  ]) {
    const p = spawn({ PLENARY_DATA_DIR: tempDir(), ...env });
    expect(await p.child.exited).not.toBe(0);
    expect(p.out.err + p.out.text).toContain(said);
    expect(p.out.err + p.out.text).not.toContain("hush-secret");
    expect(p.out.err + p.out.text).not.toContain("hush-pw");
  }
}, 60_000);   // seven `bun server/main.js` start-ups in a row: failure-only ceiling for a loaded machine (TECH-DEBT row 36)
