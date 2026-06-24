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
// Change events arrive over the shared WebSocket (see connectEvents below).
//
// Each subscriber declares a pattern (an exact key, a "prefix:*", or "*" for
// everything). We tell the server the union of those patterns so it only sends
// matching changes; we still match per-handler here so one page's broad
// subscription doesn't fire another handler that asked for a narrower key.
const kvSubscribers = new Set(); // { pattern, handler } entries

/** Does `key` match a subscription `pattern`? Mirrors `matches` in events.ts. */
function matchPattern(pattern, key) {
  return pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

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
  // Listen for KV changes. handler({ key, action, value }); action is "set"
  // (value present) or "delete". Returns an unsubscribe function.
  //   subscribe(handler)            -> all keys (current behavior)
  //   subscribe(pattern, handler)   -> only keys matching pattern ("chat:*" or "k")
  // Declaring a pattern lets the server filter, so the page isn't sent every key.
  subscribe(patternOrHandler, maybeHandler) {
    const entry =
      typeof patternOrHandler === "function"
        ? { pattern: "*", handler: patternOrHandler }
        : { pattern: patternOrHandler, handler: maybeHandler };
    kvSubscribers.add(entry);
    syncSubscriptions();
    return () => {
      kvSubscribers.delete(entry);
      syncSubscriptions();
    };
  },
  // Convenience: listen for changes to a single key. Returns unsubscribe.
  on(key, handler) {
    return kv.subscribe(key, handler);
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
// One per-site WebSocket carries every frame as { type, data }: "change" (live
// reload) and "log" go to every page; "kv" (key/value store changes) is filtered
// server-side by this page's subscription. We send the union of our subscribers'
// patterns as { type: "sub", patterns: [...] } and re-send it whenever it changes
// or the socket (re)opens, so the server only pushes the keys this page wants.
let ws = null;
let reloadTimer;

function connectEvents() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/__events`);
  ws.addEventListener("open", postSubscriptions); // (re)establish our filter
  ws.addEventListener("message", onMessage);
  // WebSocket has no auto-reconnect (unlike EventSource); retry on drop.
  ws.addEventListener("close", () => {
    ws = null;
    setTimeout(connectEvents, 2000);
  });
  ws.addEventListener("error", () => {
    try {
      ws && ws.close();
    } catch (_) {}
  });
}

function onMessage(e) {
  let msg;
  try {
    msg = JSON.parse(e.data); // { type, data }
  } catch {
    return;
  }
  if (msg.type === "change") {
    // Live reload: deploys refresh the page (CSS hot-swaps without a full reload).
    const path = msg.data;
    if (path.endsWith(".css") && hotSwapCss(path)) return;
    // Coalesce a burst of changes into a single reload.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => location.reload(), 100);
  } else if (msg.type === "kv") {
    dispatchKv(msg.data); // { key, action, value? }
  }
  // "log" frames are ignored on the page (used by tooling/devtools).
}

// Fan a kv change out to subscribers, matching each by its declared pattern.
function dispatchKv(change) {
  for (const { pattern, handler } of kvSubscribers) {
    if (!matchPattern(pattern, change.key)) continue;
    try {
      handler(change);
    } catch (err) {
      console.error("[inject] kv subscriber threw", err);
    }
  }
}

// Tell the server the union of patterns we care about. Sent on every change and
// on each (re)open; a no-op until the socket is open (then sent from `open`).
function syncSubscriptions() {
  postSubscriptions();
}

function postSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const patterns = [...new Set([...kvSubscribers].map((s) => s.pattern))];
  ws.send(JSON.stringify({ type: "sub", patterns }));
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
