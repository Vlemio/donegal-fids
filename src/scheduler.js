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

function getScheduleFile() {
  return process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'schedule.json')
    : path.join(__dirname, '..', 'data', 'schedule.json');
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Given today's 'YYYY-MM-DD' string, return {date, dow} for tomorrow in tz.
function nextDateParts(todayStr, tz) {
  const [y, mo, d] = todayStr.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, mo - 1, d + 1, 12, 0, 0)); // noon UTC avoids DST edge
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const p = Object.fromEntries(fmt.formatToParts(tomorrow).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday] };
}

// Materialise recurring flights for a specific date/dow into data.
function _ensureFlightsForDate(data, schedule, date, dow) {
  for (const s of schedule.recurring) {
    if (!Array.isArray(s.days) || !s.days.includes(dow)) continue;
    const id = (s.type === 'arrival' ? 'ARR-' : 'DEP-') + (s.flightNo || '').toUpperCase();
    const existing = data.flights.find((f) => f.id === id);
    if (existing) {
      // Worker suppressed this flight explicitly for this date — respect it.
      if (existing.suppressed && existing.schedDate === date) continue;
      // Already the correct date — restore codeshares if API wiped them.
      if (existing.schedDate === date) {
        if (Array.isArray(s.codeshare) && s.codeshare.length > 0 &&
            (!Array.isArray(existing.codeshare) || existing.codeshare.length === 0)) {
          existing.codeshare = s.codeshare.map((c) => String(c).toUpperCase());
        }
        continue;
      }
      // Entry is pre-populated for a FUTURE date — leave it alone.
      // (YYYY-MM-DD strings compare correctly as lexicographic order.)
      if (existing.schedDate && existing.schedDate > date) continue;
      // Past date or no date: only replace once the entry has been suppressed by cleanupOld.
      // Replacing an active entry (e.g. Landed but still within the cleanup window) stamps
      // tomorrow's schedDate on it, which blocks cleanupOld from ever suppressing it —
      // the flight stays on the board forever with an incorrect status.
      if (!existing.suppressed) continue;
      data.flights = data.flights.filter((f) => f.id !== id);
    }
    const newFlight = store.normalise({ ...s, id, status: 'Scheduled', source: 'schedule', locks: {} });
    newFlight.schedDate = date;
    data.flights.push(newFlight);
  }
}

function readSchedule() {
  try {
    const data = JSON.parse(fs.readFileSync(getScheduleFile(), 'utf8'));
    if (!Array.isArray(data.recurring)) data.recurring = [];
    return data;
  } catch (_) {
    return { recurring: [] };
  }
}

function writeSchedule(data) {
  fs.writeFileSync(getScheduleFile(), JSON.stringify(data, null, 2), 'utf8');
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
// Once all of today's flights are done/suppressed, pre-populates tomorrow's
// so the board never shows empty between last flight and midnight.
function ensureTodaysFlights(data, schedule, parts, tz) {
  // One-time migration: stamp today's date on any active flight that lacks one.
  // This covers flights written by old code (schedDate was never set) so the
  // pre-population logic below can distinguish "today's active" from "old suppressed".
  for (const f of data.flights) {
    if (!f.suppressed && !f.schedDate) f.schedDate = parts.date;
  }

  // Self-heal: a future-dated entry with a real-time status (Landed, Departed, En Route,
  // On Approach) was corrupted — the tracker or API applied today's flight data to a
  // pre-populated tomorrow entry after it got tomorrow's schedDate prematurely.
  // A flight scheduled for a future date cannot have any of these statuses; reset it
  // to Scheduled so it appears correctly when its day actually arrives.
  for (const f of data.flights) {
    if (f.schedDate && f.schedDate > parts.date &&
        (f.status === 'Landed' || f.status === 'Departed' ||
         f.status === 'En Route' || f.status === 'On Approach' || f.status === 'Diverted')) {
      f.status      = 'Scheduled';
      f.estTime     = null;
      f.live        = null;
      f.estLate     = false;
      f.estVeryLate = false;
    }
  }

  _ensureFlightsForDate(data, schedule, parts.date, parts.dow);

  // Count active flights for today — include any that still have no schedDate just in case.
  const hasActiveToday = data.flights.some(
    (f) => !f.suppressed && (!f.schedDate || f.schedDate === parts.date)
  );
  if (!hasActiveToday) {
    const tomorrow = nextDateParts(parts.date, tz || 'Europe/Dublin');
    _ensureFlightsForDate(data, schedule, tomorrow.date, tomorrow.dow);
  }
}

// Move statuses forward based on the clock (skips manually locked ones).
function autoAdvanceStatus(data, cfg, parts) {
  for (const f of data.flights) {
    if (f.suppressed) continue;                                     // hidden flight
    if (f.locks && f.locks.status) continue;                        // manual override
    if (f.schedDate && f.schedDate !== parts.date) continue;        // tomorrow's pre-populated flight

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
      // When there's no ADS-B signal (!f.live) also use the ETA as a Landed trigger —
      // a delayed flight's t+10 fires too early if the aircraft is still in the air.
      if (f.status === 'On Approach') {
        const etaMin = toMinutes(f.estTime);
        if (now >= t + 10 || (!f.live && etaMin !== null && now >= etaMin + 5)) {
          f.status = 'Landed';
        }
        continue;
      }

      // En Route / Departed means FR24 confirmed the aircraft left its origin via ADS-B.
      // Don't let the clock overwrite this with On Time / Delayed — the plane IS in the air.
      // Protection window: ETA + 30 min when we have a live ETA (flight-positions/full);
      // fall back to scheduled time + 60 min when no ETA is available. After the window,
      // something went wrong (no ADS-B landing confirmed) and the clock shows Delayed.
      // Time-based On Approach fallback: when there's no ADS-B signal and ETA is within
      // 12 min, trigger On Approach so the board shows the correct phase.
      if (f.status === 'En Route' || f.status === 'Departed') {
        const etaMin = toMinutes(f.estTime);
        const cutoff = etaMin !== null ? etaMin + 30 : t + 60;
        if (now < cutoff) {
          if (!f.live) {
            if (etaMin !== null && now >= etaMin - 12) f.status = 'On Approach';
          }
          continue;
        }
      }

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
    if (f.suppressed) continue;                                 // already handled
    if (f.schedDate && f.schedDate !== parts.date) continue;   // tomorrow's pre-populated flight
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
  ensureTodaysFlights, autoAdvanceStatus, cleanupOld, getScheduleFile
};
