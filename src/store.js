// Persistent flight store: reads/writes data/flights.json and merges API data
// without clobbering fields the staff have locked manually.
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'flights.json')
  : path.join(__dirname, '..', 'data', 'flights.json');

// Canonical status set used across the whole app.
const STATUSES = [
  'Scheduled', 'On Time', 'Check-in', 'Boarding', 'Final Call', 'Gate Closed',
  'Departed', 'On Approach', 'Delayed', 'En Route', 'Approaching', 'Landed',
  'Cancelled', 'Diverted'
];

function read() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.flights)) data.flights = [];
    return data;
  } catch (err) {
    return { lastUpdated: null, flights: [] };
  }
}

function write(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function normalise(flight) {
  return {
    id: flight.id || makeId(flight),
    type: flight.type === 'arrival' ? 'arrival' : 'departure',
    time: flight.time || '',
    estTime: flight.estTime || null,
    airline: flight.airline || '',
    airlineCode: flight.airlineCode || '',
    city: flight.city || '',
    flightNo: (flight.flightNo || '').toUpperCase(),
    codeshare: Array.isArray(flight.codeshare)
      ? flight.codeshare.map((c) => String(c).toUpperCase())
      : [],
    status: STATUSES.includes(flight.status) ? flight.status : 'Scheduled',
    source: ['api', 'schedule'].includes(flight.source) ? flight.source : 'manual',
    callsign: (flight.callsign || '').toUpperCase(),
    fr24hex:  (flight.fr24hex  || '').toLowerCase(),
    locks: flight.locks && typeof flight.locks === 'object' ? flight.locks : {},
    live: flight.live || null,
    schedDate: flight.schedDate || null,
    suppressed: flight.suppressed === true
  };
}

function makeId(flight) {
  const prefix = flight.type === 'arrival' ? 'ARR' : 'DEP';
  const no = (flight.flightNo || 'UNK').toUpperCase();
  return `${prefix}-${no}`;
}

// Fields the API is allowed to update (when not locked by staff).
// fr24hex is the Mode-S ICAO24 from FR24 — stored so matchState can do a direct
// transponder lookup instead of relying solely on callsign string matching.
const API_FIELDS = ['time', 'estTime', 'status', 'city', 'airline', 'airlineCode', 'codeshare', 'callsign', 'fr24hex'];

function toMin(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function apiDelayMins(sched, est) {
  const a = toMin(sched), b = toMin(est);
  if (a == null || b == null) return 0;
  let d = b - a;
  if (d < -720) d += 24 * 60; // midnight crossing
  return d;
}

// Merge an array of API-sourced flights into the stored board.
// Manual flights are never deleted by the API. Locked fields are preserved.
function mergeApi(apiFlights) {
  const data = read();
  const byId = new Map(data.flights.map((f) => [f.id, f]));

  for (const incoming of apiFlights) {
    const flight = normalise({ ...incoming, source: 'api' });
    const existing = byId.get(flight.id);

    if (!existing) {
      byId.set(flight.id, flight);
      continue;
    }

    // Update only unlocked, API-managed fields on the existing record.
    const locks = existing.locks || {};
    for (const field of API_FIELDS) {
      if (!locks[field] && flight[field] !== undefined && flight[field] !== '') {
        // Don't let the API downgrade a real-time status that ADS-B or the tracker
        // confirmed. Once a flight is On Approach, Departed, or Landed the API
        // cannot walk it back to Scheduled / On Time / Delayed.
        if (field === 'status') {
          // Airline decisions (Diverted, Cancelled) always win, even over real-time statuses.
          const AIRLINE_OVERRIDE = ['Diverted', 'Cancelled'];
          const REALTIME = ['Departed', 'En Route', 'On Approach', 'Landed'];
          // Flight progression order — used to block status downgrades.
          const PROGRESSION = ['Scheduled', 'On Time', 'Delayed', 'Departed', 'En Route', 'On Approach', 'Landed'];
          // "Scheduled" from the API means the provider doesn't know anything specific —
          // it must never overwrite a status the clock engine or tracker already set.
          if (flight[field] === 'Scheduled' && existing.status !== 'Scheduled') continue;
          if (REALTIME.includes(existing.status) && !AIRLINE_OVERRIDE.includes(flight[field])) {
            // FR24 confirmed event: FR24 has actual ADS-B evidence of takeoff or landing.
            // Allow it to overwrite a stale REALTIME status (e.g. En Route → Landed when
            // OpenSky missed the approach entirely).
            const fr24Confirmed = !!incoming.fr24Confirmed;
            // Delay override: if an arrival shows a realtime ADS-B status but the API
            // reports ≥60 min delay, the ADS-B match is almost certainly wrong.
            const bigDelay = existing.type === 'arrival' && existing.live &&
              flight.estTime && apiDelayMins(existing.time, flight.estTime) >= 60;
            if (!fr24Confirmed && !bigDelay) continue;
            // No downgrade: FR24 confirmed events can only advance the status, not walk it
            // back. e.g. if ADS-B set On Approach, FR24 saying En Route (takeoff confirmed
            // but landing not yet) must not revert to an earlier stage.
            if (fr24Confirmed) {
              const existIdx = PROGRESSION.indexOf(existing.status);
              const newIdx   = PROGRESSION.indexOf(flight[field]);
              if (newIdx >= 0 && newIdx <= existIdx) continue;
            }
            existing.live = null; // evict stale live data on confirmed event or big delay
          }
        }
        existing[field] = flight[field];
      }
    }
    // Once a flight is touched by the API it is considered API-tracked,
    // unless it was created by hand (we keep source 'manual' so staff know).
    if (existing.source !== 'manual') existing.source = 'api';
  }

  data.flights = Array.from(byId.values());
  return write(data);
}

module.exports = { read, write, normalise, makeId, mergeApi, STATUSES, DATA_FILE };
