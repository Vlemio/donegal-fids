/* Donegal FIDS — control panel logic */

const STATUSES = [
  'Scheduled', 'On Time', 'Check-in', 'Boarding', 'Final Call', 'Gate Closed',
  'Departed', 'On Approach', 'Delayed', 'En Route', 'Approaching', 'Landed',
  'Cancelled', 'Diverted'
];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);
let modalMode = 'flight'; // 'flight' | 'schedule'

function statClass(s) { return 'stat--' + String(s).toLowerCase().replace(/[^a-z]/g, ''); }

/* ===================== Flights ===================== */
async function loadFlights() {
  const data = await (await fetch('/api/flights', { cache: 'no-store' })).json();
  const flights = data.flights || [];
  renderFlights($('depList'), flights.filter((f) => f.type === 'departure'));
  renderFlights($('arrList'), flights.filter((f) => f.type === 'arrival'));
}

function renderFlights(container, flights) {
  flights.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (!flights.length) { container.innerHTML = '<p class="muted">No flights.</p>'; return; }
  container.innerHTML = '';
  for (const f of flights) {
    const locked = f.locks && f.locks.status;
    const el = document.createElement('div');
    el.className = 'flight';
    el.innerHTML = `
      <div class="flight__time">${f.time || '--:--'}
        ${f.estTime ? `<div class="flight__est">Est ${f.estTime}</div>` : ''}
      </div>
      <div class="flight__main">
        <div class="flight__no">${f.flightNo}
          <span class="stat ${statClass(f.status)}">${f.status}</span>
          ${locked ? '<span class="lock-tag">🔒 manual</span>' : '<span class="lock-tag lock-tag--auto">auto</span>'}
        </div>
        <div class="flight__sub">${f.airline} · ${f.city}
          ${(f.codeshare || []).length ? '· ' + f.codeshare.join(' ') : ''}
          <span class="src-tag ${f.source === 'api' ? 'src-tag--api' : ''}">${f.source}</span>
        </div>
      </div>
      <div class="flight__actions">
        <button class="btn btn--icon" data-edit="${f.id}">Edit</button>
        <button class="btn btn--icon btn--danger" data-del="${f.id}">✕</button>
      </div>`;
    container.appendChild(el);
  }
  container.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openFlight(b.dataset.edit)));
  container.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => delFlight(b.dataset.del)));
}

async function delFlight(id) {
  if (!confirm('Delete this flight from the board?')) return;
  await fetch(`/api/flights/${id}`, { method: 'DELETE' });
  loadFlights();
}

/* ===================== Timetable ===================== */
async function loadSchedule() {
  const data = await (await fetch('/api/schedule', { cache: 'no-store' })).json();
  const list = data.recurring || [];
  const c = $('schedList');
  if (!list.length) { c.innerHTML = '<p class="muted">No recurring flights yet.</p>'; return; }
  list.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  c.innerHTML = '';
  for (const s of list) {
    const days = (s.days || []).map((d) => DAY_LABELS[d]).join(' ');
    const key = s._id || `${s.type}|${s.flightNo}`;
    const el = document.createElement('div');
    el.className = 'flight';
    el.innerHTML = `
      <div class="flight__time">${s.time || '--:--'}
        <div class="flight__est">${s.type === 'arrival' ? '↓ arr' : '↑ dep'}</div>
      </div>
      <div class="flight__main">
        <div class="flight__no">${s.flightNo}</div>
        <div class="flight__sub">${s.airline} · ${s.city} · <span class="days-tag">${days || 'no days set'}</span></div>
      </div>
      <div class="flight__actions">
        <button class="btn btn--icon" data-sedit="${key}">Edit</button>
        <button class="btn btn--icon btn--danger" data-sdel="${key}">✕</button>
      </div>`;
    c.appendChild(el);
  }
  c.querySelectorAll('[data-sedit]').forEach((b) =>
    b.addEventListener('click', () => openSchedule(b.dataset.sedit)));
  c.querySelectorAll('[data-sdel]').forEach((b) =>
    b.addEventListener('click', () => delSchedule(b.dataset.sdel)));
}

async function delSchedule(key) {
  if (!confirm('Remove from timetable? (does not remove flights already on the board today)')) return;
  await fetch(`/api/schedule/by-id/${encodeURIComponent(key)}`, { method: 'DELETE' });
  loadSchedule();
}

/* ===================== Modal ===================== */
function fillStatusSelect() { $('f_status').innerHTML = STATUSES.map((s) => `<option>${s}</option>`).join(''); }

function buildDays(selected = []) {
  $('f_days').innerHTML = DAY_LABELS.map((d, i) =>
    `<label class="day"><input type="checkbox" value="${i}" ${selected.includes(i) ? 'checked' : ''}>${d}</label>`
  ).join('');
}
function readDays() {
  return [...$('f_days').querySelectorAll('input:checked')].map((c) => Number(c.value));
}

function setMode(mode) {
  modalMode = mode;
  const isSched = mode === 'schedule';
  $('statusField').hidden = isSched;
  $('lockField').hidden = isSched;
  $('daysField').hidden = !isSched;
}

let flightCache = [];
async function openFlight(id) {
  setMode('flight');
  flightCache = (await (await fetch('/api/flights', { cache: 'no-store' })).json()).flights || [];
  const f = flightCache.find((x) => x.id === id) ||
    { type: 'departure', status: 'Scheduled', codeshare: [], airline: 'Aer Lingus', airlineCode: 'EI', locks: {} };
  $('modalTitle').textContent = id ? 'Edit flight' : 'Add flight';
  $('f_id').value = id || '';
  $('f_type').value = f.type;
  $('f_status').value = f.status;
  $('f_time').value = f.time || '';
  $('f_estTime').value = f.estTime || '';
  $('f_flightNo').value = f.flightNo || '';
  $('f_city').value = f.city || '';
  $('f_airline').value = f.airline || '';
  $('f_airlineCode').value = f.airlineCode || '';
  $('f_codeshare').value = (f.codeshare || []).join(', ');
  $('f_callsign').value = f.callsign || '';
  $('f_lockStatus').checked = !!(f.locks && f.locks.status);
  $('modal').hidden = false;
}

let schedCache = [];
async function openSchedule(key) {
  setMode('schedule');
  schedCache = (await (await fetch('/api/schedule', { cache: 'no-store' })).json()).recurring || [];
  let s = { type: 'departure', codeshare: [], airline: 'Aer Lingus', airlineCode: 'EI', days: [1, 2, 3, 4, 5] };
  if (key) {
    s = schedCache.find((x) => x._id === key) || s;
  }
  $('modalTitle').textContent = key ? 'Edit recurring flight' : 'Add recurring flight';
  $('f_id').value = s._id || '';
  $('f_type').value = s.type;
  $('f_time').value = s.time || '';
  $('f_estTime').value = '';
  $('f_flightNo').value = s.flightNo || '';
  $('f_city').value = s.city || '';
  $('f_airline').value = s.airline || '';
  $('f_airlineCode').value = s.airlineCode || '';
  $('f_codeshare').value = (s.codeshare || []).join(', ');
  $('f_callsign').value = s.callsign || '';
  buildDays(s.days || []);
  $('modal').hidden = false;
}

function closeEditor() { $('modal').hidden = true; }

async function saveModal() {
  const base = {
    type: $('f_type').value,
    time: $('f_time').value.trim(),
    flightNo: $('f_flightNo').value.trim().toUpperCase(),
    city: $('f_city').value.trim(),
    airline: $('f_airline').value.trim(),
    airlineCode: $('f_airlineCode').value.trim().toUpperCase(),
    codeshare: $('f_codeshare').value.split(',').map((s) => s.trim()).filter(Boolean),
    callsign: $('f_callsign').value.trim().toUpperCase()
  };
  if (!base.flightNo) { alert('Flight number is required'); return; }

  if (modalMode === 'schedule') {
    base.days = readDays();
    const schedId = $('f_id').value;
    if (schedId) base._id = schedId;
    await fetch('/api/schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base)
    });
    closeEditor();
    loadSchedule();
    loadFlights();
    return;
  }

  // flight mode
  base.status = $('f_status').value;
  base.estTime = $('f_estTime').value.trim() || null;
  base.locks = { status: $('f_lockStatus').checked };
  const id = $('f_id').value;
  if (id) {
    await fetch(`/api/flights/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base)
    });
  } else {
    await fetch('/api/flights', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base)
    });
  }
  closeEditor();
  loadFlights();
}

/* ===================== Settings ===================== */
async function loadConfig() {
  const cfg = await (await fetch('/api/config')).json();
  $('autoSchedule').checked = cfg.display.autoSchedule !== false;
  $('autoStatus').checked = cfg.display.autoStatus !== false;
  $('boardingLeadMin').value = cfg.display.boardingLeadMin ?? 25;
  $('removeAfterMin').value = cfg.display.removeAfterMin ?? 60;
  $('refreshSeconds').value = cfg.display.refreshSeconds || 15;
  $('noticeText').value = cfg.display.noticeText || '';
  $('apiEnabled').checked = !!cfg.api.enabled;
  $('apiKey').value = cfg.api.rapidApiKey || '';
  $('pollInterval').value = cfg.api.pollIntervalSeconds || 120;
  const osky = cfg.opensky || {};
  $('oskyEnabled').checked = osky.enabled !== false;
  $('oskyId').value = osky.clientId || '';
  $('oskySecret').value = osky.clientSecret || '';
  refreshApiStatus();
  refreshLiveStatus();
}

async function saveSettings() {
  const body = {
    display: {
      autoSchedule: $('autoSchedule').checked,
      autoStatus: $('autoStatus').checked,
      boardingLeadMin: Number($('boardingLeadMin').value) || 0,
      removeAfterMin: Number($('removeAfterMin').value) || 0,
      refreshSeconds: Number($('refreshSeconds').value) || 15,
      noticeText: $('noticeText').value.trim()
    },
    api: {
      enabled: $('apiEnabled').checked,
      rapidApiKey: $('apiKey').value.trim(),
      pollIntervalSeconds: Number($('pollInterval').value) || 120
    },
    opensky: {
      enabled: $('oskyEnabled').checked,
      clientId: $('oskyId').value.trim(),
      clientSecret: $('oskySecret').value.trim()
    }
  };
  await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  $('settingsMsg').textContent = 'Saved ✓';
  setTimeout(() => ($('settingsMsg').textContent = ''), 2000);
  refreshApiStatus();
  loadFlights();
}

async function refreshApiStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const pill = $('apiStatus');
    pill.textContent = s.message || '—';
    pill.className = 'pill ' + (s.ok ? 'pill--ok' : s.ok === false ? 'pill--err' : '');
  } catch (_) {}
}

async function refreshLiveStatus() {
  try {
    const s = await (await fetch('/api/live')).json();
    const pill = $('oskyStatus');
    pill.textContent = s.message || '—';
    pill.className = 'pill ' + (s.ok ? 'pill--ok' : s.ok === false ? 'pill--err' : '');
  } catch (_) {}
}

async function pullNow() {
  $('apiStatus').textContent = 'Pulling…';
  await fetch('/api/pull', { method: 'POST' });
  refreshApiStatus();
  loadFlights();
}

/* ===================== Wire up ===================== */
fillStatusSelect();
$('addBtn').addEventListener('click', () => openFlight(''));
$('addSchedBtn').addEventListener('click', () => openSchedule(''));
$('cancelBtn').addEventListener('click', closeEditor);
$('saveFlight').addEventListener('click', saveModal);
$('saveSettings').addEventListener('click', saveSettings);
$('pullBtn').addEventListener('click', pullNow);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeEditor(); });

loadFlights();
loadSchedule();
loadConfig();
setInterval(loadFlights, 10000);
setInterval(refreshApiStatus, 15000);
setInterval(refreshLiveStatus, 15000);
