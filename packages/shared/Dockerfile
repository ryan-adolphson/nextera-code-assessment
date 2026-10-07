# syntax=docker/dockerfile:1.7
# Migration runner for LOCAL docker-compose only (`migrate` service): `prisma migrate deploy`.
# In GCP, GitHub Actions runs the same command through the Cloud SQL Auth Proxy
# (.github/workflows/deploy.yml), so this image is never pushed.
# Build context = repo root (needs the root package-lock.json).

ARG NODE_IMAGE=node:24.15-alpine

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
# Only @nextera/shared, with its dev dependencies (the prisma CLI is one). --ignore-scripts: `prepare`
# would build sources that aren't here; then run the one install script that matters: the download
# of Prisma's migration engine.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts -w @nextera/shared \
 && cd node_modules/@prisma/engines && node scripts/postinstall.js
COPY packages/shared/prisma packages/shared/prisma
COPY packages/shared/prisma.config.ts packages/shared/
WORKDIR /app/packages/shared
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]
