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
# Create the mount point so the app can resolve SITES_DIR before the volume is populated.
RUN mkdir -p sites

EXPOSE 3000
CMD ["bun", "src/index.ts"]
