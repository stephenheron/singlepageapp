// Shared client injected into every served HTML page (via /__inject.js).
// Edit this file and refresh — it's served with no-cache, so changes show up
// immediately. This runs on every site, so keep it generic.

/**
 * Small fetch helper: GETs JSON and throws on non-2xx.
 * @param {string} url
 * @param {RequestInit} [opts]
 */
export async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Which site is this? (subdomain label, e.g. "test-site")
const site = location.hostname.split(".")[0];

// --- key/value store -------------------------------------------------------
// A per-site store backed by the site's SQLite db. Import it as a module:
//   import { kv } from "/__inject.js";
// Values are any JSON-serializable data. Scoped to this site by origin.
// Change events arrive over the shared SSE stream (see connectEvents below).
const kvSubscribers = new Set(); // handlers for live { key, action, value } changes

export const kv = {
  async get(key) {
    const res = await fetch(`/__kv/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kv.get(${key}) → ${res.status}`);
    return res.json();
  },
  async set(key, value) {
    const res = await fetch(`/__kv/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(value ?? null),
    });
    if (!res.ok) throw new Error(`kv.set(${key}) → ${res.status}`);
  },
  async remove(key) {
    const res = await fetch(`/__kv/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`kv.remove(${key}) → ${res.status}`);
  },
  async keys() {
    const res = await fetch("/__kv");
    if (!res.ok) throw new Error(`kv.keys() → ${res.status}`);
    return res.json();
  },
  // Listen for changes to any key. handler({ key, action, value }); action is
  // "set" (value present) or "delete". Returns an unsubscribe function.
  subscribe(handler) {
    kvSubscribers.add(handler);
    return () => kvSubscribers.delete(handler);
  },
  // Convenience: listen for changes to a single key. Returns unsubscribe.
  on(key, handler) {
    return kv.subscribe((change) => {
      if (change.key === key) handler(change);
    });
  },
};

// --- server functions ------------------------------------------------------
// Call this site's server-side handlers (sites/<site>/server/*.js, mounted at
// /__fn/*). Import it as a module:
//   import { fn } from "/__inject.js";
//   const data = await fn("hello", { query: { name: "sp" } }); // GET /__fn/hello?name=sp
//   const saved = await fn.post("save", { title: "hi" });       // POST /__fn/save (JSON body)
// JSON responses are parsed automatically; anything else comes back as text.
// Non-2xx responses throw an Error carrying the handler's { error } message.

/**
 * Call a server function by name (the path under server/, without ".js").
 * @param {string} name e.g. "hello" or "users/list" ("" or "/" → server/index.js)
 * @param {{ method?: string, query?: Record<string,any>, body?: any, headers?: Record<string,string> }} [opts]
 */
export async function fn(name, opts = {}) {
  const { method = "GET", query, body, headers = {} } = opts;
  let path = "/__fn/" + String(name).replace(/^\/+/, "");
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) path += `?${qs}`;
  }

  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] ??= "application/json";
    }
  }

  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = payload && payload.error ? payload.error : payload || res.statusText;
    throw new Error(`fn ${name || "index"} → ${res.status}: ${msg}`);
  }
  return payload;
}

/** GET a server function, passing `query` as the query string. */
fn.get = (name, query) => fn(name, { method: "GET", query });
/** POST a server function with a JSON (or string) `body`. */
fn.post = (name, body, opts) => fn(name, { ...opts, method: "POST", body });

// --- event stream ----------------------------------------------------------
// One per-site SSE connection carries every event type: "change" (live reload)
// and "kv" (key/value store changes). NOTE on scale: the server pushes ALL of a
// site's kv changes to every page; kv.on(key) filters here on the client. Fine
// for chat-sized loads, but won't scale to high write volume or many keys —
// the future fix is server-side per-key subscriptions.
function connectEvents() {
  const es = new EventSource("/__events"); // auto-reconnects on drop

  // Live reload: deploys refresh the page (CSS hot-swaps without a full reload).
  let reloadTimer;
  es.addEventListener("change", (e) => {
    const path = e.data;
    if (path.endsWith(".css") && hotSwapCss(path)) return;
    // Coalesce a burst of changes into a single reload.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => location.reload(), 100);
  });

  // KV changes: fan out to subscribers registered via kv.subscribe / kv.on.
  es.addEventListener("kv", (e) => {
    let change;
    try {
      change = JSON.parse(e.data); // { key, action, value? }
    } catch {
      return;
    }
    for (const handler of kvSubscribers) {
      try {
        handler(change);
      } catch (err) {
        console.error("[inject] kv subscriber threw", err);
      }
    }
  });
}

// Re-point a matching <link rel=stylesheet> with a cache-bust. Returns false
// if no matching stylesheet is linked (caller falls back to a full reload).
function hotSwapCss(path) {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href, location.href);
    if (url.pathname === path) {
      url.searchParams.set("_r", String(Date.now()));
      link.href = url.href;
      return true;
    }
  }
  return false;
}

connectEvents();

async function init() {
  console.log(`[inject] loaded on "${site}"`);

  // --- your custom data fetching goes here -------------------------------
  // Example:
  // try {
  //   const data = await fetchJSON("https://api.example.com/thing");
  //   document.querySelector("#data")?.replaceChildren(JSON.stringify(data));
  // } catch (err) {
  //   console.error("[inject] fetch failed", err);
  // }
  // ----------------------------------------------------------------------
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
