# syntax=docker/dockerfile:1.7
# nextera Angular app image (Cloud Run service nextera-web): the production build served by nginx.
# Build context = apps/web (a separate npm project with its own package-lock.json):
#   docker buildx build --platform linux/amd64 -f apps/web/Dockerfile -t <registry>/web:<tag> apps/web
# (or `npm run docker:build:web` from the repo root, see CLAUDE.md)
#
# One image for every environment: the API base URL is runtime config. The container validates
# API_BASE_URL at startup (docker/40-runtime-config.sh; it refuses to start on a bad value) and
# serves it as /config.json, which src/main.ts loads before bootstrapping.

ARG NODE_IMAGE=node:24.14-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# --- build: platform-independent static files, so it runs natively on the build machine ---------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npx ng build --configuration production

# --- runtime: unprivileged nginx (uid 101), no Node, no npm -------------------------------------
FROM ${NGINX_IMAGE} AS runtime
ENV PORT=8080 \
    NGINX_ENVSUBST_FILTER=^PORT$ \
    NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE=1
USER root
# The stock default.conf is replaced by our template; /usr/share/nginx/runtime holds config.json.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /usr/share/nginx/runtime \
 && chown nginx:root /usr/share/nginx/runtime
USER nginx
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist/web/browser /usr/share/nginx/html
EXPOSE 8080
# Used by docker-compose only; Cloud Run uses the probes defined in Terraform.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
# The base image's entrypoint runs /docker-entrypoint.d (templates, runtime config), then
# `nginx -g 'daemon off;'` as PID 1.
