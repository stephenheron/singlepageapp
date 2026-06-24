# Future ideas

A running list of things we want to improve. Each entry notes how it works today
(with file pointers) and the direction we're leaning — not a committed design.

---

## 1. Per-site deploy keys — ✅ done

**Was.** There was exactly one secret: `SINGLEPAGE_TOKEN`, a single shared
bearer token that gated the entire management/write API. Anyone holding it could
write to **any** site — `PUT/DELETE /api/sites/<name>/files` for any `<name>` —
as well as create sites. No isolation: one key ruled them all.

**Now (implemented).** `SINGLEPAGE_TOKEN` is now an **admin** token, and each
site has its own **deploy key** with strict isolation:

- `SINGLEPAGE_TOKEN` authorizes only site creation (`POST /api/sites`) and
  deploy-key rotation (`authorized` in `api.ts`). It can **no longer** write
  files.
- File writes (`PUT/DELETE /api/sites/<name>/files`) require *that site's* deploy
  key (`verifyDeployKey`). Site A's key cannot touch site B.
- On creation, the server generates a key (`sp_<base64url>`), returns it once,
  and stores only its **SHA-256 hash** in a backend-only `meta` table inside the
  site's `data/db.sqlite` (`metaGet`/`metaSet` in `kv.ts`) — never in the
  client-readable `kv` table, never broadcast. Comparison is constant-time.
- New `POST /api/sites/<name>/deploy-key` (admin) rotates a site's key; it's also
  how a site created before deploy keys existed gets its first one. A site with
  no stored key rejects all writes until an admin issues one.
- The CLI (`cli.ts`) keeps both the admin token and the site's deploy key in a
  gitignored `.singlepage.credentials.json` (never synced — `singlepage.json`
  carries no secrets). It sends the deploy key on uploads, and `singlepage
  rotate-key` rotates + re-saves.

**Still open.** Authenticating a site's *end-users* (sessions, `ctx.user`) is a
separate, larger topic — see the note below and #3 for keeping KV data away from
clients.

> Note: this is only about *who can deploy*. Authenticating a site's end-users
> (sessions, `ctx.user`, etc.) is a separate, larger topic and not in scope here.
> Runtime surfaces (`/__kv`, `/__fn/*`, `/__events`) remain open per host today;
> see #3 for keeping specific KV data away from clients.

---

## 2. Smarter event subscriptions (stop fanning out everything) — ✅ done

**Was.** `events.ts` kept one SSE connection per open page per site and
**broadcast every KV change to every page of that site**; per-key filtering
happened on the client (`kv.on(key)` filtered in `client/inject.js`), and the
value rode along in every broadcast — so every page received every key's every
change, even keys it never subscribed to.

**Now (implemented).** The event bus moved from SSE to a **per-site WebSocket**
(`/__events`, upgraded in `index.ts`), and KV filtering happens **server-side**:

- Each socket declares the keys/prefixes it wants by sending
  `{ type: "sub", patterns: [...] }`; the server stores that on `ws.data` and
  only delivers matching `kv` changes (`broadcastKv` + `matches` in `events.ts`).
- Pattern matching: exact key, or a trailing-`*` prefix (`room:123:*`); `"*"`
  alone means everything. The client mirrors the same rule (`matchPattern` in
  `client/inject.js`) so multiplexed handlers on one socket don't cross-fire.
- The `kv.on/subscribe` surface is preserved and extended:
  `kv.subscribe(handler)` still means "all" (back-compat), while
  `kv.subscribe(pattern, handler)` / `kv.on(key, handler)` opt into filtering.
  The client sends the **union** of its subscribers' patterns and re-sends it on
  every change and on each (re)connect.
- `change` (live reload) and `log` frames still go to every socket unfiltered.
- Frames are now `{ type, data }` JSON envelopes; Bun's built-in keepalive pings
  replaced the manual SSE heartbeat. Covered by `events.test.ts`.

**Now also (via #3).** Private keys are no longer broadcast at all — `kvSet`
/`kvRemove` skip the fan-out for them — so values a client shouldn't see never
reach the wire. Read-only and read-write changes still broadcast to any matching
subscriber (both are client-readable). Withholding values *per user* (only
permitted subscribers) still needs end-user auth (#1); an auth handshake fits as
a first WS message, and the per-socket filter remains the natural enforcement
point.

---

## 3. KV visibility / access classes for server + cron — ✅ done

**Was.** One KV store per site, one table `kv(key, value, updated_at)` in
`kv.ts`. The same data was reachable two ways with the **same** permissions:

- Browser: `/__kv` — full read + write (`handleKv`).
- Backend (server functions / cron): `ctx.kv.get/set/remove/keys` via the sync
  helpers `kvGet/kvSet/kvRemove/kvKeys`.

There was no way to keep a value away from the client, or to let the client read
but not write it. Everything in KV was client-readable and client-writable.

**Now (implemented).** Each key carries a **visibility class** stored in a new
`class` column on the `kv` table (`kv(key, value, updated_at, class)`), enforced
at the `/__kv` boundary and the event fan-out while the backend keeps full
access:

- **private** — backend (server/cron) only. To a client the key looks absent:
  `handleKv` returns `404 null` for **every** method (GET/PUT/DELETE), it's
  excluded from the `/__kv` key listing (`kvVisibleKeys`), and its changes are
  **never broadcast** (`kvSet`/`kvRemove` skip `broadcastKv` for private keys).
  For secrets, server-computed state, API keys.
- **read-only** — clients can read (and subscribe over the WebSocket), but only
  the backend can write: `/__kv` PUT/DELETE return `403`. Changes still
  broadcast, since clients are allowed to read them.
- **read-write** — the default and prior behavior (client read + write).

How a class is assigned: the **backend owns it** — only server/cron code sets a
class, via `ctx.kv.set(key, value, { class })` or `ctx.kv.setClass(key, class)`
(wired through `__host_kv_set`/`__host_kv_set_class` in `sandbox.ts` to
`kvSet`/`kvSetClass`). A plain `set` with no class preserves an existing key's
class; new keys default to read-write. Client writes over `/__kv` never set a
class. Existing databases are migrated in `ensureDb` (`ALTER TABLE kv ADD COLUMN
class … DEFAULT 'readwrite'`), so prior rows become read-write. Covered by
`kv.test.ts` and a sandbox wiring test in `sandbox.test.ts`.

**Still open.** Classes today are client-vs-backend only; per-*user* visibility
(key A visible to user X but not Y) needs end-user auth (#1) and is not yet
addressed. Private GET/PUT/DELETE all return `404` to hide existence, but an
adversary who can also create keys could still probe via write timing — a
non-issue for value confidentiality, which is what this protects.

---

These three reinforce each other: real auth (#1) would extend per-key visibility
(#3) to per-user, and scoped subscriptions (#2) are the delivery mechanism that
already keeps private data off the wire — #3 defines *what* to withhold and the
WebSocket fan-out is where it's enforced.
