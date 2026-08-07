// FlightAware AeroAPI v4 adapter.
// Secondary flight-discovery source alongside AeroDataBox — better coverage of
// GA, charter, and smaller operators that AeroDataBox can miss at regional airports.
// Also provides ICAO-format callsigns (e.g. EIN3402) which match ADS-B transponders
// better than AeroDataBox's IATA codes (e.g. EAI42D).

const BASE = 'https://aeroapi.flightaware.com/aeroapi';

// Convert a UTC ISO string from FlightAware to local HH:MM at the airport timezone.
function toLocalHHMM(isoUtc, tz) {
  if (!isoUtc) return '';
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d);
}

function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel')) return 'Cancelled';
  if (s.includes('divert')) return 'Diverted';
  if (s.includes('arrived')) return 'Landed';
  if (s.includes('en route') || s.includes('enroute')) return 'En Route';
  if (s.includes('delay')) return 'Delayed';
  return 'Scheduled';
}

function mapFlight(item, type, tz) {
  // For arrivals:  scheduled_in  = arrival time at EIDL (what goes in "time")
  // For departures: scheduled_out = departure time from EIDL
  const schedUtc   = type === 'arrival' ? item.scheduled_in  : item.scheduled_out;
  const revisedUtc = type === 'arrival'
    ? (item.estimated_in  || item.actual_in)
    : (item.estimated_out || item.actual_out);

  const otherPort = type === 'arrival' ? (item.origin || {}) : (item.destination || {});

  const schedHHMM   = toLocalHHMM(schedUtc, tz);
  const revisedHHMM = toLocalHHMM(revisedUtc, tz);

  // Prefer IATA ident for the flight number (used to build the board ID like ARR-EI3402).
  // Fall back to ICAO ident or bare ident (covers private/GA registrations like G-ABCD).
  const iataIdent = (item.ident_iata || '').replace(/\s/g, '').toUpperCase();
  const icaoIdent = (item.ident_icao || '').replace(/\s/g, '').toUpperCase();
  const bareIdent = (item.ident    || '').replace(/\s/g, '').toUpperCase();

  const flightNo   = iataIdent || bareIdent;
  const airlineCode = (item.operator_iata || iataIdent.slice(0, 2) || '').toUpperCase();

  // ICAO callsign matches what ADS-B transponders broadcast, unlike AeroDataBox's IATA codes.
  const callsign = icaoIdent || bareIdent;

  const city = otherPort.city || otherPort.name || '';

  if (!schedHHMM || !flightNo) return null;

  return {
    type,
    flightNo,
    callsign,
    time: schedHHMM,
    estTime: revisedHHMM && revisedHHMM !== schedHHMM ? revisedHHMM : null,
    airline: item.operator || '',
    airlineCode,
    city,
    codeshare: Array.isArray(item.codeshares_iata) ? item.codeshares_iata : [],
    status: mapStatus(item.status)
  };
}

async function fetchFlights(config) {
  const fa = config.flightaware;
  if (!fa || !fa.apiKey) throw new Error('No FlightAware API key configured');

  const tz         = (config.display && config.display.timezone) || 'Europe/Dublin';
  const icao       = config.airport.icao;
  const lookBack   = Number(fa.lookBackHours)  || 1;
  const lookAhead  = Number(fa.lookAheadHours) || 11;

  const now   = new Date();
  const start = new Date(now.getTime() - lookBack  * 3600000).toISOString();
  const end   = new Date(now.getTime() + lookAhead * 3600000).toISOString();

  const headers = { 'x-apikey': fa.apiKey };

  const [arrRes, depRes] = await Promise.all([
    fetch(`${BASE}/airports/${icao}/flights/arrivals?start=${start}&end=${end}&max_pages=1`,   { headers }),
    fetch(`${BASE}/airports/${icao}/flights/departures?start=${start}&end=${end}&max_pages=1`, { headers })
  ]);

  if (!arrRes.ok) {
    const body = await arrRes.text().catch(() => '');
    throw new Error(`FlightAware arrivals ${arrRes.status}: ${body.slice(0, 200)}`);
  }
  if (!depRes.ok) {
    const body = await depRes.text().catch(() => '');
    throw new Error(`FlightAware departures ${depRes.status}: ${body.slice(0, 200)}`);
  }

  const arrJson = await arrRes.json();
  const depJson = await depRes.json();

  const arrivals   = (arrJson.arrivals   || []).map((it) => mapFlight(it, 'arrival',   tz));
  const departures = (depJson.departures || []).map((it) => mapFlight(it, 'departure', tz));

  return [...arrivals, ...departures].filter(Boolean);
}

module.exports = { fetchFlights };
