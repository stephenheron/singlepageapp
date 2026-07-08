import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR } from "./config.ts";
import { metaGet, kvGet } from "./kv.ts";

// api.ts reads SINGLEPAGE_APP_TOKEN at import time and exits if it's unset, so set
// the admin token first, then import it dynamically (after the env is in place).
const ADMIN = "test-admin-token";
process.env.SINGLEPAGE_APP_TOKEN = ADMIN;
const { handleApi } = await import("./api.ts");

const created: string[] = [];
afterAll(() => {
  for (const name of created) rmSync(join(SITES_DIR, name), { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const u = new URL(`http://test.local${path}`);
  return handleApi(new Request(u.href, { method, headers, body }), u);
}

async function createSite(base: string): Promise<{ name: string; deployKey: string }> {
  const res = await call("POST", "/api/sites", { token: ADMIN, json: { name: base } });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { name: string; deployKey: string };
  created.push(data.name);
  return data;
}

const putFile = (name: string, token: string) =>
  call("PUT", `/api/sites/${name}/files?path=public/probe.html`, { token, body: "<h1>hi</h1>" });

test("site creation requires the admin token", async () => {
  expect((await call("POST", "/api/sites", { json: { name: "auth-noauth" } })).status).toBe(401);
  expect(
    (await call("POST", "/api/sites", { token: "wrong", json: { name: "auth-wrong" } })).status,
  ).toBe(401);

  const { name, deployKey } = await createSite("auth-create");
  expect(name).toBe("auth-create");
  expect(deployKey.startsWith("sp_")).toBe(true);
});

test("created site url uses the request's scheme/authority, not the internal port", async () => {
  // Simulate the front proxy: browser reached us on https at the apex domain
  // with no explicit port. The returned url must reflect that, not :3000.
  const u = new URL("http://internal-host:3000/api/sites");
  const req = new Request(u.href, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      host: "singlepageapp.co",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ name: "auth-proxied" }),
  });
  const res = await handleApi(req, u);
  const data = (await res.json()) as { name: string; url: string };
  created.push(data.name);
  expect(data.url).toBe("https://auth-proxied.singlepageapp.co/");
});

test("deploy key is stored hashed and never in the client-readable kv store", async () => {
  const { name, deployKey } = await createSite("auth-hashed");
  const stored = metaGet(name, "deploy_key_hash");
  expect(stored).not.toBeNull();
  expect(stored).not.toBe(deployKey); // stored as a hash, not the raw key
  // The secret must not be reachable via /__kv (the kv table).
  expect(kvGet(name, "deploy_key_hash")).toBeNull();
});

test("file writes require the site's deploy key, not the admin token", async () => {
  const { name, deployKey } = await createSite("auth-files");

  expect((await putFile(name, ADMIN)).status).toBe(401); // admin token can't deploy
  expect((await putFile(name, "sp_bogus")).status).toBe(401); // wrong key

  const ok = await putFile(name, deployKey);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
});

test(".env uploads to the site root (never public/), other root files are rejected", async () => {
  const { name, deployKey } = await createSite("auth-env");

  // .env is allowed, gated by the deploy key, and lands at the site root — not
  // under public/, so it is never served.
  const put = await call("PUT", `/api/sites/${name}/files?path=.env`, {
    token: deployKey,
    body: "API_KEY=secret\n",
  });
  expect(put.status).toBe(200);
  expect(await Bun.file(join(SITES_DIR, name, ".env")).text()).toBe("API_KEY=secret\n");
  expect(await Bun.file(join(SITES_DIR, name, "public", ".env")).exists()).toBe(false);

  // The admin token can't write it (file writes need the site's deploy key).
  expect(
    (await call("PUT", `/api/sites/${name}/files?path=.env`, { token: ADMIN, body: "X=1" })).status,
  ).toBe(401);

  // Arbitrary site-root files remain disallowed (only public/server/cron + the
  // singlepage.json / .env allow-list can be written).
  expect(
    (await call("PUT", `/api/sites/${name}/files?path=secrets.txt`, { token: deployKey, body: "x" }))
      .status,
  ).toBe(400);
});

test("a deploy key is scoped to its own site", async () => {
  const a = await createSite("auth-scope-a");
  const b = await createSite("auth-scope-b");

  expect((await putFile(a.name, b.deployKey)).status).toBe(401); // B's key can't touch A
  expect((await putFile(a.name, a.deployKey)).status).toBe(200);
});

test("rotation issues a new key and invalidates the old one", async () => {
  const { name, deployKey: key1 } = await createSite("auth-rotate");
  expect((await putFile(name, key1)).status).toBe(200);

  // rotation requires admin
  expect((await call("POST", `/api/sites/${name}/deploy-key`)).status).toBe(401);
  // rotating an unknown site is a 404
  expect((await call("POST", "/api/sites/does-not-exist/deploy-key", { token: ADMIN })).status).toBe(
    404,
  );

  const res = await call("POST", `/api/sites/${name}/deploy-key`, { token: ADMIN });
  expect(res.status).toBe(200);
  const { deployKey: key2 } = (await res.json()) as { deployKey: string };
  expect(key2).not.toBe(key1);

  expect((await putFile(name, key1)).status).toBe(401); // old key dead
  expect((await putFile(name, key2)).status).toBe(200); // new key works
});
