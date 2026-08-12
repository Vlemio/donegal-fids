// Vercel entry point — all /api/* requests route here.
// Mirrors server.js routes exactly; background polling is replaced by the
// /api/tick route which cron-job.org calls every 2 minutes.
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const store    = require('../src/store');
const scheduler    = require('../src/scheduler');
const apiAdapter   = require('../src/apiAdapter');
const fr24Adapter  = require('../src/fr24Adapter');
const flightAwareAdapter = require('../src/flightAwareAdapter');
const openskyAdapter     = require('../src/openskyAdapter');
const tracker      = require('../src/tracker');
const websiteSync  = require('../src/websiteSync');
const kv           = require('../src/kvStore');
const { issueToken, verifyToken, timingSafeStringEqual } = require('../src/authToken');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS for the public board data endpoint
app.use((req, res, next) => {
  if (req.path === '/api/flights' && req.method === 'GET') {
    res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  }
  next();
});

// Load KV state into /tmp before every request so the sync modules (store,
// scheduler) can use ordinary fs reads. No-op when running locally.
app.use(async (req, res, next) => {
  try { await kv.loadState(); } catch (e) { console.error('[kv] load:', e.message); }
  next();
});

// ---- Auth helpers -----------------------------------------------------------
function parseCookies(header) {
  return (header || '').split(';').reduce((acc, part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) acc[k.trim()] = v.join('=').trim();
    return acc;
  }, {});
}

// Brute-force guard on the login form: 5 wrong passwords from same IP → 15-min lockout.
// Backed by KV when available (see src/kvStore.js) so the counter is shared
// across every serverless instance — an in-memory-only Map resets per cold
// start AND is per-instance, so a parallel/distributed attack can dodge it
// entirely by landing on several warm instances at once. Falls back to this
// in-memory Map when KV isn't configured (local dev without a KV_URL).
const _loginFailsMem = new Map();
const LOGIN_MAX    = 5;
const LOGIN_LOCK_S  = 15 * 60;

async function getLoginFailRecord(ip) {
  const fromKv = await kv.getLoginFail(ip);
  return fromKv || _loginFailsMem.get(ip) || { count: 0, until: 0 };
}

async function recordLoginFail(ip, record) {
  if (kv.HAS_KV) {
    const ttl = record.until > Date.now() ? Math.ceil((record.until - Date.now()) / 1000) : LOGIN_LOCK_S;
    await kv.setLoginFail(ip, record, ttl);
  } else {
    _loginFailsMem.set(ip, record);
  }
}

async function clearLoginFailRecord(ip) {
  if (kv.HAS_KV) await kv.clearLoginFail(ip);
  else _loginFailsMem.delete(ip);
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

// Routes that don't need auth
const PUBLIC_ROUTES = [
  { m: 'GET',  p: '/api/flights' },   // public board data for the airport website
  { m: 'POST', p: '/api/auth' },      // login form
  { m: 'GET',  p: '/api/logout' },    // logout (clears cookie — no auth needed)
  { m: 'GET',  p: '/api/tick' },      // cron-job.org — has its own TICK_SECRET check
  { m: 'POST', p: '/api/tick' },
];

// Auth wall — runs before every API route.
// Returns 401 JSON (not a redirect) so admin.js fetch calls can detect it cleanly.
//
// The cookie holds a signed, expiring session token (see src/authToken.js),
// never the password itself — a leaked cookie only grants a time-boxed
// session, not the real credential, and rotating FIDS_PASSWORD invalidates
// every outstanding token immediately.
app.use((req, res, next) => {
  const pw = process.env.FIDS_PASSWORD;
  if (!pw) return next(); // dev mode — no password set, open access

  if (PUBLIC_ROUTES.some(r => r.m === req.method && r.p === req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (verifyToken(cookies.fids_auth, pw)) return next();

  return res.status(401).json({ error: 'Authentication required' });
});

// ---- Config helpers (same overlay logic as server.js) ----------------------
function readConfig() {
  const cfgPath = kv.HAS_KV
    ? path.join(kv.TMP_DIR, 'config.json')
    : path.join(__dirname, '..', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (process.env.FR24_API_KEY)          cfg.fr24        = { ...cfg.fr24,        apiKey:       process.env.FR24_API_KEY };
  if (process.env.RAPIDAPI_KEY)          cfg.api         = { ...cfg.api,         rapidApiKey:  process.env.RAPIDAPI_KEY };
  if (process.env.OPENSKY_CLIENT_ID)     cfg.opensky     = { ...cfg.opensky,     clientId:     process.env.OPENSKY_CLIENT_ID };
  if (process.env.OPENSKY_CLIENT_SECRET) cfg.opensky     = { ...cfg.opensky,     clientSecret: process.env.OPENSKY_CLIENT_SECRET };
  if (process.env.GITHUB_GIST_ID)        cfg.websiteSync = { ...cfg.websiteSync, gistId:       process.env.GITHUB_GIST_ID };
  if (process.env.GITHUB_GIST_TOKEN)     cfg.websiteSync = { ...cfg.websiteSync, gistToken:    process.env.GITHUB_GIST_TOKEN };
  return cfg;
}

function writeConfig(cfg) {
  const cfgPath = kv.HAS_KV
    ? path.join(kv.TMP_DIR, 'config.json')
    : path.join(__dirname, '..', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---- In-memory state (persists across warm invocations, resets on cold start)
// The tick also saves/loads this from KV so it survives container recycling.
let liveData = { at: null, ok: null, message: 'No tracking data yet', aircraft: [], tracked: [], possible: [] };
let lastPoll = { at: null, ok: null, message: 'Polling not started' };
let lastSync = { at: null, ok: null, message: 'Website sync not started' };
let openskyBackoffUntil   = 0;
let openskyConsecutive429 = 0;
let lastApproachPoll = 0;
let lastDepartPoll   = 0;
const firedReasons   = new Map();

// ---- Polling helpers (same logic as server.js) -----------------------------
const POLL_CHECK_MS   = 2 * 60 * 1000;
const TRIG_TOL        = 3;
const FIXED_SWEEPS    = [4*60, 9*60, 12*60, 15*60];
const REASON_COOLDOWN = 12 * 60 * 1000;

function _nowMinsTz(tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}

function _hhmToMins(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function apiTrigger(data, cfg) {
  const tz  = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
  const now = _nowMinsTz(tz);
  for (const sweep of FIXED_SWEEPS) {
    if (Math.abs(now - sweep) <= TRIG_TOL) {
      const hh = String(Math.floor(sweep / 60)).padStart(2, '0');
      const mm = String(sweep % 60).padStart(2, '0');
      return `daily sweep ${hh}:${mm}`;
    }
  }
  for (const f of data.flights) {
    if (f.status === 'Landed' || f.status === 'Cancelled') continue;
    const t = _hhmToMins(f.time);
    if (t == null) continue;
    const diff = now - t;
    if (Math.abs(diff + 60) <= TRIG_TOL) return `T-60 ${f.flightNo}`;
    if (f.type === 'arrival') {
      if (Math.abs(diff + 20) <= TRIG_TOL) return `T-20 ${f.flightNo}`;
      if (Math.abs(diff)      <= TRIG_TOL) return `T   ${f.flightNo}`;
      if (diff > 0 && diff <= 120 && diff % 20 <= TRIG_TOL) return `+${diff}min delay ${f.flightNo}`;
    } else {
      if (Math.abs(diff) <= TRIG_TOL) return `T   ${f.flightNo}`;
      if (diff > 0 && diff <= 120 && f.status !== 'Departed' && diff % 20 <= TRIG_TOL) return `+${diff}min delay ${f.flightNo}`;
    }
  }
  return null;
}

async function pollOnce(forceReason) {
  const cfg = readConfig();
  if (!cfg.api.enabled) {
    lastPoll = { at: new Date().toISOString(), ok: false, message: 'API disabled' };
    return lastPoll;
  }
  const data   = store.read();
  const reason = forceReason || apiTrigger(data, cfg);
  if (!reason) {
    lastPoll = { ...lastPoll, at: new Date().toISOString(), message: 'Standby' };
    return lastPoll;
  }
  if (!forceReason) {
    const last = firedReasons.get(reason) || 0;
    if (Date.now() - last < REASON_COOLDOWN) {
      lastPoll = { ...lastPoll, at: new Date().toISOString(), message: 'Standby' };
      return lastPoll;
    }
    firedReasons.set(reason, Date.now());
  }
  const results = { adb: 0, fr24: 0, fa: 0, errors: [] };
  try {
    const flights = await apiAdapter.fetchFlights(cfg);
    store.mergeApi(flights);
    results.adb = flights.length;
  } catch (err) { results.errors.push(`ADB: ${err.message}`); }
  if (cfg.fr24 && cfg.fr24.enabled && cfg.fr24.apiKey) {
    try {
      const fr24Flights = await fr24Adapter.fetchFlights(cfg);
      store.mergeApi(fr24Flights);
      results.fr24 = fr24Flights.length;
    } catch (err) { results.errors.push(`FR24: ${err.message}`); }
  }
  if (cfg.flightaware && cfg.flightaware.enabled && cfg.flightaware.apiKey) {
    try {
      const faFlights = await flightAwareAdapter.fetchFlights(cfg);
      store.mergeApi(faFlights);
      results.fa = faFlights.length;
    } catch (err) { results.errors.push(`FA: ${err.message}`); }
  }
  const errStr = results.errors.length ? ` (errors: ${results.errors.join('; ')})` : '';
  lastPoll = {
    at: new Date().toISOString(),
    ok: results.errors.length < 2,
    message: `[${reason}] ADB:${results.adb} FR24:${results.fr24} FA:${results.fa}${errStr}`,
  };
  return lastPoll;
}

// Returns true when any flight is in a time-critical window that warrants 1-min FR24 polling.
// Arrivals: within 10 min of API-estimated ETA, OR within 15 min of scheduled time when
//   estTime is unknown — the wider window covers early arrivals where FR24 hasn't yet
//   populated estTime and the scheduled time is the only reference we have.
// Departures: within ±30 min of estimated departure — to catch Departed quickly.
function isInFastPollWindow(data, cfg) {
  const tz  = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
  const now = _nowMinsTz(tz);
  for (const f of data.flights) {
    if (f.suppressed) continue;
    if (['Landed', 'Departed', 'Cancelled', 'Diverted'].includes(f.status)) continue;
    if (f.type === 'arrival') {
      const estMin  = _hhmToMins(f.estTime);
      const schedMin = _hhmToMins(f.time);
      // When we have an API-estimated ETA, use the tighter 10-min window.
      // When estTime is unknown, fall back to scheduled time with a wider 15-min window
      // so early-arriving flights (which land before estTime is set) aren't missed.
      const etaMin  = estMin !== null ? estMin : schedMin;
      const margin  = estMin !== null ? 10 : 15;
      if (etaMin !== null && now >= etaMin - margin) return true;
    } else {
      const depMin = _hhmToMins(f.estTime) ?? _hhmToMins(f.time);
      if (depMin !== null && Math.abs(now - depMin) <= 30) return true;
    }
  }
  return false;
}

// Returns a string describing what was done (included in /api/tick response for diagnosis).
// Previously returned void — callers would see "ok" even when the function returned early
// without querying FR24 at all, which made stale-data bugs impossible to diagnose remotely.
async function fr24Tick(force = false) {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.enabled || !cfg.fr24.apiKey) return 'skipped:no-cfg';
  const data = store.read();
  if (!tracker.isActiveWindow(data, cfg)) return 'skipped:inactive';
  // Fast-poll every minute when close to an arrival ETA or a departure time.
  // Otherwise run every 2 minutes (even UTC minutes only) to save credits.
  // The `force` flag (passed when the admin triggers a manual tick) bypasses the
  // even/odd throttle so the forced run actually queries FR24 instead of silently skipping.
  if (!force && !isInFastPollWindow(data, cfg) && Math.floor(Date.now() / 60000) % 2 !== 0) {
    return 'skipped:throttle';
  }
  const flights = await fr24Adapter.fetchFlights(cfg);
  store.mergeApi(flights);
  return `ok:${flights.length}`;
}

function engineTick() {
  const cfg = readConfig();
  const tz  = cfg.display.timezone || 'Europe/Dublin';
  const data  = store.read();
  const parts = scheduler.localParts(tz);
  const before = JSON.stringify(data.flights);
  if (cfg.display.autoSchedule !== false) scheduler.ensureTodaysFlights(data, scheduler.readSchedule(), parts, tz);
  if (cfg.display.autoStatus   !== false) scheduler.autoAdvanceStatus(data, cfg, parts);
  scheduler.cleanupOld(data, cfg, parts);
  if (JSON.stringify(data.flights) !== before) store.write(data);
}

async function trackTick() {
  const cfg = readConfig();
  if (!cfg.opensky || !cfg.opensky.enabled) {
    liveData = { at: new Date().toISOString(), ok: false, message: 'Live tracking off', aircraft: [], tracked: [] };
    return;
  }
  if (Date.now() < openskyBackoffUntil) return;
  const data = store.read();
  const IDLE_REFRESH_MS = 5 * 60 * 1000;
  const dataAge = liveData.at ? Date.now() - new Date(liveData.at).getTime() : Infinity;
  if (!tracker.isActiveWindow(data, cfg) && dataAge < IDLE_REFRESH_MS) return;

  try {
    const states = await openskyAdapter.getStates(cfg);
    openskyBackoffUntil   = 0;
    openskyConsecutive429 = 0;
    const knownHexes = new Set(states.map(s => s.icao24));
    const remoteHexes = data.flights
      .filter(f => f.type === 'arrival' && f.fr24hex &&
                   !['Landed', 'Cancelled', 'Diverted'].includes(f.status) &&
                   !knownHexes.has(f.fr24hex))
      .map(f => f.fr24hex);
    if (remoteHexes.length > 0) {
      try {
        const extra = await openskyAdapter.getStatesByIcao24(remoteHexes, cfg);
        extra.forEach(s => states.push(s));
      } catch (_) {}
    }
    const freshData = store.read();
    const { tracked, possible } = tracker.track(freshData, cfg, states);
    store.write(freshData);

    // FR24 landing check on approach dropout
    const APPROACH_POLL_COOLDOWN = 2 * 60 * 1000;
    const hasApproachDropout = freshData.flights.some(
      f => f.type === 'arrival' && f.status === 'On Approach' && f.live && f.live.dropoutSince,
    );
    if (hasApproachDropout && Date.now() - lastApproachPoll > APPROACH_POLL_COOLDOWN) {
      lastApproachPoll = Date.now();
      pollOnce('fr24-landing-check').catch(() => {});
    }

    // FR24 departure check
    const DEPART_POLL_COOLDOWN = 60 * 1000;
    const depNowMin = _nowMinsTz((cfg.display && cfg.display.timezone) || 'Europe/Dublin');
    const hasPendingDeparture = freshData.flights.some(f => {
      if (f.type !== 'departure') return false;
      if (['Departed', 'Landed', 'Cancelled', 'Diverted'].includes(f.status)) return false;
      const t = _hhmToMins(f.time);
      if (t == null) return false;
      return depNowMin - t >= 0 && depNowMin - t <= 15;
    });
    if (hasPendingDeparture && Date.now() - lastDepartPoll > DEPART_POLL_COOLDOWN) {
      lastDepartPoll = Date.now();
      pollOnce('fr24-depart-check').catch(() => {});
    }

    const possibleMsg = possible.length ? `, ${possible.length} unscheduled approaching` : '';
    liveData = {
      at: new Date().toISOString(), ok: true,
      message: `${states.length} aircraft seen, ${tracked.length} matched${possibleMsg}`,
      aircraft: states, tracked, possible,
    };
  } catch (err) {
    if (err.message && err.message.includes('429')) {
      openskyConsecutive429 = Math.min(openskyConsecutive429 + 1, 3);
      openskyBackoffUntil = Date.now() + Math.pow(2, openskyConsecutive429 - 1) * 5 * 60 * 1000;
    }
    liveData = { ...liveData, at: new Date().toISOString(), ok: false, message: err.message };
  }
}

// ---- /api/tick — cron endpoint (cron-job.org calls this every 2 min) -------
// Protected by TICK_SECRET env var. Set it in Vercel and configure cron-job.org
// to send  Authorization: Bearer <TICK_SECRET>  in the request header.
app.get('/api/tick', async (req, res) => {
  const secret = process.env.TICK_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (!timingSafeStringEqual(auth, `Bearer ${secret}`)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const t0 = Date.now();

  // Concurrency guard: cron-job.org fires this every 2 min regardless of
  // whether the previous run finished. Two overlapping runs each mutate
  // their own /tmp copy of the same starting KV snapshot independently,
  // and whichever calls kv.saveFlights() last silently overwrites the
  // other's work — a slow run (GitHub/FR24/OpenSky hiccup) was enough to
  // make an already-cleaned-up flight list flip back to stale data. Bail
  // out immediately if another tick is already in flight instead of racing.
  if (!(await kv.acquireTickLock())) {
    return res.json({ ok: true, skipped: 'tick already in progress', ms: Date.now() - t0 });
  }

  const results = { engine: false, fr24: null, poll: null, track: null, sync: null };

  try {
    try {
      engineTick();
      results.engine = true;
    } catch (err) { results.engineErr = err.message; }

    try {
      const force = req.query.force === '1';
      results.fr24 = await fr24Tick(force);
    } catch (err) { results.fr24 = `err: ${err.message}`; }

    try {
      const p = await pollOnce();
      results.poll = p.message;
    } catch (err) { results.pollErr = err.message; }

    try {
      await trackTick();
      results.track = liveData.message;
    } catch (err) { results.track = `err: ${err.message}`; }

    try {
      const cfg = readConfig();
      const syncResult = await websiteSync.syncTick(cfg);
      lastSync = { at: new Date().toISOString(), ...syncResult };
      results.sync = syncResult.message;
    } catch (err) { results.sync = `err: ${err.message}`; }

    // Persist updated flights and live data to KV
    try {
      const [kvResult] = await Promise.all([
        kv.saveFlights(),
        kv.setLiveData(liveData),
      ]);
      results.kv = kvResult || 'saved-no-file';
    } catch (err) {
      results.kv = `err: ${err.message}`;
      console.error('[kv] save after tick:', err.message);
    }
  } finally {
    await kv.releaseTickLock();
  }

  res.json({ ok: true, ms: Date.now() - t0, ...results });
});

// ---- Public board data -------------------------------------------------------
app.get('/api/flights', (req, res) => {
  const cfg  = readConfig();
  const data = store.read();
  res.json({
    ...data,
    flights: data.flights.filter(f => !f.suppressed),
    config: { display: cfg.display, airport: cfg.airport },
  });
});

// ---- Manual management (admin panel) ----------------------------------------
app.post('/api/flights', async (req, res) => {
  const data   = store.read();
  const flight = store.normalise({ ...req.body, source: req.body.source || 'manual' });
  const idx = data.flights.findIndex(f => f.id === flight.id);
  if (idx >= 0) data.flights[idx] = flight; else data.flights.push(flight);
  store.write(data);
  await kv.saveFlights();
  res.json(flight);
});

app.put('/api/flights/:id', async (req, res) => {
  const data = store.read();
  const idx  = data.flights.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  data.flights[idx] = store.normalise({ ...data.flights[idx], ...req.body, id: req.params.id });
  store.write(data);
  await kv.saveFlights();
  res.json(data.flights[idx]);
});

app.delete('/api/flights/:id', async (req, res) => {
  const data = store.read();
  data.flights = data.flights.filter(f => f.id !== req.params.id);
  store.write(data);
  await kv.saveFlights();
  res.json({ ok: true });
});

app.post('/api/flights/:id/lock', async (req, res) => {
  const { field, locked } = req.body;
  const data   = store.read();
  const flight = data.flights.find(f => f.id === req.params.id);
  if (!flight) return res.status(404).json({ error: 'not found' });
  flight.locks = flight.locks || {};
  if (locked) flight.locks[field] = true; else delete flight.locks[field];
  store.write(data);
  await kv.saveFlights();
  res.json(flight);
});

// ---- Recurring timetable ----------------------------------------------------
app.get('/api/schedule', (req, res) => res.json(scheduler.readSchedule()));

app.post('/api/schedule', async (req, res) => {
  const data    = scheduler.readSchedule();
  const flightNo = (req.body.flightNo || '').toUpperCase();
  const id = req.body._id ||
    `${req.body.type === 'arrival' ? 'arr' : 'dep'}-${flightNo.toLowerCase()}-${Date.now()}`;
  const entry = {
    _id: id,
    type: req.body.type === 'arrival' ? 'arrival' : 'departure',
    time: req.body.time || '', airline: req.body.airline || '',
    airlineCode: req.body.airlineCode || '', city: req.body.city || '',
    flightNo, callsign: (req.body.callsign || '').toUpperCase(),
    codeshare: Array.isArray(req.body.codeshare) ? req.body.codeshare : [],
    days: Array.isArray(req.body.days) ? req.body.days.map(Number) : [],
  };
  const idx = data.recurring.findIndex(e => e._id === id);
  if (idx >= 0) data.recurring[idx] = entry; else data.recurring.push(entry);
  scheduler.writeSchedule(data);
  engineTick();
  await Promise.all([kv.saveSchedule(), kv.saveFlights()]);
  res.json(entry);
});

app.delete('/api/schedule/by-id/:id', async (req, res) => {
  const data = scheduler.readSchedule();
  data.recurring = data.recurring.filter(e => e._id !== req.params.id);
  scheduler.writeSchedule(data);
  await kv.saveSchedule();
  res.json({ ok: true });
});

app.delete('/api/schedule/:type/:flightNo', async (req, res) => {
  const data = scheduler.readSchedule();
  data.recurring = data.recurring.filter(
    e => !(e.type === req.params.type && e.flightNo === req.params.flightNo.toUpperCase()),
  );
  scheduler.writeSchedule(data);
  await kv.saveSchedule();
  res.json({ ok: true });
});

// ---- Config -----------------------------------------------------------------
app.get('/api/config', (req, res) => res.json(readConfig()));

app.post('/api/config', (req, res) => {
  const cfg  = readConfig();
  const next = {
    ...cfg,
    api:         { ...cfg.api,         ...(req.body.api         || {}) },
    fr24:        { ...cfg.fr24,        ...(req.body.fr24        || {}) },
    display:     { ...cfg.display,     ...(req.body.display     || {}) },
    opensky:     { ...cfg.opensky,     ...(req.body.opensky     || {}) },
    websiteSync: { ...cfg.websiteSync, ...(req.body.websiteSync || {}) },
  };
  writeConfig(next);
  res.json(next);
});

// Force immediate poll (admin button)
app.post('/api/pull', async (req, res) => {
  try {
    const result = await pollOnce('manual');
    await kv.saveFlights();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Status endpoints
app.get('/api/status',      (req, res) => res.json(lastPoll));
app.get('/api/sync-status', (req, res) => res.json(lastSync));

app.post('/api/sync-now', async (req, res) => {
  const cfg    = readConfig();
  const result = await websiteSync.syncTick(cfg);
  lastSync = { at: new Date().toISOString(), ...result };
  res.json(lastSync);
});

// Live ADS-B feed
app.get('/api/live', async (req, res) => {
  const cfg  = readConfig();
  // Prefer in-memory (warm) then fall back to KV (different container)
  let live = liveData;
  if (!live.at) live = (await kv.getLiveData()) || liveData;
  res.json({
    home: { icao: cfg.airport.icao, lat: cfg.airport.lat, lon: cfg.airport.lon, name: cfg.airport.name },
    airports: tracker.AIRPORTS,
    ...live,
  });
});

app.post('/api/track', async (req, res) => {
  await trackTick();
  await kv.saveFlights();
  res.json(liveData);
});

// Debug endpoints
app.get('/api/debug/opensky', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.opensky || !cfg.opensky.enabled) return res.json({ ok: false, message: 'Tracking disabled' });
  try {
    const states = await openskyAdapter.getStates(cfg);
    res.json({ ok: true, count: states.length, sample: states.slice(0, 3), bbox: cfg.opensky.bbox });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/debug/positions/raw', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.enabled) return res.json({ ok: false });
  try {
    const bb = (cfg.opensky && cfg.opensky.bbox) || {};
    const bounds = [bb.lamax || 56.5, bb.lamin || 51.0, bb.lomin || -11.0, bb.lomax || -4.0].join(',');
    const r = await fetch(
      `https://fr24api.flightradar24.com/api/live/flight-positions/light?${new URLSearchParams({ bounds })}`,
      { headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${cfg.fr24.apiKey}` } },
    );
    const data = await r.json();
    const entries = Array.isArray(data.data) ? data.data : [];
    res.json({ ok: true, count: entries.length, rawSample: entries.slice(0, 3), allKeys: entries[0] ? Object.keys(entries[0]) : [] });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/debug/fr24-credits', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.apiKey) return res.json({ ok: false, message: 'No FR24 key' });
  const headers = { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${cfg.fr24.apiKey}` };
  try {
    const bb = (cfg.opensky && cfg.opensky.bbox) || {};
    const bounds = [bb.lamax || 56.5, bb.lamin || 51.0, bb.lomin || -11.0, bb.lomax || -4.0].join(',');
    const posRes = await fetch(
      `https://fr24api.flightradar24.com/api/live/flight-positions/light?${new URLSearchParams({ bounds })}`,
      { headers },
    );
    let usageBody = null;
    try {
      const uRes = await fetch('https://fr24api.flightradar24.com/api/usage', { headers });
      usageBody = { status: uRes.status, body: await uRes.json().catch(() => null) };
    } catch (_) {}
    res.json({ ok: true, positionCallStatus: posRes.status, responseHeaders: Object.fromEntries(posRes.headers.entries()), usage: usageBody });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/debug/icao/:icao24', (req, res) => {
  const icao = req.params.icao24.toLowerCase().trim();
  const all  = liveData.aircraft || [];
  const found = all.find(st => (st.icao24 || '').toLowerCase() === icao);
  if (!found) return res.json({ ok: false, icao24: icao, message: 'Not in current live data', totalAircraft: all.length });
  res.json({
    ok: true, icao24: found.icao24,
    callsign: (found.callsign || '').trim() || '(no callsign)',
    onGround: found.onGround,
    altitudeFt: found.baroAltitude != null ? Math.round(found.baroAltitude * 3.281) : null,
    speedKt: found.velocity != null ? Math.round(found.velocity * 1.94384) : null,
    lat: found.lat, lon: found.lon, track: found.track, raw: found,
  });
});

// Suppress/restore (admin operations)
app.post('/api/flights/:id/suppress', async (req, res) => {
  const data = store.read();
  const f    = data.flights.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  f.suppressed = true;
  f.schedDate  = scheduler.localParts(readConfig().display.timezone || 'Europe/Dublin').date;
  f.live       = null;
  store.write(data);
  await kv.saveFlights();
  res.json(f);
});

app.post('/api/flights/:id/restore', async (req, res) => {
  const data = store.read();
  const f    = data.flights.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  f.suppressed = false;
  store.write(data);
  await kv.saveFlights();
  res.json(f);
});

// Cookie-based auth — login form posts here
app.post('/api/auth', async (req, res) => {
  const pw = process.env.FIDS_PASSWORD;
  const { username, password } = req.body || {};
  const ip = getIp(req);
  const record = await getLoginFailRecord(ip);

  if (record.until > Date.now()) {
    const mins = Math.ceil((record.until - Date.now()) / 60000);
    return res.redirect(302, `/login.html?error=locked&mins=${mins}`);
  }

  if (pw && username === 'donegal' && timingSafeStringEqual(password, pw)) {
    await clearLoginFailRecord(ip);
    res.setHeader('Set-Cookie',
      `fids_auth=${issueToken(pw)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
    return res.redirect(302, '/');
  }

  record.count += 1;
  if (record.count >= LOGIN_MAX) {
    record.until = Date.now() + LOGIN_LOCK_S * 1000;
    console.warn(`[auth] IP ${ip} locked out after ${record.count} failed login attempts`);
  }
  await recordLoginFail(ip, record);
  return res.redirect(302, '/login.html?error=1');
});

app.get('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie',
    'fids_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  res.redirect(302, '/login.html');
});

module.exports = app;
