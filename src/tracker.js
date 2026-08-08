// Live tracker — turns raw ADS-B positions into real flight status.
// Detects: departed-from-origin, en route (+ETA), approaching, landed, and
// delays (estimated time later than scheduled). Manual locks are respected.

// Known airports (lat/lon) for distance maths + origin/destination resolution.
const AIRPORTS = {
  EIDL: { lat: 55.0442, lon: -8.341, names: ['donegal', 'carrickfinn'] },
  EIDW: { lat: 53.4213, lon: -6.2701, names: ['dublin'] },
  EGPF: { lat: 55.8719, lon: -4.4331, names: ['glasgow'] },
  EGAC: { lat: 54.6181, lon: -5.8725, names: ['belfast city'] },
  EGAA: { lat: 54.6575, lon: -6.2158, names: ['belfast'] }
};

const NEAR_KM = 8;       // within this of an airport (+on ground) = at that airport
const APPROACH_KM = 45;  // within this of home = approaching

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function resolveAirport(cityOrName) {
  const q = String(cityOrName || '').toLowerCase().trim();
  for (const [icao, a] of Object.entries(AIRPORTS)) {
    if (a.names.some((n) => q.includes(n))) return { icao, ...a };
  }
  return null;
}

function homeAirport(cfg) {
  const icao = cfg.airport && cfg.airport.icao;
  if (icao && AIRPORTS[icao]) return { icao, ...AIRPORTS[icao] };
  return { icao: 'EIDL', ...AIRPORTS.EIDL };
}

// Find the live aircraft for a flight: FR24 hex wins (exact transponder), then
// callsign match, then flight-number digit fallback.
function matchState(flight, states) {
  const fr24hex = (flight.fr24hex || '').toLowerCase();
  const want    = (flight.callsign || '').toUpperCase().replace(/\s/g, '');
  const fnDigits = ((flight.flightNo || '').match(/\d+/) || [''])[0];
  let fallback = null;
  for (const st of states) {
    // Strip spaces from ADS-B callsign (OpenSky often pads with trailing spaces)
    const cs   = (st.callsign || '').toUpperCase().replace(/\s/g, '');
    const icao = (st.icao24 || '').toLowerCase();

    // 0. FR24 Mode-S hex: unambiguous direct transponder match.
    if (fr24hex && fr24hex === icao) return st;

    if (want) {
      // 1. Configured callsign contains the ADS-B callsign or vice-versa
      if (cs && cs.includes(want)) return st;
      // 2. Admin entered ICAO24 directly as callsign — useful for quick identification
      if (want.toLowerCase() === icao) return st;
    }

    // 3. Digit fallback: match flight number digits in callsign (e.g. 3403 in EIN3403)
    if (!want && fnDigits && fnDigits.length >= 3 && cs && cs.includes(fnDigits)) {
      fallback = fallback || st;
    }
  }
  return fallback;
}

function fmtTime(date, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

// Compass bearing (degrees, 0=North) from point `from` to point `to`.
function bearingTo(from, to) {
  const toR = (d) => d * Math.PI / 180;
  const lat1 = toR(from.lat), lat2 = toR(to.lat);
  const dLon = toR(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Find unscheduled aircraft heading toward home airport.
// Catches private jets, charters, medivac, anything with ADS-B that isn't
// already matched to a timetable flight.
//
// Transatlantic filter: flights cruise at 30,000-42,000 ft (9000-12800m) and
// are level or climbing. We only want aircraft that are (a) below 7500m OR
// (b) above 7500m but actively descending — which means they're actually going
// somewhere nearby, not just overflying Ireland.
function findPossibleArrivals(states, flights, home) {
  const matchedIcao = new Set(
    flights.filter((f) => f.live && f.live.icao24).map((f) => f.live.icao24)
  );

  const MAX_KM = 120;       // search radius around EIDL (km)
  const ALT_MIN_M = 300;    // must be properly airborne (>300m)
  const ALT_CRUISE_M = 7500;// above this we require active descent
  const HDG_TOL = 50;       // heading within ±50° of bearing to home
  const MIN_SPD = 35;       // m/s (~68 kt) — filters helicopters / noise

  const possible = [];

  for (const st of states) {
    if (matchedIcao.has(st.icao24)) continue;
    if (st.onGround) continue;
    if (!st.lat || !st.lon) continue;
    if (st.velocity == null || st.velocity < MIN_SPD) continue;

    const alt = st.baroAltitude;
    if (alt != null) {
      if (alt < ALT_MIN_M) continue;
      // High-altitude aircraft must be descending (verticalRate < −1 m/s)
      // to be considered an actual approach, not a transatlantic overflight.
      if (alt > ALT_CRUISE_M) {
        if (st.verticalRate == null || st.verticalRate > -1) continue;
      }
    }

    const dist = haversineKm({ lat: st.lat, lon: st.lon }, home);
    if (dist > MAX_KM) continue;

    // Must be heading roughly toward home.
    const bearing = bearingTo({ lat: st.lat, lon: st.lon }, home);
    const diff = Math.abs(((st.track - bearing) + 540) % 360 - 180);
    if (diff > HDG_TOL) continue;

    possible.push({
      icao24: st.icao24,
      callsign: (st.callsign || '').trim() || st.icao24,
      lat: st.lat,
      lon: st.lon,
      track: st.track,
      altitudeM: alt,
      altitudeFt: alt != null ? Math.round(alt * 3.281) : null,
      speedKt: Math.round(st.velocity * 1.94384),
      distHomeKm: Math.round(dist)
    });
  }

  return possible.sort((a, b) => a.distHomeKm - b.distHomeKm);
}

// Proximity fallback for unmatched departures.
// Aer Lingus and some other carriers use internal callsign codes (e.g. "EAI43D")
// that don't contain the flight number, breaking digit-matching.
// When callsign matching fails for an active departure, look for an airborne
// aircraft near home heading toward the scheduled destination.
function findDepartureCandidate(flight, states, home, alreadyMatched) {
  const dest = resolveAirport(flight.city);
  const MAX_KM = 220;      // covers the full Donegal–Dublin route (224 km) end-to-end
  const ALT_MAX_M = 5000;  // 16,400 ft — filters overflights at cruise (>FL160)
  const HDG_TOL = 65;      // heading tolerance toward destination
  const MIN_SPD = 60;      // m/s ≈ 117kt — properly airborne, not taxiing

  // Expected bearing from home toward destination
  const destBearing = dest ? bearingTo(home, dest) : null;

  let best = null;
  let bestDist = Infinity;

  for (const st of states) {
    if (alreadyMatched.has(st.icao24)) continue;
    if (st.onGround) continue;
    if (!st.lat || !st.lon) continue;
    if ((st.velocity || 0) < MIN_SPD) continue;

    const alt = st.baroAltitude;
    if (alt != null && alt > ALT_MAX_M) continue; // already at cruise → not a local departure

    const dist = haversineKm({ lat: st.lat, lon: st.lon }, home);
    if (dist > MAX_KM) continue;

    // Must be heading roughly toward the destination
    if (destBearing != null && st.track != null) {
      const diff = Math.abs(((st.track - destBearing) + 540) % 360 - 180);
      if (diff > HDG_TOL) continue;
    }

    if (dist < bestDist) { bestDist = dist; best = st; }
  }

  return best;
}

// Cross-track distance (km) from the great-circle route origin→home.
// Measures how far off-route a given position is. An aircraft on the Dublin→Donegal
// route has ~0 km; a Glasgow aircraft on that same check would be ~200+ km off.
function crossTrackDistKm(origin, home, pos) {
  const R = 6371;
  const toR = (d) => d * Math.PI / 180;
  const d13 = haversineKm(origin, pos) / R;                      // radians
  const b12  = toR(bearingTo(origin, home));
  const b13  = toR(bearingTo(origin, pos));
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(b13 - b12))) * R;
}

// Proximity fallback for unmatched arrivals.
// When an arrival's callsign doesn't match (AeroDataBox IATA ≠ ADS-B ICAO),
// identify the correct inbound by:
//   1. Heading toward home airport (existing geometric check).
//   2. Cross-track distance ≤ 150 km from the origin→home great-circle corridor.
//      This is the key discriminator: Dublin→Donegal and Glasgow→Donegal corridors
//      are ~200 km apart, so simultaneous inbounds from different origins can never
//      steal each other's match.
// When the origin airport is not in our AIRPORTS map the corridor check is skipped
// and we fall back to heading+distance only (safe for unknown routes).
function findArrivalCandidate(flight, states, home, alreadyMatched) {
  const MAX_KM          = 200;  // search radius around EIDL (km)
  const ALT_MIN_M       = 300;
  const ALT_CRUISE_M    = 7500;
  const HDG_TOL         = 40;   // ±40° of bearing toward home (tighter than findPossibleArrivals
                                 // to reject aircraft that are heading the wrong way near the origin)
  const MIN_SPD         = 50;   // m/s ≈ 97 kt — commercial turboprop minimum; filters helicopters
                                 // and light GA that share Irish airspace (ATR72 cruise ≈ 120 m/s)
  const MAX_CROSS_TRACK = 150;  // km off the origin→home corridor

  const origin = resolveAirport(flight.city);

  let best = null;
  let bestDist = Infinity;

  for (const st of states) {
    if (alreadyMatched.has(st.icao24)) continue;
    if (st.onGround) continue;
    if (!st.lat || !st.lon) continue;
    if ((st.velocity || 0) < MIN_SPD) continue;

    const alt = st.baroAltitude;
    if (alt != null) {
      if (alt < ALT_MIN_M) continue;
      if (alt > ALT_CRUISE_M && (st.verticalRate == null || st.verticalRate > -1)) continue;
    }

    const dist = haversineKm({ lat: st.lat, lon: st.lon }, home);
    if (dist > MAX_KM) continue;

    // Must be heading toward home
    if (st.track != null) {
      const bearing = bearingTo({ lat: st.lat, lon: st.lon }, home);
      const diff = Math.abs(((st.track - bearing) + 540) % 360 - 180);
      if (diff > HDG_TOL) continue;
    }

    // Route corridor check: reject aircraft that are too far off the origin→home
    // great-circle path. Prevents a Glasgow inbound from being matched to a Dublin
    // flight (and vice versa) when both are simultaneously inbound to Donegal.
    if (origin) {
      const xt = crossTrackDistKm(origin, home, { lat: st.lat, lon: st.lon });
      if (xt > MAX_CROSS_TRACK) continue;
    }

    if (dist < bestDist) { bestDist = dist; best = st; }
  }

  return best;
}

// Main entry: mutate data.flights with live status, return { tracked, possible }.
function track(data, cfg, states, nowDate = new Date()) {
  const tz = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
  const home = homeAirport(cfg);
  const tracked = [];
  // Track which ICAO24 codes are already matched to avoid double-matching
  const matchedIcao = new Set();

  for (const f of data.flights) {
    if (f.suppressed) continue; // hidden from board — don't touch
    let st = matchState(f, states);

    // Prevent double-matching: if callsign match returned an aircraft already
    // assigned to a previous flight, discard it and fall through to proximity.
    if (st && matchedIcao.has(st.icao24)) st = null;

    // Proximity fallback for departures: only when NO callsign is configured.
    // If we know the callsign and it didn't match, the aircraft is simply not
    // airborne yet — any proximity match would be an overflying plane.
    // Even without a callsign, limit to aircraft still close to home (≤60 km):
    // a plane that just left Donegal will be nearby; one 150 km away heading
    // southeast could be any Aer Lingus / Loganair / easyJet on another route.
    if (!st && f.type === 'departure' && !f.callsign &&
        f.status !== 'Departed' && f.status !== 'Cancelled') {
      const tMins = toMinutes(f.time);
      const nowMins = nowMinutes(cfg, nowDate);
      if (tMins == null || (nowMins >= tMins - 30 && nowMins <= tMins + 90)) {
        st = findDepartureCandidate(f, states, home, matchedIcao);
      }
    }

    // Arrivals: NO proximity fallback — only callsign/flight-number matching above.
    // Scanning the airspace for aircraft heading toward EIDL produces too many false
    // positives (dozens of flights cross this corridor every hour). If OpenSky doesn't
    // have the exact callsign, the clock + AeroDataBox handle the status instead.

    // ── Arrival "On Approach" + ADS-B dropout:
    // Could be (a) transponder off after landing, or (b) Go Around with brief
    // signal loss at low altitude. We can't tell immediately.
    // Strategy: track how long the signal has been missing.
    //   < 60 s → keep On Approach (Go Around aircraft keep transponder on throughout —
    //             any silence is a coverage gap, not a landing)
    //   ≥ 60 s → transponder is genuinely off → Landed
    // 60 s is enough: a Go Around takes the aircraft back above ADS-B coverage in < 30 s,
    // so a 60 s gap is unambiguously a transponder-off landing, not a circuit.
    // Dropout handler: transponder silence after confirmed approach or close-range En Route.
    // "On Approach": exact status match.
    // En Route / Departed + distHomeKm < 35: aircraft was last seen very close to home
    // (EMA lag may have prevented On Approach from firing) — treat the dropout as a landing.
    const _wasClose = f.live && f.live.distHomeKm != null && f.live.distHomeKm < 35;
    if (!st && f.type === 'arrival' &&
        (f.status === 'On Approach' ||
         (_wasClose && (f.status === 'En Route' || f.status === 'Departed')))) {
      const dropoutSince = (f.live && f.live.dropoutSince) || nowDate.getTime();
      const missingMs    = nowDate.getTime() - dropoutSince;
      if (missingMs >= 60 * 1000) {
        f.status      = 'Landed';
        f.estTime     = null;
        f.estLate     = false;
        f.estVeryLate = false;
        f.live        = null;
      } else {
        // Keep On Approach during the wait window.
        // Clear ETA — stale arrival time makes no sense once the plane is silent.
        // f.live stays truthy → scheduler clock won't touch the status.
        // Preserve distHomeKm so the _wasClose check keeps working on the next tick.
        f.live        = { dropoutSince, distHomeKm: f.live ? f.live.distHomeKm : null };
        f.estTime     = null;
        f.estLate     = false;
        f.estVeryLate = false;
      }
      continue;
    }

    if (!st) {
      const wasLive = !!f.live;
      f.live = null;
      // Only clear ETA if we were actively tracking this flight via ADS-B.
      // When f.live was null the ETA was set by an API (FR24 estimated, AeroDataBox
      // revised time) — keep it so the board shows something meaningful.
      if (wasLive) { f.estTime = null; f.estLate = false; f.estVeryLate = false; }
      continue;
    }
    matchedIcao.add(st.icao24);

    // Sticky values (EMA, timers, flags) only carry over when the SAME aircraft
    // is matched as the previous tick. If the matched ICAO24 changed — e.g. a
    // false-positive proximity match gave way to the real inbound — all timers
    // reset so departedAt, onGroundSince, and ETA smoothing start fresh.
    //
    // Exception: fr24hex matches are globally unique (Mode-S transponder address).
    // No false-positive is possible, so we treat every fr24hex hit as sameAircraft
    // even if OpenSky missed the aircraft for one poll. This prevents On Approach
    // from being blocked by a single ADS-B coverage gap near the airport.
    const fr24Match   = !!(f.fr24hex && f.fr24hex.toLowerCase() === (st.icao24 || '').toLowerCase());
    const sameAircraft = fr24Match || !!(f.live && f.live.icao24 === st.icao24);

    const pos = { lat: st.lat, lon: st.lon };
    const distHome = haversineKm(pos, home);
    const origin = resolveAirport(f.city);
    const distOrigin = origin ? haversineKm(pos, origin) : null;

    // Rough ETA to home: straight-line distance ÷ current ground speed.
    // EMA (α=0.35) blends new raw sample with stored smoothed value to
    // dampen ADS-B velocity noise — prevents the display jumping every poll.
    let eta = null;
    let etaSecs = null;
    if (!st.onGround && st.velocity > 30) {
      let rawSecs = (distHome * 1000) / st.velocity;
      if (rawSecs > 0 && rawSecs < 6 * 3600) {
        // Runway circuit overhead: if the aircraft is approaching from the wrong
        // side for the active runway it must overshoot and reverse — add the
        // configured overhead before smoothing.
        if (f.type === 'arrival') {
          const activeRwy = cfg.airport && cfg.airport.activeRunway;
          if (activeRwy) {
            const landingHdg  = (parseInt(activeRwy, 10) * 10) % 360; // RWY20 → 200°
            const approachDir = (landingHdg + 180) % 360;             // comes from 020°
            const acBearing   = bearingTo(home, pos);                  // airport → aircraft
            const diff = Math.abs(((acBearing - approachDir) + 540) % 360 - 180);
            if (diff > 90) {
              rawSecs += (Number(cfg.airport.circuitOverheadMin) || 8) * 60;
            }
          }
        }
        const prevSecs = sameAircraft && f.live && f.live.etaSecs;
        etaSecs = prevSecs != null ? 0.35 * rawSecs + 0.65 * prevSecs : rawSecs;
        // Round to nearest 5 minutes so the display doesn't flicker every poll.
        const secsRounded = Math.round(etaSecs / 300) * 300;
        eta = fmtTime(new Date(nowDate.getTime() + secsRounded * 1000), tz);
      }
    }

    const live = {
      callsign: st.callsign,
      icao24: st.icao24,
      lat: st.lat,
      lon: st.lon,
      track: st.track,
      altitudeM: st.baroAltitude,
      speedKt: st.velocity != null ? Math.round(st.velocity * 1.94384) : null,
      onGround: st.onGround,
      distHomeKm: Math.round(distHome),
      eta,
      etaSecs,
      // wasNearHome only carries over from the same aircraft — a different plane
      // that happened to pass close to home doesn't count as an approach attempt.
      wasNearHome: distHome < 50 || !!(sameAircraft && f.live && f.live.wasNearHome),
      departedOrigin: false,
      // departedAt resets when the matched aircraft changes, so the En Route
      // timer measures time since THIS specific aircraft was first picked up,
      // not since a prior false-positive match that may have run for minutes.
      departedAt: sameAircraft ? ((f.live && f.live.departedAt) || null) : null
    };

    const locked = f.locks && f.locks.status;

    if (f.type === 'arrival') {
      live.departedOrigin = !(origin && st.onGround && distOrigin < NEAR_KM);
      if (!locked) {
        // 200 ft = 61 m: treat as effectively on the ground to start the Landed
        // timer earlier (ADS-B onGround flag lags by a few seconds after touchdown).
        const effectiveOnGround = st.onGround || (st.baroAltitude != null && st.baroAltitude < 61);
        if (effectiveOnGround && distHome < NEAR_KM) {
          // On the ground at Donegal. Don't set Landed immediately — a Go Around
          // can briefly report ground contact before the crew climbs away again.
          // Require 2 continuous minutes of on-ground signal before confirming.
          // Only start the on-ground timer once the aircraft is confirmed (sameAircraft).
          // On first proximity match the timer stays null — avoids Landed firing 90 s
          // after a random aircraft on the EIDL apron is matched to a Dublin flight.
          const since = (sameAircraft && f.live && f.live.onGroundSince) || (sameAircraft ? nowDate.getTime() : null);
          live.onGroundSince = since;
          if (since !== null) {
            const groundMs = nowDate.getTime() - since;
            if (groundMs >= 90 * 1000) {
              f.status = 'Landed';
            }
          }
          // else: first match or < 90 s on ground — keep current status (On Approach → still monitoring)
        } else if (!effectiveOnGround) {
          // Airborne again — clear on-ground timer (handles Go Around recovery).
          live.onGroundSince = null;
          // Diversion detection — three conditions must ALL be true simultaneously:
          //   1. wasNearHome: aircraft was within 50 km at some point (genuine approach,
          //      not an overflight).
          //   2. distHome > 100 km: physically impossible during any go-around or holding
          //      pattern (max circuit radius ~30 km). Eliminates FL80 orbits too.
          //   3. altitude > 2500 m (~8200 ft): aircraft is climbing to cruise, not in a
          //      low-level circuit. Null altitude (no baro data) also triggers — if we
          //      have no altitude and it's 100 km away after confirmed approach, that's
          //      effectively a diversion.
          //   Only for scheduled operators (EI / LM) — charters/jets excluded.
          const DIVERT_OPERATORS = ['EI', 'LM'];
          const altM = st.baroAltitude;
          const genuineDivert =
            live.wasNearHome &&
            distHome > 100 &&
            (altM == null || altM > 2500) &&
            DIVERT_OPERATORS.includes(f.airlineCode);
          if (genuineDivert) {
            f.status      = 'Diverted';
            f.estTime     = null;
            f.estLate     = false;
            f.estVeryLate = false;
          } else if (f.status === 'Diverted') {
            // API set Diverted (e.g. the flight turned away before entering
            // the 50 km zone). Tracker can't confirm wasNearHome so don't
            // override — keep the API's Diverted status until it clears.
          } else if (distHome < 30 || (sameAircraft && etaSecs !== null && etaSecs < 10 * 60)) {
            // Within 30 km → On Approach immediately on first match.
            // At this range (≈16 NM) the aircraft is definitely on approach — we don't
            // need a prior tracked tick (sameAircraft) to confirm identity.
            // ETA < 10 min still requires sameAircraft to avoid EMA-inflated first-match ETAs.
            f.status = 'On Approach';
          } else if (sameAircraft) {
            // En Route / Departed only after at least one prior tracked tick confirms
            // this is really the flight's aircraft. On the very first proximity match
            // (sameAircraft=false) we keep the clock-driven status — the aircraft
            // hasn't proven it departed its origin yet.
            // Switch to En Route at ~35 km from origin (≈ 6 min at typical climb speed).
            if (distOrigin !== null) {
              f.status = distOrigin > 35 ? 'En Route' : 'Departed';
            } else {
              if (!live.departedAt) live.departedAt = nowDate.getTime();
              const minsSinceDep = (nowDate.getTime() - live.departedAt) / 60000;
              f.status = minsSinceDep >= 6 ? 'En Route' : 'Departed';
            }
          }
          // else (!sameAircraft): first proximity match — keep clock-driven status
        } else if (origin && st.onGround && distOrigin < NEAR_KM) {
          // Still on the ground at the origin (e.g. Dublin).
          // If it's within 30 min of scheduled arrival and hasn't left, it's delayed.
          const tMins = toMinutes(f.time);
          if (tMins != null && nowMinutes(cfg, nowDate) >= tMins - 60) {
            f.status = 'Delayed';
          }
          // else leave the clock-engine status (Scheduled / On Time)
        }
        // Always show ETA when in flight (Departed/On Approach) so passengers
        // know when to expect the plane. Only show when late for other statuses.
        // Never show ETA for a diverted flight — distance-to-Donegal is meaningless.
        if (eta && f.status !== 'Diverted') {
          if (f.status === 'On Approach' && f.estTime) {
            // Freeze: EST was set when approach started, don't let ADS-B noise
            // cause it to jump around in the last ~10 minutes.
          } else {
            const inFlight = f.status === 'Departed' || f.status === 'En Route' || f.status === 'On Approach';
            const delay = delayMinutes(f.time, eta);
            f.estTime = (inFlight || delay > 0) ? eta : null;
            f.estLate     = delay > 0 && delay <= 20; // amber: 1–20 min late
            f.estVeryLate = delay > 20;               // red: >20 min late
          }
        } else {
          f.estTime = null;
          f.estLate = false;
          f.estVeryLate = false;
        }
      }
    } else { // departure
      live.departedOrigin = !st.onGround || distHome > NEAR_KM;
      if (!locked) {
        if (st.onGround && distHome < NEAR_KM) {
          // Aircraft still at gate — ADS-B is the ground truth here.
          // If the clock engine already set 'Departed' (time passed but plane
          // hadn't been seen yet), walk it back: the plane is physically on
          // the ground.
          const tMins    = toMinutes(f.time);
          const nowM     = nowMinutes(cfg, nowDate);
          if (tMins != null && nowM >= tMins + 20) {
            f.status = 'Delayed';
          } else if (f.status === 'Departed') {
            f.status = 'On Time';
          }
        } else if (!st.onGround) {
          // Mark Departed only when we have a valid altitude above 100 ft (≈30 m).
          // The null-altitude case must NOT trigger Departed: when the transponder
          // powers on at engine start, onGround can briefly read false before the
          // baro sensor initialises — null altitude is the tell-tale sign.
          const alt = st.baroAltitude;
          if (alt != null && alt > 30) {
            f.status = 'Departed';
          }
        }
      }
    }

    f.live = live;
    tracked.push({ flightNo: f.flightNo, type: f.type, status: f.status, ...live });
  }

  const possible = findPossibleArrivals(states, data.flights, home);
  return { tracked, possible };
}

function toMinutes(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function nowMinutes(cfg, nowDate) {
  const tz = (cfg.display && cfg.display.timezone) || 'Europe/Dublin';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(nowDate).map((x) => [x.type, x.value]));
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}

function isPastSchedule(f, cfg, nowDate) {
  const t = toMinutes(f.time);
  return t != null && nowMinutes(cfg, nowDate) > t;
}

function delayMinutes(sched, eta) {
  const a = toMinutes(sched), b = toMinutes(eta);
  if (a == null || b == null) return 0;
  let diff = b - a;
  // Handle midnight crossing: if diff is more than half a day negative, ETA
  // wrapped past 00:00 (e.g. sched=23:45, eta=00:10 → diff=-1415 → +25 min).
  if (diff < -720) diff += 24 * 60;
  return diff;
}

// Should we even call OpenSky right now? Only when a flight is in its window.
// Note: we do NOT skip Departed/Landed by status — the time window itself is
// the gate. This lets us keep tracking a departure on the map after it leaves,
// and confirm a landing cleanly. Only Cancelled flights are excluded always.
function isActiveWindow(data, cfg, nowDate = new Date()) {
  const before = Number(cfg.opensky && cfg.opensky.trackWindowBeforeMin) || 90;
  const after = Number(cfg.opensky && cfg.opensky.trackWindowAfterMin) || 30;
  const now = nowMinutes(cfg, nowDate);
  return data.flights.some((f) => {
    if (f.status === 'Cancelled') return false;
    // Delayed flights keep the window open indefinitely — still expected.
    if (f.status === 'Delayed') return true;
    // Any flight with active ADS-B tracking keeps the window open — we need
    // to keep polling to confirm landing, update ETA, or detect a stale match.
    // Without this, an 'En Route' flight past t+after would stop being polled.
    if (f.live) return true;
    const t = toMinutes(f.time);
    return t != null && now >= t - before && now <= t + after;
  });
}

module.exports = { track, isActiveWindow, haversineKm, bearingTo, AIRPORTS, resolveAirport, homeAirport };
