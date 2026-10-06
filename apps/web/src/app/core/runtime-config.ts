/** Served by the web container (Cloud Run nextera-web), generated at startup from API_BASE_URL. */
export const RUNTIME_CONFIG_URL = '/config.json';

/**
 * Resolves the API base URL before the app bootstraps (src/main.ts).
 * - `ng serve` / `npm run start:docker`: the environment file has it, nothing is fetched.
 * - Production build (the web image): `environment.apiBaseUrl` is null and the URL comes from
 *   /config.json, so one image runs in every environment. The container has already validated it
 *   (docker/40-runtime-config.sh); this only guards against a missing or malformed file.
 */
export async function loadApiBaseUrl(
  environment: { readonly apiBaseUrl: string | null },
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  if (environment.apiBaseUrl) return environment.apiBaseUrl;

  const response = await fetchFn(RUNTIME_CONFIG_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not load ${RUNTIME_CONFIG_URL}: HTTP ${response.status}`);
  }
  let config: unknown;
  try {
    config = await response.json();
  } catch {
    throw new Error(`${RUNTIME_CONFIG_URL} is not valid JSON`);
  }
  const apiBaseUrl =
    typeof config === 'object' && config !== null && 'apiBaseUrl' in config
      ? config.apiBaseUrl
      : undefined;
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()) {
    throw new Error(`${RUNTIME_CONFIG_URL} has no apiBaseUrl`);
  }
  return apiBaseUrl.trim().replace(/\/+$/, '');
}
