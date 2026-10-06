import { loadApiBaseUrl, RUNTIME_CONFIG_URL } from './runtime-config';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('loadApiBaseUrl', () => {
  it('uses the environment URL without fetching (ng serve, start:docker)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      loadApiBaseUrl({ apiBaseUrl: 'http://localhost:3000/api' }, fetchFn),
    ).resolves.toBe('http://localhost:3000/api');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('loads /config.json, bypassing the HTTP cache, when the environment has no URL', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ apiBaseUrl: 'https://api.nextera.energy/api/' }));
    await expect(loadApiBaseUrl({ apiBaseUrl: null }, fetchFn)).resolves.toBe(
      'https://api.nextera.energy/api',
    );
    expect(RUNTIME_CONFIG_URL).toBe('/config.json');
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith('/config.json', { cache: 'no-store' });
  });

  it.each([
    ['an HTTP error', () => new Response('not found', { status: 404 }), /HTTP 404/],
    ['invalid JSON', () => jsonResponse('<!doctype html>'), /not valid JSON/],
    ['no apiBaseUrl', () => jsonResponse({}), /no apiBaseUrl/],
    ['an empty apiBaseUrl', () => jsonResponse({ apiBaseUrl: ' ' }), /no apiBaseUrl/],
    ['a non-string apiBaseUrl', () => jsonResponse({ apiBaseUrl: 42 }), /no apiBaseUrl/],
    ['a JSON null', () => jsonResponse(null), /no apiBaseUrl/],
  ])('fails on %s', async (_, response, message) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(loadApiBaseUrl({ apiBaseUrl: null }, fetchFn)).rejects.toThrow(message);
  });
});
