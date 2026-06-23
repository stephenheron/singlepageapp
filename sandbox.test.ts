import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isBlockedHost, runModule, invalidate } from "./sandbox.ts";
import { SITES_DIR } from "./config.ts";

const TEST_SITE = "_sandbox_test_site";
afterAll(() => rmSync(join(SITES_DIR, TEST_SITE), { recursive: true, force: true }));

test("SSRF guard blocks loopback, private, and link-local hosts", () => {
  for (const h of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.5.5.5",
    "0.0.0.0",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // cloud metadata
    "::1",
    "[::1]",
  ]) {
    expect(isBlockedHost(h)).toBe(true);
  }
});

test("SSRF guard allows public hosts", () => {
  for (const h of ["example.com", "api.github.com", "8.8.8.8", "172.32.0.1", "1.1.1.1"]) {
    expect(isBlockedHost(h)).toBe(false);
  }
});

test("runs a handler and returns its value", async () => {
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "echo.js"),
    `export default (req, ctx) => ctx.json({ echoed: req.query.n });`,
  );
  const r = await runModule(TEST_SITE, "server/echo.js", { query: { n: 5 } }, { deadlineMs: 2000 });
  expect(r.ok).toBe(true);
  if (r.ok) expect(JSON.parse((r.value as any).body).echoed).toBe(5);
});

// Regression: disposing a context must not leak handles / corrupt the shared
// QuickJS WASM module. Before the fix, the prelude eval result was leaked, so
// context.dispose() tripped a JS_FreeRuntime assertion and poisoned the module —
// every later run failed. This runs, invalidates (disposes), and runs again.
test("invalidate disposes cleanly and the engine stays usable", async () => {
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "ping.js"),
    `export default () => ({ status: 200, body: "pong" });`,
  );
  const first = await runModule(TEST_SITE, "server/ping.js", {}, { deadlineMs: 2000 });
  expect(first.ok).toBe(true);

  invalidate(TEST_SITE, "server/ping.js"); // disposes the context

  const second = await runModule(TEST_SITE, "server/ping.js", {}, { deadlineMs: 2000 });
  expect(second.ok).toBe(true); // rebuilt fine -> module not corrupted
  if (second.ok) expect((second.value as any).body).toBe("pong");
});

// Concurrent requests to the same handler must run on separate pooled contexts
// and all succeed (rather than clobbering one shared context's globals).
test("serves concurrent requests to the same handler", async () => {
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "id.js"),
    `export default async function (req) {
       await Promise.resolve();
       return { n: req.query.n };
     }`,
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      runModule(TEST_SITE, "server/id.js", { query: { n: i } }, { deadlineMs: 2000 }),
    ),
  );
  expect(results.every((r) => r.ok)).toBe(true);
  // Each call must get back its own input, not another's (no shared-global clobber).
  const got = results.map((r) => (r.ok ? (r.value as any).n : -1)).sort((a, b) => a - b);
  expect(got).toEqual(Array.from({ length: 12 }, (_, i) => i));
});
