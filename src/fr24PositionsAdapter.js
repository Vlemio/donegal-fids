// FR24 Live Flight Positions (Light) — real-time ADS-B.
// Drop-in replacement for openskyAdapter: same interface, same state shape,
// so tracker.js needs zero changes.
//
// FR24 units → tracker.js units:
//   alt  (ft)      → baroAltitude (m)   × 0.3048
//   gspd (knots)   → velocity (m/s)     × 0.514444
//   vspd (ft/min)  → verticalRate (m/s) × 0.00508
//
// FR24 bounds parameter format: "latN,latS,lonW,lonE"
// e.g. EIDL area: "56.5,51.0,-11.0,-4.0"

const BASE = 'https://fr24api.flightradar24.com/api';

async function fr24Get(path, params, token) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${BASE}${path}?${qs}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/json',
        'Accept-Version': 'v1',
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.status === 429) throw new Error('429 rate limited');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`FR24 positions ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Convert one FR24 position entry to the state shape tracker.js expects.
// Field names confirmed from live API response:
//   gspeed (knots), vspeed (ft/min), alt (ft baro) — no on_ground field in light tier.
// on_ground is derived: below 500 ft AND slower than 30 kt → on the ground.
// 500 ft covers all Irish/Scottish airports (highest peer is EIDW at 242 ft MSL).
// 30 kt separates taxi/parked (0–25 kt) from any airborne phase (≥ rotate speed ~120 kt).
function toState(f) {
  const onGround = f.alt != null
    ? (f.alt < 500 && (f.gspeed == null || f.gspeed < 30))
    : false;
  return {
    icao24:       (f.hex || '').toLowerCase(),
    callsign:     (f.callsign || '').trim(),
    onGround,
    baroAltitude: f.alt    != null ? f.alt    * 0.3048   : null, // ft → m
    velocity:     f.gspeed != null ? f.gspeed * 0.514444 : null, // knots → m/s
    verticalRate: f.vspeed != null ? f.vspeed * 0.00508  : null, // ft/min → m/s
    track:        f.track  != null ? f.track              : null,
    lat:          f.lat    != null ? f.lat                : null,
    lon:          f.lon    != null ? f.lon                : null
  };
}

// All aircraft within the configured bounding box.
async function getStates(cfg) {
  const token = cfg.fr24 && cfg.fr24.apiKey;
  if (!token) throw new Error('FR24: no API key in config');
  const bb = (cfg.opensky && cfg.opensky.bbox) || {};
  // FR24 bounds: latNorth,latSouth,lonWest,lonEast
  const bounds = [
    bb.lamax || 56.5,
    bb.lamin || 51.0,
    bb.lomin || -11.0,
    bb.lomax || -4.0
  ].join(',');
  const data = await fr24Get('/live/flight-positions/light', { bounds }, token);
  const entries = Array.isArray(data.data) ? data.data : [];
  return entries.map(toState).filter(s => s.lat != null && s.lon != null);
}

// Direct lookup by ICAO24 hex — for FR24-confirmed flights outside the bbox.
async function getStatesByIcao24(hexes, cfg) {
  if (!hexes || hexes.length === 0) return [];
  const token = cfg.fr24 && cfg.fr24.apiKey;
  if (!token) throw new Error('FR24: no API key in config');
  const data = await fr24Get('/live/flight-positions/light', {
    hex: hexes.join(',')
  }, token);
  const entries = Array.isArray(data.data) ? data.data : [];
  return entries.map(toState).filter(s => s.lat != null && s.lon != null);
}

module.exports = { getStates, getStatesByIcao24 };
