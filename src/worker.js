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
const STATIC_KEYS = ["name", "callsign", "shipType", "destination"];

export class AisHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ships = new Map();
    this.dirty = new Set(); // mmsi med nye navn/typer som ikke er lagret
    this.stats = { source: "kystverket", connected: false, messages: 0, since: Date.now(), lastData: 0, lastError: null, reconnects: 0, alarms: 0, saved: 0 };
    this.socket = null;

    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS ship_static (
        mmsi INTEGER PRIMARY KEY, name TEXT, callsign TEXT, shipType INTEGER, destination TEXT)`);
      for (const row of sql.exec("SELECT * FROM ship_static")) {
        const s = { mmsi: row.mmsi };
        for (const k of STATIC_KEYS) if (row[k] !== null) s[k] = row[k];
        this.ships.set(row.mmsi, s);
      }
    });
  }

  async fetch(request) {
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
      if (s.seen && s.seen < cutoff) { delete s.seen; delete s.lat; delete s.lon; }
    }
    // Bare hold objektet i live hvis egen tilkobling faktisk har gitt data.
    // Ellers sparer vi gratiskvoten; workeren mater objektet når noen ser på kartet.
    if (this.stats.lastData) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  saveStatic() {
    if (!this.dirty.size) return;
    const sql = this.ctx.storage.sql;
    for (const mmsi of this.dirty) {
      const s = this.ships.get(mmsi);
      if (!s) continue;
      sql.exec(
        `INSERT INTO ship_static (mmsi, name, callsign, shipType, destination) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mmsi) DO UPDATE SET name=excluded.name, callsign=excluded.callsign,
           shipType=excluded.shipType, destination=excluded.destination`,
        mmsi, s.name ?? null, s.callsign ?? null, s.shipType ?? null, s.destination ?? null);
    }
    this.stats.saved += this.dirty.size;
    this.dirty.clear();
  }

  ensureConnected() {
    if (this.socket) return;
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
    if (msg.lat != null && msg.lon != null) s.seen = Date.now();
    this.ships.set(msg.mmsi, s);
    this.stats.messages++;
  }
}

// Reserve: workeren leser selv fra Kystverket i noen sekunder og sender meldingene til objektet.
// Brukes når objektet ikke har fått data selv (noen Cloudflare-steder slipper ikke gjennom).
const RELAY_READ_MS = 4000;
const RELAY_EVERY_MS = 8000;
let lastRelay = 0;
let relaying = null;

async function relayOnce(env, hub) {
  const sock = connect({ hostname: env.AIS_HOST, port: Number(env.AIS_PORT) });
  const reader = sock.readable.getReader();
  const parser = new AisParser();
  const dec = new TextDecoder("latin1");
  const msgs = [];
  let buf = "";
  const timer = new Promise((r) => setTimeout(() => r({ timeout: true }), RELAY_READ_MS));
  try {
    const op = await Promise.race([sock.opened.then(() => "ok"), timer]);
    if (op !== "ok") return;
    while (true) {
      const res = await Promise.race([reader.read(), timer]);
      if (res.timeout || res.done) break;
      buf += dec.decode(res.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        try { const m = parser.parseLine(l); if (m) msgs.push(m); } catch {}
      }
    }
  } catch {
    // ignorer; neste forsøk kommer ved neste oppdatering
  } finally {
    try { reader.releaseLock(); } catch {}
    try { sock.close(); } catch {}
  }
  if (msgs.length) await hub.fetch("https://hub/ingest", { method: "POST", body: JSON.stringify(msgs) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ships") {
      const hub = env.AIS_HUB.get(env.AIS_HUB.idFromName("norge-eu"), { locationHint: "weur" });
      let res = await hub.fetch(request);
      const data = await res.json();
      const hubLive = data.stats.connected && Date.now() - data.stats.lastData < 15000;
      if (!hubLive && Date.now() - lastRelay > RELAY_EVERY_MS) {
        lastRelay = Date.now();
        relaying = relaying || relayOnce(env, hub).finally(() => (relaying = null));
        await relaying;
        res = await hub.fetch(request);
        return res;
      }
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
};
