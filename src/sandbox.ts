import { join, resolve, sep } from "node:path";
import { lookup } from "node:dns/promises";
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { SITES_DIR } from "./config.ts";
import { kvGet, kvSet, kvRemove, kvKeys, kvSetClass, appendLog, type KvClass } from "./kv.ts";

/**
 * The single boundary to the QuickJS WASM sandbox. Nothing else in the codebase
 * imports quickjs-emscripten, so the engine can be swapped without touching the
 * server/cron layers.
 *
 * Async host calls (notably `fetch`) use the *deferred promise* model: a host
 * function returns a QuickJS promise that the host settles once the real work
 * finishes, scheduling `executePendingJobs` so the VM's awaiting code resumes.
 * This drives `await` correctly even when the async call sits after another
 * `await` in user code — unlike the asyncify model, which cannot unwind a
 * suspended stack from inside a continuation job. See the experiments in the
 * commit that introduced this file.
 *
 * User code is untrusted: it gets a small, explicit host API (kv, console,
 * fetch) and nothing else — no filesystem, process, sockets, or raw fetch.
 */

// --- Limits ------------------------------------------------------------------

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MB heap per context
const MAX_STACK_BYTES = 1024 * 1024; // 1 MB stack
const FETCH_TIMEOUT_MS = 55_000; // per outbound request (must fit within a run's deadline)
const FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024; // cap response size

// --- One-time WASM module init ----------------------------------------------

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) modulePromise = getQuickJS();
  return modulePromise;
}

// --- SSRF guard --------------------------------------------------------------

/** Block loopback, link-local, and private destinations for sandbox fetch. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 link-local/ULA
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) -> evaluate the embedded IPv4.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedHost(mapped[1]!);
  // IPv4 literals: loopback / private / link-local ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

const MAX_REDIRECTS = 5;

/** Resolve a hostname to its IP addresses. Injectable so the SSRF check is testable. */
export type HostResolver = (hostname: string) => Promise<string[]>;
const dnsResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * SSRF host check. Rejects blocked literals up front, then resolves the hostname
 * and rejects it if ANY resolved address is blocked — this is what catches a
 * public name with a private/loopback/metadata A-record (DNS rebinding) and
 * non-dotted-decimal encodings (e.g. 0x7f000001) that slip past the literal
 * check but resolve to a blocked IP. Returns an error string, or null if allowed.
 *
 * Note: there's still a narrow TOCTOU window — `fetch` does its own resolution
 * after this check, so a sub-second-rebinding resolver could differ. Closing
 * that fully needs connect-time pinning, which Bun's fetch doesn't expose; this
 * shuts the practical doors (redirects, static private records, encodings).
 */
export async function blockedHostReason(
  hostname: string,
  resolver: HostResolver = dnsResolver,
): Promise<string | null> {
  if (isBlockedHost(hostname)) return "host not allowed";
  let addrs: string[];
  try {
    addrs = await resolver(hostname);
  } catch {
    return "host did not resolve";
  }
  if (!addrs.length) return "host did not resolve";
  for (const address of addrs) {
    if (isBlockedHost(address)) return "host resolves to a blocked address";
  }
  return null;
}

/**
 * Host-side fetch, JSON-in / JSON-out, with protocol + SSRF + size guards.
 * Redirects are followed MANUALLY (`redirect: "manual"`) so every hop's
 * destination is re-validated — a single `redirect: "follow"` would let a public
 * URL bounce to a private/metadata address unchecked.
 */
async function hostFetch(argsJson: string): Promise<string> {
  const fail = (error: string) => JSON.stringify({ error });
  try {
    const { url, init } = JSON.parse(argsJson) as { url: string; init: any };
    let currentUrl = url;
    let method: string | undefined = init?.method;
    let body: unknown = init?.body;
    const headers = init?.headers;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      for (let hop = 0; ; hop++) {
        let u: URL;
        try {
          u = new URL(currentUrl);
        } catch {
          return fail(`invalid url: ${currentUrl}`);
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") return fail("protocol not allowed");
        const reason = await blockedHostReason(u.hostname);
        if (reason) return fail(reason);

        const res = await fetch(u, {
          method,
          headers,
          body: body as any,
          redirect: "manual",
          signal: ctrl.signal,
        });

        // Follow redirects ourselves, re-validating each destination.
        if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
          if (hop >= MAX_REDIRECTS) return fail("too many redirects");
          let next: URL;
          try {
            next = new URL(res.headers.get("location")!, u); // resolve relative
          } catch {
            return fail("invalid redirect location");
          }
          currentUrl = next.href;
          // 307/308 preserve method + body; 301/302/303 drop to GET with no body
          // so a sensitive request body is never replayed to a redirect target.
          if (res.status !== 307 && res.status !== 308) {
            method = "GET";
            body = undefined;
          }
          continue;
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength > FETCH_MAX_BODY_BYTES) return fail("response too large");
        const outHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => (outHeaders[k] = v));
        return JSON.stringify({
          status: res.status,
          ok: res.ok,
          headers: outHeaders,
          body: new TextDecoder().decode(buf),
        });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return fail((e as Error).message ?? String(e));
  }
}

// --- VM prelude --------------------------------------------------------------
// Plain JS evaluated inside the VM. Builds the friendly `globalThis.__ctx` API
// on top of the raw __host_* functions the host installs on the global object.
// __host_fetch returns a promise the host settles, so `fetch` simply awaits it.

const PRELUDE = `
globalThis.__ctx = (() => {
  const fmt = (x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };
  const line = (args) => Array.prototype.map.call(args, fmt).join(" ");
  const console = {
    log: function () { __host_log("log", line(arguments)); },
    info: function () { __host_log("log", line(arguments)); },
    warn: function () { __host_log("warn", line(arguments)); },
    error: function () { __host_log("error", line(arguments)); },
  };
  globalThis.console = console;
  const kv = {
    get(key) { const v = __host_kv_get(String(key)); return v === null ? null : JSON.parse(v); },
    set(key, value, options) {
      __host_kv_set(
        String(key),
        JSON.stringify(value === undefined ? null : value),
        options && options.class ? String(options.class) : "",
      );
    },
    setClass(key, cls) { __host_kv_set_class(String(key), String(cls)); },
    remove(key) { __host_kv_remove(String(key)); },
    keys() { return JSON.parse(__host_kv_keys()); },
  };
  async function fetch(url, init) {
    const res = JSON.parse(await __host_fetch(JSON.stringify({ url: String(url), init: init || null })));
    if (res.error) throw new Error("fetch failed: " + res.error);
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text: async () => res.body,
      json: async () => JSON.parse(res.body),
    };
  }
  globalThis.fetch = fetch;
  const resp = (ct) => (body, init) => ({
    status: (init && init.status) || 200,
    headers: Object.assign({ "content-type": ct }, (init && init.headers) || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    kv, console, fetch,
    json: (data, init) => ({
      status: (init && init.status) || 200,
      headers: Object.assign({ "content-type": "application/json" }, (init && init.headers) || {}),
      body: JSON.stringify(data),
    }),
    text: resp("text/plain; charset=utf-8"),
    html: resp("text/html; charset=utf-8"),
  };
})();
`;

// Per-invocation driver: an async IIFE that calls the user's default export and
// resolves to the JSON-serialized return value. We resolvePromise + pump jobs.
const DRIVER = `(async () => {
  const input = JSON.parse(globalThis.__input);
  const out = await globalThis.__handler(input, globalThis.__ctx);
  return JSON.stringify(out === undefined ? null : out);
})()`;

// --- Context pool ------------------------------------------------------------
// One QuickJS context runs a single call at a time, so per-call deadlines and
// interrupts stay clean. To serve concurrent requests to the SAME handler, we
// keep a small pool of contexts per (site, file): a request reuses an idle
// context or builds a new one up to a cap, so requests overlap during I/O (fetch)
// waits instead of serializing. Different handlers/sites use independent pools.
// NOTE: this is all on Bun's single JS thread — CPU-bound handler code still
// can't run in true parallel; only I/O waits overlap.

const MAX_CONTEXTS_PER_HANDLER = 8;

type Entry = {
  context: QuickJSContext;
  hostHandles: QuickJSHandle[];
  site: string;
  source: string;
  pool: Pool;
  generation: number; // the pool generation this context was built for
  counted: boolean; // currently counts against the pool's live cap
  refs: number; // active run + in-flight fetches keeping this context alive
  retired: boolean; // no longer reusable; dispose once `refs` hits 0
};

type Pool = {
  mtimeMs: number; // last-seen source mtime (auto-reload detection)
  generation: number; // bumped when the source changes; older entries are stale
  idle: Entry[]; // built contexts not currently running a call
  live: number; // total non-disposed contexts (idle + checked out)
  waiters: Array<() => void>; // requests parked until a slot frees
};

const pools = new Map<string, Pool>();
const poolKey = (site: string, relpath: string) => `${site} ${relpath}`;

/** Absolute path for a site-relative script, guarded against traversal. */
function resolveScript(site: string, relpath: string): string | null {
  const siteRoot = join(SITES_DIR, site);
  const abs = resolve(siteRoot, relpath.replace(/^\/+/, ""));
  if (abs !== siteRoot && !abs.startsWith(siteRoot + sep)) return null;
  return abs;
}

/** Wake one parked request to retry acquisition now that a slot may be free. */
function wakeWaiter(pool: Pool): void {
  pool.waiters.shift()?.();
}

function disposeEntry(entry: Entry): void {
  if (!entry.context.alive) return; // already disposed
  for (const h of entry.hostHandles) {
    try {
      h.dispose();
    } catch {
      /* already disposed */
    }
  }
  try {
    entry.context.dispose();
  } catch {
    /* already disposed */
  }
  if (entry.counted) {
    entry.counted = false;
    entry.pool.live--;
    wakeWaiter(entry.pool); // a slot opened up
  }
}

/**
 * Dispose a retired context, but only once nothing is touching it (`refs === 0`).
 * Disposing while a run is executing or a fetch is in flight would free handles
 * those still use — a use-after-free that crashes the shared QuickJS runtime. So
 * runs and fetches hold a ref and call this on release; the last one disposes.
 */
function disposeIfIdle(entry: Entry): void {
  if (entry.retired && entry.refs === 0) disposeEntry(entry);
}

/**
 * Decide the fate of a context that is no longer checked out for a run. Called
 * when a run releases it AND when each background async call settles, because a
 * context is reusable only once nothing is touching it (`refs === 0`).
 *
 * If `refs > 0`, detached async work (e.g. a fetch the handler kicked off but did
 * not await) is still in flight — do nothing now and revisit when it settles.
 * Returning such a context to the idle pool would let the next request check it
 * out while the old request's continuation can still resume inside the same VM,
 * clobbering shared globals/module state. Once `refs` reaches 0, reuse it if it
 * is still healthy, otherwise dispose it.
 */
function settleEntry(entry: Entry): void {
  if (entry.refs > 0) return; // background async still draining; settle on its completion
  const pool = entry.pool;
  const reusable = !entry.retired && entry.generation === pool.generation && entry.context.alive;
  if (reusable) {
    pool.idle.push(entry);
    wakeWaiter(pool);
  } else {
    entry.retired = true;
    disposeIfIdle(entry); // refs === 0 here, so this disposes now
  }
}

/** Discard every idle context in a pool (e.g. after the source changed). */
function flushIdle(pool: Pool): void {
  const idle = pool.idle;
  pool.idle = [];
  for (const e of idle) {
    e.retired = true;
    disposeEntry(e); // idle -> refs 0 -> disposes now
  }
}

/**
 * Drop cached contexts for a changed/removed script. Idle contexts are disposed
 * now; checked-out ones become stale (older generation) and are disposed when
 * their current call finishes. New requests build fresh contexts.
 */
export function invalidate(site: string, relpath: string): void {
  const pool = pools.get(poolKey(site, relpath));
  if (!pool) return;
  pool.generation++;
  pool.mtimeMs = -1; // force a re-stat on the next acquire
  flushIdle(pool);
}

/**
 * Test-only: snapshot a handler's context pool. `idleInflight` counts idle
 * contexts that still have in-flight refs — which must always be 0, since a
 * context with detached async work pending is not safe to reuse.
 */
export function __poolSnapshot(
  site: string,
  relpath: string,
): { idle: number; live: number; idleInflight: number } | null {
  const pool = pools.get(poolKey(site, relpath));
  if (!pool) return null;
  return {
    idle: pool.idle.length,
    live: pool.live,
    idleInflight: pool.idle.filter((e) => e.refs > 0).length,
  };
}

/** Build a fresh context: install host functions, run the prelude, load user code. */
async function loadEntry(
  site: string,
  relpath: string,
  abs: string,
  source: string,
  pool: Pool,
  generation: number,
): Promise<Entry> {
  const mod = await getModule();
  const context = mod.newContext();
  context.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  context.runtime.setMaxStackSize(MAX_STACK_BYTES);

  const hostHandles: QuickJSHandle[] = [];
  // The entry is referenced by the async __host_fetch callback (below), so build
  // it now; it's populated/returned by the end of this function.
  const entry: Entry = {
    context,
    hostHandles,
    site,
    source,
    pool,
    generation,
    counted: true,
    refs: 0,
    retired: false,
  };
  const install = (name: string, handle: QuickJSHandle) => {
    context.setProp(context.global, name, handle);
    hostHandles.push(handle);
  };

  /**
   * Install an async host function using the deferred-promise model. `impl` takes
   * the single JSON-string argument and resolves to a JSON string; the wrapper
   * returns a VM promise the host settles when `impl` finishes. This bakes in the
   * four invariants every async host call needs: hold a ref across the work, guard
   * `context.alive`, dispose the result handle, and pump pending jobs to resume the
   * awaiting VM code. Add new async capabilities here instead of hand-rolling them.
   */
  const installAsync = (name: string, impl: (argsJson: string) => Promise<string>) => {
    install(
      name,
      context.newFunction(name, (argsH) => {
        const argsJson = context.getString(argsH);
        const deferred = context.newPromise();
        entry.refs++; // keep the context alive until this call settles
        impl(argsJson).then((out) => {
          // The context stays alive while refs > 0, so it is always alive here.
          if (context.alive) {
            const h = context.newString(out);
            deferred.resolve(h);
            h.dispose();
            context.runtime.executePendingJobs(); // resume the awaiting VM code
          }
          entry.refs--;
          settleEntry(entry); // last ref out -> reuse if healthy, else dispose
        });
        return deferred.handle;
      }),
    );
  };

  install(
    "__host_kv_get",
    context.newFunction("__host_kv_get", (keyH) => {
      const v = kvGet(site, context.getString(keyH));
      return v === null ? context.null : context.newString(v);
    }),
  );
  install(
    "__host_kv_set",
    context.newFunction("__host_kv_set", (keyH, valH, clsH) => {
      const cls = clsH ? context.getString(clsH) : "";
      kvSet(
        site,
        context.getString(keyH),
        context.getString(valH),
        cls ? (cls as KvClass) : undefined,
      );
      return context.undefined;
    }),
  );
  install(
    "__host_kv_set_class",
    context.newFunction("__host_kv_set_class", (keyH, clsH) => {
      kvSetClass(site, context.getString(keyH), context.getString(clsH) as KvClass);
      return context.undefined;
    }),
  );
  install(
    "__host_kv_remove",
    context.newFunction("__host_kv_remove", (keyH) => {
      kvRemove(site, context.getString(keyH));
      return context.undefined;
    }),
  );
  install(
    "__host_kv_keys",
    context.newFunction("__host_kv_keys", () => context.newString(JSON.stringify(kvKeys(site)))),
  );
  install(
    "__host_log",
    context.newFunction("__host_log", (levelH, msgH) => {
      appendLog(site, source, context.getString(levelH), context.getString(msgH));
      return context.undefined;
    }),
  );
  // Async fetch via the deferred-promise model: return a promise the host settles.
  installAsync("__host_fetch", hostFetch);

  // Build the ctx API, then load the user's module and pin its default export.
  // Dispose the eval result — the prelude's last expression is the assignment
  // `globalThis.__ctx = (...)`, so its value handle pins the whole ctx graph.
  context.unwrapResult(context.evalCode(PRELUDE, "prelude.js")).dispose();

  const userSource = await Bun.file(abs).text();
  const ns = context.unwrapResult(context.evalCode(userSource, relpath, { type: "module" }));
  const handler = context.getProp(ns, "default");
  if (context.typeof(handler) !== "function") {
    handler.dispose();
    ns.dispose();
    disposeEntry(entry); // nothing async in flight at load time
    throw new Error(`${relpath} must \`export default\` a function`);
  }
  context.setProp(context.global, "__handler", handler);
  handler.dispose();
  ns.dispose();

  return entry;
}

/** Check out a context for one call: reuse an idle one, build one, or wait for a slot. */
async function acquireEntry(
  site: string,
  relpath: string,
  source: string,
): Promise<Entry | { error: string }> {
  const abs = resolveScript(site, relpath);
  if (!abs) return { error: "path not allowed" };
  const file = Bun.file(abs);
  if (!(await file.exists())) return { error: "not found" };
  const mtimeMs = (await file.stat()).mtimeMs;

  const key = poolKey(site, relpath);
  let pool = pools.get(key);
  if (!pool) {
    pool = { mtimeMs, generation: 0, idle: [], live: 0, waiters: [] };
    pools.set(key, pool);
  }
  // Source changed on disk -> bump generation and drop stale idle contexts.
  if (mtimeMs !== pool.mtimeMs) {
    pool.mtimeMs = mtimeMs;
    pool.generation++;
    flushIdle(pool);
  }

  for (;;) {
    // Reuse a current-generation idle context if there is one.
    while (pool.idle.length) {
      const e = pool.idle.pop()!;
      if (e.generation === pool.generation && e.context.alive) return e;
      e.retired = true;
      disposeEntry(e); // stale idle context
    }
    // Otherwise build one, up to the per-handler cap.
    if (pool.live < MAX_CONTEXTS_PER_HANDLER) {
      pool.live++; // reserve the slot before the async build
      try {
        return await loadEntry(site, relpath, abs, source, pool, pool.generation);
      } catch (e) {
        pool.live--;
        wakeWaiter(pool);
        return { error: (e as Error).message ?? String(e) };
      }
    }
    // At capacity: park until a slot frees, then retry.
    await new Promise<void>((res) => pool!.waiters.push(res));
  }
}

/** Return a context after a call: reuse it if healthy, otherwise discard it. */
function releaseEntry(entry: Entry, timedOut: boolean): void {
  // A timed-out (or interrupted) run can leave a draining fetch / pending promise,
  // so that context is not safe to reuse — retire it. `settleEntry` then disposes
  // it (now if refs 0, else once the draining work finishes) and never reuses it.
  if (timedOut || entry.generation !== entry.pool.generation || !entry.context.alive) {
    entry.retired = true;
  }
  // settleEntry handles the rest: reuse if healthy and fully idle, park if detached
  // async work is still in flight (refs > 0), otherwise dispose.
  settleEntry(entry);
}

// --- Public run API ----------------------------------------------------------

export type RunResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; timeout?: boolean; notFound?: boolean };

/**
 * Execute the default export of sites/<site>/<relpath> with `input`, enforcing
 * a wall-clock deadline. `input` must be JSON-serializable; the resolved value
 * is the parsed JSON of whatever the handler returns.
 */
export async function runModule(
  site: string,
  relpath: string,
  input: unknown,
  opts: { deadlineMs: number; source?: string },
): Promise<RunResult> {
  const source = opts.source ?? "server";
  const entry = await acquireEntry(site, relpath, source);
  if ("error" in entry) {
    return { ok: false, error: entry.error, notFound: entry.error === "not found" };
  }

  const { context } = entry;
  entry.refs++; // keep this checked-out context alive for the duration of the run
  const deadline = Date.now() + opts.deadlineMs;
  let timedOut = false; // a timed-out/interrupted context is discarded, not reused
  try {
    context.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    const inputH = context.newString(JSON.stringify(input ?? null));
    context.setProp(context.global, "__input", inputH);
    inputH.dispose();

    // Throws (e.g. interrupt or syntax error) propagate to the outer catch.
    const resultH = context.unwrapResult(context.evalCode(DRIVER, "driver.js"));

    // Drive the returned promise to settlement, bounded by the wall-clock deadline.
    const native = context.resolvePromise(resultH);
    native.catch(() => {}); // a timed-out run discards the context; swallow the late rejection
    context.runtime.executePendingJobs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"__timeout">((r) => {
      timer = setTimeout(() => r("__timeout"), Math.max(0, deadline - Date.now()));
    });
    try {
      const settled = await Promise.race([native, timeout]);
      if (settled === "__timeout") {
        // This context is discarded on release (a fetch may still be draining);
        // resultH is freed when the context is finally disposed.
        timedOut = true;
        resultH.dispose();
        return { ok: false, error: "deadline exceeded", timeout: true };
      }
      resultH.dispose();
      const valH = context.unwrapResult(settled);
      const outStr = context.getString(valH);
      valH.dispose();
      return { ok: true, value: JSON.parse(outStr) };
    } catch (e) {
      const r = errorResult(e);
      if (r.timeout) timedOut = true; // interrupted mid-run -> don't reuse this context
      return r;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const r = errorResult(e);
    if (r.timeout) timedOut = true;
    return r;
  } finally {
    if (context.alive) context.runtime.removeInterruptHandler();
    entry.refs--; // drop the run ref
    releaseEntry(entry, timedOut); // reuse if healthy, else discard
  }
}

function errorResult(e: unknown): { ok: false; error: string; timeout: boolean } {
  const msg = (e as Error).message ?? String(e);
  const timeout = /interrupt/i.test(msg);
  return { ok: false, error: msg, timeout };
}
