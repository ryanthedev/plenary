import { test, expect } from "bun:test";
import { staticSite, DEFAULT_MOUNTS } from "../../server/adapters/driving/static.js";

test("the static handler serves favicon.ico from favicon.svg", async () => {
  const response = await staticSite({ mounts: DEFAULT_MOUNTS }).handle(new Request("http://localhost/favicon.ico"));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toBe("image/svg+xml");
  expect(await response?.text()).toContain("<svg");
});
