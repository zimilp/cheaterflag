'use strict';
// In-app 2D replay of one moment: top-down map (built from where players walked), players, aim lines,
// who could see whom, shots, kills, smokes, flashes — with play/pause, slow motion and a scrub bar.
// Data comes from lib/replay.js (buildReplay). Exposes window.CFReplay.open(data, opts).
(function () {
  const CT = '#5b9bd5', TT = '#e0a030';
  const norm = (a) => ((a % 360) + 540) % 360 - 180;
  const lerp = (a, b, f) => a + (b - a) * f;
  const bearing = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax) * 180 / Math.PI;

  /** Horizontal angle between where `a` aims and the direction to `b` (degrees, 0 = dead on). */
  function aimError(a, b) { return Math.abs(norm(a.yaw - bearing(a.x, a.y, b.x, b.y))); }

  /** Player states at a fractional tick, interpolated between the two nearest frames. */
  function stateAt(data, tick) {
    const F = data.frames; if (!F.length) return [];
    let lo = 0, hi = F.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F[m].t <= tick) lo = m; else hi = m; }
    const A = F[lo], B = F[hi], f = B.t === A.t ? 0 : Math.max(0, Math.min(1, (tick - A.t) / (B.t - A.t)));
    const bmap = new Map(B.p.map((r) => [r[0], r]));
    return A.p.map((r) => {
      const b = bmap.get(r[0]) || r;
      const alive = f < 0.5 ? r[5] : b[5];
      return { i: r[0], x: lerp(r[1], b[1], f), y: lerp(r[2], b[2], f), yaw: r[3] + norm(b[3] - r[3]) * f, alive: !!alive, hp: f < 0.5 ? r[6] : b[6], mask: f < 0.5 ? r[7] : b[7] };
    });
  }
  const seenBy = (s, j) => !!(s.mask & (1 << j));
  const SPOT_LAG = 32;   // CS2's "spotted" flag runs ~half a second behind what players can actually see

  /** Visible = spotted now or within the next half second (allows for the lag of the spotted flag). Runs once per replay. */
  function lagAdjust(data) {
    if (data._lagAdjusted) return data;
    const F = data.frames;
    const raw = F.map((fr) => new Map(fr.p.map((r) => [r[0], r[7]])));
    let j = 0;
    for (let i = 0; i < F.length; i++) {
      if (j < i) j = i;
      while (j + 1 < F.length && F[j + 1].t - F[i].t <= SPOT_LAG) j++;
      for (const r of F[i].p) { let m = 0; for (let k = i; k <= j; k++) m |= raw[k].get(r[0]) || 0; r[7] = m; }
    }
    // a kill with no wall between them means line of sight: the victim was visible to the killer just before it
    for (const e of data.events) {
      if (e.type !== 'kill' || e.wall || e.a == null || e.v == null) continue;
      for (const fr of F) if (fr.t >= e.t - SPOT_LAG && fr.t <= e.t) { const r = fr.p.find((x) => x[0] === e.v); if (r) r[7] |= 1 << e.a; }
    }
    data._lagAdjusted = true;
    return data;
  }

  /** Who the focus player was fighting: the victim of their next kill in the window, else the enemy they aim closest to at the moment. */
  function targetOf(data) {
    if (data.focus == null) return null;
    const k = data.events.find((e) => e.type === 'kill' && e.a === data.focus && e.t >= data.moment - 64);
    if (k && k.v != null) return k.v;
    const st = stateAt(data, data.moment), me = st.find((s) => s.i === data.focus);
    if (!me) return null;
    let best = null, bestErr = 1e9;
    for (const s of st) if (s.alive && data.players[s.i].team !== data.players[data.focus].team) { const e = aimError(me, s); if (e < bestErr) { bestErr = e; best = s.i; } }
    return best;
  }
  /** Focus player's aim error to the target over the whole window: [{t, err, seen}]. */
  function aimTrace(data, target) {
    if (data.focus == null || target == null) return [];
    return data.frames.map((fr) => {
      const a = fr.p.find((r) => r[0] === data.focus), b = fr.p.find((r) => r[0] === target);
      if (!a || !b || !a[5] || !b[5]) return null;
      return { t: fr.t, err: aimError({ x: a[1], y: a[2], yaw: a[3] }, { x: b[1], y: b[2] }), seen: !!(b[7] & (1 << data.focus)) };
    }).filter(Boolean);
  }

  function floorCanvas(floor) {
    const bits = Uint8Array.from(atob(floor.data), (c) => c.charCodeAt(0));
    const cv = document.createElement('canvas'); cv.width = floor.cols; cv.height = floor.rows;
    const g = cv.getContext('2d'), img = g.createImageData(floor.cols, floor.rows);
    for (let i = 0; i < floor.cols * floor.rows; i++) if (bits[i >> 3] & (1 << (i & 7))) { img.data[i * 4] = 48; img.data[i * 4 + 1] = 55; img.data[i * 4 + 2] = 70; img.data[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
    return cv;
  }

  function open(data, opts = {}) {
    close();
    lagAdjust(data);
    const meIdx = opts.me ? data.players.findIndex((p) => p.steamid === opts.me) : -1;
    const focus = data.focus, target = targetOf(data), trace = aimTrace(data, target);
    const wrap = document.createElement('div'); wrap.id = 'replayModal';
    wrap.innerHTML = `
      <div class="rp-box">
        <div class="rp-head"><b class="rp-title"></b><span class="muted rp-map"></span><span class="rp-sp"></span>
          <button class="rp-cs2" title="Open this moment in CS2 (first-person)">Watch in CS2</button><button class="rp-x" title="Close">✕</button></div>
        <div class="rp-body">
          <canvas class="rp-map-cv"></canvas>
          <div class="rp-side">
            <div class="rp-aim"></div>
            <canvas class="rp-trace" width="260" height="110"></canvas>
            <div class="muted small rp-trace-note"></div>
            <div class="rp-feed"></div>
            <div class="rp-legend muted small">
              <div><i style="background:${CT}"></i>CT <i style="background:${TT}"></i>T &nbsp; <i class="ring"></i>suspect${meIdx >= 0 ? ' <i class="ring me"></i>you' : ''}</div>
              <div><i class="ghost"></i>faded = the suspect could <b>not</b> see this enemy (game's own visibility data, ~0.5 s precision)</div>
              <div>Long white line = where the suspect is aiming</div>
            </div>
          </div>
        </div>
        <div class="rp-ctrl">
          <button class="rp-play">❚❚</button>
          <select class="rp-speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option></select>
          <div class="rp-scrub"><canvas class="rp-marks"></canvas><input type="range" class="rp-range" /></div>
          <span class="rp-time muted small"></span>
          <label class="small muted rp-wl"><input type="checkbox" class="rp-whole" /><span>Whole map</span></label>
        </div>
      </div>`;
    document.body.append(wrap);
    const q = (s) => wrap.querySelector(s);
    const fp = focus != null ? data.players[focus] : null, tp = target != null ? data.players[target] : null;
    q('.rp-title').textContent = opts.title || (fp ? `${fp.name}` : 'Replay');
    q('.rp-map').textContent = ' · ' + String(data.map || '').replace(/^de_/, '').replace(/^\w/, (c) => c.toUpperCase());
    q('.rp-x').onclick = close;
    if (opts.onWatchCs2) q('.rp-cs2').onclick = () => opts.onWatchCs2(); else q('.rp-cs2').remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

    // ---- view box: the action around the suspect (or the whole map)
    const fl = data.floor, fimg = fl ? floorCanvas(fl) : null;
    const world = fl ? { x0: fl.minX, y1: fl.maxY, w: fl.cols * fl.cell, h: fl.rows * fl.cell } : null;
    function actionBox() {
      const pts = [];
      for (const fr of data.frames) for (const r of fr.p) if (r[5] && (r[0] === focus || r[0] === target || r[0] === meIdx || focus == null)) pts.push([r[1], r[2]]);
      if (!pts.length) return world;
      let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, size = Math.max(2200, x1 - x0 + 900, y1 - y0 + 900);
      return { x0: cx - size / 2, y1: cy + size / 2, w: size, h: size };
    }
    let view = actionBox() || { x0: -2000, y1: 2000, w: 4000, h: 4000 };
    q('.rp-whole').onchange = (e) => { view = e.target.checked && world ? world : actionBox(); draw(); };

    const cv = q('.rp-map-cv'), g = cv.getContext('2d');
    const size = () => { const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d; g.setTransform(d, 0, 0, d, 0, 0); return r; };
    let box = size();
    const S = () => Math.min(box.width / view.w, box.height / view.h);
    const px = (x) => (box.width - view.w * S()) / 2 + (x - view.x0) * S();
    const py = (y) => (box.height - view.h * S()) / 2 + (view.y1 - y) * S();

    // ---- timeline
    const range = q('.rp-range'); range.min = data.from; range.max = data.to; range.step = 1;
    let tick = Math.max(data.from, data.moment - 64 * 2), playing = true, speed = 1, last = performance.now();
    const marks = q('.rp-marks');
    function drawMarks() {
      const r = marks.getBoundingClientRect(); marks.width = r.width; marks.height = r.height; const m = marks.getContext('2d');
      const X = (t) => (t - data.from) / (data.to - data.from) * r.width;
      m.fillStyle = '#f2b233'; m.fillRect(X(data.moment) - 1, 0, 2, r.height);
      for (const e of data.events) if (e.type === 'kill') { m.fillStyle = e.a === focus ? '#ff4d4f' : '#c9ced8'; m.fillRect(X(e.t) - 1.5, 0, 3, r.height); }
    }
    q('.rp-play').onclick = () => { playing = !playing; if (playing && tick >= data.to) tick = data.from; last = performance.now(); q('.rp-play').textContent = playing ? '❚❚' : '▶'; };
    q('.rp-speed').onchange = (e) => { speed = Number(e.target.value); };
    range.oninput = () => { tick = Number(range.value); playing = false; q('.rp-play').textContent = '▶'; draw(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === ' ') { e.preventDefault(); q('.rp-play').click(); } if (e.key === 'ArrowLeft') { tick = Math.max(data.from, tick - 16); draw(); } if (e.key === 'ArrowRight') { tick = Math.min(data.to, tick + 16); draw(); } };
    document.addEventListener('keydown', onKey);
    const onResize = () => { box = size(); drawMarks(); draw(); };
    window.addEventListener('resize', onResize);

    // ---- side panel: aim trace (the tell-tale shape of a snap or a wall-track)
    const tc = q('.rp-trace'), tg = tc.getContext('2d');
    function drawTrace() {
      const W = tc.width, H = tc.height; tg.clearRect(0, 0, W, H);
      tg.fillStyle = '#12151c'; tg.fillRect(0, 0, W, H);
      if (!trace.length) { tg.fillStyle = '#8a92a3'; tg.font = '12px Segoe UI'; tg.fillText('No target to measure aim against', 10, H / 2); return; }
      const X = (t) => (t - data.from) / (data.to - data.from) * W, Y = (e) => H - 6 - Math.min(90, e) / 90 * (H - 12);
      tg.strokeStyle = '#262b36'; for (const d of [0, 30, 60, 90]) { tg.beginPath(); tg.moveTo(0, Y(d)); tg.lineTo(W, Y(d)); tg.stroke(); }
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1], b = trace[i]; if (b.t - a.t > 8) continue;
        tg.strokeStyle = b.seen ? '#2fbf71' : '#ff4d4f'; tg.lineWidth = 2;
        tg.beginPath(); tg.moveTo(X(a.t), Y(a.err)); tg.lineTo(X(b.t), Y(b.err)); tg.stroke();
      }
      tg.fillStyle = '#e7e9ee'; tg.fillRect(X(tick) - 0.5, 0, 1, H);
      tg.fillStyle = '#8a92a3'; tg.font = '10px Segoe UI'; tg.fillText('90°', 2, Y(90) + 10); tg.fillText('0° = on target', 2, H - 8);
    }
    q('.rp-trace-note').innerHTML = tp ? `Aim distance from <b></b> over time. <span style="color:#2fbf71">Green</span> = visible to the suspect, <span style="color:#ff4d4f">red</span> = hidden. A near-vertical drop to 0° is a snap; a flat red line near 0° is tracking through a wall.` : '';
    if (tp) q('.rp-trace-note b').textContent = tp.name;

    function draw() {
      g.clearRect(0, 0, box.width, box.height);
      g.fillStyle = '#0b0d11'; g.fillRect(0, 0, box.width, box.height);
      if (fimg && world) { g.imageSmoothingEnabled = true; g.drawImage(fimg, px(world.x0), py(world.y1), world.w * S(), world.h * S()); }
      const s = S();
      g.font = 'bold 22px Segoe UI'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const site of data.sites || []) { g.fillStyle = 'rgba(255,90,54,.35)'; g.fillText(site.name, px(site.x), py(site.y)); }
      // utility
      for (const e of data.events) {
        if ((e.type === 'smoke' || e.type === 'fire') && tick >= e.t && tick <= e.until) {
          g.fillStyle = e.type === 'smoke' ? 'rgba(200,205,215,.55)' : 'rgba(255,120,40,.35)';
          g.beginPath(); g.arc(px(e.x), py(e.y), (e.type === 'smoke' ? 144 : 120) * s, 0, 7); g.fill();
        }
        if ((e.type === 'flash' || e.type === 'he') && tick >= e.t && tick <= e.t + 32) {
          const a = 1 - (tick - e.t) / 32; g.fillStyle = e.type === 'flash' ? `rgba(255,255,255,${a * 0.8})` : `rgba(255,90,54,${a * 0.6})`;
          g.beginPath(); g.arc(px(e.x), py(e.y), 200 * s * (1.2 - a * 0.5), 0, 7); g.fill();
        }
      }
      const st = stateAt(data, tick), byI = new Map(st.map((x) => [x.i, x]));
      const blind = new Set(data.events.filter((e) => e.type === 'blind' && tick >= e.t && tick <= e.until).map((e) => e.v));
      const fs = focus != null ? byI.get(focus) : null;
      // the suspect's aim line
      if (fs && fs.alive) {
        const r = (fs.yaw * Math.PI) / 180, L = 4000;
        const grad = g.createLinearGradient(px(fs.x), py(fs.y), px(fs.x + Math.cos(r) * L), py(fs.y + Math.sin(r) * L));
        grad.addColorStop(0, 'rgba(255,255,255,.9)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.strokeStyle = grad; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px(fs.x), py(fs.y)); g.lineTo(px(fs.x + Math.cos(r) * L), py(fs.y + Math.sin(r) * L)); g.stroke();
      }
      // kills: line from killer to victim for 1.5 s
      for (const e of data.events) if (e.type === 'kill' && tick >= e.t && tick <= e.t + 96 && e.a != null && e.v != null) {
        const a = byI.get(e.a), v = byI.get(e.v); if (!a || !v) continue;
        g.strokeStyle = `rgba(255,77,79,${1 - (tick - e.t) / 96})`; g.lineWidth = 2; g.setLineDash(e.wall ? [6, 4] : []);
        g.beginPath(); g.moveTo(px(a.x), py(a.y)); g.lineTo(px(v.x), py(v.y)); g.stroke(); g.setLineDash([]);
      }
      // players
      g.textAlign = 'center'; g.textBaseline = 'bottom'; g.font = '11px Segoe UI';
      for (const p of st) {
        const info = data.players[p.i]; if (!info) continue;
        const X = px(p.x), Y = py(p.y), col = info.team === 'CT' ? CT : TT;
        if (!p.alive) { g.strokeStyle = '#6b7280'; g.lineWidth = 2; g.beginPath(); g.moveTo(X - 5, Y - 5); g.lineTo(X + 5, Y + 5); g.moveTo(X + 5, Y - 5); g.lineTo(X - 5, Y + 5); g.stroke(); continue; }
        const hidden = fp && info.team !== fp.team && fs && fs.alive && !seenBy(p, focus);
        g.globalAlpha = hidden ? 0.35 : 1;
        if (blind.has(p.i)) { g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(X, Y, 13, 0, 7); g.fill(); }
        const r = (p.yaw * Math.PI) / 180;
        g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(X, Y); g.lineTo(X + Math.cos(r) * 16, Y - Math.sin(r) * 16); g.stroke();
        g.fillStyle = col; g.beginPath(); g.arc(X, Y, 7, 0, 7); g.fill();
        if (hidden) { g.setLineDash([3, 3]); g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.arc(X, Y, 9, 0, 7); g.stroke(); g.setLineDash([]); }
        if (p.i === focus) { g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(X, Y, 11, 0, 7); g.stroke(); }
        if (p.i === meIdx) { g.strokeStyle = '#2fbf71'; g.lineWidth = 2.5; g.beginPath(); g.arc(X, Y, 11, 0, 7); g.stroke(); }
        // muzzle flash for shots in the last 6 ticks
        if (data.events.some((e) => e.type === 'shot' && e.a === p.i && tick >= e.t && tick <= e.t + 6)) { g.strokeStyle = '#ffd36b'; g.lineWidth = 3; g.beginPath(); g.moveTo(X + Math.cos(r) * 10, Y - Math.sin(r) * 10); g.lineTo(X + Math.cos(r) * 26, Y - Math.sin(r) * 26); g.stroke(); }
        g.fillStyle = '#e7e9ee'; g.fillText(info.name.slice(0, 16), X, Y - 12);
        g.globalAlpha = 1;
      }
      // side: what the suspect is aiming at right now
      const aimEl = q('.rp-aim');
      if (fs && fs.alive) {
        let best = null;
        for (const p of st) if (p.alive && data.players[p.i].team !== fp.team) { const e = aimError(fs, p); if (!best || e < best.e) best = { p, e }; }
        aimEl.innerHTML = best ? `<div class="muted small">${escapeHtml(fp.name)} is aiming</div><div class="rp-big">${best.e.toFixed(1)}°</div><div class="small">from <b>${escapeHtml(data.players[best.p.i].name)}</b> — <span style="color:${seenBy(best.p, focus) ? '#2fbf71' : '#ff4d4f'}">${seenBy(best.p, focus) ? 'visible to them' : 'hidden from them'}</span></div>` : '';
      } else aimEl.innerHTML = fp ? `<div class="muted small">${escapeHtml(fp.name)} is dead</div>` : '';
      // kill feed so far
      q('.rp-feed').innerHTML = data.events.filter((e) => e.type === 'kill' && e.t <= tick).slice(-5).map((e) =>
        `<div class="small"><b style="color:${e.a != null && data.players[e.a].team === 'CT' ? CT : TT}">${escapeHtml(e.a != null ? data.players[e.a].name : '?')}</b> ${escapeHtml(e.weapon)}${e.hs ? ' ⊙' : ''}${e.wall ? ' ⟂wall' : ''}${e.smoke ? ' ☁smoke' : ''}${e.blind ? ' ✺blind' : ''} <b style="color:${e.v != null && data.players[e.v].team === 'CT' ? CT : TT}">${escapeHtml(e.v != null ? data.players[e.v].name : '?')}</b></div>`).join('');
      const secs = (tick - data.moment) / data.tickrate;
      q('.rp-time').textContent = `${secs >= 0 ? '+' : '−'}${Math.abs(secs).toFixed(1)} s`;
      range.value = Math.round(tick);
      drawTrace();
    }
    function frame(now) {
      if (!document.getElementById('replayModal')) return;
      if (playing) { tick += ((now - last) / 1000) * data.tickrate * speed; if (tick >= data.to) { tick = data.to; playing = false; q('.rp-play').textContent = '▶'; } draw(); }
      last = now; requestAnimationFrame(frame);
    }
    wrap._cleanup = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
    drawMarks(); draw(); requestAnimationFrame(frame);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function close() { const w = document.getElementById('replayModal'); if (w) { w._cleanup && w._cleanup(); w.remove(); } }
  /** Loading placeholder while the demo is parsed. */
  function loading(text) {
    close();
    const w = document.createElement('div'); w.id = 'replayModal';
    w.innerHTML = '<div class="rp-box rp-loading"><div class="rp-head"><b>Replay</b><span class="rp-sp"></span><button class="rp-x">✕</button></div><div class="rp-msg muted"></div></div>';
    document.body.append(w); w.querySelector('.rp-msg').textContent = text; w.querySelector('.rp-x').onclick = close;
    return (t) => { const m = w.querySelector('.rp-msg'); if (m) m.textContent = t; };
  }

  const api = { open, close, loading, stateAt, aimError, targetOf, aimTrace, lagAdjust, SPOT_LAG };
  if (typeof window !== 'undefined') window.CFReplay = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
