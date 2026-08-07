/* Donegal FIDS — Staff Operator Panel */

const DEP_STATUSES = [
  { label: 'On Time',    value: 'On Time' },
  { label: 'Boarding',   value: 'Boarding' },
  { label: 'Final Call', value: 'Final Call' },
  { label: 'Gate Closed',value: 'Gate Closed' },
  { label: 'Delayed',    value: 'Delayed' },
  { label: 'Departed',   value: 'Departed' },
  { label: 'Cancelled',  value: 'Cancelled' },
];

const ARR_STATUSES = [
  { label: 'On Time',     value: 'On Time' },
  { label: 'Delayed',     value: 'Delayed' },
  { label: 'On Approach', value: 'On Approach' },
  { label: 'Landed',      value: 'Landed' },
  { label: 'Diverted',    value: 'Diverted' },
  { label: 'Cancelled',   value: 'Cancelled' },
];

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let flights  = [];
let schedule = [];

/* ── Clock ──────────────────────────────────────────────── */
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin'
  });
}
setInterval(updateClock, 1000);
updateClock();

/* ── Data ───────────────────────────────────────────────── */
async function loadAll() {
  const [fd, sd] = await Promise.all([
    fetch('/api/flights',  { cache: 'no-store' }).then(r => r.json()).catch(() => ({ flights: [] })),
    fetch('/api/schedule', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ recurring: [] }))
  ]);
  flights  = fd.flights  || [];
  schedule = sd.recurring || [];
  render();
}

/* ── Today's DOW (Dublin time) ──────────────────────────── */
function localDow() {
  const day = new Date().toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Dublin' });
  return DOW_MAP[day] ?? new Date().getDay();
}

/* ── Render ─────────────────────────────────────────────── */
function render() {
  const deps = flights.filter(f => f.type === 'departure').sort((a, b) => (a.time||'').localeCompare(b.time||''));
  const arrs = flights.filter(f => f.type === 'arrival').sort((a, b) => (a.time||'').localeCompare(b.time||''));

  renderList(document.getElementById('depList'), deps, DEP_STATUSES);
  renderList(document.getElementById('arrList'), arrs, ARR_STATUSES);
  renderQuickAdd();
  updateModePill();
}

function renderList(container, list, statuses) {
  if (!list.length) { container.innerHTML = '<div class="empty">No flights on board.</div>'; return; }
  container.innerHTML = '';
  for (const f of list) container.appendChild(buildCard(f, statuses));
}

/* ── Flight card ─────────────────────────────────────────── */
function buildCard(f, statuses) {
  const manual = !!(f.locks && f.locks.status);
  const card = document.createElement('div');
  card.className = 'fcard' + (manual ? ' fcard--manual' : '');

  let estHtml = '';
  if (f.estTime && f.estTime !== f.time) {
    estHtml = `<div class="fcard__time-est">Est ${f.estTime}</div>`;
  }

  let footer = '';
  if (manual) {
    const btns = statuses.map(s => {
      const active = s.value === f.status ? ' st--active' : '';
      return `<button class="st st--${sk(s.value)}${active}" data-status="${s.value}">${s.label}</button>`;
    }).join('');

    footer = `
      <div class="fcard__statuses">${btns}</div>
      <div class="fcard__est-row">
        <span class="fcard__est-label">Estimated</span>
        <input class="est-input" type="text" value="${f.estTime || ''}" placeholder="--:--" maxlength="5" inputmode="numeric" />
        <button class="btn-est-set">Set</button>
        <button class="btn-est-clear">Clear</button>
      </div>
      <div class="fcard__man-foot">
        <button class="btn-release">↺ Return to automatic</button>
        <button class="btn-remove" data-confirm="0">Remove from board</button>
      </div>`;
  } else {
    footer = `
      <div class="fcard__auto-foot">
        <button class="btn-take">Take manual control</button>
        <button class="btn-remove" data-confirm="0">Remove from board</button>
      </div>`;
  }

  card.innerHTML = `
    <div class="fcard__info">
      <div class="fcard__time">${f.time || '--:--'}${estHtml}</div>
      <div class="fcard__details">
        <div class="fcard__no">${f.flightNo}</div>
        <div class="fcard__city">${f.city || ''}</div>
        <div class="fcard__al">${f.airline || ''}</div>
      </div>
      <div class="fcard__badges">
        <span class="sbadge sbadge--${sk(f.status)}">${f.status}</span>
        <span class="mbadge mbadge--${manual ? 'manual' : 'auto'}">${manual ? 'MANUAL' : 'AUTO'}</span>
      </div>
    </div>
    ${footer}`;

  if (manual) {
    card.querySelectorAll('.st').forEach(btn =>
      btn.addEventListener('click', () => applyStatus(f, btn.dataset.status))
    );
    const estInput = card.querySelector('.est-input');
    maskTime(estInput);
    card.querySelector('.btn-est-set').addEventListener('click', () => {
      if (estInput.value) applyEstTime(f, estInput.value);
    });
    card.querySelector('.btn-est-clear').addEventListener('click', () => applyEstTime(f, null));
    card.querySelector('.btn-release').addEventListener('click', () => releaseAuto(f));
  } else {
    card.querySelector('.btn-take').addEventListener('click', () => takeControl(f));
  }

  wireRemoveBtn(card.querySelector('.btn-remove'), f);

  return card;
}

/* ── Quick Add ───────────────────────────────────────────── */
function renderQuickAdd() {
  const dow = localDow();
  const boardIds = new Set(flights.map(f => f.id));

  const todaySchedule = schedule
    .filter(s => Array.isArray(s.days) && s.days.includes(dow))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const missing = todaySchedule.filter(s => {
    const id = (s.type === 'arrival' ? 'ARR-' : 'DEP-') + (s.flightNo || '').toUpperCase();
    return !boardIds.has(id);
  });

  const container = document.getElementById('qaList');
  if (!missing.length) {
    container.innerHTML = '<p class="qa-all-ok">✓ All scheduled flights are on the board.</p>';
    return;
  }

  container.innerHTML = '';
  for (const s of missing) {
    const tile = document.createElement('button');
    tile.className = 'qa-tile';
    const arrow = s.type === 'arrival' ? '↓' : '↑';
    tile.innerHTML = `
      <div class="qa-tile__meta">${arrow} ${s.type === 'arrival' ? 'ARR' : 'DEP'}</div>
      <div class="qa-tile__time">${s.time || '--:--'}</div>
      <div class="qa-tile__main">
        <div class="qa-tile__no">${s.flightNo}</div>
        <div class="qa-tile__city">${s.city || ''} · ${s.airline || ''}</div>
      </div>
      <div class="qa-tile__add">+ Add to board</div>`;
    tile.addEventListener('click', () => addFromSchedule(s, tile));
    container.appendChild(tile);
  }
}

async function addFromSchedule(s, tileEl) {
  tileEl.disabled = true;
  tileEl.querySelector('.qa-tile__add').textContent = 'Adding…';
  const id = (s.type === 'arrival' ? 'ARR-' : 'DEP-') + (s.flightNo || '').toUpperCase();
  await fetch('/api/flights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...s, id, status: 'Scheduled', source: 'manual', locks: {} })
  });
  await loadAll();
}

/* ── Actions ─────────────────────────────────────────────── */
async function applyStatus(f, status) {
  const updated = { ...f, status, locks: { ...f.locks, status: true } };
  optimistic(f.id, updated);
  await putFlight(f.id, { status, locks: { status: true } });
}

async function applyEstTime(f, estTime) {
  const updated = { ...f, estTime: estTime || null, locks: { ...f.locks, status: true } };
  optimistic(f.id, updated);
  await putFlight(f.id, { estTime: estTime || null });
}

async function takeControl(f) {
  const updated = { ...f, locks: { ...f.locks, status: true } };
  optimistic(f.id, updated);
  await putFlight(f.id, { locks: { status: true } });
}

async function releaseAuto(f) {
  const updated = { ...f, locks: { ...f.locks, status: false } };
  optimistic(f.id, updated);
  await putFlight(f.id, { locks: { status: false } });
}

async function releaseAll() {
  const locked = flights.filter(f => f.locks && f.locks.status);
  if (!locked.length) return;
  for (const f of locked) optimistic(f.id, { ...f, locks: { ...f.locks, status: false } });
  render();
  await Promise.all(locked.map(f => putFlight(f.id, { locks: { status: false } })));
  await loadAll();
}

async function removeFlight(f) {
  if (f.source === 'manual') {
    await fetch(`/api/flights/${f.id}`, { method: 'DELETE' });
  } else {
    await fetch(`/api/flights/${f.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suppressed: true })
    });
  }
  flights = flights.filter(fl => fl.id !== f.id);
  render();
  await loadAll();
}

function wireRemoveBtn(btn, f) {
  if (!btn) return;
  let timer = null;
  btn.addEventListener('click', () => {
    if (btn.dataset.confirm === '1') {
      clearTimeout(timer);
      removeFlight(f);
    } else {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm remove?';
      btn.classList.add('btn-remove--confirm');
      timer = setTimeout(() => {
        btn.dataset.confirm = '0';
        btn.textContent = 'Remove from board';
        btn.classList.remove('btn-remove--confirm');
      }, 5000);
    }
  });
}

function optimistic(id, updated) {
  const idx = flights.findIndex(f => f.id === id);
  if (idx !== -1) { flights[idx] = updated; render(); }
}

async function putFlight(id, patch) {
  await fetch(`/api/flights/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
}

/* ── Mode pill ───────────────────────────────────────────── */
function updateModePill() {
  const n = flights.filter(f => f.locks && f.locks.status).length;
  const pill = document.getElementById('modePill');
  pill.textContent = n === 0 ? '● ALL AUTO' : `⚠ ${n} MANUAL`;
  pill.className = 'mode-pill' + (n > 0 ? ' mode-pill--manual' : '');
}

function sk(s) { return String(s).toLowerCase().replace(/\s+/g, ''); }

/* Auto-format time input: digits only, inserts ':' after 2nd digit */
function maskTime(el) {
  el.addEventListener('input', function () {
    const digits = this.value.replace(/\D/g, '').slice(0, 4);
    this.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
  });
}

/* ── Custom add form ─────────────────────────────────────── */
const ALL_STATUSES = [
  'Scheduled', 'On Time', 'Check-in', 'Boarding', 'Final Call',
  'Gate Closed', 'Departed', 'On Approach', 'Delayed',
  'Landed', 'Cancelled', 'Diverted'
];

/* ── Custom add form ─────────────────────────────────────── */
(function initCustomForm() {
  const toggle    = document.getElementById('customToggle');
  const form      = document.getElementById('customForm');
  const statusSel = document.getElementById('cf_status');
  const apCustom  = document.getElementById('apCustom');
  const apOther   = document.getElementById('apOther');

  statusSel.innerHTML = ALL_STATUSES.map(s => `<option value="${s}">${s}</option>`).join('');
  maskTime(document.getElementById('cf_time'));

  // Airline quick-pick buttons
  let pickedAirline = '';
  let pickedCode    = '';

  document.getElementById('apPicks').querySelectorAll('.ap-btn[data-name]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ap-btn').forEach(b => b.classList.remove('ap-btn--active'));
      btn.classList.add('ap-btn--active');
      pickedAirline = btn.dataset.name;
      pickedCode    = btn.dataset.code;
      apCustom.hidden = true;
    });
  });

  apOther.addEventListener('click', () => {
    document.querySelectorAll('.ap-btn').forEach(b => b.classList.remove('ap-btn--active'));
    apOther.classList.add('ap-btn--active');
    pickedAirline = '';
    pickedCode    = '';
    apCustom.hidden = false;
    document.getElementById('cf_airline').focus();
  });

  function resetPicker() {
    document.querySelectorAll('.ap-btn').forEach(b => b.classList.remove('ap-btn--active'));
    apCustom.hidden = true;
    pickedAirline = '';
    pickedCode    = '';
    if (document.getElementById('cf_airline')) document.getElementById('cf_airline').value = '';
    if (document.getElementById('cf_code'))    document.getElementById('cf_code').value    = '';
  }

  function closeForm() {
    form.hidden = true;
    toggle.textContent = '＋ Add custom flight';
    toggle.className = 'custom-add__toggle';
    resetPicker();
  }

  toggle.addEventListener('click', () => {
    const open = !form.hidden;
    form.hidden = open;
    toggle.textContent = open ? '＋ Add custom flight' : '✕ Close';
    toggle.className = 'custom-add__toggle' + (open ? '' : ' custom-add__toggle--open');
    if (open) resetPicker();
  });

  document.getElementById('cfCancelBtn').addEventListener('click', closeForm);

  document.getElementById('cfAddBtn').addEventListener('click', async () => {
    const flightNo = document.getElementById('cf_no').value.trim().toUpperCase();
    const time     = document.getElementById('cf_time').value;
    if (!flightNo || !time) { alert('Flight number and time are required.'); return; }

    // Use quick-pick values, or fall back to the free-text inputs
    const airline     = pickedAirline || (document.getElementById('cf_airline')?.value.trim() ?? '');
    const airlineCode = pickedCode    || (document.getElementById('cf_code')?.value.trim().toUpperCase() ?? flightNo.slice(0, 2));
    const type        = document.getElementById('cf_type').value;
    const city        = document.getElementById('cf_city').value.trim();
    const status      = statusSel.value;
    const id          = (type === 'arrival' ? 'ARR-' : 'DEP-') + flightNo;

    await fetch('/api/flights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type, flightNo, time, city, airline, airlineCode, status, source: 'manual', locks: { status: true } })
    });

    ['cf_no', 'cf_time', 'cf_city'].forEach(fid => { const el = document.getElementById(fid); if (el) el.value = ''; });
    statusSel.value = 'Scheduled';
    closeForm();
    await loadAll();
  });
})();

/* ── Wire up ─────────────────────────────────────────────── */
document.getElementById('allAutoBtn').addEventListener('click', releaseAll);

loadAll();
setInterval(loadAll, 10_000);
