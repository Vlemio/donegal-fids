// Pushes the current flight board straight to a secret GitHub Gist.
//
// One-way only: this project never receives inbound connections for this.
// It PATCHes its own gist (websiteSync.gistId), authenticated with a
// fine-grained GitHub token scoped ONLY to "Gist: Read and write"
// (websiteSync.gistToken in config.json) — that token can't touch real
// repos even if it ever leaked from a kiosk PC. The airport website reads
// that same gist back (unauthenticated, since gist reads don't need a
// token) and re-serves it same-origin — see the website's
// src/lib/flightsStore.ts.
//
// This can run from anywhere — this laptop today, the airport PC later —
// without ever opening a port or exposing the admin panel.
const store = require('./store');

function publicShape(flight) {
  return {
    id: flight.id,
    type: flight.type,
    time: flight.time,
    estTime: flight.estTime,
    estLate: !!flight.estLate,
    estVeryLate: !!flight.estVeryLate,
    airline: flight.airline,
    airlineCode: flight.airlineCode,
    city: flight.city,
    flightNo: flight.flightNo,
    codeshare: flight.codeshare || [],
    status: flight.status,
  };
}

async function syncTick(cfg) {
  const ws = cfg.websiteSync;
  if (!ws || !ws.enabled) {
    return { ok: false, message: 'sync disabled' };
  }
  if (!ws.gistId || !ws.gistToken || ws.gistToken === 'PASTE_YOUR_GITHUB_PAT_HERE') {
    return { ok: false, message: 'sync missing gistId/gistToken in config.json' };
  }

  const data = store.read();
  const flights = data.flights.filter((f) => !f.suppressed).map(publicShape);
  const payload = { updated: new Date().toISOString(), flights };

  try {
    const res = await fetch(`https://api.github.com/gists/${ws.gistId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${ws.gistToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'donegal-fids-sync',
      },
      body: JSON.stringify({ files: { 'flights.json': { content: JSON.stringify(payload) } } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text}`.trim());
    }
    return { ok: true, message: `synced ${flights.length} flights to gist` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { syncTick };
