// Båtblikk på Cloudflare.
// Worker: serverer kartet og /api/ships.
// AisHub (Durable Object): holder TCP-strømmen fra Kystverket åpen hele tiden,
// husker siste posisjon for hver båt, og lagrer navn og båttype så de overlever omstart.

import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { AisParser } from "./ais.js";

const MAX_AGE_MS = 30 * 60 * 1000; // vis båter sett siste 30 min
const ALARM_MS = 30 * 1000; // vekker objektet jevnlig så det holder seg i live
const STALE_MS = 90 * 1000; // ingen data på så lenge = koble til på nytt
// Øk VERSION ved endringer i AisHub. En kjørende, eldre instans starter seg da på nytt
// (Cloudflare bytter ikke alltid kode i et objekt som får jevnlige forespørsler).
const VERSION = 6;
const HUB_NAME = "norge-eu-2";
const TRACK_MS = 6 * 60 * 60 * 1000; // husk rute 6 timer bakover
const TRACK_MAX = 400;
const STATIC_KEYS = ["name", "callsign", "shipType", "destination", "imo", "len", "beam", "draught", "eta"];

export class AisHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ships = new Map();
    this.tracks = new Map(); // mmsi -> [[lat, lon, tid], ...] siste timer (bare i minnet)
    this.dirty = new Set(); // mmsi med nye navn/typer som ikke er lagret
    this.stats = { version: VERSION, source: "kystverket", connected: false, messages: 0, since: Date.now(), lastData: 0, lastError: null, reconnects: 0, alarms: 0, saved: 0 };
    this.socket = null;

    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS ship_static (
        mmsi INTEGER PRIMARY KEY, name TEXT, callsign TEXT, shipType INTEGER, destination TEXT)`);
      for (const col of ["imo INTEGER", "len INTEGER", "beam INTEGER", "draught REAL", "eta TEXT"]) {
        try { sql.exec("ALTER TABLE ship_static ADD COLUMN " + col); } catch {} // finnes allerede
      }
      for (const row of sql.exec("SELECT * FROM ship_static")) {
        const s = { mmsi: row.mmsi };
        for (const k of STATIC_KEYS) if (row[k] !== null) s[k] = row[k];
        this.ships.set(row.mmsi, s);
      }
    });
  }

  async fetch(request) {
    if (Number(request.headers.get("x-batblikk-version")) > VERSION) this.ctx.abort("ny versjon av koden");
    try {
      return await this.handle(request);
    } catch (e) {
      return Response.json({ error: "hub: " + String((e && e.stack) || e) }, { status: 500 });
    }
  }

  async handle(request) {
    const url = new URL(request.url);
    // Meldinger som workeren selv har lest fra Kystverket (reserve når objektet ikke når fram selv)
    if (request.method === "POST" && url.pathname === "/ingest") {
      const msgs = await request.json();
      for (const m of msgs) this.update(m);
      this.stats.relayed = (this.stats.relayed || 0) + msgs.length;
      this.stats.lastRelay = Date.now();
      this.saveStatic();
      return new Response("ok");
    }
    if (url.pathname === "/api/track") {
      const t = this.tracks.get(Number(url.searchParams.get("mmsi"))) || [];
      return Response.json(t, { headers: { "Cache-Control": "no-store" } });
    }
    this.ensureConnected();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);

    const cutoff = Date.now() - MAX_AGE_MS;
    const list = [];
    for (const s of this.ships.values()) if (s.seen && s.seen > cutoff) list.push(s);
    return Response.json({ now: Date.now(), stats: this.stats, ships: list }, { headers: { "Cache-Control": "no-store" } });
  }

  async alarm() {
    this.stats.alarms++;
    // Henger tilkoblingen uten data? Start på nytt.
    if (this.socket && this.stats.lastData && Date.now() - this.stats.lastData > STALE_MS) this.stop();
    this.ensureConnected();
    this.saveStatic();
    const cutoff = Date.now() - MAX_AGE_MS * 2;
    for (const s of this.ships.values()) {
      if (s.seen && s.seen < cutoff) { delete s.seen; delete s.lat; delete s.lon; this.tracks.delete(s.mmsi); }
    }
    // Bare hold objektet i live hvis egen tilkobling faktisk har gitt data.
    // Ellers sparer vi gratiskvoten; workeren mater objektet når noen ser på kartet.
    if (this.stats.lastData) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  addTrackPoint(mmsi, lat, lon, t) {
    let tr = this.tracks.get(mmsi);
    if (!tr) { tr = []; this.tracks.set(mmsi, tr); }
    const last = tr[tr.length - 1];
    // nytt punkt når båten har flyttet seg ~50 m eller det har gått 2 min
    if (last && Math.abs(last[0] - lat) < 0.0005 && Math.abs(last[1] - lon) < 0.001 && t - last[2] < 120000) return;
    tr.push([lat, lon, t]);
    const cutoff = t - TRACK_MS;
    while (tr.length && (tr[0][2] < cutoff || tr.length > TRACK_MAX)) tr.shift();
  }

  saveStatic() {
    if (!this.dirty.size) return;
    const sql = this.ctx.storage.sql;
    for (const mmsi of this.dirty) {
      const s = this.ships.get(mmsi);
      if (!s) continue;
      sql.exec(
        `INSERT INTO ship_static (mmsi, name, callsign, shipType, destination, imo, len, beam, draught, eta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mmsi) DO UPDATE SET name=excluded.name, callsign=excluded.callsign,
           shipType=excluded.shipType, destination=excluded.destination, imo=excluded.imo,
           len=excluded.len, beam=excluded.beam, draught=excluded.draught, eta=excluded.eta`,
        mmsi, s.name ?? null, s.callsign ?? null, s.shipType ?? null, s.destination ?? null, s.imo ?? null,
        s.len ?? null, s.beam ?? null, s.draught ?? null, s.eta ?? null);
    }
    this.stats.saved += this.dirty.size;
    this.dirty.clear();
  }

  ensureConnected() {
    if (this.socket) return;
    // Egen tilkobling har feilet fra der objektet står; prøv sjelden for ikke å mase på Kystverket.
    if (this.stats.lastError && Date.now() - (this.lastAttempt || 0) < 15 * 60 * 1000) return;
    this.lastAttempt = Date.now();
    const socket = connect({ hostname: this.env.AIS_HOST, port: Number(this.env.AIS_PORT) });
    this.socket = socket;
    this.stats.reconnects++;
    this.read(socket)
      .catch((e) => { this.stats.lastError = String((e && e.message) || e); })
      .finally(() => {
        if (this.socket === socket) { this.socket = null; this.stats.connected = false; }
      });
  }

  stop() {
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
    this.stats.connected = false;
  }

  async read(socket) {
    await socket.opened;
    this.stats.connected = true;
    this.stats.lastError = null;
    this.stats.lastData = Date.now();
    const parser = new AisParser();
    const decoder = new TextDecoder("latin1");
    const reader = socket.readable.getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.stats.lastData = Date.now();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        try { const m = parser.parseLine(line); if (m) this.update(m); } catch {}
      }
    }
  }

  update(msg) {
    const s = this.ships.get(msg.mmsi) || { mmsi: msg.mmsi };
    for (const [k, v] of Object.entries(msg)) {
      if (k === "type" || v === null || v === undefined) continue;
      if (STATIC_KEYS.includes(k) && s[k] !== v) this.dirty.add(msg.mmsi);
      s[k] = v;
    }
    if (msg.lat != null && msg.lon != null) {
      s.seen = Date.now();
      this.addTrackPoint(msg.mmsi, msg.lat, msg.lon, s.seen);
    }
    this.ships.set(msg.mmsi, s);
    this.stats.messages++;
  }
}

// Reserve: workeren leser selv fra Kystverket i noen sekunder og sender meldingene til objektet.
// Brukes når objektet ikke har fått data selv (noen Cloudflare-steder slipper ikke gjennom).
const RELAY_READ_MS = 4000;
const RELAY_EVERY_MS = 8000;
let lastRelay = 0;
let relayError = null;
let relayBusyUntil = 0;

async function relayOnce(env, hub) {
  try { await relayInner(env, hub); }
  catch (e) { relayError = String((e && e.message) || e); }
}

async function relayInner(env, hub) {
  const sock = connect({ hostname: env.AIS_HOST, port: Number(env.AIS_PORT) });
  const reader = sock.readable.getReader();
  const parser = new AisParser();
  const dec = new TextDecoder("latin1");
  const msgs = [];
  let buf = "";
  const timer = new Promise((r) => setTimeout(() => r({ timeout: true }), RELAY_READ_MS));
  try {
    const op = await Promise.race([sock.opened.then(() => "ok"), timer]);
    if (op !== "ok") { relayError = "fikk ikke kontakt med Kystverket"; return; }
    while (true) {
      const res = await Promise.race([reader.read(), timer]);
      if (res.timeout || res.done) break;
      buf += dec.decode(res.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        try { const m = parser.parseLine(l); if (m) { m.src = "no"; msgs.push(m); }; } catch {}
      }
    }
  } catch (e) {
    relayError = String((e && e.message) || e); // neste forsøk kommer ved neste oppdatering
  } finally {
    try { reader.releaseLock(); } catch {}
    try { sock.close(); } catch {}
  }
  if (msgs.length) { relayError = null; await hub.fetch("https://hub/ingest", { method: "POST", body: JSON.stringify(msgs) }); }
  else if (!relayError) relayError = "ingen data fra Kystverket på " + RELAY_READ_MS / 1000 + " s";
}

function hubStub(env) {
  const stub = env.AIS_HUB.get(env.AIS_HUB.idFromName(HUB_NAME), { locationHint: "weur" });
  // Sender versjonen med, og prøver én gang til hvis objektet startet seg på nytt.
  return {
    async fetch(input, init = {}) {
      const req = new Request(input, init);
      req.headers.set("x-batblikk-version", String(VERSION));
      try { return await stub.fetch(req.clone()); }
      catch { return env.AIS_HUB.get(env.AIS_HUB.idFromName(HUB_NAME), { locationHint: "weur" }).fetch(req); }
    },
  };
}

// ---- Finland: Digitraffic (åpne AIS-data for Østersjøen, lisens CC BY 4.0) ----
const DT = "https://meri.digitraffic.fi/api/ais/v1/";
const DT_HEADERS = { "Digitraffic-User": "Batblikk", "Accept-Encoding": "gzip", Accept: "application/json" };
const DT_POS_EVERY_MS = 30 * 1000;
const DT_META_EVERY_MS = 15 * 60 * 1000;
let lastDtPos = 0, lastDtMeta = 0, dtBusyUntil = 0, dtError = null;

function dtEta(e) {
  if (!e) return null;
  const mo = (e >> 16) & 15, d = (e >> 11) & 31, h = (e >> 6) & 31, mi = e & 63, p = (n) => String(n).padStart(2, "0");
  return mo && mo <= 12 && d ? `${p(d)}.${p(mo)}` + (h < 24 ? ` ${p(h)}:${p(mi < 60 ? mi : 0)}` : "") : null;
}

async function digitrafficOnce(hub) {
  const now = Date.now();
  const msgs = [];
  try {
    if (now - lastDtMeta > DT_META_EVERY_MS) {
      lastDtMeta = now;
      const vessels = await fetch(DT + "vessels?from=" + (now - 24 * 3600 * 1000), { headers: DT_HEADERS }).then((r) => r.json());
      for (const v of vessels) {
        msgs.push({ mmsi: v.mmsi, name: v.name?.trim() || null, callsign: v.callSign || null, shipType: v.shipType ?? null,
          destination: v.destination?.trim() || null, imo: v.imo || null, src: "fi",
          len: (v.referencePointA || 0) + (v.referencePointB || 0) || null, beam: (v.referencePointC || 0) + (v.referencePointD || 0) || null,
          draught: v.draught ? v.draught / 10 : null, eta: dtEta(v.eta) });
      }
    }
    lastDtPos = now;
    const pos = await fetch(DT + "locations?from=" + (now - 20 * 60 * 1000), { headers: DT_HEADERS }).then((r) => r.json());
    for (const f of pos.features || []) {
      const p = f.properties, [lon, lat] = f.geometry.coordinates;
      msgs.push({ mmsi: f.mmsi, lat, lon, sog: p.sog ?? null, cog: p.cog ?? null,
        heading: p.heading === 511 ? null : p.heading ?? null, status: p.navStat ?? null, src: "fi" });
    }
    dtError = null;
  } catch (e) {
    dtError = String((e && e.message) || e);
  }
  if (msgs.length) await hub.fetch("https://hub/ingest", { method: "POST", body: JSON.stringify(msgs) });
}

// ---- Danmark og Sverige: aisstream.io (gratis konto, nøkkel lagres som hemmelighet AISSTREAM_KEY) ----
// Uten nøkkel hoppes dette over. Workeren lytter noen sekunder per oppdatering.
const AS_READ_MS = 4000;
const AS_EVERY_MS = 12000;
let lastAs = 0, asBusyUntil = 0, asError = null;
const AS_BOXES = [[[53.5, 2.5], [59.5, 16.5]], [[55, 10.5], [66, 24.5]]]; // Danmark/Skagerrak/Kattegat, Sverige/Østersjøen

async function aisstreamOnce(env, hub) {
  const msgs = [];
  let ws;
  try {
    const resp = await fetch("https://stream.aisstream.io/v0/stream", { headers: { Upgrade: "websocket" } });
    ws = resp.webSocket;
    if (!ws) { asError = "aisstream svarte " + resp.status; return; }
    ws.accept();
    ws.addEventListener("message", (ev) => {
      try {
        const d = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
        if (d.error) { asError = String(d.error); return; }
        const md = d.MetaData || {}, mm = d.Message || {};
        const pr = mm.PositionReport || mm.StandardClassBPositionReport || mm.ExtendedClassBPositionReport;
        if (pr) {
          msgs.push({ mmsi: md.MMSI || pr.UserID, lat: pr.Latitude, lon: pr.Longitude,
            sog: pr.Sog >= 102.3 ? null : pr.Sog, cog: pr.Cog >= 360 ? null : pr.Cog,
            heading: pr.TrueHeading === 511 ? null : pr.TrueHeading ?? null,
            status: pr.NavigationalStatus ?? null, src: "as",
            ...(md.ShipName && md.ShipName.trim() ? { name: md.ShipName.trim() } : {}) });
        }
        const st = mm.ShipStaticData;
        if (st) {
          msgs.push({ mmsi: md.MMSI || st.UserID, name: st.Name?.trim() || null, callsign: st.CallSign?.trim() || null,
            shipType: st.Type ?? null, destination: st.Destination?.trim() || null, imo: st.ImoNumber || null, src: "as",
            len: st.Dimension ? (st.Dimension.A || 0) + (st.Dimension.B || 0) || null : null,
            beam: st.Dimension ? (st.Dimension.C || 0) + (st.Dimension.D || 0) || null : null,
            draught: st.MaximumStaticDraught || null,
            eta: st.Eta && st.Eta.Month && st.Eta.Day ? `${String(st.Eta.Day).padStart(2, "0")}.${String(st.Eta.Month).padStart(2, "0")}` + (st.Eta.Hour < 24 ? ` ${String(st.Eta.Hour).padStart(2, "0")}:${String(st.Eta.Minute < 60 ? st.Eta.Minute : 0).padStart(2, "0")}` : "") : null });
        }
      } catch {}
    });
    ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: AS_BOXES,
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData"] }));
    await new Promise((r) => setTimeout(r, AS_READ_MS));
    if (msgs.length) asError = null; else if (!asError) asError = "ingen data fra aisstream på " + AS_READ_MS / 1000 + " s";
  } catch (e) {
    asError = String((e && e.message) || e);
  } finally {
    try { ws && ws.close(1000, "ferdig"); } catch {}
  }
  const valid = msgs.filter((m) => m.mmsi && (m.lat == null || (Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180)));
  if (valid.length) await hub.fetch("https://hub/ingest", { method: "POST", body: JSON.stringify(valid) });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return Response.json({ error: String((e && e.stack) || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  },
};

async function handle(request, env) {
  {
    const url = new URL(request.url);
    if (url.pathname === "/api/track") {
      return hubStub(env).fetch(request);
    }
    if (url.pathname === "/api/ships") {
      // Ingen delte promises mellom forespørsler: Cloudflare dropper dem når
      // forespørselen som lagde dem avsluttes, og da ville alle senere kall henge
      // («This promise was created by a request that has since ended»).
      // I stedet en tidsbegrenset «opptatt»-markør; bare forespørselen som
      // starter jobben venter på den.
      const hub = hubStub(env);
      const now = Date.now();
      let dtJob = null;
      if (now - lastDtPos > DT_POS_EVERY_MS && now > dtBusyUntil) {
        dtBusyUntil = now + 20000;
        dtJob = digitrafficOnce(hub).catch(() => {}).finally(() => (dtBusyUntil = 0));
      }
      const data = await (await hub.fetch(request)).json();
      const hubLive = data.stats.connected && Date.now() - data.stats.lastData < 15000;
      let relayJob = null;
      if (!hubLive && Date.now() - lastRelay > RELAY_EVERY_MS && Date.now() > relayBusyUntil) {
        lastRelay = Date.now();
        relayBusyUntil = Date.now() + 15000;
        relayJob = relayOnce(env, hub).catch(() => {}).finally(() => (relayBusyUntil = 0));
      }
      let asJob = null;
      if (env.AISSTREAM_KEY && Date.now() - lastAs > AS_EVERY_MS && Date.now() > asBusyUntil) {
        lastAs = Date.now();
        asBusyUntil = Date.now() + 15000;
        asJob = aisstreamOnce(env, hub).catch(() => {}).finally(() => (asBusyUntil = 0));
      }
      let out = data;
      if (dtJob || relayJob || asJob) {
        await Promise.all([dtJob, relayJob, asJob]);
        out = await (await hub.fetch(request)).json();
      }
      out.stats.relayError = relayError;
      out.stats.finlandError = dtError;
      out.stats.aisstream = env.AISSTREAM_KEY ? (asError || "ok") : "ingen nøkkel";
      return Response.json(out, { headers: { "Cache-Control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  }
}
