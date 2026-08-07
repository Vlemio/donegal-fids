# Donegal FIDS — Estado de sesión (2026-06-02, ~19:30 IST)

## Arrancar
```
cd C:\Users\jjgar\Desktop\donegal-fids
npm start
```
Display: http://localhost:8080/ | Admin: http://localhost:8080/admin | Mapa: http://localhost:8080/map

---

## Callsigns Emerald Airlines (Aer Lingus Regional)
Patrón: EAI + 2 dígitos del medio + D

| Vuelo  | Tipo | Callsign |
|--------|------|----------|
| EI3401 | DEP  | EAI41D   |
| EI3402 | ARR  | EAI42D   |
| EI3403 | DEP  | EAI43D   |
| EI3408 | ARR  | EAI48D   |

Configurados en schedule.json y en vuelos del día. matchState los encuentra directamente.

---

## Flujo de estados

SALIDAS: Scheduled -> On Time (t-120) -> Departed (ADS-B >500ft o reloj en t)
- Sin Boarding automatico
- ADS-B: Delayed si sigue en tierra en Donegal pasada la hora
- ADS-B: Departed solo cuando baroAltitude > 152m (500ft)

LLEGADAS: Scheduled -> On Time (t-120) -> Delayed (t+5 sin ADS-B)
- ADS-B: Departed (salio Dublin) -> On Approach (ETA<10min) -> Landed
- ETA siempre visible en tablero cuando Departed/On Approach (ambar -> HH:MM)
- ETA rojo solo si >10min de retraso

---

## Limpieza automatica (scheduler.js)
- Salidas Departed: eliminadas a t+120min (2 horas)
- Llegadas Landed: eliminadas a t+30min (removeAfterMin)
- Llegadas Delayed stuck: eliminadas a t+90min

---

## Matching ADS-B (tracker.js)

matchState — orden de prioridad:
1. Callsign exacto (cs.includes(want))
2. ICAO24 directo (want.toLowerCase() === icao24)
3. Digit fallback (fnDigits en cs, >=3 digitos)
4. Anti-duplicado: mismo ICAO24 no se asigna a 2 vuelos

Proximity fallback:
- SALIDAS (status != Departed/Cancelled):
  findDepartureCandidate — MAX_KM=220, ALT<5000m, HDG+-65 hacia destino
- LLEGADAS (status != Landed/Cancelled):
  findArrivalCandidate — MAX_KM=120, transatlantic filter, HDG+-50 hacia EIDL

Valvulas de seguridad:
- Llegada stuck Departed >45min -> f.live=null -> reloj pone Delayed
- Vuelos Delayed -> ventana ADS-B siempre abierta (isActiveWindow)
- Background idle poll cada 5min fuera de ventana

Unscheduled (findPossibleArrivals):
- MAX_KM=120, filtro transatlantico (>7500m sin descenso activo)
- Aparecen en naranja en mapa "v Approaching EIDL"

---

## Colores tablero
- Scheduled: gris
- On Time: verde
- Departed (llegadas y salidas): azul #4db8ff
- On Approach: ambar + pulso
- Landed: verde
- Delayed: ambar
- ETA puntual: ambar-soft "-> HH:MM"
- ETA retrasado: rojo "Est HH:MM"

---

## Archivos modificados esta sesion

src/scheduler.js:
- Safety valve: llegada Departed >t+45 -> f.live=null
- Llegadas: NUNCA On Approach por reloj (solo ADS-B)
- Grace period t+5 para Delayed (llegadas)
- depKeep=120min, arrKeep=30min, Delayed stuck -> t+90

src/tracker.js:
- matchState: strip spaces, ICAO24 direct, anti-duplicado
- findDepartureCandidate (nuevo, proximity salidas, MAX_KM=220)
- findArrivalCandidate (nuevo, proximity llegadas, MAX_KM=120)
- track(): matchedIcao anti-duplicado en todo el loop
- Departure: Delayed si en tierra pasada hora; Departed solo >500ft
- isActiveWindow: Delayed siempre en ventana
- estTime visible siempre en Departed/On Approach; estLate boolean

public/board.css:
- --blue: #4db8ff
- Departed: azul (ambos paneles)
- .est ambar-soft; .est--late rojo

public/board.js:
- "-> HH:MM" (ambar) vs "Est HH:MM" (rojo si late)

server.js:
- GET /api/debug/icao/:icao24 anadido

data/schedule.json:
- Callsigns EAI41D/42D/43D/48D configurados

---

## Estado actual (19:30 IST)
- ARR-EI3408: Departed | EAI48D matched | ~101km de Donegal
- Resto: fuera de ventana o limpiados

## Pendiente
- Verificar Landed + limpieza de EI3408 esta noche
- Verificar EI3401/3403 manana con callsigns reales
- Migracion PC aeropuerto: npx pkg . --targets node18-win-x64
- Auto-start: shell:startup + msedge --kiosk http://localhost:8080/
- Cuenta OpenSky gratuita para mayor cuota
