import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR, MAX_KV_VALUE_BYTES } from "./config.ts";
import { ensureDb, kvClass, kvGet, kvVisibleKeys, handleKv } from "./kv.ts";

// identity derives its HMAC secret from the admin token; set it before importing.
process.env.SINGLEPAGE_APP_TOKEN ??= "test-admin-token";
const { resolveIdentity, verify, handleMe } = await import("./identity.ts");

const SITE = "_identity_test_site";
const OTHER = "_identity_test_other";
ensureDb(SITE);
ensureDb(OTHER);
afterAll(() => {
  for (const s of [SITE, OTHER]) rmSync(join(SITES_DIR, s), { recursive: true, force: true });
});

/** Build a Request carrying a Cookie header. */
function req(cookie?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  return new Request("http://x.local/", { ...init, headers });
}

/** Mint a fresh identity for `site` and return its id + the cookie pair to replay. */
function mint(site: string): { id: string; cookie: string } {
  const ident = resolveIdentity(req(), site);
  expect(ident.setCookie).not.toBeNull();
  const value = ident.setCookie!.split(";")[0]!; // "sp_uid=<uuid>.<sig>"
  return { id: ident.id, cookie: value };
}

test("mints a signed id when no cookie is present, then verifies it on replay", () => {
  const { id, cookie } = mint(SITE);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  // Replaying the minted cookie verifies to the same id and sets no new cookie.
  const back = resolveIdentity(req(cookie), SITE);
  expect(back.id).toBe(id);
  expect(back.setCookie).toBeNull();
});

test("the Set-Cookie is HttpOnly, SameSite=Lax, Path=/ and lives the 400-day max", () => {
  const ident = resolveIdentity(req(), SITE);
  const sc = ident.setCookie!;
  expect(sc).toContain("HttpOnly");
  expect(sc).toContain("SameSite=Lax");
  expect(sc).toContain("Path=/");
  expect(sc).toContain("Max-Age=34560000"); // 400 days, the browser-enforced ceiling
  expect(sc).not.toContain("Secure"); // http request -> no Secure
});

test("adds Secure when the request is HTTPS (forwarded proto)", () => {
  const ident = resolveIdentity(req(undefined, { headers: { "x-forwarded-proto": "https" } }), SITE);
  expect(ident.setCookie).toContain("Secure");
});

test("a tampered signature is rejected and a fresh id is minted", () => {
  const { id, cookie } = mint(SITE);
  const tampered = cookie.slice(0, -2) + (cookie.endsWith("a") ? "bb" : "aa");
  expect(verify(SITE, tampered.replace("sp_uid=", ""))).toBeNull();
  const back = resolveIdentity(req(tampered), SITE);
  expect(back.id).not.toBe(id);
  expect(back.setCookie).not.toBeNull(); // re-minted
});

test("a cookie signed for another site does not verify (no cross-site replay)", () => {
  const { cookie } = mint(SITE);
  const value = cookie.replace("sp_uid=", "");
  expect(verify(SITE, value)).not.toBeNull();
  expect(verify(OTHER, value)).toBeNull(); // foreign site rejects it
});

test("GET /__me returns the verified id", async () => {
  const { id, cookie } = mint(SITE);
  const { id: rid } = resolveIdentity(req(cookie), SITE);
  const res = await handleMe(req(cookie), SITE, rid, "/__me");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { id: string }).id).toBe(id);
});

test("per-user kv round-trips and is stored private under the user namespace", async () => {
  const { id } = mint(SITE);
  const put = await handleMe(
    new Request("http://x.local/__me/kv/cart", { method: "PUT", body: JSON.stringify([1, 2, 3]) }),
    SITE,
    id,
    "/__me/kv/cart",
  );
  expect(put.status).toBe(200);

  // Stored under user:<id>:cart, classified private.
  expect(kvClass(SITE, `user:${id}:cart`)).toBe("private");
  expect(kvGet(SITE, `user:${id}:cart`)).toBe("[1,2,3]");

  // Read it back through /__me/kv.
  const get = await handleMe(req(), SITE, id, "/__me/kv/cart");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual([1, 2, 3]);

  // Listing returns the key with the namespace stripped.
  const keys = await handleMe(req(), SITE, id, "/__me/kv");
  expect(await keys.json()).toContain("cart");

  // Delete removes it.
  const del = await handleMe(
    new Request("http://x.local/__me/kv/cart", { method: "DELETE" }),
    SITE,
    id,
    "/__me/kv/cart",
  );
  expect(del.status).toBe(200);
  expect(kvGet(SITE, `user:${id}:cart`)).toBeNull();
});

test("per-user kv PUT rejects a value over the size cap and stores nothing", async () => {
  const { id } = mint(SITE);
  const tooBig = '"' + "x".repeat(MAX_KV_VALUE_BYTES) + '"'; // > MAX bytes
  const put = await handleMe(
    new Request("http://x.local/__me/kv/big", { method: "PUT", body: tooBig }),
    SITE,
    id,
    "/__me/kv/big",
  );
  expect(put.status).toBe(413);
  expect(kvGet(SITE, `user:${id}:big`)).toBeNull(); // nothing written
});

test("one visitor cannot read another visitor's per-user data", async () => {
  const a = mint(SITE).id;
  const b = mint(SITE).id;
  await handleMe(
    new Request("http://x.local/__me/kv/secret", { method: "PUT", body: JSON.stringify("A-only") }),
    SITE,
    a,
    "/__me/kv/secret",
  );

  // B asks for "secret" — scoped to user:<B>:secret, which doesn't exist.
  const bGet = await handleMe(req(), SITE, b, "/__me/kv/secret");
  expect(bGet.status).toBe(404);

  // B's key listing never includes A's data.
  const bKeys = await handleMe(req(), SITE, b, "/__me/kv");
  expect(await bKeys.json()).not.toContain("secret");
});

test("user:* keys are not reachable through raw /__kv", async () => {
  const id = mint(SITE).id;
  await handleMe(
    new Request("http://x.local/__me/kv/note", { method: "PUT", body: JSON.stringify("hi") }),
    SITE,
    id,
    "/__me/kv/note",
  );
  const fullKey = `user:${id}:note`;

  // Direct read via /__kv is a 404, even though the row exists.
  const read = await handleKv(new Request("http://x.local/"), SITE, fullKey);
  expect(read.status).toBe(404);

  // A write attempt via /__kv is refused (treated as absent), leaving the value intact.
  const write = await handleKv(
    new Request("http://x.local/", { method: "PUT", body: '"hacked"' }),
    SITE,
    fullKey,
  );
  expect(write.status).toBe(404);
  expect(kvGet(SITE, fullKey)).toBe('"hi"');

  // And it never appears in the client-visible key listing.
  expect(kvVisibleKeys(SITE)).not.toContain(fullKey);
});
