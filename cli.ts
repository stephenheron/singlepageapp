#!/usr/bin/env bun
import { basename } from "node:path";
import { mkdir } from "node:fs/promises";

const CONFIG = "singlepage.json";
const SCAFFOLD_DIRS = ["public", "server", "cron"];

async function init() {
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: dirName }),
    });
  } catch (err) {
    console.error(`Could not reach ${endpoint}: ${(err as Error).message}`);
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

const cmd = process.argv[2];
if (cmd === "init") {
  await init();
} else {
  console.log("Usage: singlepage init");
  process.exit(cmd ? 1 : 0);
}
