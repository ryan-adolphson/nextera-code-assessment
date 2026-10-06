// Production build (the web image, Cloud Run nextera-web). The API base URL is runtime config:
// the container validates API_BASE_URL at startup and serves it as /config.json, which
// src/main.ts loads before bootstrapping (core/runtime-config.ts). One image, every environment.
export const environment = {
  production: true,
  apiBaseUrl: null as string | null,
};
