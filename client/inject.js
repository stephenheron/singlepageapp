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
// A per-site store backed by the site's SQLite db, exposed as `window.kv`.
// Values are any JSON-serializable data. Scoped to this site by origin.
const kv = {
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
};
window.kv = kv;

// --- live reload -----------------------------------------------------------
// Subscribe to the server's per-site SSE stream. When a public file is
// deployed, the page refreshes (CSS hot-swaps without a full reload).
function connectLiveReload() {
  const es = new EventSource("/__reload"); // auto-reconnects on drop
  let reloadTimer;
  es.addEventListener("change", (e) => {
    const path = e.data;
    if (path.endsWith(".css") && hotSwapCss(path)) return;
    // Coalesce a burst of changes into a single reload.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => location.reload(), 100);
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

connectLiveReload();

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
