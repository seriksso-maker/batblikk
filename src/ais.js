// Minimal AIS (NMEA !AIVDM) decoder: position reports (1, 2, 3, 18, 19)
// and static data (5, 24). No dependencies.

const SIXBIT_TEXT =
  "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?";

function payloadToBits(payload, fillBits) {
  let bits = "";
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    bits += v.toString(2).padStart(6, "0");
  }
  return fillBits ? bits.slice(0, bits.length - fillBits) : bits;
}

function uint(bits, start, len) {
  const s = bits.substr(start, len);
  if (s.length < len) return null;
  return parseInt(s, 2);
}

function int(bits, start, len) {
  const v = uint(bits, start, len);
  if (v === null) return null;
  return v >= 2 ** (len - 1) ? v - 2 ** len : v;
}

function text(bits, start, len) {
  let out = "";
  for (let i = 0; i + 6 <= len; i += 6) {
    const v = uint(bits, start + i, 6);
    if (v === null) break;
    out += SIXBIT_TEXT[v];
  }
  return out.replace(/@.*$/, "").trim() || null;
}

function coord(raw, invalid) {
  if (raw === null) return null;
  const v = raw / 600000;
  return Math.abs(v) >= invalid ? null : Math.round(v * 1e6) / 1e6;
}

function sog(raw) {
  return raw === null || raw === 1023 ? null : raw / 10;
}
function cog(raw) {
  return raw === null || raw >= 3600 ? null : raw / 10;
}
function heading(raw) {
  return raw === null || raw === 511 ? null : raw;
}

function decodeBits(bits) {
  const type = uint(bits, 0, 6);
  const mmsi = uint(bits, 8, 30);
  if (!mmsi) return null;
  switch (type) {
    case 1:
    case 2:
    case 3:
      return {
        type,
        mmsi,
        status: uint(bits, 38, 4),
        sog: sog(uint(bits, 50, 10)),
        lon: coord(int(bits, 61, 28), 181),
        lat: coord(int(bits, 89, 27), 91),
        cog: cog(uint(bits, 116, 12)),
        heading: heading(uint(bits, 128, 9)),
      };
    case 18:
    case 19: {
      const m = {
        type,
        mmsi,
        sog: sog(uint(bits, 46, 10)),
        lon: coord(int(bits, 57, 28), 181),
        lat: coord(int(bits, 85, 27), 91),
        cog: cog(uint(bits, 112, 12)),
        heading: heading(uint(bits, 124, 9)),
      };
      if (type === 19) {
        m.name = text(bits, 143, 120);
        m.shipType = uint(bits, 263, 8);
      }
      return m;
    }
    case 5:
      return {
        type,
        mmsi,
        callsign: text(bits, 70, 42),
        name: text(bits, 112, 120),
        shipType: uint(bits, 232, 8),
        destination: text(bits, 302, 120),
      };
    case 24: {
      const part = uint(bits, 38, 2);
      if (part === 0) return { type, mmsi, name: text(bits, 40, 120) };
      if (part === 1)
        return {
          type,
          mmsi,
          shipType: uint(bits, 40, 8),
          callsign: text(bits, 90, 42),
        };
      return null;
    }
    default:
      return null;
  }
}

// Stateful parser: feed it lines, get decoded messages back.
// Handles multi-part sentences and optional NMEA 4.0 tag blocks (\...\).
class AisParser {
  constructor() {
    this.parts = new Map();
  }

  parseLine(line) {
    const start = line.search(/[!$][A-Z]{2}VD[MO]/);
    if (start < 0) return null;
    const sentence = line.slice(start).trim();
    const star = sentence.indexOf("*");
    const body = star >= 0 ? sentence.slice(1, star) : sentence.slice(1);
    const f = body.split(",");
    if (f.length < 7) return null;
    const total = +f[1];
    const num = +f[2];
    const seq = f[3];
    const channel = f[4];
    const payload = f[5];
    const fill = +f[6] || 0;

    if (total === 1) return decodeBits(payloadToBits(payload, fill));

    const key = `${seq}:${channel}`;
    let entry = this.parts.get(key);
    if (num === 1 || !entry) entry = { payloads: [], t: Date.now() };
    entry.payloads[num - 1] = payload;
    this.parts.set(key, entry);
    if (num !== total) {
      if (this.parts.size > 500) this.cleanup();
      return null;
    }
    this.parts.delete(key);
    if (entry.payloads.filter(Boolean).length !== total) return null;
    return decodeBits(payloadToBits(entry.payloads.join(""), fill));
  }

  cleanup() {
    const cutoff = Date.now() - 10000;
    for (const [k, v] of this.parts) if (v.t < cutoff) this.parts.delete(k);
  }
}

export { AisParser, decodeBits, payloadToBits };
