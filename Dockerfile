# Production image for the FINISHED clone only.
# It serves the built Next.js site — no Playwright, no extraction scripts.
# Cloning itself happens in the dev container (see Dockerfile.dev).
#
# Based on https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile

# IMPORTANT: Node.js version maintenance
# This Dockerfile uses node:22-alpine to match the repo's Node 22 baseline
# (package.json "engines" + .nvmrc). Update NODE_VERSION when the baseline changes.
ARG NODE_VERSION=22-alpine

# ============================================
# Stage 1: Install dependencies
# ============================================
FROM node:${NODE_VERSION} AS dependencies

WORKDIR /app

# Copy manifest + lockfile first to leverage Docker layer caching
COPY package.json package-lock.json ./

# Frozen lockfile for reproducible builds; skip Playwright's browser download —
# the production image never runs a browser
RUN --mount=type=cache,target=/root/.npm \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund

# ============================================
# Stage 2: Build the Next.js app (standalone output)
# ============================================
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# next.config.ts sets output: "standalone", so the build emits a
# self-contained server in .next/standalone
RUN npm run build

# ============================================
# Stage 3: Slim runtime
# ============================================
FROM node:${NODE_VERSION} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

# public/ holds the cloned site's downloaded assets (images, fonts, videos) —
# it must ship with the runtime image
COPY --from=builder --chown=node:node /app/public ./public

# Correct permissions for the prerender cache
RUN mkdir .next && chown node:node .next

# Output-file-tracing keeps the runtime image small:
# https://nextjs.org/docs/app/api-reference/config/next-config-js/output
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Non-root for security
USER node

EXPOSE 3000

CMD ["node", "server.js"]
