// OpenSky Network adapter — FREE live ADS-B aircraft positions.
// Anonymous: ~400 req/day. Authenticated (Basic Auth with account): ~4000 req/day.
// Docs: https://openskynetwork.github.io/opensky-api/rest.html

const STATES_URL = 'https://opensky-network.org/api/states/all';

// Raw OpenSky state-vector indices we care about.
function parseState(s) {
  return {
    icao24: s[0],
    callsign: (s[1] || '').trim(),
    lon: s[5],
    lat: s[6],
    baroAltitude: s[7], // metres
    onGround: s[8],
    velocity: s[9], // m/s (ground speed)
    track: s[10], // degrees true
    verticalRate: s[11],
    geoAltitude: s[13]
  };
}

function makeHeaders(cfg) {
  const { clientId, clientSecret } = cfg.opensky || {};
  if (clientId && clientSecret) {
    return { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` };
  }
  return {};
}

// Fetch all aircraft within the configured bounding box.
async function getStates(cfg) {
  const b = (cfg.opensky && cfg.opensky.bbox) || {};
  const params = new URLSearchParams({
    lamin: b.lamin ?? 51.0, lomin: b.lomin ?? -11.0,
    lamax: b.lamax ?? 56.0, lomax: b.lomax ?? -5.0
  });
  const res = await fetch(`${STATES_URL}?${params}`, { headers: makeHeaders(cfg) });
  if (!res.ok) throw new Error(`OpenSky states ${res.status}`);
  const json = await res.json();
  return (json.states || []).map(parseState).filter((s) => s.lat != null && s.lon != null);
}

// Fetch specific aircraft by ICAO24 hex list — no bbox restriction.
// Used for FR24-confirmed arrivals that may still be far from EIDL
// (e.g. a private jet that just took off from a distant airport).
async function getStatesByIcao24(icao24List, cfg) {
  if (!icao24List || icao24List.length === 0) return [];
  const params = new URLSearchParams({ icao24: icao24List.join(',') });
  const res = await fetch(`${STATES_URL}?${params}`, { headers: makeHeaders(cfg) });
  if (!res.ok) throw new Error(`OpenSky icao24 ${res.status}`);
  const json = await res.json();
  return (json.states || []).map(parseState).filter((s) => s.lat != null && s.lon != null);
}

module.exports = { getStates, getStatesByIcao24 };
