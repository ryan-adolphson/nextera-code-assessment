# syntax=docker/dockerfile:1.7
# nextera API + SSE image (Cloud Run service nextera-api).
# Build context = repo root: the app needs packages/shared and the root package-lock.json.
#   docker buildx build --platform linux/amd64 -f apps/api/Dockerfile -t <registry>/api:<tag> .
# (or `npm run docker:build:api`, see CLAUDE.md)
# Only this workspace and @nextera/shared are installed: the other service's dependencies never
# enter this image.

ARG NODE_IMAGE=node:24.15-alpine

# --- manifests (dependency layers stay cached until one of these changes) --------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# --- build: all dependencies of this app + shared --------------------------------------------
# --ignore-scripts: the shared package's `prepare` needs sources that aren't copied yet.
FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts -w @nextera/api -w @nextera/shared --include-workspace-root
COPY packages/shared/ packages/shared/
RUN npm run build -w @nextera/shared
COPY apps/api/ apps/api/
RUN npm run build -w @nextera/api

# --- production dependencies only (fresh install, not a prune) ---------------------------------
# --omit=optional too: the prisma CLI, typescript and their deps are "devOptional" (optional peers
# of @prisma/client) and survive a plain --omit=dev.
FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=optional --ignore-scripts \
      -w @nextera/api -w @nextera/shared --include-workspace-root

# --- runtime ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 8080
# Used by docker-compose only; Cloud Run uses the probes defined in Terraform.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health/live" >/dev/null || exit 1
# node as PID 1 (not npm) so SIGTERM reaches Nest's shutdown hooks.
CMD ["node", "dist/main.js"]
