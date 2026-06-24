# Future ideas

A running list of things we want to improve. Each entry notes how it works today
(with file pointers) and the direction we're leaning — not a committed design.

---

## 1. Per-site deploy keys

**Today.** There is exactly one secret: `SINGLEPAGE_TOKEN`, a single shared
bearer token that gates the entire management/write API (`api.ts`, constant-time
check in `authorized`). Anyone holding it can write to **any** site —
`PUT/DELETE /api/sites/<name>/files` for any `<name>` — as well as create sites.
There is no isolation between sites: one key rules them all. The CLI (`cli.ts`)
sends this same global token on every upload.

**The problem.** We want a **per-site key** so that only someone holding *that
site's* key can deploy to it. Holding site A's key must not grant the ability to
push files to site B.

**Direction.**

- On site creation (`POST /api/sites`), generate a unique deploy key for that
  site and return it to the caller.
- Scope the file-write endpoints (`PUT/DELETE /api/sites/<name>/files`) to that
  site's key instead of the global token — a key only authorizes writes to its
  own site.
- The CLI stores the site key locally (e.g. in `singlepage.json`, or a separate
  non-synced secret file) and sends it on uploads to that site.
- Decide what still gates *site creation* itself — likely keep a global/admin
  token for "who can create new sites," separate from the per-site deploy keys.
- Store each site's key with its site (per-site SQLite, or alongside the site
  config), and compare in constant time as we do now.

Open questions: where the key lives so the CLI can use it without leaking it into
served/public files; key rotation/revocation; migration for existing sites.

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

**Still open.** Values are still delivered to anyone whose pattern matches — we
don't yet *withhold* values a subscriber shouldn't see; that needs the #3
visibility classes (private keys must never be broadcast, read-only keys only to
permitted subscribers). The per-socket filter is the natural enforcement point,
and an auth handshake (#1) fits as a first WS message.

---

## 3. KV visibility / access classes for server + cron

**Today.** One KV store per site, one table `kv(key, value, updated_at)` in
`kv.ts`. The same data is reachable two ways with the **same** permissions:

- Browser: `/__kv` — full read + write (`handleKv`).
- Backend (server functions / cron): `ctx.kv.get/set/remove/keys` via the sync
  helpers `kvGet/kvSet/kvRemove/kvKeys`.

There is no way to keep a value away from the client, or to let the client read
but not write it. Everything in KV is client-readable and client-writable.

**Direction.** Visibility classes per key (or per namespace), enforced at the
`/__kv` boundary while the backend keeps full access:

- **private** — backend (server/cron) only; never returned over `/__kv`, never
  broadcast to clients. For secrets, server-computed state, API keys (overlaps
  with the deferred per-site secrets store).
- **read-only** — client can read (and subscribe), but only the backend can
  write. `/__kv` PUT/DELETE rejected for these keys; writes go through server
  functions.
- **read-write** — current behavior (client read + write).

Sketch: store a class per key (extra column, or naming convention / namespace
prefixes like `_private:*`, `_ro:*`), enforce it in `handleKv` and in the event
fan-out (#2 — never broadcast private keys, and only push read-only/read-write
changes to permitted subscribers). The backend `ctx.kv` ignores the class and
sees everything.

Open questions: per-key metadata vs prefix convention; how a server function
declares/assigns a class; interaction with #1 (per-user visibility, not just
client-vs-backend).

---

These three reinforce each other: real auth (#1) makes per-key visibility (#3)
meaningful, and scoped subscriptions (#2, now done) are the delivery mechanism
that keeps private/read-only data from leaking to the wrong client — once #3
defines *what* to withhold, #2's per-socket filter is where it gets enforced.
