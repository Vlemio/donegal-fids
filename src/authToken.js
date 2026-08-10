// Signed, stateless session tokens for FIDS cookie auth.
//
// The cookie used to hold FIDS_PASSWORD itself (`fids_auth=<password>`) —
// anyone who ever saw that cookie value (a log line, a screen-share, a
// kiosk left unlocked) had the real login password, not just a revocable
// session. This issues an HMAC-signed, expiring token instead: the cookie
// proves "logged in until <time>" without containing the password, and
// rotating FIDS_PASSWORD (the HMAC key) instantly invalidates every
// previously issued token.
const crypto = require('crypto');

const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the old cookie Max-Age

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function issueToken(secret) {
  const expiry = Date.now() + SESSION_MS;
  return `${expiry}.${sign(expiry, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const expected = sign(expiry, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Constant-time string compare for the login form's password check itself
// (previously a plain `===`, which leaks timing information byte-by-byte).
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so the branch above
    // doesn't itself become a length oracle via early return timing.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { issueToken, verifyToken, timingSafeStringEqual, SESSION_MS };
