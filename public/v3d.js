// Båtblikk 3D: MapLibre med terreng og fartøy som 3D-modeller (fill-extrusion).
// Lastes først når noen åpner 3D-visningen. Bruker de samme båtdataene som hovedkartet (ships, byMmsi).
(function () {
  const ML = "https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl";
  const R = Math.PI / 180;
  const DEF_SIZE = { cargo:[120,20], tanker:[180,30], passenger:[110,20], fishing:[30,8], leisure:[11,3.6], service:[28,9], fast:[32,9], other:[22,6] };
  const st = { map:null, follow:null, view:"bak", last:0, raf:0, upd:0, brg:null, open:false, base:"sat" };

  const css = `
  #v3d{position:fixed;inset:0;z-index:2000;background:#0a1017;display:none}
  #v3d.on{display:block}
  #v3dMap{position:absolute;inset:0}
  #v3d .bar{position:absolute;z-index:5;top:calc(10px + env(safe-area-inset-top));left:10px;right:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;pointer-events:none}
  #v3d .bar>*{pointer-events:auto}
  #v3d .grp{display:flex;gap:2px;padding:3px;background:rgba(8,17,28,.88);border:1px solid #1e2b39;border-radius:12px}
  #v3d .grp button{background:none;border:1px solid transparent;color:#e8eef3;border-radius:9px;padding:5px 10px;min-height:30px;font:500 13px 'Barlow',system-ui,sans-serif;cursor:pointer}
  #v3d .grp button.on{border-color:#5aa9d6;background:#13263a;color:#d9f1ff}
  #v3d .x3{margin-left:auto;width:38px;height:38px;border-radius:50%;background:rgba(8,17,28,.88);border:1px solid #1e2b39;color:#fff;font-size:16px;cursor:pointer}
  #v3d .hud{position:absolute;z-index:5;left:10px;bottom:calc(14px + env(safe-area-inset-bottom));background:rgba(8,17,28,.9);border:1px solid #1e2b39;border-radius:12px;padding:10px 14px;color:#dbe6ef;min-width:220px;max-width:calc(100% - 20px);box-sizing:border-box}
  #v3d .hud .n{font:700 22px/1.1 'Barlow Condensed','Barlow',sans-serif;letter-spacing:.02em}
  #v3d .hud .t{color:#7b8fa3;font-size:12.5px;margin:2px 0 6px}
  #v3d .hud .g{display:flex;gap:16px;font:500 13px 'IBM Plex Mono',ui-monospace,monospace}
  #v3d .hud .g span{display:block;color:#7b8fa3;font:500 10px 'Barlow',sans-serif;text-transform:uppercase;letter-spacing:.08em}
  #v3d .tip{position:absolute;z-index:5;right:56px;bottom:calc(40px + env(safe-area-inset-bottom));background:rgba(8,17,28,.85);border:1px solid #1e2b39;border-radius:10px;padding:6px 10px;color:#9fb2c4;font-size:12px;max-width:260px}
  #v3d .msg{position:absolute;z-index:6;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(8,17,28,.92);border:1px solid #1e2b39;border-radius:12px;padding:12px 16px;color:#dbe6ef}
  @media (max-width:640px){ #v3d .tip{display:none} #v3d .grp button{padding:4px 7px;font-size:12px} }`;
  const el = document.createElement("div");
  el.id = "v3d";
  el.innerHTML = `<style>${css}</style><div id="v3dMap"></div>
    <div class="bar">
      <div class="grp" id="v3dViews"><button data-v="bak">Bak båten</button><button data-v="bro">Fra brua</button><button data-v="rundt">Rundt</button><button data-v="ovenfra">Ovenfra</button><button data-v="fri">Fri</button></div>
      <div class="grp" id="v3dBase"><button data-b="sat">Satellitt</button><button data-b="kart">Kart</button></div>
      <button class="x3" id="v3dX" aria-label="Lukk 3D">✕</button>
    </div>
    <div class="hud" id="v3dHud" hidden></div>
    <div class="tip">Trykk på en båt for å følge den. Dra for å se rundt, rull eller klyp for å zoome.</div>
    <div class="msg" id="v3dMsg">Laster 3D-kart …</div>`;
  document.body.appendChild(el);
  const q = (id) => document.getElementById(id);

  function loadML() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise((res, rej) => {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = ML + ".css"; document.head.appendChild(l);
      const s = document.createElement("script"); s.src = ML + ".js"; s.onload = res;
      s.onerror = () => rej(new Error("Kunne ikke laste 3D-biblioteket. Sjekk internett og prøv igjen."));
      document.head.appendChild(s);
    });
  }

  const cosd = (d) => Math.cos(d * R);
  // Posisjon fremskrevet med fart og kurs siden siste melding, så båtene glir jevnt
  function pos(s, now) {
    if (!(s.sog > 0.3) || s.cog == null) return [s.lon, s.lat];
    const dt = s.seen ? Math.min(120, Math.max(0, (now - s.seen) / 1000)) : 0, m = s.sog * 0.514444 * dt;
    return [s.lon + (m * Math.sin(s.cog * R)) / (111320 * cosd(s.lat)), s.lat + (m * Math.cos(s.cog * R)) / 111320];
  }
  const hdgOf = (s) => (s.heading != null ? s.heading : s.cog != null ? s.cog : 0);
  function sizeOf(s) {
    const c = catOf(s.shipType).id, d = DEF_SIZE[c] || DEF_SIZE.other;
    return [s.len || d[0], s.beam || Math.max(3, (s.len || d[0]) / 6) || d[1], c];
  }
  // Lokale meter (x tvers, y langs, baug = +y) -> lengde/bredde
  function poly(c, h, pts) {
    const ring = pts.map(([x, y]) => {
      const e = x * Math.cos(h * R) + y * Math.sin(h * R), n = -x * Math.sin(h * R) + y * Math.cos(h * R);
      return [c[0] + e / (111320 * cosd(c[1])), c[1] + n / 111320];
    });
    ring.push(ring[0]);
    return [ring];
  }
  function shipFeatures(s, c, h, k, color, out) {
    const [L0, B0, cat] = sizeOf(s), L = L0 * k, B = B0 * k, hl = L / 2;
    const hull = Math.max(1.5, B0 * 0.28) * k;
    out.push({ type:"Feature", properties:{ mmsi:s.mmsi, color, base:0, top:hull },
      geometry:{ type:"Polygon", coordinates: poly(c, h, [[-B/2,-hl],[B/2,-hl],[B/2,hl*0.55],[B*0.18,hl*0.92],[0,hl],[-B*0.18,hl*0.92],[-B/2,hl*0.55]]) } });
    const sup = (y0, y1, w, h0, h1, col) => out.push({ type:"Feature", properties:{ mmsi:s.mmsi, color:col, base:h0, top:h1 },
      geometry:{ type:"Polygon", coordinates: poly(c, h, [[-w/2,y0],[w/2,y0],[w/2,y1],[-w/2,y1]]) } });
    const white = "#e9eef2";
    if (cat === "passenger") { sup(-hl*0.8, hl*0.45, B*0.86, hull, hull + B*0.45, white); sup(-hl*0.5, hl*0.2, B*0.7, hull + B*0.45, hull + B*0.7, white); }
    else if (cat === "cargo") { sup(-hl*0.95, -hl*0.7, B*0.9, hull, hull + B*0.9, white); for (let i = 0; i < 4; i++) sup(-hl*0.62 + i*hl*0.36, -hl*0.62 + i*hl*0.36 + hl*0.3, B*0.86, hull, hull + B*0.22, ["#c0392b","#2e86c1","#e67e22","#27ae60"][i % 4]); }
    else if (cat === "tanker") { sup(-hl*0.95, -hl*0.72, B*0.9, hull, hull + B*0.8, white); sup(-hl*0.65, hl*0.75, B*0.12, hull, hull + B*0.08, "#555"); }
    else if (cat === "leisure") { sup(-hl*0.4, hl*0.15, B*0.6, hull, hull + B*0.35, white); }
    else if (cat === "fishing" || cat === "service") { sup(hl*0.05, hl*0.55, B*0.75, hull, hull + B*0.7, white); }
    else if (cat === "fast") { sup(-hl*0.6, hl*0.3, B*0.85, hull, hull + B*0.3, white); }
    else { sup(-hl*0.8, -hl*0.45, B*0.75, hull, hull + B*0.6, white); }
  }

  function buildData() {
    const m = st.map, now = Date.now(), b = m.getBounds(), z = m.getZoom();
    const mpp = (78271.5 * cosd(m.getCenter().lat)) / Math.pow(2, z);
    const feats = [];
    let n = 0;
    const pad = 0.3, w = b.getWest(), e = b.getEast(), so = b.getSouth(), no = b.getNorth();
    const dw = (e - w) * pad, dh = (no - so) * pad;
    for (const s of ships) {
      if (s.lat == null) continue;
      const tr = st.follow === s.mmsi;
      if (!tr && (s.lon < w - dw || s.lon > e + dw || s.lat < so - dh || s.lat > no + dh)) continue;
      if (++n > 1500 && !tr) continue;
      const c = pos(s, now), [L0] = sizeOf(s);
      const k = Math.min(80, Math.max(1, (26 * mpp) / L0)); // minst ca. 26 piksler lang
      const cat = catOf(s.shipType);
      shipFeatures(s, c, hdgOf(s), k, tr ? "#ffb454" : cat.color, feats);
    }
    m.getSource("ships3d").setData({ type:"FeatureCollection", features:feats });
  }

  function followCam(dt) {
    const s = st.follow != null && byMmsi.get(st.follow);
    if (!s) return;
    const m = st.map, c = pos(s, Date.now()), h = hdgOf(s), [L0] = sizeOf(s);
    const zBase = Math.max(13, Math.min(18, 18.5 - Math.log2(Math.max(10, L0) / 25)));
    const lerpAng = (a, b2, t) => a + ((((b2 - a) % 360) + 540) % 360 - 180) * t;
    let target;
    if (st.view === "bak") target = { brg:h, pitch:70, zoom:zBase, center:c };
    else if (st.view === "bro") {
      const ahead = L0 * 1.4;
      target = { brg:h, pitch:80, zoom:zBase + 1.1, center:[c[0] + (ahead * Math.sin(h * R)) / (111320 * cosd(c[1])), c[1] + (ahead * Math.cos(h * R)) / 111320] };
    }
    else if (st.view === "rundt") target = { brg:(m.getBearing() + 10 * dt) % 360, pitch:62, zoom:zBase - 0.4, center:c, raw:true };
    else if (st.view === "ovenfra") target = { brg:0, pitch:0, zoom:zBase - 0.6, center:c };
    else { m.setCenter(c); return; } // fri: følger posisjonen, du styrer vinkelen
    const t = Math.min(1, dt * 2.5);
    const brg = target.raw ? target.brg : lerpAng(m.getBearing(), target.brg, t);
    m.jumpTo({ center:target.center, bearing:brg, pitch:m.getPitch() + (target.pitch - m.getPitch()) * t, zoom:m.getZoom() + (target.zoom - m.getZoom()) * t });
  }

  function hud() {
    const s = st.follow != null && byMmsi.get(st.follow);
    const box = q("v3dHud");
    if (!s) { box.hidden = true; return; }
    const flag = flagOf(s.mmsi);
    box.hidden = false;
    box.innerHTML = `<div class="n">${flagEmoji(flag)} ${esc(s.name || "Ukjent navn")}</div><div class="t">${esc(typeName(s.shipType))}${s.len ? ` · ${s.len} × ${s.beam || "?"} m` : ""}</div>
      <div class="g"><div><span>Fart</span>${s.sog != null ? s.sog.toFixed(1) + " kn" : "–"}</div><div><span>Kurs</span>${s.cog != null ? Math.round(s.cog) + "°" : "–"}</div><div><span>Til</span>${esc(s.destination || "–")}</div></div>`;
  }

  function loop(t) {
    if (!st.open) return;
    st.raf = requestAnimationFrame(loop);
    const dt = st.last ? Math.min(0.1, (t - st.last) / 1000) : 0; st.last = t;
    if (!st.map || !st.ready) return;
    if (st.follow != null && !st.userMoving) followCam(dt);
    if (t - st.upd > 250) { st.upd = t; buildData(); }
    if (!st.hudT || t - st.hudT > 1000) { st.hudT = t; hud(); }
  }

  function setView(v) {
    st.view = v;
    for (const b of q("v3dViews").children) b.classList.toggle("on", b.dataset.v === v);
  }
  function setBase(b) {
    st.base = b;
    for (const x of q("v3dBase").children) x.classList.toggle("on", x.dataset.b === b);
    if (st.map && st.map.getLayer("sat")) {
      st.map.setLayoutProperty("sat", "visibility", b === "sat" ? "visible" : "none");
      st.map.setLayoutProperty("kart", "visibility", b === "kart" ? "visible" : "none");
    }
  }

  function create(center) {
    const m = new maplibregl.Map({
      container:"v3dMap", center, zoom:13, pitch:65, bearing:0, maxPitch:85, attributionControl:{ compact:true },
      canvasContextAttributes:{ antialias:true },
      style:{
        version:8,
        sources:{
          sat:{ type:"raster", tileSize:256, maxzoom:13, attribution:"Bilder © Esri, Maxar", tiles:["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] },
          kart:{ type:"raster", tileSize:256, maxzoom:18, attribution:"© Kartverket", tiles:["https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png"] },
          dem:{ type:"raster-dem", tileSize:256, maxzoom:14, encoding:"terrarium", attribution:"Terreng: AWS/Mapzen", tiles:["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] },
          ships3d:{ type:"geojson", data:{ type:"FeatureCollection", features:[] } },
        },
        layers:[
          { id:"bg", type:"background", paint:{ "background-color":"#0b2236" } },
          { id:"sat", type:"raster", source:"sat", layout:{ visibility: st.base === "sat" ? "visible" : "none" } },
          { id:"kart", type:"raster", source:"kart", layout:{ visibility: st.base === "kart" ? "visible" : "none" } },
          { id:"ships", type:"fill-extrusion", source:"ships3d", paint:{
            "fill-extrusion-color":["get","color"], "fill-extrusion-base":["get","base"], "fill-extrusion-height":["get","top"], "fill-extrusion-opacity":0.95 } },
        ],
        terrain:{ source:"dem", exaggeration:1.3 },
        sky:{ "sky-color":"#3f86d6", "horizon-color":"#cfe2f1", "fog-color":"#d7e4ee", "sky-horizon-blend":0.5, "horizon-fog-blend":0.7, "fog-ground-blend":0.6 },
      },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch:true }), "bottom-right");
    m.once("style.load", () => { st.ready = true; q("v3dMsg").hidden = true; });
    m.on("error", () => {});
    m.on("click", "ships", (e) => { const f = e.features && e.features[0]; if (f) { st.follow = f.properties.mmsi; if (st.view === "fri") setView("bak"); hud(); } });
    m.on("mouseenter", "ships", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "ships", () => (m.getCanvas().style.cursor = ""));
    // Når du drar selv, slipper kameraet taket til du velger en visning igjen
    const userStart = (e) => { if (e.originalEvent && st.view !== "fri") setView("fri"); };
    m.on("dragstart", userStart); m.on("rotatestart", userStart); m.on("pitchstart", userStart);
    st.map = m;
  }

  window.__v3d = st;
  window.open3D = function (mmsi) {
    st.open = true; el.classList.add("on");
    st.follow = mmsi != null ? mmsi : (typeof selected !== "undefined" ? selected : null);
    const s = st.follow != null && byMmsi.get(st.follow);
    const c = s ? [s.lon, s.lat] : [map.getCenter().lng, map.getCenter().lat];
    setView(s ? "bak" : "fri"); setBase(st.base);
    q("v3dMsg").hidden = false; q("v3dMsg").textContent = "Laster 3D-kart …";
    loadML().then(() => {
      if (!st.map) create(c); else { st.map.resize(); st.map.jumpTo({ center:c, zoom:s ? 14 : Math.max(11, map.getZoom() + 1), pitch:65 }); q("v3dMsg").hidden = true; }
      st.last = 0; cancelAnimationFrame(st.raf); st.raf = requestAnimationFrame(loop);
    }).catch((e) => { q("v3dMsg").textContent = e.message; });
  };
  function close3D() {
    st.open = false; el.classList.remove("on"); cancelAnimationFrame(st.raf);
    if (st.map) { const c = st.map.getCenter(); map.setView([c.lat, c.lng], Math.max(5, Math.round(st.map.getZoom() - 1))); }
  }
  q("v3dX").onclick = close3D;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && st.open) close3D(); });
  q("v3dViews").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) setView(b.dataset.v); });
  q("v3dBase").addEventListener("click", (e) => { const b = e.target.closest("[data-b]"); if (b) setBase(b.dataset.b); });
})();
