# Future ideas

A running list of things we want to improve. Each entry notes how it works today
(with file pointers) and the direction we're leaning — not a committed design.

---

## Abuse & resource limits (shared-host hardening)

The isolation primitives are solid (per-context heap/stack/deadline in
`sandbox.ts`, SSRF + 5 MB response cap on `ctx.fetch`, hashed deploy keys, signed
identity, inbound body-size caps, and now per-site storage quotas — see Recently
shipped). The gap that remains is **request-rate exhaustion by unauthenticated
visitors on a shared host**: CPU/memory are shared across every tenant, so one
visitor spraying expensive routes degrades the box for all of them. The item
below closes that path.

### 1. Rate limiting

No rate limiting exists anywhere. An anonymous visitor can hammer `/__fn/*` (each
request drives a QuickJS run with a 60 s budget) or spray `/__kv` / `/__me/kv`
writes. The per-handler pool (`MAX_CONTEXTS_PER_HANDLER = 8`, `sandbox.ts:274`)
bounds one handler but throttles nothing across requests.

Leaning toward: a cheap in-process token bucket keyed by IP (`x-forwarded-for`,
since we sit behind Caddy) and/or site, on the expensive/writable routes. Some of
this could live in the front proxy (`config/Caddyfile`), but an in-process backstop
is worth keeping because the proxy can't see per-site sandbox cost.

## Capability primitives (batteries for real apps)

Server/cron handlers get a fixed `ctx` (`kv`, `console`, `fetch`, `json`, `text`,
`html`, `user`) built in `sandbox.ts`. These two extend that surface so sites can
do useful work without leaving the sandbox or managing their own secrets.

### AI primitive (`ctx.ai`)

Today a handler that wants an LLM has to call out through `ctx.fetch` with its own
provider key — which means the site has to store a secret (private KV at best) and
we have no visibility or metering. Given the project is already agent-oriented
(`init` installs a Claude skill + `AGENTS.md`), a first-class AI call is a natural
differentiator: "the host where agents build AI-native apps without juggling API
keys."

Leaning toward: a `ctx.ai` helper (e.g. `ctx.ai.generate({ prompt })` /
`ctx.ai.embed(...)`) where the **host** holds the provider key, calls go through the
existing SSRF-safe fetch path, and usage is metered per site. Default to the latest
Claude models. Open questions: per-site budgets/quotas (ties into the abuse-limits
work above), streaming vs. single-shot from inside a sandboxed run, and whether the
host key is shared or per-site-configurable.

### Background jobs / queue (`ctx.queue`)

Cron exists (`cron.ts`, scheduled from the `cron` map in `singlepage.json`), but
there is no on-demand async work: a server function must do everything within its
60 s request deadline (`server.ts:13`), so anything slow or flaky (sending email,
calling a model, hitting a third-party API) blocks the response and dies with it.

Leaning toward: a per-site queue — `ctx.queue.enqueue(job, payload)` from a server
function, with workers running the same `cron/`-style sandboxed handlers, plus
retries with backoff and a dead-letter view. Reuses the existing sandbox + per-site
SQLite (`kv.ts`) for durable job state; needs a concurrency cap that respects the
global sandbox budget (see abuse-limits #1, rate limiting). Pairs naturally with the AI primitive
(offload slow generations) and any future email helper (magic links, notifications).

<!--
Recently shipped:
- Per-site storage quota: `kvSet` enforces per-site byte + key caps and a per-user
  `user:<id>:*` key cap (`kvQuota()` in config.ts, env-overridable), throwing
  `KvQuotaError` → 507 at the `/__kv` and `/__me/kv` boundaries. Byte/row totals
  are kept as running counters in the `meta` table (seeded once in `ensureDb`) so
  writes stay O(log n) instead of scanning every value. See config.ts, kv.ts,
  identity.ts, quota.test.ts.
- Inbound body-size caps: a global `maxRequestBodySize` on `Bun.serve`
  (`MAX_REQUEST_BODY_BYTES`, env-overridable) as a host-memory backstop, plus a
  256 KB `MAX_KV_VALUE_BYTES` cap on `/__kv` and `/__me/kv` PUTs via
  `readLimitedBody` (checks Content-Length then actual byte length). See
  config.ts, index.ts, kv.ts, identity.ts.
- Anonymous end-user identity (signed sp_uid cookie): per-visitor `ctx.user` in
  server functions, `user.id()` + private `user.kv` on the page, `/__me` endpoint.
  See identity.ts.
-->
