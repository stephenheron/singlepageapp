# syntax=docker/dockerfile:1

# single-page — Bun multi-tenant web host.
# Build context is the repo root; runtime state (sites/) lives on a Kamal volume.

FROM oven/bun:1 AS base
WORKDIR /app

# --- install production dependencies in an isolated layer -------------------
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- final image ------------------------------------------------------------
FROM base AS release
ENV NODE_ENV=production

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# sites/ is provided at runtime by a persistent Kamal volume (see config/deploy.yml).
# Create the mount point and hand it (plus /app) to the non-root `bun` user
# (UID 1000, ships with the image) so a fresh volume inherits bun ownership and
# the app can write site files + SQLite. Running as non-root limits the blast
# radius of a sandbox escape.
RUN mkdir -p sites && chown -R bun:bun /app

# Drop root: the server only needs to read /app and write /app/sites, and binds
# port 3000 (>1024), so it needs no privileges.
USER bun

EXPOSE 3000
CMD ["bun", "src/index.ts"]
