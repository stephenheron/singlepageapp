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
