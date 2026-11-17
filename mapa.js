// ══════════════════════════════════════════════
// 🗺️ PESTAÑA MAPA — lotes de Santa Bárbara
//
// Datos (en data.json, el mismo que usa el álbum):
//   "LOTES":     { "638": ["070", "512"], ... }   números de patente vistos en cada lote
//   "LOTES_POS": { "638": [x, y], ... }           ubicaciones corregidas/agregadas desde la web
// Ubicación de cada lote en el plano: lotes-plano.json (fijo) + LOTES_POS (pisa al fijo).
//
// Para editar hace falta una "clave": un token de GitHub con permiso de escritura
// sobre el repo. Se pega una sola vez y queda guardado solo en ese navegador.
// Los cambios se encolan en el celu y se suben cuando hay señal.
// ══════════════════════════════════════════════
(() => {
  const CFG = {
    owner: "chiffoneg",
    repo: "Patentes",
    branch: "main",
    dataPath: "data.json",
    img: "plano-santa-barbara.jpg",
    pos: "lotes-plano.json",
  };
  const LS = { token: "mapa.token", ops: "mapa.ops", cache: "mapa.cache" };

  // ── localStorage tolerante (modo privado, etc.) ──
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ── Estado ──
  let base = store.get(LS.cache, null);   // { album: [...], LOTES, LOTES_POS } último data.json conocido
  let ops = store.get(LS.ops, []);        // cambios todavía no subidos
  let token = store.get(LS.token, "");
  let editing = false;
  let posFijas = {};
  let selected = null;     // número de lote abierto en la hoja
  let pendingSpot = null;  // [x, y] tocado sin lote conocido (modo edición)
  let picking = null;      // lote al que se le está corrigiendo la ubicación
  let flushing = false, netDown = false, lastError = "";
  let started = false, imgW = 0, imgH = 0, qTocado = false;

  const $ = (id) => document.getElementById(id);
  const pad3 = (s) => String(s).padStart(3, "0");
  const esLote = (s) => /^\d{1,4}$/.test(String(s));
  const esNum = (s) => /^\d{3}$/.test(String(s));
  const clone = (o) => JSON.parse(JSON.stringify(o || {}));

  // ══ Modelo ══
  function applyOps(d, list) {
    d.LOTES = d.LOTES || {};
    for (const o of list) {
      if (o.t === "add") {
        const a = d.LOTES[o.lote] || (d.LOTES[o.lote] = []);
        if (!a.includes(o.num)) { a.push(o.num); a.sort(); }
      } else if (o.t === "del") {
        const a = (d.LOTES[o.lote] || []).filter((n) => n !== o.num);
        if (a.length) d.LOTES[o.lote] = a; else delete d.LOTES[o.lote];
      } else if (o.t === "pos") {
        d.LOTES_POS = d.LOTES_POS || {};
        d.LOTES_POS[o.lote] = [o.x, o.y];
      }
    }
    return d;
  }

  function view() {
    const v = applyOps({ LOTES: clone(base?.LOTES), LOTES_POS: clone(base?.LOTES_POS) }, ops);
    const lotes = {};
    for (const [l, nums] of Object.entries(v.LOTES || {})) {
      if (!esLote(l) || !Array.isArray(nums)) continue;
      const ok = nums.filter(esNum);
      if (ok.length) lotes[l] = ok;
    }
    const pos = { ...posFijas };
    for (const [l, p] of Object.entries(v.LOTES_POS || {})) {
      if (esLote(l) && Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) pos[l] = p;
    }
    return { lotes, pos };
  }

  function album() { return new Set(base?.album || []); }
  function proximo() {
    const a = album();
    let n = 0;
    while (n < 1000 && a.has(pad3(n))) n++;
    return n < 1000 ? pad3(n) : "";
  }

  function setBase(d) {
    base = { album: Object.keys(d.PATENTES || {}), LOTES: d.LOTES || {}, LOTES_POS: d.LOTES_POS || {} };
    store.set(LS.cache, base);
  }

  // ══ GitHub ══
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
  function gh(path, opts = {}) {
    return fetch(API + path, {
      cache: "no-store",
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
  }
  function httpError(r) { const e = new Error(`GitHub respondió ${r.status}`); e.status = r.status; return e; }
  function b64enc(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b) {
    return new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  }
  async function ghGet() {
    const r = await gh(`/contents/${CFG.dataPath}?ref=${CFG.branch}`);
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
  }
  async function ghPut(data, sha, message) {
    const r = await gh(`/contents/${CFG.dataPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: b64enc(JSON.stringify(data, null, 2) + "\n"), sha, branch: CFG.branch }),
    });
    if (!r.ok) throw httpError(r);
  }

  function commitMsg(list) {
    const partes = list.map((o) =>
      o.t === "add" ? `lote ${o.lote} +${o.num}` : o.t === "del" ? `lote ${o.lote} -${o.num}` : `ubica lote ${o.lote}`);
    let msg = "Mapa: " + partes.slice(0, 6).join(", ");
    if (partes.length > 6) msg += ` y ${partes.length - 6} más`;
    return msg;
  }

  // ══ Carga ══
  async function loadData() {
    let d = null;
    if (token) {
      try { d = (await ghGet()).data; netDown = false; }
      catch (e) {
        if (e.status === 401) { lastError = "La clave no sirve más"; }
        else if (!e.status) netDown = true;
      }
    }
    if (!d) {
      try {
        const r = await fetch(`${CFG.dataPath}?t=${Date.now()}`, { cache: "no-store" });
        d = await r.json();
        netDown = false;
      } catch { netDown = true; }
    }
    if (d) setBase(d);
    else if (!base) $("mp-result").textContent = "No se pudieron cargar los datos. Revisá la conexión.";
    render();
    if (ops.length) flush();
  }

  async function loadPos() {
    try {
      const r = await fetch(`${CFG.pos}?t=${Date.now()}`);
      const j = await r.json();
      posFijas = {};
      for (const [l, p] of Object.entries(j)) if (esLote(l) && Array.isArray(p)) posFijas[l] = p;
    } catch (e) { console.error("No se pudo cargar", CFG.pos, e); }
    render();
  }

  // ══ Guardado (cola) ══
  let flushT = null;
  function scheduleFlush(ms = 1500) { clearTimeout(flushT); flushT = setTimeout(flush, ms); }

  async function flush() {
    if (flushing || !ops.length || !token || navigator.onLine === false) return renderSync();
    flushing = true;
    lastError = "";
    renderSync();
    const batch = ops.slice();
    try {
      for (let intento = 0; ; intento++) {
        try {
          const { data, sha } = await ghGet();
          applyOps(data, batch);
          await ghPut(data, sha, commitMsg(batch));
          setBase(data);
          break;
        } catch (e) {
          // 409/422: alguien (el bot) commiteó en el medio → releer y reintentar
          if ((e.status === 409 || e.status === 422) && intento < 3) continue;
          throw e;
        }
      }
      ops = ops.slice(batch.length);
      store.set(LS.ops, ops);
      netDown = false;
    } catch (e) {
      if (!e.status) netDown = true;
      else if (e.status === 401 || e.status === 403) lastError = "La clave no sirve más";
      else lastError = e.message;
      console.error(e);
    } finally {
      flushing = false;
      render();
      if (ops.length && !lastError) scheduleFlush(netDown ? 20000 : 3000);
    }
  }

  function change(op, msg) {
    ops.push({ ...op, ts: Date.now() });
    store.set(LS.ops, ops);
    toast(msg + (navigator.onLine === false || netDown ? " · se sube cuando vuelva la señal" : ""));
    render();
    scheduleFlush();
  }

  window.addEventListener("online", () => { netDown = false; flush(); });
  // el celu congela las pestañas en segundo plano: al volver a la página, reintentar enseguida
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ops.length && token) { netDown = false; flush(); }
  });
  window.addEventListener("offline", () => { netDown = true; renderSync(); });
  setInterval(() => { if (ops.length && token) flush(); }, 30000);

  // ══ Render ══
  function renderSync() {
    const s = $("mp-sync");
    if (!s) return;
    const n = ops.length, cambios = `${n} cambio${n > 1 ? "s" : ""}`;
    const offline = navigator.onLine === false || netDown;
    let cls = "", txt;
    if (flushing) { cls = "busy"; txt = "⏳ Guardando…"; }
    else if (lastError) { cls = "error"; txt = `⚠️ ${lastError}${n ? ` · ${cambios} sin subir` : ""}`; }
    else if (n && offline) { cls = "offline"; txt = `📴 Sin señal · ${cambios} esperando`; }
    else if (offline) { cls = "offline"; txt = "📴 Sin señal"; }
    else if (n) { cls = "busy"; txt = `⏳ ${cambios} por subir`; }
    else txt = token ? "☁️ Todo guardado" : "👀 Solo lectura";
    s.className = "mp-sync " + cls;
    s.textContent = txt;

    const lb = $("mp-lock");
    lb.textContent = editing ? "✏️ Editando" : "🔒 Editar";
    lb.className = "mp-next" + (editing ? " on" : "");
    lb.style.background = editing ? "#7fff6e" : "";
    lb.style.color = editing ? "#1a2340" : "";
  }

  function query() {
    const v = $("mp-q").value.replace(/\D/g, "");
    return v ? pad3(v) : "";
  }

  function render() {
    if (!started) return;
    const { lotes, pos } = view();
    const q = query();
    const a = album();

    $("mp-next-num").textContent = proximo() || "—";

    // resultado de búsqueda
    const res = $("mp-result");
    if (!base) { /* sigue el mensaje de carga */ }
    else if (!q) res.innerHTML = "Escribí un número de 3 dígitos para ver en qué lotes está.";
    else {
      const hits = Object.keys(lotes).filter((l) => lotes[l].includes(q)).sort((x, y) => x - y);
      let html = a.has(q) ? `<span class="mp-have">✅ El ${q} ya está en tu álbum.</span> ` : "";
      html += hits.length
        ? `El <b>${q}</b> está en ${hits.length} lote${hits.length > 1 ? "s" : ""}: ` +
          hits.map((l) => `<button class="mp-lot-link" data-lot="${l}">Lote ${l}</button>`).join("")
        : `Ningún lote cargado tiene el <b>${q}</b> todavía.`;
      res.innerHTML = html;
    }

    // marcadores
    const box = $("mp-markers");
    box.innerHTML = "";
    const add = (l, cls, label) => {
      const p = pos[l];
      if (!p) return;
      const m = document.createElement("div");
      m.className = "mp-marker " + cls;
      m.style.left = p[0] + "px";
      m.style.top = p[1] + "px";
      m.textContent = label;
      box.appendChild(m);
    };
    for (const [l, nums] of Object.entries(lotes)) {
      add(l, (q && nums.includes(q) ? "hit" : "") + (l === selected ? " sel" : ""), nums.length);
    }
    if (selected && !lotes[selected]) add(selected, "sel empty", "");

    if (selected) renderSheet();
    renderSync();
  }

  // ══ Hoja del lote ══
  function openLot(l) {
    selected = String(l);
    pendingSpot = null;
    $("mp-sheet").classList.add("open");
    render();
  }
  function openSpot(x, y) {
    selected = null;
    pendingSpot = [Math.round(x), Math.round(y)];
    renderSheet();
    $("mp-sheet").classList.add("open");
    render();
  }
  function closeSheet() {
    selected = null;
    pendingSpot = null;
    actionsKey = "";
    $("mp-sheet").classList.remove("open");
    render();
  }

  // Las acciones (input + botones) solo se rearman si cambia el lote o el modo,
  // así un guardado en segundo plano no borra lo que estás escribiendo.
  let actionsKey = "";
  function renderSheet() {
    const title = $("mp-sheet-title"), sub = $("mp-sheet-sub"), chips = $("mp-chips"), act = $("mp-actions");
    const key = (pendingSpot ? "spot:" + pendingSpot.join(",") : "lote:" + selected) + "|" + editing;
    const rebuild = key !== actionsKey;
    actionsKey = key;

    if (pendingSpot) {
      if (!rebuild) return;
      title.textContent = "¿QUÉ LOTE ES?";
      sub.textContent = "No tengo ningún lote ubicado acá. Fijate el número en el plano y escribilo.";
      chips.innerHTML = "";
      act.innerHTML = `
        <div class="mp-add">
          <input id="mp-spot-num" inputmode="numeric" maxlength="4" placeholder="Nº de lote" autocomplete="off"/>
          <button class="mp-btn" id="mp-spot-ok">Ubicar</button>
        </div>`;
      const ok = () => {
        const v = $("mp-spot-num").value.replace(/\D/g, "").replace(/^0+/, "");
        if (!esLote(v)) return toast("Escribí el número de lote");
        const [x, y] = pendingSpot;
        change({ t: "pos", lote: v, x, y }, `Lote ${v} ubicado`);
        openLot(v);
      };
      $("mp-spot-ok").addEventListener("click", ok);
      $("mp-spot-num").addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
      setTimeout(() => $("mp-spot-num")?.focus(), 250);
      return;
    }

    const l = selected;
    const { lotes } = view();
    const nums = lotes[l] || [];
    const q = query();
    const a = album();
    title.textContent = "LOTE " + l;
    sub.textContent = nums.length
      ? `${nums.length} número${nums.length > 1 ? "s" : ""} cargado${nums.length > 1 ? "s" : ""}`
      : "Todavía no cargaste nada en este lote";

    chips.innerHTML = nums.length ? "" : `<span class="mp-empty">—</span>`;
    nums.forEach((n) => {
      const c = document.createElement("span");
      c.className = "mp-chip" + (n === q ? " hit" : "") + (a.has(n) ? " have" : "");
      c.innerHTML = n + (a.has(n) ? " <small>ya en álbum</small>" : "");
      if (editing) {
        const x = document.createElement("button");
        x.textContent = "✕";
        x.title = "Borrar " + n;
        x.addEventListener("click", () => {
          if (!confirm(`¿Borrar el ${n} del lote ${l}?`)) return;
          change({ t: "del", lote: l, num: n }, `Borrado ${n} del lote ${l}`);
        });
        c.appendChild(x);
      }
      chips.appendChild(c);
    });

    if (!rebuild) return;
    if (editing) {
      act.innerHTML = `
        <div class="mp-add">
          <input id="mp-add-num" inputmode="numeric" maxlength="3" placeholder="Nº de patente" autocomplete="off"/>
          <button class="mp-btn" id="mp-add-btn">Agregar</button>
        </div>
        <div class="mp-links">
          <button id="mp-move">📍 Corregir ubicación de este lote</button>
          <button id="mp-forget">🔑 Olvidar clave en este navegador</button>
        </div>`;
      const add = () => {
        const v = $("mp-add-num").value.replace(/\D/g, "");
        if (!v) return toast("Escribí un número");
        const n = pad3(v);
        if ((view().lotes[l] || []).includes(n)) return toast(`El ${n} ya está en el lote ${l}`);
        change({ t: "add", lote: l, num: n }, `Agregado ${n} al lote ${l}`);
        setTimeout(() => $("mp-add-num")?.focus(), 0);
      };
      $("mp-add-btn").addEventListener("click", add);
      $("mp-add-num").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
      $("mp-move").addEventListener("click", () => startPicking(l));
      $("mp-forget").addEventListener("click", forgetToken);
    } else {
      act.innerHTML = `<div class="mp-locked"><span>🔒 Para agregar o borrar números, desbloqueá con tu clave.</span><button class="mp-btn" id="mp-go-unlock">Desbloquear</button></div>`;
      $("mp-go-unlock").addEventListener("click", onLock);
    }
  }

  function startPicking(l) {
    picking = l;
    $("mp-sheet").classList.remove("open");
    $("mp-banner-txt").textContent = `Tocá en el mapa dónde está el lote ${l}`;
    $("mp-banner").classList.add("show");
    $("mp-map").classList.add("picking");
  }
  function stopPicking() {
    picking = null;
    $("mp-banner").classList.remove("show");
    $("mp-map").classList.remove("picking");
  }

  // ══ Clave ══
  function onLock() {
    if (!token) { $("mp-unlock").classList.add("open"); $("mp-unlock-err").textContent = ""; setTimeout(() => $("mp-unlock-input").focus(), 50); return; }
    editing = !editing;
    toast(editing ? "✏️ Modo edición" : "Modo solo lectura");
    render();
  }
  async function unlock() {
    const t = $("mp-unlock-input").value.trim();
    const err = $("mp-unlock-err");
    if (!t) { err.textContent = "Pegá tu clave."; return; }
    err.textContent = "Comprobando…";
    try {
      const r = await fetch(API, { cache: "no-store", headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json" } });
      if (r.status === 401) { err.textContent = "Esa clave no es válida."; return; }
      if (!r.ok) { err.textContent = `GitHub respondió ${r.status}. ¿La clave tiene acceso al repo ${CFG.repo}?`; return; }
      const j = await r.json();
      if (!j.permissions?.push) { err.textContent = "La clave funciona pero no tiene permiso para editar el repo."; return; }
    } catch {
      err.textContent = "Sin conexión. Probá de nuevo cuando tengas señal.";
      return;
    }
    token = t;
    store.set(LS.token, token);
    $("mp-unlock-input").value = "";
    $("mp-unlock").classList.remove("open");
    editing = true;
    lastError = "";
    toast("✏️ Modo edición activado en este navegador");
    render();
    loadData();
  }
  function forgetToken() {
    const msg = ops.length
      ? `Hay ${ops.length} cambio(s) sin subir que se van a perder. ¿Olvidar la clave igual?`
      : "¿Olvidar la clave en este navegador? Para volver a editar vas a tener que pegarla de nuevo.";
    if (!confirm(msg)) return;
    token = "";
    store.del(LS.token);
    ops = [];
    store.set(LS.ops, ops);
    editing = false;
    lastError = "";
    toast("Clave olvidada");
    render();
  }

  // ══ Zoom y arrastre ══
  let z = 1, tx = 0, ty = 0, fitZ = 1;
  let suppressClick = false;

  // Se dibuja como mucho una vez por cuadro de pantalla (el dedo manda muchos más eventos).
  let rafId = 0;
  function apply() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const inner = $("mp-inner");
      inner.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`;
      inner.style.setProperty("--z", z);
    });
  }
  function clampPan() {
    const map = $("mp-map");
    const w = map.clientWidth, h = map.clientHeight, iw = imgW * z, ih = imgH * z;
    tx = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, tx));
    ty = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, ty));
  }
  function computeFit() {
    const map = $("mp-map");
    fitZ = Math.min(map.clientWidth / imgW, map.clientHeight / imgH);
  }
  function fit() { computeFit(); z = fitZ; clampPan(); apply(); }
  function zoomAt(cx, cy, factor) {
    const nz = Math.min(4, Math.max(fitZ, z * factor));
    tx = cx - (cx - tx) * (nz / z);
    ty = cy - (cy - ty) * (nz / z);
    z = nz;
    clampPan();
    apply();
  }
  function focusLot(l) {
    const p = view().pos[l];
    if (!p) return;
    const map = $("mp-map"), inner = $("mp-inner");
    z = Math.max(z, 1.8);
    tx = map.clientWidth / 2 - p[0] * z;
    ty = map.clientHeight * 0.3 - p[1] * z;
    inner.style.transition = "transform 0.35s ease";
    clampPan();
    apply();
    setTimeout(() => (inner.style.transition = ""), 400);
  }
  function initialView() {
    computeFit();
    const map = $("mp-map");
    // en celular (mapa vertical) arranca llenando el alto; en compu, el plano entero
    z = Math.max(fitZ, map.clientHeight / imgH);
    const { lotes, pos } = view();
    const q = query();
    const pts = Object.keys(lotes).filter((l) => q && lotes[l].includes(q) && pos[l]).map((l) => pos[l]);
    const c = pts.length
      ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
      : [imgW / 2, imgH / 2];
    tx = map.clientWidth / 2 - c[0] * z;
    ty = map.clientHeight / 2 - c[1] * z;
    clampPan();
    apply();
  }

  function toImage(clientX, clientY) {
    const r = $("mp-map").getBoundingClientRect();
    return [(clientX - r.left - tx) / z, (clientY - r.top - ty) / z];
  }
  function nearestLot(x, y) {
    const { pos } = view();
    const radio = Math.max(16, 22 / z);
    let best = null, bd = Infinity;
    for (const [l, p] of Object.entries(pos)) {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bd) { bd = d; best = l; }
    }
    return bd <= radio ? best : null;
  }

  function onMapTap(e) {
    if (suppressClick || e.target.closest(".mp-zoom, .mp-banner")) return;
    if (!imgW) return;
    const [x, y] = toImage(e.clientX, e.clientY);
    if (x < 0 || y < 0 || x > imgW || y > imgH) return;
    if (picking) {
      const l = picking;
      stopPicking();
      change({ t: "pos", lote: l, x: Math.round(x), y: Math.round(y) }, `Lote ${l} reubicado`);
      openLot(l);
      return;
    }
    const l = nearestLot(x, y);
    if (l) return openLot(l);
    if (editing) return openSpot(x, y);
    toast("Tocá sobre un número de lote");
  }

  function bindMap() {
    const map = $("mp-map");
    $("mp-z-in").addEventListener("click", () => zoomAt(map.clientWidth / 2, map.clientHeight / 2, 1.5));
    $("mp-z-out").addEventListener("click", () => zoomAt(map.clientWidth / 2, map.clientHeight / 2, 1 / 1.5));
    $("mp-z-fit").addEventListener("click", fit);

    map.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = map.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    const pointers = new Map();
    let start = null, pinch = null;
    map.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".mp-zoom, .mp-banner")) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start = { x: e.clientX, y: e.clientY, tx, ty };
      suppressClick = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z };
      }
      map.classList.add("dragging");
    });
    map.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const r = map.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, (pinch.z * d) / pinch.d / z);
        suppressClick = true;
      } else if (pointers.size === 1 && start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 6) {
          suppressClick = true;
          if (!map.hasPointerCapture(e.pointerId)) map.setPointerCapture(e.pointerId);
        }
        if (suppressClick) { tx = start.tx + dx; ty = start.ty + dy; clampPan(); apply(); }
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) { const p = [...pointers.values()][0]; start = { x: p.x, y: p.y, tx, ty }; }
      if (!pointers.size) { start = null; map.classList.remove("dragging"); setTimeout(() => (suppressClick = false), 0); }
    };
    map.addEventListener("pointerup", end);
    map.addEventListener("pointercancel", end);
    map.addEventListener("click", onMapTap);
  }

  // ══ Toast ══
  let toastT;
  function toast(msg) {
    const t = $("mp-toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ══ Armado de la vista ══
  function build() {
    $("vista-mapa").innerHTML = `
      <section class="mp-toolbar">
        <div class="mp-row">
          <label class="mp-search"><span>Patente</span>
            <input id="mp-q" inputmode="numeric" maxlength="3" placeholder="000" autocomplete="off"/></label>
          <button class="mp-next" id="mp-next">Próximo: <b id="mp-next-num">—</b></button>
          <label class="mp-search lote"><span>Ir a lote</span>
            <input id="mp-lq" inputmode="numeric" maxlength="4" placeholder="638" autocomplete="off"/></label>
          <button class="mp-next" id="mp-lock">🔒 Editar</button>
          <div class="mp-sync" id="mp-sync"></div>
        </div>
        <div class="mp-result" id="mp-result">Cargando…</div>
      </section>
      <div class="mp-map" id="mp-map">
        <div class="mp-loading" id="mp-loading">Cargando plano…</div>
        <div class="mp-inner" id="mp-inner">
          <img id="mp-img" alt="Plano de Santa Bárbara" decoding="async" draggable="false"/>
          <div id="mp-markers"></div>
        </div>
        <div class="mp-banner" id="mp-banner"><span id="mp-banner-txt"></span><button id="mp-banner-x">Cancelar</button></div>
        <div class="mp-zoom">
          <button id="mp-z-in" aria-label="Acercar">+</button>
          <button id="mp-z-out" aria-label="Alejar">−</button>
          <button id="mp-z-fit" aria-label="Ver todo">⤢</button>
        </div>
        <div class="mp-legend">
          <span><i style="background:#7fff6e;border-color:#1a2340"></i>Tiene el número buscado</span>
          <span><i style="background:#1a2340"></i>Lote con números cargados</span>
        </div>
      </div>
      <div class="mp-sheet" id="mp-sheet">
        <div class="mp-grip"></div>
        <div class="mp-sheet-head"><h2 id="mp-sheet-title"></h2><button class="mp-x" id="mp-sheet-x" aria-label="Cerrar">✕</button></div>
        <div class="mp-sub" id="mp-sheet-sub"></div>
        <div class="mp-chips" id="mp-chips"></div>
        <div id="mp-actions"></div>
      </div>
      <div class="mp-overlay" id="mp-unlock">
        <div class="mp-modal">
          <h3>🔑 Modo edición</h3>
          <p>Pegá tu clave (un token de GitHub con permiso para editar el repo <b>${CFG.repo}</b>).
             Se guarda <b>solo en este navegador</b>. Sin clave, el mapa se puede mirar pero no cambiar.</p>
          <input id="mp-unlock-input" type="password" placeholder="github_pat_…" autocomplete="off"/>
          <div class="mp-err" id="mp-unlock-err"></div>
          <div class="mp-row">
            <button class="mp-btn ghost" id="mp-unlock-cancel">Cancelar</button>
            <button class="mp-btn" id="mp-unlock-ok">Desbloquear</button>
          </div>
        </div>
      </div>
      <div class="mp-toast" id="mp-toast"></div>`;

    $("mp-q").addEventListener("input", () => { qTocado = true; $("mp-q").value = $("mp-q").value.replace(/\D/g, ""); render(); });
    $("mp-next").addEventListener("click", () => { $("mp-q").value = proximo(); render(); });
    $("mp-lq").addEventListener("keydown", (e) => { if (e.key === "Enter") goLot(); });
    $("mp-lq").addEventListener("change", goLot);
    $("mp-lock").addEventListener("click", onLock);
    $("mp-sheet-x").addEventListener("click", closeSheet);
    $("mp-banner-x").addEventListener("click", () => { const l = picking; stopPicking(); if (l) openLot(l); });
    $("mp-unlock-cancel").addEventListener("click", () => $("mp-unlock").classList.remove("open"));
    $("mp-unlock-ok").addEventListener("click", unlock);
    $("mp-unlock-input").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
    $("mp-result").addEventListener("click", (e) => {
      const b = e.target.closest(".mp-lot-link");
      if (b) { focusLot(b.dataset.lot); openLot(b.dataset.lot); }
    });
    bindMap();
  }

  function goLot() {
    const v = $("mp-lq").value.replace(/\D/g, "").replace(/^0+/, "");
    if (!v) return;
    if (view().pos[v]) { focusLot(v); openLot(v); $("mp-lq").blur(); }
    else if (editing) { toast(`El lote ${v} no está ubicado. Tocá en el mapa dónde está.`); startPicking(v); }
    else toast(`No tengo ubicado el lote ${v}`);
  }

  function start() {
    if (started) return;
    started = true;
    build();
    const img = $("mp-img");
    img.addEventListener("load", () => {
      imgW = img.naturalWidth;
      imgH = img.naturalHeight;
      img.style.width = imgW + "px";
      img.style.height = imgH + "px";
      $("mp-inner").style.width = imgW + "px";
      $("mp-inner").style.height = imgH + "px";
      $("mp-loading").remove();
      initialView();
    });
    img.src = CFG.img;
    if (base) $("mp-q").value = proximo();
    render();
    Promise.all([loadPos(), loadData()]).then(() => {
      // si no tocaste el buscador, que muestre el próximo número del álbum ya actualizado
      if (!qTocado) $("mp-q").value = proximo();
      render();
      if (imgW) initialView();
    });
  }

  // ══ Pestañas ══
  function setHeaderVar() {
    document.body.style.setProperty("--mp-hh", document.querySelector("header").offsetHeight + "px");
  }
  function setVista(v) {
    const mapa = v === "mapa";
    document.body.classList.toggle("modo-mapa", mapa);
    document.querySelectorAll(".mp-tab").forEach((t) => t.classList.toggle("active", t.dataset.vista === v));
    if (location.hash !== (mapa ? "#mapa" : "") && !(location.hash === "" && !mapa)) {
      history.replaceState(null, "", mapa ? "#mapa" : location.pathname + location.search);
    }
    setHeaderVar();
    if (mapa) {
      start();
      if (imgW) { computeFit(); z = Math.max(z, fitZ); clampPan(); apply(); }
    }
  }
  document.querySelectorAll(".mp-tab").forEach((t) => t.addEventListener("click", () => setVista(t.dataset.vista)));
  window.addEventListener("hashchange", () => setVista(location.hash === "#mapa" ? "mapa" : "album"));
  window.addEventListener("resize", () => {
    setHeaderVar();
    if (imgW && started) { computeFit(); z = Math.max(z, fitZ); clampPan(); apply(); }
  });
  setVista(location.hash === "#mapa" ? "mapa" : "album");

  // Si quedaron cambios sin subir de otra vez (p. ej. cerraste la pestaña sin señal),
  // se suben al abrir la página, aunque entres por la pestaña Álbum.
  if (ops.length && token) flush();
})();
