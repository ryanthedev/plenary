// scripts/dev-google.js portBusy (p5-googlev LOW 2): anything accepting TCP on 127.0.0.1 or ::1 counts as busy, HTTP or
// not, so the harness and the live server check never start beside a silent listener. Always runs; local only.
import { test, expect } from "bun:test";
import { listening, portBusy } from "../../scripts/dev-google.js";

const silent = hostname => Bun.listen({ hostname, port: 0, socket: { data() {} } });   // accepts, never answers

for (const host of ["::1", "127.0.0.1"]) {
  test(`a silent listener on ${host} reads busy; after it stops, free`, async () => {
    const srv = silent(host);
    try {
      expect(await listening(host, srv.port)).toBe(true);
      expect(await portBusy(srv.port)).toBe(true);
    } finally { srv.stop(true); }
    expect(await portBusy(srv.port)).toBe(false);
  });
}

test("a port nobody holds is free on both", async () => {
  const srv = silent("127.0.0.1");
  const port = srv.port;
  srv.stop(true);
  expect(await listening("127.0.0.1", port)).toBe(false);
  expect(await listening("::1", port)).toBe(false);
});
