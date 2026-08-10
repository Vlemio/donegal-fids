// Vercel Edge Middleware — runs before every request on the CDN edge.
// Protects the board and admin with cookie-based auth (custom login page).
// GET /api/flights is always public so the airport website can fetch data.
//
// Set FIDS_PASSWORD in Vercel environment variables to enable auth.
// Leave it unset and the FIDS is open (useful during local testing).
//
// The cookie holds a signed, expiring session token (HMAC-SHA256 over an
// expiry timestamp, keyed by FIDS_PASSWORD) — never the password itself —
// so a leaked cookie only grants a time-boxed session, not the real
// credential, and rotating the password invalidates every outstanding
// token immediately. Tokens are issued in api/index.js's Node runtime
// (src/authToken.js, Node crypto); this Edge runtime has no `crypto`
// module, so verification here re-implements the same HMAC-SHA256 check
// with the Web Crypto API — same algorithm, same output.

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeHexEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(expiryStr));
  return timingSafeHexEqual(toHex(sigBuf), sig);
}

export default async function middleware(request) {
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
  if (await verifyToken(cookies['fids_auth'], pw)) return; // authenticated

  return Response.redirect(new URL('/login.html', request.url).href, 302);
}

export const config = {
  // Run on every path except Vercel internals
  matcher: ['/((?!_vercel|_next).*)'],
};
