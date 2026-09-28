import { describe, it, expect, vi } from 'vitest';
import { onRequest } from '../../functions/_middleware.js';

// Runs the middleware against a URL with stubbed next()/ASSETS, returning
// the response plus the URL ASSETS was asked for (if any).
async function run(href) {
  const next = vi.fn(async () => new Response('next'));
  let assetUrl = null;
  const env = {
    ASSETS: { fetch: vi.fn(async req => { assetUrl = req.url; return new Response('app.html'); }) },
  };
  const res = await onRequest({ request: new Request(href), next, env });
  return { res, next, assetUrl };
}

describe('app subdomain', () => {
  it('serves app.html at the root of app.gamepointla.com', async () => {
    const { res, assetUrl } = await run('https://app.gamepointla.com/');
    expect(assetUrl).toBe('https://app.gamepointla.com/app');
    expect(await res.text()).toBe('app.html');
  });

  it('serves app.html at the root of app.localhost with port', async () => {
    const { assetUrl } = await run('http://app.localhost:8788/');
    expect(assetUrl).toBe('http://app.localhost:8788/app');
  });

  it('preserves the query string on the rewrite', async () => {
    const { assetUrl } = await run('https://app.gamepointla.com/?utm=x');
    expect(assetUrl).toBe('https://app.gamepointla.com/app?utm=x');
  });

  it('passes other paths on the app host through', async () => {
    const { next } = await run('https://app.gamepointla.com/track');
    expect(next).toHaveBeenCalled();
  });
});

describe('legacy /app redirect', () => {
  it.each([
    ['https://gamepointla.com/app', 'https://app.gamepointla.com/'],
    ['https://gamepointla.com/app.html', 'https://app.gamepointla.com/'],
    ['https://www.gamepointla.com/app', 'https://app.gamepointla.com/'],
    ['https://gamepointla.com/app?x=1', 'https://app.gamepointla.com/?x=1'],
    ['http://localhost:8788/app', 'http://app.localhost:8788/'],
  ])('%s → %s', async (from, to) => {
    const { res } = await run(from);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(to);
  });

  it.each([
    'http://127.0.0.1:8788/app',
    'https://abc123.gamepointla.pages.dev/app',
  ])('does not redirect %s (no app. sibling possible)', async href => {
    const { next } = await run(href);
    expect(next).toHaveBeenCalled();
  });

  it('leaves the landing page root alone', async () => {
    const { next } = await run('https://gamepointla.com/');
    expect(next).toHaveBeenCalled();
  });
});
