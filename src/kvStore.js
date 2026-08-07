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
async function saveFlights() {
  if (!HAS_KV) return;
  const db = getKv();
  const p = path.join(TMP_DIR, 'flights.json');
  if (fs.existsSync(p)) {
    await db.set('flights', JSON.parse(fs.readFileSync(p, 'utf8')));
  }
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

module.exports = {
  loadState, saveFlights, saveSchedule,
  getLiveData, setLiveData,
  getPollState, setPollState,
  TMP_DIR, HAS_KV,
};
