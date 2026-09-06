// AeroDataBox adapter (via RapidAPI). Fetches departures/arrivals for the
// configured airport and maps them into our internal flight model.
//
// Swap this file to support a different provider later — the rest of the app
// only depends on fetchFlights(config) returning an array of flight objects.

function pad(n) {
  return String(n).padStart(2, '0');
}

// AeroDataBox wants local datetimes like 2026-06-01T08:00 in the airport's timezone.
// Use Intl so this is correct even when the Node process runs in UTC.
function localStamp(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function hhmm(iso) {
  if (!iso) return '';
  // AeroDataBox local time looks like "2026-06-01 08:05+01:00"
  const m = String(iso).match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

// Map AeroDataBox status strings to our canonical set.
function mapStatus(raw, type) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel')) return 'Cancelled';
  if (s.includes('divert')) return 'Diverted';
  if (s.includes('board')) return 'Boarding';
  if (s.includes('gateclosed') || s.includes('gate closed')) return 'Gate Closed';
  if (s.includes('checkin') || s.includes('check-in')) return 'Check-in';
  if (s.includes('delay')) return 'Delayed';
  if (s.includes('departed')) return 'Departed';
  if (s.includes('arrived')) return 'Landed';
  if (s.includes('approach')) return 'Approaching';
  if (s.includes('enroute') || s.includes('en route')) return 'En Route';
  return type === 'arrival' ? 'Scheduled' : 'Scheduled';
}

function mapMovement(item, type) {
  // "thisSide" holds the scheduled/revised times for this airport.
  // "otherSide" holds the opposite airport (origin for arrivals, destination for departures).
  const thisSide  = (type === 'arrival' ? item.arrival  : item.departure) || {};
  const otherSide = (type === 'arrival' ? item.departure : item.arrival)  || {};
  const otherPort = otherSide.airport || {};
  const sched   = thisSide.scheduledTime || {};
  const revised = thisSide.revisedTime   || {};

  const number = (item.number || '').replace(/\s+/g, '').toUpperCase();
  const airlineName = (item.airline && item.airline.name) || '';
  const airlineIcao = (item.airline && item.airline.icao) || null;
  const aircraftModel = (item.aircraft && item.aircraft.model) || null;
  const otherSched = otherSide.scheduledTime || {};

  const schedHHMM = hhmm(sched.local);
  const revHHMM = hhmm(revised.local);

  return {
    type,
    flightNo: number,
    time: schedHHMM,
    estTime: revHHMM && revHHMM !== schedHHMM ? revHHMM : null,
    airline: airlineName,
    airlineCode: number.slice(0, 2),
    airlineIcao: airlineIcao || null,
    aircraftModel: aircraftModel || null,
    city: otherPort.municipalityName || otherPort.shortName || otherPort.name || '',
    // For arrivals: origin airport and scheduled departure from origin (UTC).
    // Used by fr24Adapter to detect origin-side delay before the flight departs.
    originIcao: type === 'arrival' ? (otherPort.icao || null) : null,
    originSchedDepUtc: type === 'arrival' ? (otherSched.utc || null) : null,
    codeshare: Array.isArray(item.codeshareStatus) ? item.codeshareStatus.map((c) => String(c).toUpperCase()) : [],
    status: mapStatus(item.status, type)
  };
}

async function fetchFlights(config) {
  const { icao } = config.airport;
  const { rapidApiKey, lookBackHours = 3, lookAheadHours = 10 } = config.api;
  if (!rapidApiKey) throw new Error('No RapidAPI key configured');

  const now = new Date();
  const from = new Date(now.getTime() - lookBackHours * 3600 * 1000);
  const to = new Date(now.getTime() + lookAheadHours * 3600 * 1000);

  const url =
    `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}/` +
    `${localStamp(from)}/${localStamp(to)}` +
    `?withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false`;

  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': rapidApiKey,
      'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AeroDataBox ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const departures = (json.departures || []).map((it) => mapMovement(it, 'departure'));
  const arrivals = (json.arrivals || []).map((it) => mapMovement(it, 'arrival'));
  const flights = [...departures, ...arrivals].filter((f) => f.flightNo);

  // Enrich pre-departure arrivals with real-time data from AeroDataBox flight-by-number.
  // This gives us the actual callsign, aircraft hex, revised departure time and predicted
  // arrival — things the airport-query endpoint doesn't return at Basic quality.
  await enrichPreDeparture(flights, config);

  return flights;
}

// Per-flight cooldown to avoid calling flight-by-number too frequently.
const _lastFlightByNum = new Map(); // flightNo → last fetch timestamp
const FLIGHT_BY_NUM_COOLDOWN = 30 * 60 * 1000; // 30 min — prevents runaway calls during manual debug sessions

function _parseUtcMs(s) {
  if (!s) return null;
  return new Date(String(s).trim().replace(' ', 'T').replace(/(?<!Z)$/, 'Z')).getTime();
}

function _utcMsToLocal(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(ms)).map(x => [x.type, x.value])
  );
  return `${p.hour}:${p.minute}`;
}

async function enrichPreDeparture(flights, config) {
  const { rapidApiKey } = config.api;
  if (!rapidApiKey) return;
  const tz    = (config.display && config.display.timezone) || 'Europe/Dublin';
  const today = new Date().toISOString().slice(0, 10);
  const now   = Date.now();

  const pending = flights.filter(f =>
    f.type === 'arrival' &&
    !['En Route', 'Departed', 'On Approach', 'Landed', 'Diverted', 'Cancelled'].includes(f.status)
  );

  for (const flight of pending) {
    if (now - (_lastFlightByNum.get(flight.flightNo) || 0) < FLIGHT_BY_NUM_COOLDOWN) continue;
    _lastFlightByNum.set(flight.flightNo, now);

    try {
      const url = `https://aerodatabox.p.rapidapi.com/flights/number/${flight.flightNo}/${today}`;
      const res = await fetch(url, {
        headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : data;
      if (!entry) continue;

      // Callsign and hex — update so FR24 live-positions can find this aircraft.
      if (entry.callSign) flight.callsign = entry.callSign.toUpperCase().replace(/\s+/g, '');
      if (entry.aircraft && entry.aircraft.modeS) flight.fr24hex = entry.aircraft.modeS.toLowerCase();

      const dep = entry.departure || {};
      const arr = entry.arrival   || {};

      // Best revised arrival: use predictedTime at EIDL directly; fall back to
      // revised departure + same offset (delay propagates 1:1 to arrival time).
      const predArrMs = _parseUtcMs((arr.predictedTime  || {}).utc);
      const revDepMs  = _parseUtcMs((dep.revisedTime    || {}).utc);
      const schDepMs  = _parseUtcMs((dep.scheduledTime  || {}).utc);

      if (predArrMs) {
        flight.estTime = _utcMsToLocal(predArrMs, tz);
      } else if (revDepMs && schDepMs) {
        const delayMin = Math.round((revDepMs - schDepMs) / 60000);
        if (delayMin > 10 && flight.time) {
          const [hh, mm] = flight.time.split(':').map(Number);
          const rev = hh * 60 + mm + delayMin;
          flight.estTime = `${String(Math.floor(rev / 60) % 24).padStart(2, '0')}:${String(rev % 60).padStart(2, '0')}`;
        }
      }

      if (flight.estTime) {
        console.log(`[ADB] ${flight.flightNo}: callsign=${flight.callsign} hex=${flight.fr24hex} estTime=${flight.estTime}`);
      }
    } catch (err) {
      console.warn(`[ADB] enrichPreDeparture ${flight.flightNo}:`, err.message);
    }
  }
}

module.exports = { fetchFlights };
