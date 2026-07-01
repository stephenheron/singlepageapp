import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  isBlockedHost,
  blockedHostReason,
  runModule,
  invalidate,
  __poolSnapshot,
} from "./sandbox.ts";
import { kvClass, kvGet } from "./kv.ts";
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

test("SSRF guard blocks IPv4-mapped IPv6 forms", () => {
  for (const h of ["::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:169.254.169.254"]) {
    expect(isBlockedHost(h)).toBe(true);
  }
});

test("blockedHostReason rejects blocked literals without resolving", async () => {
  const explode = async () => {
    throw new Error("resolver should not be called for a blocked literal");
  };
  expect(await blockedHostReason("127.0.0.1", explode)).toBeTruthy();
  expect(await blockedHostReason("169.254.169.254", explode)).toBeTruthy();
});

test("blockedHostReason rejects names that resolve to a blocked address (DNS rebinding)", async () => {
  const toMetadata = async () => ["169.254.169.254"]; // attacker A-record -> cloud metadata
  expect(await blockedHostReason("evil.example.com", toMetadata)).toBe(
    "host resolves to a blocked address",
  );
  const toLoopback = async () => ["93.184.216.34", "127.0.0.1"]; // one bad address is enough
  expect(await blockedHostReason("mixed.example.com", toLoopback)).toBe(
    "host resolves to a blocked address",
  );
});

test("blockedHostReason allows names that resolve to public addresses", async () => {
  const toPublic = async () => ["93.184.216.34"];
  expect(await blockedHostReason("example.com", toPublic)).toBeNull();
});

test("blockedHostReason rejects names that fail to resolve", async () => {
  const nxdomain = async () => {
    throw new Error("ENOTFOUND");
  };
  // e.g. an alternate IP encoding that isn't a valid hostname and won't resolve.
  expect(await blockedHostReason("0x7f000001", nxdomain)).toBe("host did not resolve");
  const empty = async () => [];
  expect(await blockedHostReason("void.example.com", empty)).toBe("host did not resolve");
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

test("ctx.user exposes a private per-user store, and is null without a caller", async () => {
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "profile.js"),
    `export default (req, ctx) => {
      if (!ctx.user) return ctx.json({ user: null });
      ctx.user.kv.set("name", req.query.name);
      return ctx.json({ id: ctx.user.id, name: ctx.user.kv.get("name"), keys: ctx.user.kv.keys() });
    };`,
  );

  // With a caller: writes land under user:<id>:* as private, scoped to the id.
  const r = await runModule(
    TEST_SITE,
    "server/profile.js",
    { query: { name: "Ada" } },
    { deadlineMs: 2000, user: { id: "u123" } },
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    const body = JSON.parse((r.value as any).body);
    expect(body.id).toBe("u123");
    expect(body.name).toBe("Ada");
    expect(body.keys).toEqual(["name"]); // namespace stripped, only this user's keys
  }
  expect(kvClass(TEST_SITE, "user:u123:name")).toBe("private");
  expect(kvGet(TEST_SITE, "user:u123:name")).toBe('"Ada"');

  // No caller (e.g. cron): ctx.user is null. Reuses the pooled context, proving
  // the per-call __user reset works rather than leaking the prior id.
  const cron = await runModule(TEST_SITE, "server/profile.js", {}, { deadlineMs: 2000 });
  expect(cron.ok).toBe(true);
  if (cron.ok) expect(JSON.parse((cron.value as any).body).user).toBeNull();
});

test("ctx.env exposes the site's .env and re-reads it per call", async () => {
  const envPath = join(SITES_DIR, TEST_SITE, ".env");
  await Bun.write(envPath, "API_KEY=first\nOTHER=x\n");
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "env.js"),
    `export default (req, ctx) => ctx.json({ key: ctx.env.API_KEY, missing: ctx.env.NOPE ?? null });`,
  );

  const r = await runModule(TEST_SITE, "server/env.js", {}, { deadlineMs: 2000 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    const body = JSON.parse((r.value as any).body);
    expect(body.key).toBe("first");
    expect(body.missing).toBeNull();
  }

  // Rewrite .env; a pooled context must serve the fresh value, not a baked one.
  await Bun.write(envPath, "API_KEY=second\n");
  const r2 = await runModule(TEST_SITE, "server/env.js", {}, { deadlineMs: 2000 });
  expect(r2.ok).toBe(true);
  if (r2.ok) expect(JSON.parse((r2.value as any).body).key).toBe("second");
});

test("ctx.env is frozen so handlers can't mutate the shared context", async () => {
  await Bun.write(join(SITES_DIR, TEST_SITE, ".env"), "A=1\n");
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "freeze.js"),
    `export default (req, ctx) => {
      try { ctx.env.A = "mutated"; } catch (e) {}
      return ctx.json({ a: ctx.env.A });
    };`,
  );
  const r = await runModule(TEST_SITE, "server/freeze.js", {}, { deadlineMs: 2000 });
  expect(r.ok).toBe(true);
  if (r.ok) expect(JSON.parse((r.value as any).body).a).toBe("1");
});

test("ctx.kv.set forwards a visibility class to the backend", async () => {
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "secret.js"),
    `export default (req, ctx) => {
      ctx.kv.set("apiKey", "s3cret", { class: "private" });
      ctx.kv.set("config", { theme: "dark" }, { class: "readonly" });
      ctx.kv.set("count", 1);
      ctx.kv.setClass("count", "private");
      return ctx.json({ ok: true });
    };`,
  );
  const r = await runModule(TEST_SITE, "server/secret.js", {}, { deadlineMs: 2000 });
  expect(r.ok).toBe(true);
  expect(kvClass(TEST_SITE, "apiKey")).toBe("private");
  expect(kvClass(TEST_SITE, "config")).toBe("readonly");
  expect(kvClass(TEST_SITE, "count")).toBe("private");
  expect(kvGet(TEST_SITE, "apiKey")).toBe('"s3cret"');
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

// Regression: a handler that kicks off an async host call WITHOUT awaiting it
// (detached / fire-and-forget) returns before that call settles. The context
// must NOT go back into the idle pool while that work is in flight — otherwise
// the next request reuses the same VM and the old request's continuation resumes
// against the new request's globals/module state (executePendingJobs runs it).
// We assert the invariant directly: no idle context ever has in-flight refs.
test("detached async work keeps the context out of the idle pool", async () => {
  // Fires ctx.fetch but does not await it, then returns immediately. The fetch is
  // still draining (network RTT >> the sync gap before we snapshot below).
  await Bun.write(
    join(SITES_DIR, TEST_SITE, "server", "detached.js"),
    `export default function (req, ctx) {
       ctx.fetch("https://example.com").then(() => {}).catch(() => {});
       return { accepted: true };
     }`,
  );
  const r = await runModule(TEST_SITE, "server/detached.js", {}, { deadlineMs: 3000 });
  expect(r.ok).toBe(true);

  // The handler has returned but its detached fetch is still in flight. Before the
  // fix, releaseEntry pushed this context (refs === 1) straight into idle, where the
  // next request could check it out. It must be parked instead, not idle-reusable.
  const snap = __poolSnapshot(TEST_SITE, "server/detached.js");
  expect(snap?.idleInflight ?? 0).toBe(0);
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
