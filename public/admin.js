/* Donegal FIDS — Control Panel */

const DEP_STATUSES = ['Go Scheduled', 'On Time', 'Go to Security', 'Departed', 'Cancelled'];
const ARR_STATUSES = ['Scheduled', 'On Time', 'On Approach', 'Landed', 'Diverted', 'Cancelled'];
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
  const statuses = f.type === 'departure' ? DEP_STATUSES : ARR_STATUSES;
  const locked   = !!(f.locks && f.locks.status);
  const isManual = locked && statuses.includes(f.status);
  const wrapSlug = isManual ? slug(f.status) : 'auto';

  const hint = !isManual && f.status && !['Scheduled', 'Go Scheduled'].includes(f.status)
    ? `<span class="auto-hint">${f.status}</span>` : '';

  const options = [
    `<option value="__auto"${!isManual ? ' selected' : ''}>🔄 Auto</option>`,
    ...statuses.map(s =>
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
        const body = { status: val, locks: { status: true } };
        if (['Cancelled', 'Diverted'].includes(val)) {
          body.estTime = null;
          const card = sel.closest('.fcard');
          if (card) { const inp = card.querySelector('.js-est'); if (inp) inp.value = ''; }
        }
        await put(id, body);
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
  const emerald  = recurring.filter(s => (s.flightNo || '').startsWith('EI'));
  const loganair = recurring.filter(s => (s.flightNo || '').startsWith('LM'));
  const other    = recurring.filter(s => !s.flightNo?.startsWith('EI') && !s.flightNo?.startsWith('LM'));

  $('schedContent').innerHTML =
    renderAirlineSection('🟢 Emerald Airlines', 'EI', [...emerald, ...other]) +
    renderAirlineSection('🔵 Loganair',          'LM', loganair);
}

function getDayLabel(days) {
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return 'Every day';
  if (s.length === 5 && !s.includes(0) && !s.includes(6)) return 'Mon – Fri';
  if (s.length === 2 && s.includes(0) && s.includes(6)) return 'Weekends';
  return s.map(d => DAY_LABELS[d]).join(' · ');
}

function schedCard(entry) {
  const key = entry._id || `${entry.type}|${entry.flightNo}`;
  const dir = entry.type === 'arrival' ? '↓' : '↑';
  const dirClass = entry.type === 'arrival' ? 'arr' : 'dep';
  return `<div class="scard">
    <div class="scard__dir scard__dir--${dirClass}">${dir}</div>
    <div class="scard__info">
      <div class="scard__no">${entry.flightNo} <span class="scard__time">${entry.time}</span></div>
      ${entry.city ? `<div class="scard__days">${entry.city}</div>` : ''}
    </div>
    <div class="scard__actions">
      <button class="btn btn--sm js-sedit" data-key="${key}">Edit</button>
      <button class="btn btn--sm btn--danger js-sdel" data-key="${key}">✕</button>
    </div>
  </div>`;
}

function renderAirlineSection(title, code, entries) {
  let bodyHTML = '';

  if (!entries.length) {
    bodyHTML = '<p class="empty">No flights.</p>';
  } else {
    const patternKey = e => (e.days || []).slice().sort((a, b) => a - b).join(',');
    const patterns = new Set(entries.map(patternKey));

    if (patterns.size === 1) {
      // All entries share the same day pattern — one group
      const label = getDayLabel(entries[0].days || []);
      const sorted = [...entries].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      bodyHTML = `<div class="day-group">
        <div class="day-group__label">${label}</div>
        ${sorted.map(schedCard).join('')}
      </div>`;
    } else {
      // Multiple patterns — group by individual day
      const byDay = {};
      for (const e of entries) {
        for (const d of (e.days || [])) {
          if (!byDay[d]) byDay[d] = [];
          if (!byDay[d].some(x => x._id && x._id === e._id)) byDay[d].push(e);
        }
      }
      for (const d of [0, 1, 2, 3, 4, 5, 6]) {
        if (!byDay[d]?.length) continue;
        const sorted = [...byDay[d]].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        bodyHTML += `<div class="day-group">
          <div class="day-group__label">${DAY_LABELS[d]}</div>
          ${sorted.map(schedCard).join('')}
        </div>`;
      }
    }
  }

  return `<div class="airline-section">
    <div class="airline-section__head">
      <span class="airline-section__name">${title}</span>
      <button class="btn btn--sm btn--outline js-add-sched" data-code="${code}">+ Add flight</button>
    </div>
    <div class="airline-section__body">${bodyHTML}</div>
  </div>`;
}

async function delSched(key) {
  if (!confirm('Remove this flight from the timetable?')) return;
  await fetch(`/api/schedule/by-id/${encodeURIComponent(key)}`, { method: 'DELETE' });
  loadSchedule();
}

// ── Modal ─────────────────────────────────────────────────────────────────

function clearErrors() {
  document.querySelectorAll('.field--error').forEach(f => f.classList.remove('field--error'));
  $('callsignWarn').style.display = 'none';
}

const PLACEHOLDERS = {
  LM: { flightNo: 'LM203', city: 'Glasgow',   airline: 'Loganair',  airlineCode: 'LM', callsign: 'LOG203'  },
  EI: { flightNo: 'EI3401', city: 'Dublin',   airline: 'Aer Lingus', airlineCode: 'EI', callsign: 'EAI3402' },
};

async function checkFlightDetection(recurring) {
  const flightNo = $('f_flightNo').value.trim().toUpperCase();
  const callsign = $('f_callsign').value.trim().toUpperCase();
  if (!flightNo && !callsign) { $('callsignWarn').style.display = 'none'; return; }
  const known = recurring.some(r =>
    (r.flightNo  && r.flightNo.toUpperCase()  === flightNo)  ||
    (r.callsign  && r.callsign.toUpperCase()  === callsign)
  );
  $('callsignWarn').style.display = known ? 'none' : '';
}

async function openModal(key, defaults = {}) {
  clearErrors();
  const { recurring = [] } = await fetch('/api/schedule', { cache: 'no-store' }).then(r => r.json());
  const ph = PLACEHOLDERS[defaults.code] || PLACEHOLDERS.EI;

  let s = {
    type: 'departure',
    airline: ph.airline,
    airlineCode: ph.airlineCode,
    days: []
  };
  if (key) s = recurring.find(x => x._id === key) || s;

  $('modalTitle').textContent = key ? 'Edit scheduled flight' : 'Add scheduled flight';
  $('f_id').value          = s._id || '';
  $('f_type').value        = s.type || 'departure';
  $('f_time').value        = s.time || '';
  $('f_flightNo').value    = s.flightNo || '';
  $('f_city').value        = s.city || '';
  $('f_airline').value     = s.airline || '';
  $('f_airlineCode').value = s.airlineCode || '';
  $('f_codeshare').value   = (s.codeshare || []).join(', ');
  $('f_callsign').value    = s.callsign || '';
  buildDays(s.days || []);

  // Update placeholders to match airline context
  $('f_flightNo').placeholder    = ph.flightNo;
  $('f_city').placeholder        = ph.city;
  $('f_airline').placeholder     = ph.airline;
  $('f_airlineCode').placeholder = ph.airlineCode;
  $('f_callsign').placeholder    = ph.callsign;

  // Detect unknown flights on blur
  const onCheck = () => checkFlightDetection(recurring);
  ['f_flightNo', 'f_callsign'].forEach(id => {
    const el = $(id);
    el.removeEventListener('blur', el._detectCheck);
    el._detectCheck = onCheck;
    el.addEventListener('blur', onCheck);
  });

  $('modal').classList.add('is-open');
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

function closeModal() { $('modal').classList.remove('is-open'); }

async function saveSched() {
  clearErrors();
  let ok = true;

  const require = id => {
    if (!$(id).value.trim()) {
      $(id).closest('.field').classList.add('field--error');
      ok = false;
    }
  };
  require('f_time');
  require('f_flightNo');
  require('f_city');
  require('f_airline');
  require('f_airlineCode');

  const days = readDays();
  if (days.length === 0) { $('fDaysWrap').classList.add('field--error'); ok = false; }

  if (!ok) return;

  const base = {
    type:        $('f_type').value,
    time:        $('f_time').value.trim(),
    flightNo:    $('f_flightNo').value.trim().toUpperCase(),
    city:        $('f_city').value.trim(),
    airline:     $('f_airline').value.trim(),
    airlineCode: $('f_airlineCode').value.trim().toUpperCase(),
    codeshare:   $('f_codeshare').value.split(',').map(s => s.trim()).filter(Boolean),
    callsign:    $('f_callsign').value.trim().toUpperCase(),
    days,
  };
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

// Event delegation for dynamically rendered schedule buttons
$('schedContent').addEventListener('click', e => {
  const editBtn = e.target.closest('.js-sedit');
  const delBtn  = e.target.closest('.js-sdel');
  const addBtn  = e.target.closest('.js-add-sched');
  if (editBtn) openModal(editBtn.dataset.key);
  if (delBtn)  delSched(delBtn.dataset.key);
  if (addBtn)  openModal('', { code: addBtn.dataset.code });
});

// Modal close — X, Cancel, backdrop click, Escape
document.querySelectorAll('#modalClose, #modalCancel').forEach(el => el.addEventListener('click', closeModal));
$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

$('saveSched').addEventListener('click', saveSched);

loadFlights();
setInterval(loadFlights, 10000);
