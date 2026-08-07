// Vercel Edge Middleware — runs before every request on the CDN edge.
// Protects the board and admin with cookie-based auth (custom login page).
// GET /api/flights is always public so the airport website can fetch data.
//
// Set FIDS_PASSWORD in Vercel environment variables to enable auth.
// Leave it unset and the FIDS is open (useful during local testing).

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export default function middleware(request) {
  const pw = process.env.FIDS_PASSWORD;
  if (!pw) return; // no password configured — open

  const url      = new URL(request.url);
  const pathname = url.pathname;

  // Public: airport website data feed
  if (pathname === '/api/flights' && request.method === 'GET') return;

  // Public: static assets
  if (/\.(css|js|png|jpg|jpeg|ico|svg|woff2?|map)$/.test(pathname)) return;

  // Public: tick (Bearer-authenticated inside the handler) and auth endpoints
  if (pathname === '/api/tick') return;
  if (pathname === '/api/auth') return;
  if (pathname === '/login.html' || pathname === '/login') return;

  // Check session cookie
  const cookies = parseCookies(request.headers.get('cookie'));
  if (cookies['fids_auth'] === pw) return; // authenticated

  return Response.redirect(new URL('/login.html', request.url).href, 302);
}

export const config = {
  // Run on every path except Vercel internals
  matcher: ['/((?!_vercel|_next).*)'],
};
