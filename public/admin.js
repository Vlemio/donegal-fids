/* Donegal FIDS — Control Panel */

const MANUAL_STATUSES = ['Scheduled', 'On Time', 'On Approach', 'Landed', 'Departed', 'Diverted', 'Cancelled'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = id => document.getElementById(id);

function slug(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '');
}

// ── Live board ────────────────────────────────────────────────────────────

async function loadFlights() {
  try {
    const { flights = [] } = await fetch('/api/flights', { cache: 'no-store' }).then(r => r.json());
    renderFlights('depList', flights.filter(f => f.type === 'departure'));
    renderFlights('arrList', flights.filter(f => f.type === 'arrival'));
    $('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('lastUpdate').textContent = 'Update failed';
  }
}

function buildStatusSelect(f) {
  const locked = !!(f.locks && f.locks.status);
  const isManual = locked && MANUAL_STATUSES.includes(f.status);
  const wrapSlug = isManual ? slug(f.status) : 'auto';

  // When status is auto-managed and not one of our 7, show what the engine has as a hint
  const hint = !isManual && f.status && !['Scheduled'].includes(f.status)
    ? `<span class="auto-hint">${f.status}</span>` : '';

  const options = [
    `<option value="__auto"${!isManual ? ' selected' : ''}>🔄 Auto</option>`,
    ...MANUAL_STATUSES.map(s =>
      `<option value="${s}"${isManual && f.status === s ? ' selected' : ''}>${s}</option>`
    )
  ].join('');

  return `<div class="status-wrap" data-slug="${wrapSlug}">
    <select class="status-sel" data-id="${f.id}">${options}</select>${hint}
  </div>`;
}

function renderFlights(listId, flights) {
  const c = $(listId);
  flights.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (!flights.length) { c.innerHTML = '<p class="empty">No flights today.</p>'; return; }

  c.innerHTML = flights.map(f => {
    const hasEst = f.estTime && f.estTime !== f.time;
    const timeHtml = hasEst
      ? `<span class="t-sched">${f.time}</span><span class="t-arrow">→</span><span class="t-est">${f.estTime}</span>`
      : `<span class="t-sched">${f.time || '--:--'}</span>`;

    return `<div class="fcard">
      <div class="fcard__time">${timeHtml}</div>
      <div class="fcard__info">
        <div class="fcard__no">${f.flightNo}</div>
        <div class="fcard__city">${f.city || ''}</div>
      </div>
      <div class="fcard__right">
        ${buildStatusSelect(f)}
        <label class="est-label">
          <span>Est.</span>
          <input class="est-input js-est" type="text" placeholder="--:--"
            value="${f.estTime || ''}" data-id="${f.id}" maxlength="5">
        </label>
      </div>
    </div>`;
  }).join('');

  // Status select
  c.querySelectorAll('.status-sel').forEach(sel => {
    const wrap = sel.closest('.status-wrap');
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const val = sel.value;
      if (val === '__auto') {
        await put(id, { locks: { status: false } });
        wrap.dataset.slug = 'auto';
      } else {
        await put(id, { status: val, locks: { status: true } });
        wrap.dataset.slug = slug(val);
      }
      setTimeout(loadFlights, 400);
    });
  });

  // Est time input
  c.querySelectorAll('.js-est').forEach(inp => {
    inp.addEventListener('change', () => put(inp.dataset.id, { estTime: inp.value.trim() || null }));
  });
}

async function put(id, body) {
  return fetch(`/api/flights/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ── Schedule ──────────────────────────────────────────────────────────────

async function loadSchedule() {
  const { recurring = [] } = await fetch('/api/schedule', { cache: 'no-store' }).then(r => r.json());
  recurring.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const emerald  = recurring.filter(s => (s.flightNo || '').startsWith('EI'));
  const loganair = recurring.filter(s => (s.flightNo || '').startsWith('LM'));
  const other    = recurring.filter(s => !s.flightNo?.startsWith('EI') && !s.flightNo?.startsWith('LM'));
  renderSched('schedEmerald',  [...emerald, ...other]);
  renderSched('schedLoganair', loganair);
}

function renderSched(listId, entries) {
  const c = $(listId);
  if (!entries.length) { c.innerHTML = '<p class="empty">No flights.</p>'; return; }
  c.innerHTML = entries.map(s => {
    const days = (s.days || []).map(d => DAY_LABELS[d]).join(' · ');
    const key  = s._id || `${s.type}|${s.flightNo}`;
    const dir  = s.type === 'arrival' ? '↓' : '↑';
    const dirClass = s.type === 'arrival' ? 'arr' : 'dep';
    return `<div class="scard">
      <div class="scard__dir scard__dir--${dirClass}">${dir}</div>
      <div class="scard__info">
        <div class="scard__no">${s.flightNo} <span class="scard__time">${s.time}</span></div>
        <div class="scard__days">${days || '—'}</div>
      </div>
      <div class="scard__actions">
        <button class="btn btn--sm" data-sedit="${key}">Edit</button>
        <button class="btn btn--sm btn--danger" data-sdel="${key}">✕</button>
      </div>
    </div>`;
  }).join('');
  c.querySelectorAll('[data-sedit]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.sedit)));
  c.querySelectorAll('[data-sdel]').forEach(b => b.addEventListener('click', () => delSched(b.dataset.sdel)));
}

async function delSched(key) {
  if (!confirm('Remove this flight from the timetable?')) return;
  await fetch(`/api/schedule/by-id/${encodeURIComponent(key)}`, { method: 'DELETE' });
  loadSchedule();
}

// ── Modal ─────────────────────────────────────────────────────────────────

async function openModal(key) {
  const { recurring = [] } = await fetch('/api/schedule', { cache: 'no-store' }).then(r => r.json());
  let s = { type: 'departure', airline: 'Aer Lingus', airlineCode: 'EI', days: [1,2,3,4,5] };
  if (key) s = recurring.find(x => x._id === key) || s;
  $('modalTitle').textContent = key ? 'Edit scheduled flight' : 'Add scheduled flight';
  $('f_id').value        = s._id || '';
  $('f_type').value      = s.type || 'departure';
  $('f_time').value      = s.time || '';
  $('f_flightNo').value  = s.flightNo || '';
  $('f_city').value      = s.city || '';
  $('f_airline').value   = s.airline || '';
  $('f_airlineCode').value = s.airlineCode || '';
  $('f_codeshare').value = (s.codeshare || []).join(', ');
  $('f_callsign').value  = s.callsign || '';
  buildDays(s.days || []);
  $('modal').hidden = false;
}

function buildDays(selected = []) {
  $('f_days').innerHTML = DAY_LABELS.map((d, i) =>
    `<label class="day-btn">
      <input type="checkbox" value="${i}"${selected.includes(i) ? ' checked' : ''}>
      <span>${d}</span>
    </label>`
  ).join('');
}

function readDays() {
  return [...$('f_days').querySelectorAll('input:checked')].map(c => +c.value);
}

function closeModal() { $('modal').hidden = true; }

async function saveSched() {
  const base = {
    type:        $('f_type').value,
    time:        $('f_time').value.trim(),
    flightNo:    $('f_flightNo').value.trim().toUpperCase(),
    city:        $('f_city').value.trim(),
    airline:     $('f_airline').value.trim(),
    airlineCode: $('f_airlineCode').value.trim().toUpperCase(),
    codeshare:   $('f_codeshare').value.split(',').map(s => s.trim()).filter(Boolean),
    callsign:    $('f_callsign').value.trim().toUpperCase(),
    days:        readDays(),
  };
  if (!base.flightNo) { alert('Flight number is required'); return; }
  const id = $('f_id').value;
  if (id) base._id = id;
  await fetch('/api/schedule', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base)
  });
  closeModal();
  loadSchedule();
  loadFlights();
}

// ── Wire up ───────────────────────────────────────────────────────────────

$('schedToggle').addEventListener('click', () => {
  const p = $('schedPanel');
  p.hidden = !p.hidden;
  $('schedArrow').textContent = p.hidden ? '▼' : '▲';
  if (!p.hidden) loadSchedule();
});

$('addSchedBtn').addEventListener('click', () => openModal(''));
$('modalClose').addEventListener('click',  closeModal);
$('modalCancel').addEventListener('click', closeModal);
$('saveSched').addEventListener('click',   saveSched);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });

loadFlights();
setInterval(loadFlights, 10000);
