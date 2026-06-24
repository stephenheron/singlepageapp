#!/usr/bin/env bun
import { basename } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";

const CONFIG = "singlepage.json";
const SCAFFOLD_DIRS = ["public", "server", "cron"];

// Required shared secret, sent as a bearer token on every API request.
const TOKEN = process.env.SINGLEPAGE_TOKEN;
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${TOKEN}` });

function requireToken(): void {
  if (!TOKEN) {
    console.error("SINGLEPAGE_TOKEN is required. Set it (e.g. in a .env file) and retry.");
    process.exit(1);
  }
}

// `watch` syncs these dirs plus the config file (server needs cron config).
const SYNC_DIRS = SCAFFOLD_DIRS;
const EXTRA_FILES = [CONFIG];
const DEBOUNCE_MS = 150;   // collapse a burst of fs events into one reconcile
const RECONCILE_MS = 2000; // periodic safety-net rescan
const MAX_CONCURRENT = 8;

type Config = { endpoint: string; site: string };

// --- init ------------------------------------------------------------------

async function init() {
  requireToken();
  // Reuse a previously saved endpoint as the default, if present.
  let prev: { endpoint?: string } = {};
  try {
    prev = await Bun.file(CONFIG).json();
  } catch {
    // no existing config — that's fine
  }
  const defaultEndpoint = prev.endpoint ?? "http://localhost:3000";

  const answer = prompt(`Single Page API endpoint [${defaultEndpoint}]:`)?.trim();
  const endpoint = (answer || defaultEndpoint).replace(/\/+$/, "");
  if (!endpoint) {
    console.error("No endpoint provided. Aborting.");
    process.exit(1);
  }

  const dirName = basename(process.cwd());

  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: dirName }),
    });
  } catch (err) {
    console.error(`Could not reach ${endpoint}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (res.status === 401) {
    console.error("Unauthorized — set SINGLEPAGE_TOKEN to match the server's token.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Server error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const site = (await res.json()) as { name: string; url: string };
  const config = { endpoint, site: site.name, cron: {} as Record<string, string> };
  await Bun.write(CONFIG, JSON.stringify(config, null, 2) + "\n");

  // Scaffold local project directories (idempotent).
  for (const dir of SCAFFOLD_DIRS) {
    await mkdir(dir, { recursive: true });
  }

  console.log(`\n✓ Created site "${site.name}"`);
  console.log(`  URL:    ${site.url}`);
  console.log(`  Config: ./${CONFIG}`);
  console.log(`  Dirs:   ${SCAFFOLD_DIRS.map((d) => `${d}/`).join("  ")}`);
}

// --- shared helpers ---------------------------------------------------------

async function loadConfig(): Promise<Config> {
  let cfg: { endpoint?: string; site?: string };
  try {
    cfg = await Bun.file(CONFIG).json();
  } catch {
    console.error(`No ${CONFIG} found here. Run \`singlepage init\` first.`);
    process.exit(1);
  }
  if (!cfg?.endpoint || !cfg?.site) {
    console.error(`${CONFIG} is missing "endpoint" or "site". Run \`singlepage init\`.`);
    process.exit(1);
  }
  return { endpoint: String(cfg.endpoint).replace(/\/+$/, ""), site: String(cfg.site) };
}

/** Bounds the number of concurrent transfers in flight. */
function makeSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function fileUrl({ endpoint, site }: Config, relpath: string): string {
  return `${endpoint}/api/sites/${encodeURIComponent(site)}/files?path=${encodeURIComponent(relpath)}`;
}

async function uploadPath(cfg: Config, relpath: string): Promise<boolean> {
  try {
    const res = await fetch(fileUrl(cfg, relpath), {
      method: "PUT",
      headers: authHeaders(),
      body: Bun.file(relpath),
    });
    if (!res.ok) {
      console.error(`  ✗ upload ${relpath} → ${res.status}`);
      return false;
    }
    console.log(`  ↑ ${relpath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ upload ${relpath} → ${(err as Error).message}`);
    return false;
  }
}

async function deletePath(cfg: Config, relpath: string): Promise<boolean> {
  try {
    const res = await fetch(fileUrl(cfg, relpath), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.error(`  ✗ delete ${relpath} → ${res.status}`);
      return false;
    }
    console.log(`  ✗ ${relpath} (deleted)`);
    return true;
  } catch (err) {
    console.error(`  ✗ delete ${relpath} → ${(err as Error).message}`);
    return false;
  }
}

/**
 * Snapshot of every synced file -> a cheap change signature (mtime:size).
 * Used both as the initial upload set and as the baseline for reconcile diffs.
 */
async function snapshotFiles(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const add = async (rel: string) => {
    try {
      const s = await stat(rel);
      if (s.isFile()) map.set(rel, `${s.mtimeMs}:${s.size}`);
    } catch {
      // vanished between scan and stat — skip
    }
  };
  for (const dir of SYNC_DIRS) {
    const glob = new Bun.Glob("**/*");
    for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
      await add(`${dir}/${rel}`);
    }
  }
  for (const f of EXTRA_FILES) await add(f);
  return map;
}

// --- watch ------------------------------------------------------------------

async function watch() {
  requireToken();
  const cfg = await loadConfig();
  const sem = makeSemaphore(MAX_CONCURRENT);

  // 1) Initial full upload. The snapshot is the post-upload baseline, so the
  //    first reconcile sees no diff and we don't re-upload everything.
  let snapshot = await snapshotFiles();
  const files = [...snapshot.keys()];
  console.log(`Uploading ${files.length} file(s) to ${cfg.endpoint} (site "${cfg.site}")...`);
  await Promise.all(files.map((rel) => sem(() => uploadPath(cfg, rel))));

  // 2) Per-path worker — serializes transfers for a single path so overlapping
  //    edits never produce out-of-order PUTs; each pass re-derives the action
  //    from current FS state, so the latest write always wins.
  const dirty = new Set<string>();   // paths needing sync
  const running = new Set<string>(); // paths with an active worker

  async function pump(rel: string) {
    if (running.has(rel)) return;
    running.add(rel);
    try {
      while (dirty.has(rel)) {
        dirty.delete(rel);

        let sig: string | null = null; // non-null => file exists, upload it
        try {
          const s = await stat(rel);
          if (s.isDirectory()) continue; // dir events carry no content
          sig = `${s.mtimeMs}:${s.size}`;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`  ! stat ${rel}: ${(err as Error).message}`);
            continue;
          }
        }

        const ok = await sem(() =>
          sig !== null ? uploadPath(cfg, rel) : deletePath(cfg, rel),
        );
        // Only advance the baseline on success; failures stay diffed so the
        // next reconcile retries them automatically.
        if (ok) {
          if (sig !== null) snapshot.set(rel, sig);
          else snapshot.delete(rel);
        }
      }
    } finally {
      running.delete(rel);
    }
  }

  // 3) Reconcile is the source of truth: rescan, diff against the baseline, and
  //    pump anything that differs. This catches what fs.watch misses on macOS
  //    (files in newly-created subdirectories, coalesced burst events).
  async function reconcile() {
    const cur = await snapshotFiles();
    for (const [rel, sig] of cur) {
      if (snapshot.get(rel) !== sig) {
        dirty.add(rel);
        void pump(rel);
      }
    }
    for (const rel of snapshot.keys()) {
      if (!cur.has(rel)) {
        dirty.add(rel); // deleted locally
        void pump(rel);
      }
    }
  }

  // fs.watch is only a low-latency trigger; reconcile does the real work.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const triggerReconcile = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void reconcile();
    }, DEBOUNCE_MS);
  };

  const watchers: ReturnType<typeof fsWatch>[] = [];
  for (const dir of SYNC_DIRS) {
    try {
      watchers.push(fsWatch(dir, { recursive: true }, () => triggerReconcile()));
    } catch (err) {
      console.error(`Cannot watch ${dir}/: ${(err as Error).message}`);
    }
  }
  try {
    watchers.push(fsWatch(CONFIG, () => triggerReconcile()));
  } catch {
    // config file may not exist yet — ignore
  }

  // Periodic safety-net rescan in case an fs event never arrives.
  const sweep = setInterval(() => void reconcile(), RECONCILE_MS);

  process.on("SIGINT", () => {
    console.log("\nStopping watch.");
    clearInterval(sweep);
    for (const w of watchers) w.close();
    process.exit(0);
  });

  console.log(`\nWatching ${SYNC_DIRS.map((d) => `${d}/`).join(", ")} and ${CONFIG} — Ctrl-C to stop.`);
}

// --- dispatch ---------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "init") {
  await init();
} else if (cmd === "watch") {
  await watch();
} else {
  console.log("Usage: singlepage <init|watch>");
  process.exit(cmd ? 1 : 0);
}
