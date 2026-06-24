# single-page

A small, multi-tenant web host built on [Bun](https://bun.com). Each **site**
lives on its own subdomain and gets a static `public/` directory, a sandboxed
server-function runtime, scheduled cron jobs, a per-site key/value store, and
live reload — all from one process, with zero per-site DNS or config.

```
<site>.<BASE_DOMAIN>  ->  sites/<site>/public/   (static files)
                          sites/<site>/server/   (server functions, /__fn/*)
                          sites/<site>/cron/      (scheduled jobs)
                          sites/<site>/data/      (SQLite: kv + logs, backend-only)
```

Locally, browsers resolve `*.localhost` to `127.0.0.1` automatically (RFC 6761),
so `http://test-site.localhost:3000` just works.

## Quick start

Install dependencies and start the server:

```bash
bun install
SINGLEPAGE_APP_TOKEN=dev-secret bun start
```

`SINGLEPAGE_APP_TOKEN` is the **admin token** (required — the server refuses to start
without it). It authorizes site creation and deploy-key rotation, nothing else.

Now create and deploy a site with the `singlepage` CLI. Build it once, then work
from your project directory:

```bash
bun run build:cli          # produces ./singlepage (or run `bun src/cli.ts`)

mkdir my-site && cd my-site
SINGLEPAGE_APP_TOKEN=dev-secret singlepage init   # creates the site, scaffolds dirs
singlepage watch                              # uploads + live-syncs on change
```

`init` calls the server, creates the site, scaffolds the dirs, and writes:

- **`singlepage.json`** — endpoint, site name, and the `cron` map. Synced to the
  server; carries no secrets.
- **`.singlepage.credentials.json`** — the admin token and this site's **deploy
  key**, gitignored and never synced.
- **An agent guide** — a frontend-focused guide for AI coding agents, installed as
  both a Claude skill (`.claude/skills/singlepage/SKILL.md`) and a vendor-neutral
  `AGENTS.md` block at the project root. Re-running `init` refreshes them (the
  `AGENTS.md` block is updated in place, leaving any other content untouched).

Then open the URL `init` printed (e.g. `http://my-site.localhost:3000/`). Edit
files under `public/`, `server/`, or `cron/` and `watch` deploys them; open pages
live-reload (CSS hot-swaps without a full reload).

### CLI commands

| Command | What it does |
| --- | --- |
| `singlepage init` | Create a site (admin token), scaffold `public/ server/ cron/`, save config + credentials, and install the agent guide (`SKILL.md` + `AGENTS.md`). |
| `singlepage watch` | Initial upload, then watch `public/ server/ cron/` + `singlepage.json` and sync changes (deploy key). |
| `singlepage rotate-key` | Issue a new deploy key for the site; the old one stops working. Also how a pre-deploy-key site gets its first key. |

## Architecture

### Subdomain routing

`siteFromHost` maps the request `Host` to a site; everything under
`sites/<site>/public/` is served statically. The bare `BASE_DOMAIN` (no
subdomain) serves an apex listing page. A handful of reserved per-site routes sit
in front of static files:

| Route | Purpose |
| --- | --- |
| `/__fn/<name>` | Invoke `server/<name>.js` (`server/index.js` for `/__fn`). |
| `/__kv`, `/__kv/<key>` | Per-site key/value store (see below). |
| `/__events` | WebSocket: live reload + KV change stream. |
| `/__inject.js` | Shared client, auto-injected into every served HTML page. |

### Server functions & cron (sandbox)

Files in `server/` and `cron/` run in a **QuickJS sandbox** (one isolate per
`(site, file)`, with per-call deadlines), so site code can't touch the host
filesystem or process. A server function default-exports a handler:

```js
// server/hello.js
export default (req, ctx) => ctx.json({ hello: req.query.name ?? "world" });
```

- **`req`** — `{ method, path, query, headers, body }`.
- **`ctx`** — `{ kv, console, fetch, json, text, html }`. `ctx.fetch` is
  guarded against SSRF (loopback/private/link-local hosts blocked); `console`
  output is captured as logs.

Cron jobs are `cron/<name>.js`, scheduled from the `cron` map in
`singlepage.json` (`{ "<name>": "<cron expression>" }`) and run with the same
`ctx`.

### KV store & visibility classes

One SQLite-backed key/value store per site, reachable two ways:

- **Browser:** `/__kv` (and `ctx`-free client helpers, below).
- **Backend:** `ctx.kv.get/set/remove/keys` inside server/cron code, which always
  has full access.

Each key carries a **visibility class** that gates client (`/__kv`) access and the
event broadcast, while the backend ignores it:

| Class | Client read | Client write | Broadcast to clients |
| --- | --- | --- | --- |
| `private` | ✗ (looks absent — 404) | ✗ (404) | never |
| `readonly` | ✓ | ✗ (403) | ✓ |
| `readwrite` (default) | ✓ | ✓ | ✓ |

The class is **backend-owned** — only server/cron code sets it:

```js
ctx.kv.set("apiKey", secret, { class: "private" });   // backend-only secret
ctx.kv.set("config", data,  { class: "readonly" });   // clients read, backend writes
ctx.kv.set("count", 0);                               // default read-write
ctx.kv.setClass("count", "private");                  // reclassify in place
```

A plain `set` with no class preserves an existing key's class; new keys default
to `readwrite`. Client writes over `/__kv` never set a class. (Implemented in
`kv.ts`; the `class` column is migrated into existing databases on open.)

### Client (`/__inject.js`)

Every served HTML page gets a `<script type="module">` for the shared client,
which connects the event stream and exposes:

```js
import { kv, fn } from "/__inject.js";

await kv.set("count", 1);
await kv.get("count");
kv.on("count", ({ value }) => render(value));   // server-filtered subscription
kv.subscribe("room:*", handler);                // prefix; "*" = everything

await fn.get("hello", { name: "ada" });         // GET  /__fn/hello?name=ada
await fn.post("users", { email });              // POST /__fn/users
```

KV subscriptions are filtered **server-side**: the page sends the union of its
patterns over the WebSocket and only matching changes are delivered (private keys
never are).

### Deploy keys & isolation

Two secret types, strictly scoped:

- **Admin token** (`SINGLEPAGE_APP_TOKEN`) — site creation (`POST /api/sites`) and
  deploy-key rotation only. It **cannot** write files.
- **Per-site deploy key** — file uploads/deletes for one site
  (`PUT/DELETE /api/sites/<name>/files`). Site A's key can't touch site B. Only
  the SHA-256 hash is stored server-side; the raw key is shown once on issue.

## API & configuration reference

### Management API (`/api/*`, host-agnostic)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/sites` | admin token | Create a site `{ name }`; returns `{ name, url, deployKey }` (key shown once). |
| `POST /api/sites/<name>/deploy-key` | admin token | Rotate (or first-issue) the site's deploy key. |
| `PUT /api/sites/<name>/files?path=<rel>` | deploy key | Upload a file under `public/`, `server/`, `cron/`, or `singlepage.json`. |
| `DELETE /api/sites/<name>/files?path=<rel>` | deploy key | Delete a file. |

All auth is `Authorization: Bearer <token>`. Upload paths are allow-listed and
guarded against traversal.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `SINGLEPAGE_APP_TOKEN` | — (required) | Admin token (server + CLI). |
| `SINGLEPAGE_DEPLOY_KEY` | — | Fallback deploy key for the CLI (the credentials file wins). |
| `PORT` | `3000` | Listen port. |
| `BASE_DOMAIN` | `localhost` | Apex domain; sites are `<site>.<BASE_DOMAIN>`. |

Bun auto-loads `.env`, so these can live in a local `.env` file.

### Scripts

| Script | Command |
| --- | --- |
| `bun start` | Run the server (`src/index.ts`). |
| `bun run build:cli` | Compile the `singlepage` CLI to a standalone binary. |
| `bun test` | Run the test suite. |

---

Created with `bun init`; see `IDEAS.md` for the roadmap and design notes.
```

