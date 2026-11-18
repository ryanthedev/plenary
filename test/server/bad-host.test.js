// A malformed Host header is the client's mistake: 400, no stack trace, at most one short debug line per second (row 14).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-badhost-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One raw HTTP exchange over TCP: the status line and the whole answer. */
async function raw(port, text) {
  let out = "";
  await new Promise((resolve, reject) => {
    Bun.connect({ hostname: "127.0.0.1", port, socket: {
      open(s) { s.write(text); },
      data(s, d) { out += new TextDecoder().decode(d); },
      close: resolve, error: (_, e) => reject(e), connectError: (_, e) => reject(e),
    } }).then(s => setTimeout(() => s.end(), 300), reject);
  });
  return out;
}

test("malformed Host headers answer 400 with no stack and no error log line; the server keeps serving", async () => {
  const lines = [];
  const app = await start({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "debug" }, { write: l => lines.push(l) });
  try {
    const port = app.server.port;
    const cases = { "empty Host": "GET /health HTTP/1.1\r\nHost:\r\n\r\n", "bare ::1": "GET /health HTTP/1.1\r\nHost: ::1\r\n\r\n",
      "userinfo": "GET /health HTTP/1.1\r\nHost: evil@localhost\r\n\r\n", "port too big": "GET /health HTTP/1.1\r\nHost: localhost:99999\r\n\r\n",
      "HTTP/1.0 without Host": "GET /health HTTP/1.0\r\n\r\n" };
    for (const [name, req] of Object.entries(cases)) {
      const res = await raw(port, req);
      expect([name, res.split("\r\n")[0]]).toEqual([name, "HTTP/1.1 400 Bad Request"]);
      expect(res).toContain('"bad-request"');
      expect(res).not.toMatch(/Invalid URL|at .*\.js|stack/i);
    }
    const got = lines.join("");
    expect(got).not.toContain('"level":"error"');
    expect(got).not.toMatch(/Invalid URL|http handler failed|stack/);
    expect(got.split("\n").filter(l => l.includes("bad request")).length).toBeLessThanOrEqual(2);   // one per second at most
    expect((await fetch(app.server.url + "/health")).status).toBe(200);
  } finally { await app.stop(); }
});

test("two servers in one process each log their own bad-Host line (the limiter is per server)", async () => {
  const [a, b] = [[], []];
  const d2 = mkdtempSync(join(tmpdir(), "plenary-badhost2-"));
  const one = await start({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "debug" }, { write: l => a.push(l) });
  const two = await start({ PLENARY_DATA_DIR: d2, PORT: "0", LOG_LEVEL: "debug" }, { write: l => b.push(l) });
  try {
    const bad = "GET /health HTTP/1.1\r\nHost: localhost:99999\r\n\r\n";
    await raw(one.server.port, bad);
    await raw(two.server.port, bad);
    for (const lines of [a, b]) expect(lines.join("").split("\n").filter(l => l.includes("bad request")).length).toBe(1);
  } finally { await one.stop(); await two.stop(); rmSync(d2, { recursive: true, force: true }); }
});
