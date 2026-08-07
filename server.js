// Donegal FIDS server
// - Serves the display board (/) and the staff control panel (/admin)
// - REST API for manual flight management
// - Optional background polling of a flight-data API (hybrid mode)
const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./src/store');
const apiAdapter = require('./src/apiAdapter');
const fr24Adapter = require('./src/fr24Adapter');
const flightAwareAdapter = require('./src/flightAwareAdapter');
const scheduler = require('./src/scheduler');
const openskyAdapter = require('./src/openskyAdapter');
const tracker = require('./src/tracker');
const websiteSync = require('./src/websiteSync');

// Cloud deploy: DATA_DIR env var points to a persistent volume (e.g. /data on Railway).
// Locally: falls back to ./data/ for data files and ./config.json for config.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = process.env.DATA_DIR
  ? path.join(DATA_DIR, 'config.json')
  : path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 8080;

// On first cloud deploy the volume is empty — seed from bundled defaults.
function initDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const seed = (src, dst) => {
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`[init] seeded ${path.basename(dst)} from repo`);
    }
  };
  seed(path.join(__dirname, 'data', 'schedule.json'), path.join(DATA_DIR, 'schedule.json'));
  seed(path.join(__dirname, 'config.example.json'),   CONFIG_FILE);
  const flightsFile = path.join(DATA_DIR, 'flights.json');
  if (!fs.existsSync(flightsFile)) {
    fs.writeFileSync(flightsFile, JSON.stringify({ lastUpdated: null, flights: [] }, null, 2));
    console.log('[init] created empty flights.json');
  }
}

function readConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  // Env var overrides for secrets — safe to set in Railway without exposing them in config.json.
  if (process.env.FR24_API_KEY)          cfg.fr24      = { ...cfg.fr24,      apiKey:       process.env.FR24_API_KEY };
  if (process.env.RAPIDAPI_KEY)          cfg.api       = { ...cfg.api,       rapidApiKey:  process.env.RAPIDAPI_KEY };
  if (process.env.OPENSKY_CLIENT_ID)     cfg.opensky   = { ...cfg.opensky,   clientId:     process.env.OPENSKY_CLIENT_ID };
  if (process.env.OPENSKY_CLIENT_SECRET) cfg.opensky   = { ...cfg.opensky,   clientSecret: process.env.OPENSKY_CLIENT_SECRET };
  if (process.env.GITHUB_GIST_ID)        cfg.websiteSync = { ...cfg.websiteSync, gistId:   process.env.GITHUB_GIST_ID };
  if (process.env.GITHUB_GIST_TOKEN)     cfg.websiteSync = { ...cfg.websiteSync, gistToken: process.env.GITHUB_GIST_TOKEN };
  return cfg;
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// HTTP Basic Auth — protects all routes except GET /api/flights (public for the airport website).
// Set FIDS_PASSWORD env var to enable; if not set the server is open (local/dev mode).
function basicAuth(req, res, next) {
  const pw = process.env.FIDS_PASSWORD;
  if (!pw) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass === pw) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Donegal Airport FIDS"');
  res.status(401).send('Donegal Airport FIDS — authentication required');
}

const app = express();
app.use(express.json());

// Auth wall — before static files so the board HTML itself is gated.
// GET /api/flights is exempt so the airport website can fetch without credentials.
app.use((req, res, next) => {
  if (req.path === '/api/flights' && req.method === 'GET') return next();
  basicAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ---- Public board data -----------------------------------------------------
app.get('/api/flights', (req, res) => {
  const cfg = readConfig();
  const data = store.read();
  // CORS: allow the airport website to fetch flight data cross-origin.
  const origin = process.env.CORS_ORIGIN || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.json({ ...data, flights: data.flights.filter(f => !f.suppressed), config: { display: cfg.display, airport: cfg.airport } });
});

// ---- Manual management (used by /admin) ------------------------------------
app.post('/api/flights', (req, res) => {
  const data = store.read();
  const flight = store.normalise({ ...req.body, source: req.body.source || 'manual' });
  const idx = data.flights.findIndex((f) => f.id === flight.id);
  if (idx >= 0) data.flights[idx] = flight;
  else data.flights.push(flight);
  store.write(data);
  res.json(flight);
});

app.put('/api/flights/:id', (req, res) => {
  const data = store.read();
  const idx = data.flights.findIndex((f) => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  data.flights[idx] = store.normalise({ ...data.flights[idx], ...req.body, id: req.params.id });
  store.write(data);
  res.json(data.flights[idx]);
});

app.delete('/api/flights/:id', (req, res) => {
  const data = store.read();
  data.flights = data.flights.filter((f) => f.id !== req.params.id);
  store.write(data);
  res.json({ ok: true });
});

// Toggle a per-field lock so the API will not overwrite a manual value.
app.post('/api/flights/:id/lock', (req, res) => {
  const { field, locked } = req.body;
  const data = store.read();
  const flight = data.flights.find((f) => f.id === req.params.id);
  if (!flight) return res.status(404).json({ error: 'not found' });
  flight.locks = flight.locks || {};
  if (locked) flight.locks[field] = true;
  else delete flight.locks[field];
  store.write(data);
  res.json(flight);
});

// ---- Recurring timetable ----------------------------------------------------
app.get('/api/schedule', (req, res) => res.json(scheduler.readSchedule()));

app.post('/api/schedule', (req, res) => {
  const data = scheduler.readSchedule();
  const flightNo = (req.body.flightNo || '').toUpperCase();
  const id = req.body._id ||
    `${req.body.type === 'arrival' ? 'arr' : 'dep'}-${flightNo.toLowerCase()}-${Date.now()}`;
  const entry = {
    _id: id,
    type: req.body.type === 'arrival' ? 'arrival' : 'departure',
    time: req.body.time || '',
    airline: req.body.airline || '',
    airlineCode: req.body.airlineCode || '',
    city: req.body.city || '',
    flightNo,
    callsign: (req.body.callsign || '').toUpperCase(),
    codeshare: Array.isArray(req.body.codeshare) ? req.body.codeshare : [],
    days: Array.isArray(req.body.days) ? req.body.days.map(Number) : []
  };
  const idx = data.recurring.findIndex((e) => e._id === id);
  if (idx >= 0) data.recurring[idx] = entry;
  else data.recurring.push(entry);
  scheduler.writeSchedule(data);
  engineTick();
  res.json(entry);
});

// Delete by _id — must be registered before the generic :type/:flightNo route.
app.delete('/api/schedule/by-id/:id', (req, res) => {
  const data = scheduler.readSchedule();
  data.recurring = data.recurring.filter((e) => e._id !== req.params.id);
  scheduler.writeSchedule(data);
  res.json({ ok: true });
});

app.delete('/api/schedule/:type/:flightNo', (req, res) => {
  const data = scheduler.readSchedule();
  data.recurring = data.recurring.filter(
    (e) => !(e.type === req.params.type && e.flightNo === req.params.flightNo.toUpperCase())
  );
  scheduler.writeSchedule(data);
  res.json({ ok: true });
});

// ---- Config (API key, intervals, notice text) ------------------------------
app.get('/api/config', (req, res) => res.json(readConfig()));

app.post('/api/config', (req, res) => {
  const cfg = readConfig();
  const next = {
    ...cfg,
    api: { ...cfg.api, ...(req.body.api || {}) },
    fr24: { ...cfg.fr24, ...(req.body.fr24 || {}) },
    display: { ...cfg.display, ...(req.body.display || {}) },
    opensky: { ...cfg.opensky, ...(req.body.opensky || {}) },
    websiteSync: { ...cfg.websiteSync, ...(req.body.websiteSync || {}) }
  };
  writeConfig(next);
  restartPolling();
  startWebsiteSync();
  res.json(next);
});

// Force an immediate API pull (button in admin).
app.post('/api/pull', async (req, res) => {
  try {
    const result = await pollOnce('manual');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/operator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operator.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Background polling (smart event-driven schedule) -----------------------
// Instead of a blind fixed interval, AeroDataBox is called only at meaningful
// moments, keeping usage well within the free tier (~10-15 calls/day):
//
//   04:00          — full-day timetable discovery (seeds all today's flights)
//   09:00 12:00 15:00 — ad-hoc sweeps (catches jets, charters, LoganAir extras)
//   T-60 per flight — cancel / delay check before origin departure
//   T    per flight — has it actually taken off / arrived?
//   T+20, T+40 … T+120 — delay recovery: every 20 min while still not moving

let pollTimer = null;
let fr24Timer  = null;
let lastPoll = { at: null, ok: null, message: 'Polling not started' };

const POLL_CHECK_MS    = 2 * 60 * 1000;              // lightweight check every 2 min
const TRIG_TOL         = 3;                           // ±3 min window around a trigger
const FIXED_SWEEPS     = [4*60, 9*60, 12*60, 15*60]; // 04:00 09:00 12:00 15:00
const REASON_COOLDOWN  = 12 * 60 * 1000;             // same trigger fires at most once per 12 min
const firedReasons     = new Map();                   // reason → last-fired timestamp

function _nowMinsTz(tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}

function _hhmToMins(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Returns a human-readable reason string when an API call is due, else null.
function apiTrigger(data, cfg) {
  const tz  = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
  const now = _nowMinsTz(tz);

  // 1. Fixed daily sweeps
  for (const sweep of FIXED_SWEEPS) {
    if (Math.abs(now - sweep) <= TRIG_TOL) {
      const hh = String(Math.floor(sweep / 60)).padStart(2, '0');
      const mm = String(sweep % 60).padStart(2, '0');
      return `daily sweep ${hh}:${mm}`;
    }
  }

  // 2. Per-flight event triggers
  for (const f of data.flights) {
    if (f.status === 'Landed' || f.status === 'Cancelled') continue;
    const t = _hhmToMins(f.time);
    if (t == null) continue;
    const diff = now - t;  // negative = before scheduled time, positive = after

    // T-60: cancel / delay check (works for both arrivals and departures)
    if (Math.abs(diff + 60) <= TRIG_TOL) return `T-60 ${f.flightNo}`;

    if (f.type === 'arrival') {
      if (Math.abs(diff + 20) <= TRIG_TOL) return `T-20 ${f.flightNo}`;  // final approach window
      if (Math.abs(diff)      <= TRIG_TOL) return `T   ${f.flightNo}`;   // scheduled arrival
      // Delay recovery: every 20 min while not yet on the ground (up to 2h late)
      if (diff > 0 && diff <= 120 && diff % 20 <= TRIG_TOL) return `+${diff}min delay ${f.flightNo}`;

    } else { // departure from Donegal
      if (Math.abs(diff) <= TRIG_TOL) return `T   ${f.flightNo}`;        // scheduled departure
      // Not yet departed: keep asking every 20 min
      if (diff > 0 && diff <= 120 && f.status !== 'Departed' && diff % 20 <= TRIG_TOL) {
        return `+${diff}min delay ${f.flightNo}`;
      }
    }
  }

  return null; // nothing due right now
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

  // Dedup: the ±3 min trigger window spans 3 consecutive 2-min checks.
  // Only fire each unique trigger reason once per 12-min cooldown window.
  if (!forceReason) {
    const last = firedReasons.get(reason) || 0;
    if (Date.now() - last < REASON_COOLDOWN) {
      lastPoll = { ...lastPoll, at: new Date().toISOString(), message: 'Standby' };
      return lastPoll;
    }
    firedReasons.set(reason, Date.now());
  }

  // Poll order: AeroDataBox first (scheduled times + basic status), then FR24
  // (ICAO callsigns + authoritative events overwrite ADB), then FlightAware if enabled.
  const results = { adb: 0, fr24: 0, fa: 0, errors: [] };
  try {
    const flights = await apiAdapter.fetchFlights(cfg);
    store.mergeApi(flights);
    results.adb = flights.length;
  } catch (err) {
    results.errors.push(`ADB: ${err.message}`);
    console.warn(`[poll] AeroDataBox failed: ${err.message}`);
  }
  if (cfg.fr24 && cfg.fr24.enabled && cfg.fr24.apiKey) {
    try {
      const fr24Flights = await fr24Adapter.fetchFlights(cfg);
      store.mergeApi(fr24Flights);
      results.fr24 = fr24Flights.length;
    } catch (err) {
      results.errors.push(`FR24: ${err.message}`);
      console.warn(`[poll] FR24 failed: ${err.message}`);
    }
  }
  if (cfg.flightaware && cfg.flightaware.enabled && cfg.flightaware.apiKey) {
    try {
      const faFlights = await flightAwareAdapter.fetchFlights(cfg);
      store.mergeApi(faFlights);
      results.fa = faFlights.length;
    } catch (err) {
      results.errors.push(`FA: ${err.message}`);
      console.warn(`[poll] FlightAware failed: ${err.message}`);
    }
  }
  const errStr = results.errors.length ? ` (errors: ${results.errors.join('; ')})` : '';
  lastPoll = {
    at: new Date().toISOString(),
    ok: results.errors.length < 2,
    message: `[${reason}] ADB:${results.adb} FR24:${results.fr24} FA:${results.fa} flights${errStr}`
  };
  console.log(`[poll] ${lastPoll.message}`);
  return lastPoll;
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const cfg = readConfig();
  if (!cfg.api.enabled) {
    console.log('[poll] API disabled — commercial data off');
    return;
  }
  pollOnce('startup');
  pollTimer = setInterval(pollOnce, POLL_CHECK_MS);
  console.log(`[poll] smart schedule active — checks every ${POLL_CHECK_MS / 60000} min`);
}

// FR24 independent poll — runs every 5 min during the active flight window.
// ADB is expensive (RapidAPI credits) so we fire it only on event triggers.
// FR24 is cheaper and more time-sensitive (actual takeoff/landing events),
// so it gets its own heartbeat to catch events between the ADB trigger windows.
async function fr24Tick() {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.enabled || !cfg.fr24.apiKey) return;
  const data = store.read();
  if (!tracker.isActiveWindow(data, cfg)) return;
  try {
    const flights = await fr24Adapter.fetchFlights(cfg);
    store.mergeApi(flights);
    console.log(`[fr24] ${flights.length} flights`);
  } catch (err) {
    console.warn(`[fr24] poll failed: ${err.message}`);
  }
}

function startFr24Polling() {
  if (fr24Timer) clearInterval(fr24Timer);
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.enabled) {
    console.log('[fr24] independent polling disabled');
    return;
  }
  fr24Tick(); // immediate first call — don't wait 1 min on startup
  fr24Timer = setInterval(fr24Tick, 60 * 1000);
  console.log('[fr24] independent poll every 1 min (active window only)');
}

app.get('/api/status', (req, res) => res.json(lastPoll));

// ---- Auto engine (free, no API): timetable + clock-driven statuses ----------
let engineTimer = null;

function engineTick() {
  const cfg = readConfig();
  const tz = cfg.display.timezone || 'Europe/Dublin';
  const data = store.read();
  const parts = scheduler.localParts(tz);
  let changed = JSON.stringify(data.flights);

  if (cfg.display.autoSchedule !== false) {
    scheduler.ensureTodaysFlights(data, scheduler.readSchedule(), parts);
  }
  if (cfg.display.autoStatus !== false) {
    scheduler.autoAdvanceStatus(data, cfg, parts);
  }
  scheduler.cleanupOld(data, cfg, parts);

  if (JSON.stringify(data.flights) !== changed) store.write(data);
}

function startEngine() {
  if (engineTimer) clearInterval(engineTimer);
  engineTick();
  engineTimer = setInterval(engineTick, 60 * 1000);
  console.log('[engine] auto timetable + status running (every 60s)');
}

// ---- Live ADS-B tracking (free, OpenSky) -----------------------------------
let trackTimer = null;
let liveData = { at: null, ok: null, message: 'Tracking not started', aircraft: [], tracked: [], possible: [] };
let openskyBackoffUntil   = 0; // epoch ms — don't call OpenSky before this time
let openskyConsecutive429 = 0; // exponential backoff counter
let lastApproachPoll = 0; // epoch ms — last FR24 poll triggered by On Approach dropout
let lastDepartPoll   = 0; // epoch ms — last FR24 poll triggered by pending departure window

async function trackTick() {
  const cfg = readConfig();
  if (!cfg.opensky || !cfg.opensky.enabled) {
    liveData = { at: new Date().toISOString(), ok: false, message: 'Live tracking off', aircraft: [], tracked: [] };
    return;
  }
  // Respect 429 backoff: if we were rate-limited, wait before retrying.
  if (Date.now() < openskyBackoffUntil) {
    const secs = Math.ceil((openskyBackoffUntil - Date.now()) / 1000);
    liveData = { ...liveData, at: new Date().toISOString(), ok: false, message: `Rate-limited — retrying in ${secs}s` };
    return;
  }
  const data = store.read();
  // Smart polling: call OpenSky when a flight is in window, OR when map data
  // is stale (>5 min) so the map always has reasonably fresh aircraft.
  const IDLE_REFRESH_MS = 5 * 60 * 1000;
  const dataAge = liveData.at ? Date.now() - new Date(liveData.at).getTime() : Infinity;
  if (!tracker.isActiveWindow(data, cfg) && dataAge < IDLE_REFRESH_MS) {
    liveData = { ...liveData, at: new Date().toISOString(), ok: true, message: 'Idle — no flight in window' };
    return;
  }
  try {
    const states = await openskyAdapter.getStates(cfg);
    openskyBackoffUntil   = 0; // successful call — clear backoff
    openskyConsecutive429 = 0; // reset exponential counter

    // Supplement bbox with direct ICAO24 lookups for FR24-confirmed inbound arrivals
    // that are still outside the search area (e.g. a private jet over the Channel or
    // Atlantic that hasn't yet crossed into the EIDL bbox). One extra OpenSky call,
    // only when needed — typically 0–2 aircraft.
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
        if (extra.length) console.log(`[track] +${extra.length} remote ICAO24 (outside bbox)`);
      } catch (remoteErr) {
        console.warn(`[track] ICAO24 supplement failed: ${remoteErr.message}`);
      }
    }

    // Re-read after the async OpenSky call: engineTick (sync) may have written
    // autoAdvanced statuses while we were awaiting the network response.
    // Writing our stale snapshot would clobber those changes.
    const freshData = store.read();
    const { tracked, possible } = tracker.track(freshData, cfg, states);
    store.write(freshData);

    // FR24 landing check: if any arrival is On Approach but ADS-B signal is gone
    // (dropoutSince set), poll FR24 immediately — it has datetime_landed which
    // resolves the landing faster and more reliably than waiting for the dropout timer.
    // Cooldown: 2 min so we don't hammer FR24 across consecutive OpenSky polls.
    const APPROACH_POLL_COOLDOWN = 2 * 60 * 1000;
    const hasApproachDropout = freshData.flights.some(
      f => f.type === 'arrival' && f.status === 'On Approach' &&
           f.live && f.live.dropoutSince
    );
    if (hasApproachDropout && Date.now() - lastApproachPoll > APPROACH_POLL_COOLDOWN) {
      lastApproachPoll = Date.now();
      pollOnce('fr24-landing-check').catch(err => console.warn('[track] fr24 landing check failed:', err.message));
    }

    // FR24 departure check: if any departure is past its scheduled time but still
    // not confirmed Departed, poll FR24 immediately — datetime_takeoff is authoritative.
    // Catches the gap between the T trigger (fires ~at schedule) and FR24 recording
    // the actual takeoff (1–2 min after wheels-up). Cooldown: 3 min.
    const DEPART_POLL_COOLDOWN = 60 * 1000;
    const depTz     = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
    const depNowMin = _nowMinsTz(depTz);
    const hasPendingDeparture = freshData.flights.some(f => {
      if (f.type !== 'departure') return false;
      if (['Departed', 'Landed', 'Cancelled', 'Diverted'].includes(f.status)) return false;
      const t = _hhmToMins(f.time);
      if (t == null) return false;
      const diff = depNowMin - t;
      return diff >= 0 && diff <= 15; // 0–15 min post-schedule window
    });
    if (hasPendingDeparture && Date.now() - lastDepartPoll > DEPART_POLL_COOLDOWN) {
      lastDepartPoll = Date.now();
      pollOnce('fr24-depart-check').catch(err => console.warn('[track] fr24 depart check failed:', err.message));
    }

    const possibleMsg = possible.length ? `, ${possible.length} unscheduled approaching` : '';
    liveData = {
      at: new Date().toISOString(), ok: true,
      message: `${states.length} aircraft seen, ${tracked.length} matched${possibleMsg}`,
      aircraft: states, tracked, possible
    };
    console.log(`[track] ${liveData.message}`);
  } catch (err) {
    if (err.message && err.message.includes('429')) {
      // Exponential backoff: 5 min → 10 min → 20 min, then cap at 20 min.
      openskyConsecutive429 = Math.min(openskyConsecutive429 + 1, 3);
      const backoffMs = Math.pow(2, openskyConsecutive429 - 1) * 5 * 60 * 1000;
      openskyBackoffUntil = Date.now() + backoffMs;
      console.warn(`[track] rate-limited (429) — backing off ${backoffMs / 60000} min (attempt ${openskyConsecutive429})`);
    }
    liveData = { ...liveData, at: new Date().toISOString(), ok: false, message: err.message };
    console.warn(`[track] failed: ${err.message}`);
  }
}

function startTracking() {
  if (trackTimer) clearInterval(trackTimer);
  const cfg = readConfig();
  const ms = Math.max(30, (cfg.opensky && cfg.opensky.pollSeconds) || 60) * 1000;
  // 15-second startup delay: avoids a burst of rapid OpenSky calls when the
  // server is restarted repeatedly during development (each restart resets
  // openskyBackoffUntil to 0 and would otherwise call immediately).
  setTimeout(trackTick, 15 * 1000);
  trackTimer = setInterval(trackTick, ms);
  console.log(`[track] live tracking every ${ms / 1000}s (smart-polled, 15s startup delay)`);
}

// ---- Website sync (free, one-way push) -------------------------------------
// Pushes the current board to the public airport website every N seconds.
// This project never receives inbound connections for this — it only POSTs
// out, authenticated with a shared secret. See src/websiteSync.js.
let syncTimer = null;
let lastSync = { at: null, ok: null, message: 'Website sync not started' };

async function syncOnce() {
  const cfg = readConfig();
  const result = await websiteSync.syncTick(cfg);
  lastSync = { at: new Date().toISOString(), ...result };
  if (!result.ok) console.warn(`[sync] ${result.message}`);
}

function startWebsiteSync() {
  if (syncTimer) clearInterval(syncTimer);
  const cfg = readConfig();
  if (!cfg.websiteSync || !cfg.websiteSync.enabled) {
    lastSync = { at: new Date().toISOString(), ok: false, message: 'Website sync disabled' };
    console.log('[sync] website push disabled');
    return;
  }
  const ms = Math.max(15, cfg.websiteSync.intervalSeconds || 30) * 1000;
  syncOnce();
  syncTimer = setInterval(syncOnce, ms);
  console.log(`[sync] pushing to website every ${ms / 1000}s`);
}

app.get('/api/sync-status', (req, res) => res.json(lastSync));
app.post('/api/sync-now', async (req, res) => { await syncOnce(); res.json(lastSync); });

// Live feed for the map: home/origin airports + all aircraft + matched flights.
app.get('/api/live', (req, res) => {
  const cfg = readConfig();
  res.json({
    home: { icao: cfg.airport.icao, lat: cfg.airport.lat, lon: cfg.airport.lon, name: cfg.airport.name },
    airports: tracker.AIRPORTS,
    ...liveData
  });
});

app.post('/api/track', async (req, res) => {
  await trackTick();
  res.json(liveData);
});

// Debug: test OpenSky directly, bypassing the window check.
app.get('/api/debug/opensky', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.opensky || !cfg.opensky.enabled) {
    return res.json({ ok: false, message: 'Live tracking is disabled in config' });
  }
  try {
    const states = await openskyAdapter.getStates(cfg);
    res.json({ ok: true, count: states.length, sample: states.slice(0, 3), bbox: cfg.opensky.bbox });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Debug: raw FR24 positions response (shows actual field names before mapping).
app.get('/api/debug/positions/raw', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.enabled) return res.json({ ok: false });
  try {
    const bb = (cfg.opensky && cfg.opensky.bbox) || {};
    const bounds = [bb.lamax || 56.5, bb.lamin || 51.0, bb.lomin || -11.0, bb.lomax || -4.0].join(',');
    const qs  = new URLSearchParams({ bounds }).toString();
    const r   = await fetch(`https://fr24api.flightradar24.com/api/live/flight-positions/light?${qs}`, {
      headers: { 'Accept': 'application/json', 'Accept-Version': 'v1', 'Authorization': `Bearer ${cfg.fr24.apiKey}` }
    });
    const data = await r.json();
    const entries = Array.isArray(data.data) ? data.data : [];
    res.json({ ok: true, count: entries.length, rawSample: entries.slice(0, 3), allKeys: entries[0] ? Object.keys(entries[0]) : [] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Debug: FR24 credit / usage check — returns response headers + account/usage endpoint.
app.get('/api/debug/fr24-credits', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.fr24 || !cfg.fr24.apiKey) return res.json({ ok: false, message: 'No FR24 key' });
  const headers = { 'Accept': 'application/json', 'Accept-Version': 'v1', 'Authorization': `Bearer ${cfg.fr24.apiKey}` };
  try {
    // Make a minimal positions call and capture all response headers
    const bb = (cfg.opensky && cfg.opensky.bbox) || {};
    const bounds = [bb.lamax || 56.5, bb.lamin || 51.0, bb.lomin || -11.0, bb.lomax || -4.0].join(',');
    const qs = new URLSearchParams({ bounds }).toString();
    const posRes = await fetch(`https://fr24api.flightradar24.com/api/live/flight-positions/light?${qs}`, { headers });
    const posHeaders = Object.fromEntries(posRes.headers.entries());
    // Also try the usage endpoint (URL from their docs page)
    let usageBody = null;
    try {
      const uRes = await fetch('https://fr24api.flightradar24.com/api/usage', { headers });
      usageBody = { status: uRes.status, body: await uRes.json().catch(() => null) };
    } catch (_) {}
    res.json({ ok: true, positionCallStatus: posRes.status, responseHeaders: posHeaders, usage: usageBody });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Debug: look up a specific aircraft by ICAO24 in current live data.
// Usage: GET /api/debug/icao/4caa53
// Returns the full ADS-B state so you can find the real callsign to enter in admin.
app.get('/api/debug/icao/:icao24', (req, res) => {
  const icao = req.params.icao24.toLowerCase().trim();
  const all = liveData.aircraft || [];
  const found = all.find((st) => (st.icao24 || '').toLowerCase() === icao);
  if (!found) {
    return res.json({
      ok: false, icao24: icao,
      message: 'Not in current live data — try /api/track to force a fresh poll first',
      totalAircraft: all.length
    });
  }
  res.json({
    ok: true,
    icao24: found.icao24,
    callsign: (found.callsign || '').trim() || '(empty — no callsign broadcast)',
    onGround: found.onGround,
    altitudeFt: found.baroAltitude != null ? Math.round(found.baroAltitude * 3.281) : null,
    speedKt: found.velocity != null ? Math.round(found.velocity * 1.94384) : null,
    lat: found.lat, lon: found.lon, track: found.track,
    raw: found
  });
});

app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'public', 'map.html')));

initDataDir();
app.listen(PORT, () => {
  console.log(`\n  Donegal FIDS running`);
  console.log(`  Display : http://localhost:${PORT}/`);
  console.log(`  Control : http://localhost:${PORT}/admin\n`);
  startEngine();
  startTracking();
  restartPolling();
  startFr24Polling();
  startWebsiteSync();
});
