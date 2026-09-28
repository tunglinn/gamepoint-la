// Host-based routing: the editor lives at the root of the "app." subdomain
// (app.gamepointla.com in production, app.localhost:8788 under `npm run dev`),
// the landing page at the root of the bare domain. Both hostnames are served
// by the same Pages project, so they share every static file — only "/" and
// the legacy "/app" path behave differently per host.
//
// Only requests matched by _routes.json reach this middleware; static assets
// bypass Functions entirely.

// Hosts that can't have an "app." sibling: IP literals (app.127.0.0.1 isn't a
// name) and *.pages.dev preview URLs (Cloudflare doesn't provision
// app.<hash>.<project>.pages.dev). These keep serving the editor at /app.
function canUseAppSubdomain(hostname) {
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith('[')) return false;
  if (hostname.endsWith('.pages.dev')) return false;
  return true;
}

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);

  // app.<domain>/ → serve app.html (a rewrite, not a redirect, so the address
  // bar stays at "/"). "/app" is the clean-URL form of app.html.
  if (url.hostname.startsWith('app.')) {
    if (url.pathname === '/') {
      return env.ASSETS.fetch(new Request(new URL('/app' + url.search, url), request));
    }
    return next();
  }

  // <domain>/app → permanent redirect to app.<domain>/, keeping protocol and
  // port so localhost:8788/app → app.localhost:8788/. A leading "www." is
  // replaced rather than nested (www.x.com → app.x.com).
  if ((url.pathname === '/app' || url.pathname === '/app.html') &&
      canUseAppSubdomain(url.hostname)) {
    const appHost = 'app.' + url.host.replace(/^www\./, '');
    return Response.redirect(`${url.protocol}//${appHost}/${url.search}`, 301);
  }

  return next();
}
