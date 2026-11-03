import { expect, test, type Request } from '@playwright/test';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 9.1: the live-status pill and the app's own reconnect, with the SSE transport controlled
// by page.route (read-only; real readings arriving live are in tests/data/live.spec.ts).

const isEvents = (r: Request) => new URL(r.url()).pathname.endsWith('/api/events');
const isFarms = (r: Request) => new URL(r.url()).pathname.endsWith('/api/farms');

test.describe('Live status', () => {
  test('shows Connecting… until the stream opens, then Live; the token is in the URL', async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const streams: Request[] = [];
    await page.route('**/api/events**', async (route) => {
      streams.push(route.request());
      await held;
      await route.fallback();
    });
    await page.clock.setFixedTime(SEED_NOW);
    await logIn(page, 'viewer');

    const status = page.getByTestId('live-status');
    await expect(status).toHaveText('Connecting…');
    await expect(status).toHaveAttribute('data-status', 'connecting');
    release();
    await expect(status).toHaveText('Live');
    await expect(status).toHaveAttribute('data-status', 'open');
    // EventSource can't send headers: the token travels as ?access_token=.
    const token = await page.evaluate(
      () => JSON.parse(localStorage.getItem('nextera.session')!).accessToken as string,
    );
    expect(new URL(streams[0].url()).searchParams.get('access_token')).toBe(token);
  });

  test('after the browser gives up (503) it shows Reconnecting…, retries with a new stream and resyncs', async ({
    page,
  }) => {
    let refuse = true;
    await page.route('**/api/events**', (route) =>
      refuse ? route.fulfill({ status: 503, body: 'Service Unavailable' }) : route.fallback(),
    );
    const streams: Request[] = [];
    const farms: Request[] = [];
    page.on('request', (r) => {
      if (isEvents(r)) streams.push(r);
      if (isFarms(r)) farms.push(r);
    });
    await page.clock.setFixedTime(SEED_NOW);
    await logIn(page, 'viewer');

    const status = page.getByTestId('live-status');
    await expect(status).toHaveText('Reconnecting…');
    // The app keeps trying (backoff 1 s, 2 s, … with jitter), each time with a new EventSource.
    await expect.poll(() => streams.length).toBeGreaterThanOrEqual(2);
    const farmsBefore = farms.length;

    refuse = false;
    await expect(status).toHaveText('Live', { timeout: 15_000 });
    // Its own reconnect opened: the fleet reloads (resync), since readings may have been missed.
    await expect.poll(() => farms.length).toBe(farmsBefore + 1);
  });
});
