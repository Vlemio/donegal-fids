/* ============================================================
   Donegal FIDS — display board logic
   - Live clock (Europe/Dublin)
   - Polls /api/flights and re-renders with subtle animations
   - Falls back to a built-in dataset if the server is unreachable
     (so the screen never goes blank — useful while migrating)
   ============================================================ */

const TZ = 'Europe/Dublin';
let REFRESH_MS = 15000;
let prevState = new Map(); // id -> serialised flight (to detect changes)

// Fallback data mirrors data/flights.json so the board still shows
// something if opened without the server running.
const FALLBACK = {
  config: { airport: { name: 'Donegal Airport', nameIrish: 'Aerfort Dhún na nGall' }, display: {} },
  flights: [
    { id: 'DEP-EI3401', type: 'departure', time: '07:55', airline: 'Aer Lingus', airlineCode: 'EI', city: 'Dublin', flightNo: 'EI3401', codeshare: ['BA8911', 'QR8254'], status: 'Departed' },
    { id: 'DEP-EI3403', type: 'departure', time: '14:30', airline: 'Aer Lingus', airlineCode: 'EI', city: 'Dublin', flightNo: 'EI3403', codeshare: ['BA8913'], status: 'Departed' },
    { id: 'ARR-EI3402', type: 'arrival', time: '14:00', airline: 'Aer Lingus', airlineCode: 'EI', city: 'Dublin', flightNo: 'EI3402', codeshare: ['QR9666', 'BA8912'], status: 'Landed' },
    { id: 'ARR-EI3408', type: 'arrival', time: '20:00', airline: 'Aer Lingus', airlineCode: 'EI', city: 'Dublin', flightNo: 'EI3408', codeshare: ['QR8255', 'BA8914'], status: 'Delayed' }
  ]
};

/* ---------- Clock ---------- */
function tickClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(now);
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short'
  }).format(now);
  document.getElementById('clock').textContent = time;
  document.getElementById('date').textContent = date;
}

/* ---------- Helpers ---------- */
function statusClass(status) {
  return 'status--' + String(status).toLowerCase().replace(/[^a-z]/g, '');
}

function minutesUntil(hhmm) {
  if (!hhmm) return Infinity;
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const dub = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const target = new Date(dub);
  target.setHours(h, m, 0, 0);
  return Math.round((target - dub) / 60000);
}

function sortFlights(list) {
  return [...list].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

function rowHtml(f) {
  const codeshare = (f.codeshare || []).join('  ');
  const est = f.estTime
    ? `<span class="est ${f.estVeryLate ? 'est--very-late' : f.estLate ? 'est--late' : ''}">EST ${f.estTime}</span>`
    : '';
  return `
    <div class="cell cell--time">${f.time || '--:--'}${est}</div>
    <div class="cell cell--airline">
      ${f.airlineCode ? `<span class="airline-badge">${f.airlineCode}</span>` : ''}
      <span>${f.airline || ''}</span>
    </div>
    <div class="cell cell--city">${f.city || ''}</div>
    <div class="cell cell--flight">${f.flightNo || ''}</div>
    <div class="cell cell--code">${codeshare}</div>
    <div class="cell cell--status">
      <span class="status ${statusClass(f.status)}">${f.status || 'Scheduled'}</span>
    </div>`;
}

function render(container, flights) {
  if (!flights.length) {
    container.innerHTML = '<div class="empty">No scheduled flights</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of sortFlights(flights)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = f.id;
    row.innerHTML = rowHtml(f);

    const serial = JSON.stringify(f);
    const prev = prevState.get(f.id);
    if (prev === undefined) row.classList.add('row--new');
    else if (prev !== serial) {
      row.querySelectorAll('.cell').forEach((c) => c.classList.add('cell--flash'));
    }
    prevState.set(f.id, serial);
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

/* ---------- Data ---------- */
function applyData(data) {
  const flights = data.flights || [];
  const departures = flights.filter((f) => f.type === 'departure');
  const arrivals = flights.filter((f) => f.type === 'arrival');

  render(document.getElementById('departures'), departures);
  render(document.getElementById('arrivals'), arrivals);

  if (data.config && data.config.airport) {
    document.getElementById('airportName').textContent = data.config.airport.name || 'Donegal Airport';
    document.getElementById('airportIrish').textContent = data.config.airport.nameIrish || 'Aerfort Dhún na nGall';
  }

  const notice = data.config && data.config.display && data.config.display.noticeText;
  const ticker = document.getElementById('ticker');
  ticker.textContent = notice
    ? notice
    : 'Welcome to Donegal Airport · Fáilte go Aerfort Dhún na nGall · Please keep your boarding pass and ID ready';

  if (data.config && data.config.display && data.config.display.refreshSeconds) {
    REFRESH_MS = data.config.display.refreshSeconds * 1000;
  }
}

async function poll() {
  try {
    const res = await fetch('/api/flights', { cache: 'no-store' });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    applyData(data);
  } catch (err) {
    // Offline / opened as a file — show fallback data.
    if (prevState.size === 0) applyData(FALLBACK);
  }
}

/* ---------- Kiosk guards ---------- */
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  // Block F5 (refresh), F11 (toggle fullscreen), Alt+F4, browser shortcuts
  if (e.key === 'F5' || e.key === 'F11' || (e.altKey && e.key === 'F4')) e.preventDefault();
});

/* ---------- Boot ---------- */
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, REFRESH_MS);
