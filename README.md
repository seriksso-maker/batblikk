# Båtblikk

Live kart over båttrafikk i norske farvann, med data fra Kystverkets åpne AIS-strøm (lisens NLOD).

- `src/worker.js`: Cloudflare Worker. En Durable Object holder TCP-tilkoblingen til Kystverket (`153.44.253.27:5631`) åpen hele tiden, husker siste posisjon per båt og lagrer navn og båttype i SQLite.
- `src/ais.js`: AIS-dekoder (posisjon fra type 1, 2, 3, 18, 19, og navn, type og destinasjon fra type 5 og 24).
- `public/`: kartet (Leaflet + OpenStreetMap). Det henter `/api/ships` hvert 5. sekund.

Publiseres automatisk til Cloudflare når `main` endres (Workers Builds).

Lokalt: `npm install && npx wrangler dev`.

Live: https://batblikk.seriksso.workers.dev
