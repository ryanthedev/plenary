// Issue #42 end to end, as deployed: `bun server/main.js` as a child process, a picture uploaded by the web client's
// wsNet, the process killed (SIGKILL: no shutdown hook runs), a new process on the same data dir, a fresh client that
// gets the bytes back through a signed URL. Also the blob settings main.js refuses at start.
import { test, expect, afterAll } from "bun:test";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { tempDir, cleanup, until, spawnTracked, fakePng, sha1 } from "./helpers.js";

afterAll(cleanup);
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

/** A web-client net, welcomed as the dev editor. After a kill -9 the dead host's lease holds the board for its ttl: the
 *  server answers `unavailable` and a client reconnects (rule 12), as the session does; this does the same by hand. */
async function client(port, board, name) {
  const net = wsNet({ url: `ws://127.0.0.1:${port}/ws`, WebSocket });
  const got = [];
  net.onFile(f => got.push(f));
  const tr = net.join(), msgs = [];
  tr.onMessage(m => msgs.push(m));
  const hello = () => tr.send({ t: "hello", v: 1, token: TOKEN, board, since: 0, client: name });
  hello();
  await until(async () => {
    if (msgs.some(m => m.t === "welcome")) return true;
    if (msgs.some(m => m.t === "error")) { msgs.length = 0; tr.reopen(); await Bun.sleep(400); hello(); }
    return false;
  }, "welcome", 20_000);
  return { net, got, close: () => tr.close() };
}

test("DW-42.1 DW-42.2 DW-42.3: upload, kill -9, restart on the same data, reload: the picture's bytes come back", async () => {
  const dir = tempDir(), bytes = fakePng(5000, 7), id = sha1(bytes);
  const file = { id, mimeType: "image/png", dataURL: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` };
  const env = { PLENARY_DATA_DIR: dir, COOKIE_KEY: "k".repeat(40), PLENARY_LEASE_TTL_MS: "3000", PLENARY_DEV_TOKENS: JSON.stringify({ [TOKEN]: { name: "ann", role: "editor" } }) };

  const p1 = spawn(env);
  const { port } = await p1.line("server listening"), { board } = await p1.line("dev tokens are ON: not for production");
  const up = await client(port, board, "up");
  up.net.put(file);
  await until(() => { try { return [...new Bun.Glob("*/*/*").scanSync(`${dir}/blobs`)].length === 1; } catch { return false; } }, "the blob on disk");
  up.close();
  p1.child.kill("SIGKILL"); await p1.child.exited;

  const p2 = spawn(env);
  const { port: port2 } = await p2.line("server listening"), again = await p2.line("dev tokens are ON: not for production");
  expect(again.board).toBe(board);
  const down = await client(port2, board, "down");
  down.net.want(id);                                                   // what the app does for an image element with no bytes
  const f = await until(() => down.got[0], "the bytes after the restart");
  expect(f).toEqual({ id, mimeType: "image/png", dataURL: file.dataURL });
  down.close();
  p2.child.kill("SIGTERM"); expect(await p2.child.exited).toBe(0);
}, 30_000);   // two process starts; a loaded machine slows them, it is not a bug

test("main.js refuses a half-set S3 config and a bad quota, naming the variables and never a secret", async () => {
  for (const [env, said] of [
    [{ S3_ENDPOINT: "http://127.0.0.1:1", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "hush-secret" }, "S3_BUCKET, S3_REGION"],
    [{ PLENARY_BLOB_QUOTA_BYTES: "ten" }, "PLENARY_BLOB_QUOTA_BYTES"],
    [{ PLENARY_BLOB_QUOTA_BYTES: "0" }, "PLENARY_BLOB_QUOTA_BYTES"],
  ]) {
    const p = spawn({ PLENARY_DATA_DIR: tempDir(), ...env });
    expect(await p.child.exited).not.toBe(0);
    expect(p.out.err + p.out.text).toContain(said);
    expect(p.out.err + p.out.text).not.toContain("hush-secret");
  }
});
