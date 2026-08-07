# Donegal FIDS · Flight Information Display System

A modern, self-updating flight board for **Donegal Airport (Aerfort Dhún na nGall)**.

- **Display** (`/`) — the fullscreen board for the screen in the terminal.
- **Control panel** (`/admin`) — where staff add/edit flights and turn automation on/off.
- **Hybrid data** — pulls flight data from an API *and* lets staff override anything by hand.

---

## Quick start (your laptop)

You need [Node.js 18+](https://nodejs.org) installed (one-time).

```powershell
cd C:\Users\jjgar\Desktop\donegal-fids
npm install        # first time only
npm start
```

Then open:

- Display: <http://localhost:8080/>
- Control panel: <http://localhost:8080/admin>

Out of the box it runs in **manual mode** — no API key needed. The board already
shows today's flights from `data/flights.json`.

---

## Self-updating for FREE (no API needed) — recommended

Donegal's flights repeat, so the board updates itself with **zero cost**:

1. **Recurring timetable** — in the control panel, *Recurring timetable → Add*.
   Set the flight, time and operating days. From then on the board fills itself
   every matching day.
2. **Auto status by clock** — flights move on their own:
   `Scheduled → Boarding → Departed` (departures) and
   `Scheduled → Approaching → Landed` (arrivals), using the scheduled time.
3. **Auto cleanup** — finished flights drop off after a configurable delay.
4. **Manual always wins** — for a delay/cancellation just edit the flight and
   tick **"Lock status (manual)"**. The auto engine will leave it exactly as you
   set it. Untick to hand it back to the engine.

Settings: *Automation & settings* → toggle auto-fill / auto-status, set the
"Boarding shows X min before" lead, and the cleanup delay.

> This is the recommended mode for Donegal: free, offline, and reliable. You only
> ever touch exceptions (delays), which staff know before any API would anyway.

## Live tracking + map (FREE, OpenSky / ADS-B)

Real aircraft tracking using the free [OpenSky Network](https://opensky-network.org):

- **Real delays** — ETA is computed from the aircraft's live position and speed; if
  it's running later than scheduled, the board shows an estimated time.
- **"Has it left Dublin yet?"** — once the inbound is airborne it shows *En Route*
  and an "✈ departed origin" tag; *Approaching* when it's near Donegal; *Landed*
  when it's on the ground here.
- **Live map** at `/map` — every aircraft over Ireland, with your flights
  highlighted, plus speed/altitude/ETA.

### Setup
1. Control panel → *Live tracking · OpenSky* → tick **Track real aircraft**.
2. For each timetable flight, set its **ADS-B callsign** (e.g. `EAI3402`) so it
   matches reliably. (Open `/map` near a flight time to read the callsign off the
   real aircraft, then paste it into the timetable.)
3. Works **anonymously** out of the box. For higher daily limits, create a free
   OpenSky account → API client, and paste the Client ID/Secret in settings.

> **Smart polling:** the tracker only calls OpenSky when a flight is within its
> window (≈90 min before until 30 min after), so it stays comfortably inside the
> free limits even anonymously.

## Optional paid mode — flight API

> Note: the airport's Flightradar24 **Contributor** plan does **not** include API
> access (FR24's API is a separate paid product). A budget option is AeroDataBox.

1. In the **control panel** tick *"Auto-update from flight API"*, paste your
   AeroDataBox key, and save.
2. The server polls the API every *N* seconds and merges results into the board.
3. **Manual always wins where it matters.** Any flight you create by hand stays.
   Use *Edit* to fix a value; if you want the API to stop overwriting a field,
   that flight is tagged `manual` and protected.
4. *"Pull now"* forces an immediate refresh.

### Getting an API key (AeroDataBox via RapidAPI)

1. Sign up at <https://rapidapi.com/aedbx-aedbx/api/aerodatabox>
2. Subscribe (there is a low-cost / limited-free tier).
3. Copy your **X-RapidAPI-Key** and paste it into the control panel.

> Donegal is a small airport — if the API returns little or nothing, just keep
> using manual mode. The adapter lives in `src/apiAdapter.js` and can be swapped
> for another provider without touching the rest of the app.

---

## Migrating to the airport PC

The whole thing is one folder. Two options:

### Option A — install Node on the airport PC
1. Install Node.js 18+.
2. Copy the `donegal-fids` folder over.
3. `npm install` then `npm start`.
4. Open `http://localhost:8080/` fullscreen (F11) on the display.

### Option B — single .exe, no Node needed (recommended for the kiosk)
On your laptop, build a standalone executable:

```powershell
npm install
npx pkg . --targets node18-win-x64 --output donegal-fids.exe
```

Then copy `donegal-fids.exe`, the `public/`, `data/` and `config.json` next to it
to the airport PC and double-click the `.exe`. No Node install required there.

### Auto-start on boot (kiosk)
- Put a shortcut to `npm start` (or the `.exe`) in the Windows *Startup* folder
  (`shell:startup`).
- Launch the browser in kiosk mode pointing at the display, e.g.:
  ```
  msedge --kiosk http://localhost:8080/ --edge-kiosk-type=fullscreen
  ```

---

## Files

```
donegal-fids/
  server.js            Express server + API polling
  config.json          airport, API key, intervals, footer notice
  data/flights.json    current board (auto-saved)
  src/
    store.js           read/write + merge logic (manual vs API)
    apiAdapter.js      AeroDataBox → internal model (swappable)
  public/
    index.html/.css/.js   the display board
    admin.html/.css/.js   the control panel
```
