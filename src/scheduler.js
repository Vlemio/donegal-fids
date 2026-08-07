// Free "self-updating" engine — no external API needed.
// 1. ensureTodaysFlights: materialise the recurring timetable for today.
// 2. autoAdvanceStatus: move statuses forward based on the clock.
// 3. cleanupOld: drop flights that are well past.
//
// Manual control always wins: any flight whose status is locked
// (locks.status === true) is never touched by the auto engine.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SCHEDULE_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'schedule.json')
  : path.join(__dirname, '..', 'data', 'schedule.json');

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function readSchedule() {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    if (!Array.isArray(data.recurring)) data.recurring = [];
    return data;
  } catch (_) {
    return { recurring: [] };
  }
}

function writeSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// Current time in the airport's timezone, broken into useful parts.
function localParts(tz = 'Europe/Dublin', now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: DOW[p.weekday],
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10)
  };
}

function toMinutes(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Add today's recurring flights if they aren't on the board yet.
// Uses a schedDate field to detect stale previous-day entries with the same ID
// (date-agnostic IDs like ARR-EI3408 would otherwise block tomorrow's flight).
function ensureTodaysFlights(data, schedule, parts) {
  for (const s of schedule.recurring) {
    if (!Array.isArray(s.days) || !s.days.includes(parts.dow)) continue;
    const id = (s.type === 'arrival' ? 'ARR-' : 'DEP-') + (s.flightNo || '').toUpperCase();
    const existing = data.flights.find((f) => f.id === id);
    if (existing) {
      // Suppressed today: worker removed it from the board. Keep it suppressed
      // until tomorrow (different schedDate) when it resets to a fresh entry.
      if (existing.suppressed && existing.schedDate === parts.date) continue;
      // Only replace if the flight has a schedDate from a PREVIOUS day.
      if (!existing.schedDate || existing.schedDate === parts.date) continue;
      // Previous day's flight still lingering — replace it with today's fresh entry.
      data.flights = data.flights.filter((f) => f.id !== id);
    }
    const newFlight = store.normalise({ ...s, id, status: 'Scheduled', source: 'schedule', locks: {} });
    newFlight.schedDate = parts.date; // survives across the day; compared on next ensureTodaysFlights run
    data.flights.push(newFlight);
  }
}

// Move statuses forward based on the clock (skips manually locked ones).
function autoAdvanceStatus(data, cfg, parts) {
  for (const f of data.flights) {
    if (f.suppressed) continue;              // hidden flight — leave it alone
    if (f.locks && f.locks.status) continue; // manual override wins

    const t = toMinutes(f.time);
    if (t == null) continue;
    const now = parts.minutes;

    // Safety valve: if an arrival has been stuck at "Departed" or "En Route" (ADS-B
    // matched a plane but never confirmed landing) for 90+ min past scheduled arrival,
    // release the ADS-B lock so the clock can mark it Delayed. This catches stale
    // matches where the transponder went silent, the wrong plane was matched, or the
    // flight diverted before getting close to Donegal. Threshold is 90 min — enough
    // to cover genuine Donegal delays (Dublin–Donegal is a ~50 min leg).
    if (f.type === 'arrival' && f.live &&
        (f.status === 'Departed' || f.status === 'En Route') && now >= t + 90) {
      f.live = null;
    }

    // Self-heal: clear bogus near-arrival statuses set too far before scheduled time.
    // "On Approach" means <10 min from home — impossible 20+ min before arrival.
    // "Landed" means on the ground at EIDL — impossible before scheduled arrival time.
    // "En Route" is NOT included: a genuine Dublin→Donegal flight IS En Route 50 min
    // before the 14:00 arrival (it departs ~13:10). Only proximity-derived near-home
    // statuses can be safely self-healed this way.
    // Runs before the f.live guard so it fires even when the bad ADS-B match left f.live set.
    if (f.type === 'arrival' && now < t - 20 &&
        (f.status === 'On Approach' || f.status === 'Landed')) {
      f.status = 'Scheduled';
      f.live   = null;
      f.estTime = null;
    }

    if (f.live) continue; // ADS-B tracker owns this flight's status

    if (f.type === 'departure') {
      // Effective departure minute: scheduled time, pushed later by two sources:
      // 1. AeroDataBox revised time (estTime already set by mergeApi).
      // 2. Turnaround: the inbound aircraft for this airline hasn't landed yet —
      //    the plane physically can't leave before it arrives + minimum turnaround.
      let effectiveT = t;
      const estMin = toMinutes(f.estTime);
      if (estMin !== null && estMin > t) effectiveT = estMin;

      // Turnaround: find an arrival from the same airline that is scheduled within
      // 4 h before this departure and hasn't landed yet.
      const TURNAROUND_MIN = 25;
      const inbound = data.flights.find(
        (a) =>
          a.type === 'arrival' &&
          a.airlineCode === f.airlineCode &&
          toMinutes(a.time) !== null &&
          toMinutes(a.time) < t &&
          toMinutes(a.time) >= t - 4 * 60 &&
          // Include Landed inbounds that landed so recently there isn't enough
          // turnaround time yet. Use estTime (API-revised) if available — it better
          // reflects actual landing time than the scheduled time when the flight is delayed.
          (a.status !== 'Landed' || (toMinutes(a.estTime || a.time) + TURNAROUND_MIN) > now)
      );
      if (inbound) {
        // Use live ADS-B ETA when the tracker has it — more accurate than scheduled/API time.
        const liveEta = inbound.live && inbound.live.eta ? toMinutes(inbound.live.eta) : null;
        const arrEst  = liveEta ?? toMinutes(inbound.estTime) ?? toMinutes(inbound.time);
        if (arrEst !== null) {
          const earliest = arrEst + TURNAROUND_MIN;
          if (earliest > effectiveT) effectiveT = earliest;
        }
      }

      // 15-min grace before clock-driven Departed: gives ADS-B time to detect the
      // actual takeoff (OpenSky at EIDL only picks up aircraft once airborne at altitude).
      // If ADS-B confirms departure first it sets 'Departed' via the tracker and
      // f.live becomes truthy — the clock then skips this flight entirely.
      if (now >= effectiveT + 15) f.status = 'Departed';
      else if (now >= t - 120) f.status = effectiveT > t ? 'Delayed' : 'On Time';
      else f.status = 'Scheduled';

      // Hard correctness guard: if the inbound is still physically in the air
      // (En Route / On Approach), the turnaround aircraft cannot have departed —
      // the plane literally hasn't landed yet. Walk back any clock-set Departed
      // to Delayed. ADS-B-confirmed departures (f.live set) are never touched here.
      if (inbound && ['En Route', 'On Approach'].includes(inbound.status) &&
          f.status === 'Departed' && !f.live) {
        f.status = 'Delayed';
      }
    } else { // arrival
      // Final / airline-set states: clock never touches these.
      if (f.status === 'Landed' || f.status === 'Diverted' || f.status === 'Cancelled') continue;

      // "On Approach" is resolved by the ADS-B dropout handler in tracker.js.
      // Fallback: 10+ min past scheduled arrival with no ADS-B → Landed.
      if (f.status === 'On Approach') {
        if (now >= t + 10) f.status = 'Landed';
        continue;
      }

      // En Route / Departed means FR24 confirmed the aircraft left its origin via ADS-B.
      // Don't let the clock overwrite this with On Time / Delayed — that would be wrong
      // (the plane IS in the air). Protect until 60 min past schedule; after that, something
      // went wrong (no ADS-B landing confirmed) and the clock correctly shows Delayed.
      if ((f.status === 'En Route' || f.status === 'Departed') && now < t + 60) continue;

      // Clock fallback: Scheduled → On Time → Delayed.
      // Only runs for statuses the clock owns: Scheduled, On Time, Delayed.
      if (now >= t + 5) f.status = 'Delayed';
      else if (now >= t - 120) f.status = 'On Time';
      else f.status = 'Scheduled';
    }
  }
}

// Suppress flights that finished a while ago, to keep the board tidy.
// We suppress (hide) instead of deleting so that ensureTodaysFlights won't
// re-add them as fresh "Scheduled" entries for the rest of the day.
// The suppressed entry has schedDate = today, so tomorrow it is replaced.
function cleanupOld(data, cfg, parts) {
  const arrKeep = Number(cfg.display.removeAfterMin) || 30;
  // Departures stay on the board 120 min (2h) after scheduled departure time.
  const depKeep = 120;
  for (const f of data.flights) {
    if (f.locks && f.locks.keep) continue;
    if (f.suppressed) continue; // already handled
    const t = toMinutes(f.time);
    if (t == null) {
      // Timeless flights (no scheduled time): suppress immediately if terminal.
      if (['Departed', 'Landed', 'Cancelled', 'Diverted'].includes(f.status)) {
        f.suppressed = true;
        f.schedDate  = parts.date;
        f.live       = null;
      }
      continue;
    }

    const shouldSuppress =
      (f.type === 'departure' && f.status === 'Departed' && parts.minutes > t + depKeep) ||
      (f.type === 'arrival'   && f.status === 'Landed'   && parts.minutes > t + arrKeep) ||
      (f.type === 'arrival'   && f.status === 'Delayed'  && parts.minutes > t + 90);

    if (shouldSuppress) {
      f.suppressed = true;
      f.schedDate  = parts.date;
      f.live       = null;
    }
  }
}

module.exports = {
  readSchedule, writeSchedule, localParts, toMinutes,
  ensureTodaysFlights, autoAdvanceStatus, cleanupOld, SCHEDULE_FILE
};
