/* Donegal FIDS — live map (Leaflet + OpenSky feed) */

const map = L.map('map', { zoomControl: true, attributionControl: false })
  .setView([55.0442, -8.341], 7);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12 }).addTo(map);

const planeLayer = L.layerGroup().addTo(map);
const airportLayer = L.layerGroup().addTo(map);
let airportsDrawn = false;
let planeMarkers = {}; // icao24 -> marker

// isMatch = scheduled + matched, isPossible = unscheduled heading to EIDL
function planeIcon(track, isMatch, isPossible) {
  let cls = 'plane--other';
  if (isMatch) cls = 'plane--match';
  else if (isPossible) cls = 'plane--possible';
  return L.divIcon({
    className: `plane ${cls}`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<div style="transform:rotate(${track || 0}deg)">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2c.7 0 1.3.9 1.3 2v5.2l7.7 4.6v1.8l-7.7-2.4v4.3l2 1.4v1.3L12 20l-3.3 1.7v-1.3l2-1.4v-4.3L3 17.4v-1.8l7.7-4.6V4c0-1.1.6-2 1.3-2z"/>
      </svg></div>`
  });
}

function drawAirports(data) {
  if (airportsDrawn) return;
  const aps = data.airports || {};
  for (const [icao, a] of Object.entries(aps)) {
    L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: '<div class="ap-marker"></div>', iconSize: [10, 10] }) }).addTo(airportLayer);
    L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: `<div class="ap-label">${icao}</div>`, iconSize: [40, 14], iconAnchor: [-6, 7] }) }).addTo(airportLayer);
  }
  airportsDrawn = true;
}

function statusClass(s) { return 's-' + String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

/* ---------- Scheduled-flight cards ---------- */
function renderTracked(data) {
  const c = document.getElementById('tracked');
  const tracked = data.tracked || [];
  if (!tracked.length) {
    c.innerHTML = '<div class="empty">No tracked flights right now.<br>Aircraft appear when a flight is within its tracking window (≈90 min before).</div>';
    return;
  }
  c.innerHTML = '';
  for (const t of tracked) {
    const el = document.createElement('div');
    el.className = 'tcard';
    el.innerHTML = `
      <div class="tcard__top">
        <span class="tcard__no">${t.flightNo} <small style="color:var(--dim)">${t.callsign || ''}</small></span>
        <span class="tcard__stat ${statusClass(t.status)}">${t.status}</span>
      </div>
      <div class="tcard__row">
        ${t.eta ? `<span>ETA <b>${t.eta}</b></span>` : ''}
        <span>${t.distHomeKm} km out</span>
        ${t.speedKt != null ? `<span>${t.speedKt} kt</span>` : ''}
        ${t.altitudeM != null ? `<span><b>${Math.round(t.altitudeM * 3.281).toLocaleString()}</b> ft</span>` : ''}
        ${t.type === 'arrival' && t.departedOrigin ? '<span class="depart-tag">✈ departed origin</span>' : ''}
      </div>`;
    el.addEventListener('click', () => { if (t.lat) map.flyTo([t.lat, t.lon], 9); });
    c.appendChild(el);
  }
}

/* ---------- Unscheduled approaching cards ---------- */
function renderPossible(data) {
  const section = document.getElementById('possibleSection');
  const c = document.getElementById('possible');
  const possible = data.possible || [];

  if (!possible.length) {
    section.style.display = 'none';
    c.innerHTML = '';
    return;
  }

  section.style.display = '';
  c.innerHTML = '';
  for (const p of possible) {
    const el = document.createElement('div');
    el.className = 'pcard';
    el.innerHTML = `
      <div class="pcard__top">
        <span class="pcard__id">${p.callsign}</span>
        <span class="pcard__dist">${p.distHomeKm} km</span>
      </div>
      <div class="pcard__row">
        ${p.speedKt ? `<span>${p.speedKt} kt</span>` : ''}
        ${p.altitudeFt != null ? `<span>${p.altitudeFt.toLocaleString()} ft</span>` : ''}
      </div>`;
    el.addEventListener('click', () => { if (p.lat) map.flyTo([p.lat, p.lon], 10); });
    c.appendChild(el);
  }
}

/* ---------- Aircraft icons on map ---------- */
function renderPlanes(data) {
  planeLayer.clearLayers();
  planeMarkers = {};
  const matchedIcaos  = new Set((data.tracked  || []).map((t) => t.icao24));
  const possibleIcaos = new Set((data.possible || []).map((p) => p.icao24));

  for (const a of data.aircraft || []) {
    if (!a.lat || !a.lon) continue;
    const isMatch    = matchedIcaos.has(a.icao24);
    const isPossible = !isMatch && possibleIcaos.has(a.icao24);
    const zOff = isMatch ? 1000 : isPossible ? 500 : 0;
    const m = L.marker([a.lat, a.lon], { icon: planeIcon(a.track, isMatch, isPossible), zIndexOffset: zOff });
    m.bindPopup(
      `<b>${a.callsign || a.icao24}</b><br>` +
      `${a.onGround ? 'On ground' : Math.round((a.baroAltitude || 0) * 3.281).toLocaleString() + ' ft'}<br>` +
      `${a.velocity != null ? Math.round(a.velocity * 1.94384) + ' kt' : ''}` +
      (isPossible ? '<br><em style="color:#ffcf5c">⚠ Unscheduled — heading to EIDL</em>' : '')
    );
    m.addTo(planeLayer);
    planeMarkers[a.icao24] = m;
  }
}

function setStatus(data) {
  const dot = document.getElementById('liveDot');
  const msg = document.getElementById('statusMsg');
  dot.className = 'dot ' + (data.ok ? 'dot--live' : 'dot--err');
  msg.textContent = data.message || '—';
}

async function refresh() {
  try {
    const data = await (await fetch('/api/live', { cache: 'no-store' })).json();
    drawAirports(data);
    renderPlanes(data);
    renderTracked(data);
    renderPossible(data);
    setStatus(data);
  } catch (err) {
    setStatus({ ok: false, message: 'Connection error' });
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  document.getElementById('statusMsg').textContent = 'Refreshing…';
  await fetch('/api/track', { method: 'POST' });
  refresh();
});

// Force an immediate OpenSky poll when the map first opens,
// so you always see live aircraft without waiting for the next tick.
async function init() {
  await fetch('/api/track', { method: 'POST' }).catch(() => {});
  refresh();
  setInterval(refresh, 20000);
}
init();
