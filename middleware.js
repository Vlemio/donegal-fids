// Vercel Edge Middleware — runs before every request on the CDN edge.
// Protects the board (/), the admin panel (/admin), and all management
// API routes with HTTP Basic Auth. GET /api/flights is always public so
// the airport website can fetch flight data without credentials.
//
// Set FIDS_PASSWORD in Vercel environment variables to enable auth.
// Leave it unset and the FIDS is open (useful during testing).

export default function middleware(request) {
  const pw = process.env.FIDS_PASSWORD;
  if (!pw) return; // no password set — open

  const url      = new URL(request.url);
  const pathname = url.pathname;

  // Public: board display
  if (pathname === '/' || pathname === '/index.html') return;

  // Public: airport website data feed
  if (pathname === '/api/flights' && request.method === 'GET') return;

  // Public: static assets (CSS, JS, images, fonts)
  if (/\.(css|js|png|jpg|jpeg|ico|svg|woff2?|map)$/.test(pathname)) return;

  // Tick endpoint uses Bearer token — let the handler validate it
  if (pathname === '/api/tick') return;

  // Everything else requires Basic auth
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const decoded = atob(auth.slice(6));
    const colon   = decoded.indexOf(':');
    const pass    = colon >= 0 ? decoded.slice(colon + 1) : decoded;
    if (pass === pw) return;
  }

  return new Response('Donegal Airport FIDS — authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Donegal Airport FIDS"' },
  });
}

export const config = {
  // Run on every path except Vercel internals
  matcher: ['/((?!_vercel|_next).*)'],
};
