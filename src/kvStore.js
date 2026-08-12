// Vercel KV bridge — bridges Vercel KV (Redis) with the sync filesystem
// code that already reads/writes via process.env.DATA_DIR.
//
// On Vercel: KV_URL is set → this module reads KV → /tmp/fids at the start
//   of each function invocation, and writes /tmp/fids → KV after mutations.
// Locally: KV_URL is absent → all functions are no-ops; server.js uses ./data/.
const fs   = require('fs');
const path = require('path');

const HAS_KV  = !!process.env.KV_URL;
const TMP_DIR = '/tmp/fids'; // Vercel Linux containers, not used locally
const ROOT    = path.join(__dirname, '..');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function getKv() {
  return require('@vercel/kv').kv;
}

// Read persistent state from KV and materialise it in /tmp so the sync
// modules (store.js, scheduler.js) can read it with ordinary fs calls.
async function loadState() {
  if (!HAS_KV) return;
  ensureTmpDir();
  process.env.DATA_DIR = TMP_DIR;

  const db = getKv();
  const [flights, schedule] = await Promise.all([
    db.get('flights'),
    db.get('schedule'),
  ]);

  // Flights
  fs.writeFileSync(
    path.join(TMP_DIR, 'flights.json'),
    JSON.stringify(flights || { lastUpdated: null, flights: [] }, null, 2),
  );

  // Schedule — seed from repo on first deploy (key absent from KV)
  const scheduleDst = path.join(TMP_DIR, 'schedule.json');
  if (schedule) {
    fs.writeFileSync(scheduleDst, JSON.stringify(schedule, null, 2));
  } else {
    const seed = path.join(ROOT, 'data', 'schedule.json');
    if (fs.existsSync(seed)) fs.copyFileSync(seed, scheduleDst);
  }

  // Config — built from example template; secrets always come from env vars
  const cfgDst = path.join(TMP_DIR, 'config.json');
  if (!fs.existsSync(cfgDst)) {
    const ex = path.join(ROOT, 'config.example.json');
    if (fs.existsSync(ex)) fs.copyFileSync(ex, cfgDst);
  }
}

// Write the current /tmp/flights.json back to KV.
// Returns the lastUpdated timestamp written (for diagnostic use by /api/tick).
async function saveFlights() {
  if (!HAS_KV) return null;
  const db = getKv();
  const p = path.join(TMP_DIR, 'flights.json');
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  await db.set('flights', data);
  // Read back immediately to confirm the write reached the store.
  const verify = await db.get('flights');
  return { wrote: data.lastUpdated, readback: verify?.lastUpdated };
}

// Write the current /tmp/schedule.json back to KV.
async function saveSchedule() {
  if (!HAS_KV) return;
  const db = getKv();
  const p = path.join(TMP_DIR, 'schedule.json');
  if (fs.existsSync(p)) {
    await db.set('schedule', JSON.parse(fs.readFileSync(p, 'utf8')));
  }
}

// Live ADS-B data shared between the tick and /api/live.
// Expires after 5 min so stale data from a dead tick isn't served forever.
async function getLiveData() {
  if (!HAS_KV) return null;
  return getKv().get('liveData');
}

async function setLiveData(data) {
  if (!HAS_KV) return;
  await getKv().set('liveData', data, { ex: 300 });
}

// Ephemeral poll state (dedup map, backoff timers).
// Lost on cold starts — acceptable; worst case is one extra API call.
async function getPollState() {
  if (!HAS_KV) return {};
  return (await getKv().get('pollState')) || {};
}

async function setPollState(state) {
  if (!HAS_KV) return;
  await getKv().set('pollState', state, { ex: 3600 }); // 1h TTL
}

// Login brute-force lockout, keyed per IP. Backed by KV (shared across every
// serverless instance) instead of an in-memory Map — an in-memory counter
// resets on cold start AND is per-instance, so a distributed/parallel login
// attack can land on several warm instances at once and never trip the
// 5-attempts lockout. KV makes the counter global regardless of which
// instance handles which request. Falls back to null when KV isn't
// configured (local dev) — the caller keeps its own in-memory fallback.
async function getLoginFail(ip) {
  if (!HAS_KV) return null;
  return getKv().get(`loginfail:${ip}`);
}

async function setLoginFail(ip, record, ttlSeconds) {
  if (!HAS_KV) return;
  await getKv().set(`loginfail:${ip}`, record, { ex: ttlSeconds });
}

async function clearLoginFail(ip) {
  if (!HAS_KV) return;
  await getKv().del(`loginfail:${ip}`);
}

// Tick concurrency guard. /api/tick has no queue — cron-job.org fires it
// every 2 min regardless of whether the previous run finished, and each run
// does several sequential external API calls (GitHub, FR24, OpenSky) that
// can occasionally take much longer than usual. Two overlapping runs each
// load the same KV snapshot into their own /tmp, mutate it independently,
// and whichever finishes last silently overwrites the other's work — so a
// slow run can make a healthy, already-suppressed flight list flip back to
// stale data. SET NX with a short TTL makes only one tick body execute at a
// time; the loser returns immediately instead of racing to save.
// No-ops (always "acquired") when KV isn't configured — local kiosk mode
// runs ticks sequentially in one process, so there's nothing to race.
async function acquireTickLock() {
  if (!HAS_KV) return true;
  const res = await getKv().set('tick-lock', Date.now(), { nx: true, ex: 55 });
  return res !== null;
}

async function releaseTickLock() {
  if (!HAS_KV) return;
  await getKv().del('tick-lock');
}

module.exports = {
  loadState, saveFlights, saveSchedule,
  getLiveData, setLiveData,
  getPollState, setPollState,
  getLoginFail, setLoginFail, clearLoginFail,
  acquireTickLock, releaseTickLock,
  TMP_DIR, HAS_KV,
};
