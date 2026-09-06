// FR24 adapter — Flightradar24 API (Flight Summary Light).
//
// What this provides that the other APIs don't:
//   callsign  — ICAO transponder callsign (e.g. EAI42D), not IATA flight number
//   fr24hex   — Mode-S ICAO24 hex for unambiguous ADS-B matching in tracker.js
//   status    — derived from actual ADS-B events (takeoff / landing / diversion)
//   estTime   — for in-flight arrivals: computed from actual takeoff + typical route duration
//               (ADS-B tracker overwrites this with a position-based ETA once it has signal)
//   fr24Confirmed — flag that lets store.mergeApi bypass the REALTIME status guard,
//               so a FR24-confirmed Landed can overwrite an ADS-B-set En Route

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
      throw new Error(`FR24 HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Peer ICAO → city name for the board and tracker.resolveAirport().
const ICAO_TO_CITY = {
  EIDW: 'Dublin',
  EINN: 'Shannon',
  EGPF: 'Glasgow',
  EGPH: 'Edinburgh',
  EGAC: 'Belfast City',
  EGAA: 'Belfast',
  EGJJ: 'Jersey',
  EGLL: 'London',
  EGKK: 'London Gatwick',
  EGSS: 'London Stansted',
  EGCC: 'Manchester',
  EGBB: 'Birmingham',
  EGNT: 'Newcastle',
  EGPE: 'Inverness',
  EGPD: 'Aberdeen',
  EGHI: 'Southampton',
};

// Typical door-to-door flight duration (minutes) from peer to EIDL.
// Only used when FR24 has the takeoff time but OpenSky hasn't seen the aircraft yet.
const ROUTE_MIN = {
  EIDW: 41,   // Dublin → Donegal  (observed block time)
  EINN: 55,   // Shannon → Donegal
  EGPF: 41,   // Glasgow → Donegal  (observed block time)
  EGPH: 60,   // Edinburgh → Donegal
  EGAC: 40,   // Belfast City → Donegal
  EGAA: 45,   // Belfast Intl → Donegal
  EGJJ: 80,   // Jersey → Donegal
  EGLL: 95,   // London Heathrow → Donegal
  EGKK: 95,   // London Gatwick → Donegal
  EGSS: 90,   // London Stansted → Donegal
  EGCC: 70,   // Manchester → Donegal
  EGBB: 75,   // Birmingham → Donegal
  EGNT: 65,   // Newcastle → Donegal
};

// AeroDataBox UTC strings use a space separator ("2026-09-06 16:45Z"), not 'T'.
// Normalise before parsing so both formats work.
function parseAnyUtcMs(dtStr) {
  if (!dtStr) return null;
  const s = dtStr.trim().replace(' ', 'T');
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
}

// FR24 datetimes are UTC but have no 'Z' suffix — appending it forces correct parsing.
function utcToLocalHHMM(utcMs, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value])
  );
  return `${p.hour}:${p.minute}`;
}

// FR24 field names in the actual API response (Flight Summary Light):
//   orig_icao, dest_icao, dest_icao_actual  (NOT origin_icao / destination_icao)
// Dates may or may not have a trailing 'Z' — normalise before parsing.
function parseUtcMs(dtStr) {
  if (!dtStr) return null;
  return new Date(dtStr.endsWith('Z') ? dtStr : dtStr + 'Z').getTime();
}

function deriveStatus(f, isArrival) {
  // Diversion always wins, even if the flight later tries to return.
  if (f.dest_icao_actual && f.dest_icao_actual !== f.dest_icao) {
    return 'Diverted';
  }
  if (f.datetime_landed)  return isArrival ? 'Landed'   : 'Departed';
  if (f.datetime_takeoff) return isArrival ? 'En Route' : 'Departed';
  return null; // not yet departed — let AeroDataBox / clock own the status
}

// Maps AeroDataBox aircraft.model → FR24 type code (used for filtering origin-side arrivals).
const MODEL_TO_FR24_TYPE = {
  'ATR 42': 'AT46', 'ATR 42-300': 'AT46', 'ATR 42-600': 'AT46',
  'ATR 72': 'AT76', 'ATR 72-500': 'AT76', 'ATR 72-600': 'AT76',
};
const TURNAROUND_MIN        = 25;  // minimum ground time at origin before next departure
const ORIGIN_DELAY_BUFFER   = 10;  // minutes of delay at origin before we show Delayed
const ORIGIN_LOOKBACK_MS    = 90 * 60 * 1000; // only consider landings in the last 90 min

// Check whether an arrival's inbound aircraft landed late at the origin airport.
// If landing + turnaround exceeds the scheduled departure + buffer, the arrival will be
// delayed and we update estTime so the scheduler shows Delayed automatically.
// Returns an array of { id, estTime } corrections.
async function checkOriginDelay(preDepArrivals, token, tz) {
  if (!preDepArrivals.length) return [];
  const results = [];

  // Group by origin ICAO to avoid duplicate flight-summary calls for the same airport.
  const byOrigin = {};
  for (const a of preDepArrivals) {
    const fr24Type = MODEL_TO_FR24_TYPE[a.aircraftModel] ||
                     MODEL_TO_FR24_TYPE[(a.aircraftModel || '').split(' ').slice(0,2).join(' ')] ||
                     MODEL_TO_FR24_TYPE[(a.aircraftModel || '').split('-')[0].trim()];
    if (!fr24Type) continue;
    if (!byOrigin[a.originIcao]) byOrigin[a.originIcao] = [];
    byOrigin[a.originIcao].push({ ...a, fr24Type });
  }

  const today = new Date().toISOString().slice(0, 10);

  for (const [originIcao, arrivals] of Object.entries(byOrigin)) {
    let originEntries;
    try {
      const data = await fr24Get('/flight-summary/light', {
        flight_datetime_from: `${today} 00:00:00`,
        flight_datetime_to:   `${today} 23:59:59`,
        airports: `both:${originIcao}`,
        limit: 50,
      }, token);
      originEntries = Array.isArray(data.data) ? data.data : [];
    } catch (err) {
      console.warn(`[FR24] origin-delay ${originIcao}:`, err.message);
      continue;
    }

    for (const flight of arrivals) {
      const schedDepMs = parseAnyUtcMs(flight.originSchedDepUtc);
      if (!schedDepMs) continue;

      // Candidates: flights that arrived at this origin airport recently, matching
      // the expected aircraft type and (if known) the operating airline.
      const now = Date.now();
      const candidates = originEntries
        .filter(e =>
          (e.dest_icao === originIcao || e.dest_icao_actual === originIcao) &&
          e.datetime_landed &&
          (e.type || '').toUpperCase() === flight.fr24Type &&
          (!flight.airlineIcao || (e.operating_as || e.painted_as || '').toUpperCase() === flight.airlineIcao.toUpperCase())
        )
        .map(e => ({ landedMs: parseUtcMs(e.datetime_landed), e }))
        .filter(({ landedMs }) => landedMs && (now - landedMs) < ORIGIN_LOOKBACK_MS)
        .sort((a, b) => b.landedMs - a.landedMs);

      if (!candidates.length) continue;

      const { landedMs } = candidates[0];
      const earliestDepMs = landedMs + TURNAROUND_MIN * 60 * 1000;
      const delayMs = earliestDepMs - schedDepMs;

      if (delayMs <= ORIGIN_DELAY_BUFFER * 60 * 1000) continue; // within buffer

      const delayMin = Math.ceil(delayMs / 60000);
      // Revised arrival at EIDL = scheduled arrival + same delay (departure delay flows through).
      const [hh, mm] = (flight.time || '00:00').split(':').map(Number);
      const revisedMin = hh * 60 + mm + delayMin;
      const revHH = String(Math.floor(revisedMin / 60) % 24).padStart(2, '0');
      const revMM = String(revisedMin % 60).padStart(2, '0');

      console.log(`[FR24] origin-delay ${flight.id}: landed ${new Date(landedMs).toISOString()} → +${delayMin}min → estTime ${revHH}:${revMM}`);
      results.push({ id: flight.id, type: 'arrival', flightNo: flight.flightNo, estTime: `${revHH}:${revMM}` });
    }
  }
  return results;
}

async function fetchFlights(cfg, pendingDeps = [], onApproachArrivals = [], goAroundChecks = [], preDepArrivals = []) {
  const token = cfg.fr24 && cfg.fr24.apiKey;
  if (!token) throw new Error('FR24: no API key in config');

  const home  = (cfg.airport && cfg.airport.icao) || 'EIDL';
  const tz    = (cfg.display  && cfg.display.timezone) || 'Europe/Dublin';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const data = await fr24Get('/flight-summary/light', {
    flight_datetime_from: `${today} 00:00:00`,
    flight_datetime_to:   `${today} 23:59:59`,
    airports: `both:${home}`,
    limit: 20
  }, token);

  const entries = Array.isArray(data.data) ? data.data : [];
  const flights = [];
  const inFlightArrivals = []; // pending live-ETA enrichment via flight-positions/full

  for (const f of entries) {
    // Only commercial flights (have a flight number, e.g. "EI3402").
    // Private/charter aircraft are excluded — only scheduled flights appear on the board.
    if (!f.flight) continue;
    const flightNo = f.flight.toUpperCase().replace(/\s+/g, '');
    if (!flightNo) continue;

    const isArrival  = f.dest_icao === home || f.dest_icao_actual === home;
    const isDeparture = f.orig_icao === home;
    if (!isArrival && !isDeparture) continue;

    const type   = isArrival ? 'arrival' : 'departure';
    const id     = `${isArrival ? 'ARR' : 'DEP'}-${flightNo}`;
    const status = deriveStatus(f, isArrival);

    // fr24Confirmed: FR24 has real ADS-B evidence for this flight (it has taken off
    // or landed). Lets store.mergeApi bypass the REALTIME guard so, for example,
    // a confirmed Landed can overwrite ADS-B-derived En Route or On Approach.
    const fr24Confirmed = !!(f.datetime_takeoff || f.datetime_landed);

    const entry = {
      id,
      type,
      flightNo,
      callsign: (f.callsign || '').toUpperCase(),  // ICAO transponder callsign
      fr24hex:  (f.hex      || '').toLowerCase(),  // Mode-S ICAO24 for direct ADS-B match
      fr24Confirmed,
    };

    if (status) entry.status = status;

    // Peer airport: always set city (fall back to raw ICAO when not in dict).
    const peerIcao = isArrival ? f.orig_icao : f.dest_icao;
    if (peerIcao) entry.city = ICAO_TO_CITY[peerIcao] || peerIcao;

    // ETA for in-flight arrivals: set ROUTE_MIN fallback now, then enrich with
    // FR24's own live ETA (flight-positions/full) after the loop.
    if (isArrival && f.datetime_takeoff && !f.datetime_landed) {
      const durationMin = ROUTE_MIN[f.orig_icao] || 60;
      const takeoffMs   = parseUtcMs(f.datetime_takeoff);
      entry.estTime     = utcToLocalHHMM(takeoffMs + durationMin * 60 * 1000, tz);
      // Only fetch live ETA near the halfway point (±4 min window).
      // Early in the flight ROUTE_MIN is good enough; OpenSky takes over for the final approach.
      if (entry.callsign) {
        const elapsedMs  = Date.now() - parseUtcMs(f.datetime_takeoff);
        const halfwayMs  = (ROUTE_MIN[f.orig_icao] || 60) / 2 * 60 * 1000;
        if (Math.abs(elapsedMs - halfwayMs) <= 4 * 60 * 1000) {
          inFlightArrivals.push({ entry, fr24_id: f.fr24_id });
        }
      }
    }

    // Actual landing time: use it as the definitive arrival time on the board.
    if (isArrival && f.datetime_landed) {
      entry.estTime = utcToLocalHHMM(parseUtcMs(f.datetime_landed), tz);
    }

    flights.push(entry);
  }

  // Real-time status detection via FR24 live positions (one batch call).
  // flight-summary/light has 5-8 min processing lag; live-positions is updated continuously.
  // Departures:        alt > 30 m  → Departed  (aircraft left the ground)
  // On Approach arrs:  alt ≤ 50 m  → Landed    (aircraft at/near runway level)
  const confirmedDepIds = new Set(flights.filter(f => f.type === 'departure' && f.fr24Confirmed).map(f => f.id));
  const confirmedArrIds = new Set(flights.filter(f => f.type === 'arrival'   && f.fr24Confirmed && f.status === 'Landed').map(f => f.id));
  const liveDeps = pendingDeps.filter(d => !confirmedDepIds.has(d.id));
  const liveArrs = onApproachArrivals.filter(a => !confirmedArrIds.has(a.id));
  // goAroundChecks: flights already marked Landed by live-positions — watch for a climb
  const liveChecks = [...liveDeps, ...liveArrs, ...goAroundChecks];
  if (liveChecks.length > 0) {
    const batchCallsigns = [...new Set(liveChecks.map(c => c.callsign))].join(',');
    try {
      const posData = await fr24Get('/live/flight-positions/full', { callsigns: batchCallsigns, limit: 15 }, token);
      for (const pos of (Array.isArray(posData.data) ? posData.data : [])) {
        const cs  = (pos.callsign || '').toUpperCase();
        const alt = pos.alt ?? pos.baro_altitude ?? pos.geoaltitude;
        if (alt == null) continue;

        const depMatch = liveDeps.find(d => d.callsign.toUpperCase() === cs);
        if (depMatch && alt > 30) {
          const existing = flights.find(f => f.id === depMatch.id);
          if (existing) {
            existing.status = 'Departed'; existing.fr24Confirmed = true;
            if (pos.hex) existing.fr24hex = pos.hex.toLowerCase();
          } else {
            flights.push({ id: depMatch.id, type: 'departure', flightNo: depMatch.flightNo,
              callsign: cs, fr24hex: (pos.hex || '').toLowerCase(), fr24Confirmed: true, status: 'Departed' });
          }
        }

        const arrMatch = liveArrs.find(a => a.callsign.toUpperCase() === cs);
        if (arrMatch && alt <= 10) {
          // Set Landed immediately; fr24LandedLive signals it is provisional (may revert on go-around).
          const existing = flights.find(f => f.id === arrMatch.id);
          if (existing) {
            existing.status = 'Landed'; existing.fr24Confirmed = true; existing.fr24LandedLive = true;
            if (pos.hex) existing.fr24hex = pos.hex.toLowerCase();
          } else {
            flights.push({ id: arrMatch.id, type: 'arrival', flightNo: arrMatch.flightNo,
              callsign: cs, fr24hex: (pos.hex || '').toLowerCase(), fr24Confirmed: true,
              status: 'Landed', fr24LandedLive: true });
          }
        }

        // Go-around detection: a provisionally-Landed flight now climbing above 200m
        const gaMatch = goAroundChecks.find(a => a.callsign.toUpperCase() === cs);
        if (gaMatch && alt > 200) {
          flights.push({ id: gaMatch.id, fr24GoAround: true });
        }
      }
    } catch (err) {
      console.warn('[FR24] live-positions check failed:', err.message);
    }
  }

  // Enrich in-flight arrivals with FR24's own live ETA (flight-positions/full).
  // One batch call covers all concurrent in-flight arrivals.
  // Falls back silently to the ROUTE_MIN estimate already set above.
  if (inFlightArrivals.length > 0) {
    const callsigns = inFlightArrivals.map(a => a.entry.callsign).join(',');
    try {
      const posData = await fr24Get('/live/flight-positions/full', { callsigns, limit: 15 }, token);
      for (const pos of (Array.isArray(posData.data) ? posData.data : [])) {
        const match = inFlightArrivals.find(a => a.fr24_id === pos.fr24_id);
        if (match && pos.eta) {
          match.entry.estTime = utcToLocalHHMM(parseUtcMs(pos.eta), tz);
        }
      }
    } catch (err) {
      console.warn('[FR24] live-positions/full failed, using ROUTE_MIN fallback:', err.message);
    }
  }

  // Origin-side delay detection: check if the inbound aircraft landed late at the origin.
  // Runs only for pre-departure arrivals with known originIcao + aircraftModel.
  const originDelays = await checkOriginDelay(preDepArrivals, token, tz);
  for (const od of originDelays) {
    const existing = flights.find(f => f.id === od.id);
    if (existing) {
      existing.estTime = od.estTime;
    } else {
      flights.push(od);
    }
  }

  return flights;
}

module.exports = { fetchFlights };
