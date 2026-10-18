/* Retouch brush: paint over a region to take its pixels from one chosen photo.
   For the halos around legs and setae at depth edges that automatic merging
   never fully solves.

   SpoodRetouch.open({ root, stack: ImageData (current picture), auto: ImageData
     (the automatic stack, if different), frames: [{photo, used, why, ref, blob,
     focus:{width,height,data}}], onDone(canvas, changed), onCancel() })

   Modes: Paint (one finger paints), Pick (tap a spot: the photo sharpest there
   is chosen and previewed in a lens; tap again to cycle to the next sharpest;
   dragging pans), Move (one finger pans). Two fingers always pan and zoom; a mouse wheel zooms.
   "Hold to peek" shows the chosen photo across the whole frame. */
(function (root) {
  'use strict';
  const TILE = 128;

  function open(o) {
    const $ = s => o.root.querySelector(s);
    const stage = $('[data-rt=stage]'), view = $('[data-rt=view]'), chips = $('[data-rt=src]');
    const toastEl = $('[data-rt=toast]'), sizeEl = $('[data-rt=size]'), softEl = $('[data-rt=soft]');
    const undoBtn = $('[data-rt=undo]'), peekBtn = $('[data-rt=peek]');
    const modeBtns = [...o.root.querySelectorAll('[data-mode]')];
    const W = o.stack.width, H = o.stack.height;

    // full-size working image; `orig` keeps the automatic stack for the "Stack" source
    const work = document.createElement('canvas'); work.width = W; work.height = H;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    const img = new ImageData(new Uint8ClampedArray(o.stack.data), W, H);
    const orig = o.auto || o.stack;              // the automatic stack, for the "Stack" source
    wctx.putImageData(img, 0, 0);

    const frames = o.frames.slice().sort((a, b) => a.photo - b.photo);
    let src = -1;                   // -1 = the stack itself, else index into frames
    const cache = new Map();        // index -> {data: ImageData, canvas}
    const origCanvas = document.createElement('canvas'); origCanvas.width = W; origCanvas.height = H;
    origCanvas.getContext('2d').putImageData(orig, 0, 0);

    let mode = 'pick', peek = false, lens = null, strokes = [], stroke = null, dirty = null;
    let s = 1, tx = 0, ty = 0, dpr = 1, raf = 0, cursor = null;
    let pickAt = null, ranked = [], rankPos = 0;
    const listeners = [];
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); };

    // ---------- sources ----------
    async function source(i) {
      if (i < 0) return { data: orig, canvas: origCanvas };
      if (cache.has(i)) { const c = cache.get(i); cache.delete(i); cache.set(i, c); return c; }
      const bmp = await createImageBitmap(frames[i].blob);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, W, H); bmp.close && bmp.close();
      const entry = { data: g.getImageData(0, 0, W, H), canvas: c };
      cache.set(i, entry);
      while (cache.size > 2) { const k = cache.keys().next().value; const e = cache.get(k); e.canvas.width = e.canvas.height = 0; cache.delete(k); }
      return entry;
    }
    let cur = { data: orig, canvas: origCanvas };
    async function choose(i, why) {
      src = i; renderChips();
      cur = await source(i);
      if (why) toast(why);
      draw();
    }

    function renderChips() {
      chips.textContent = '';
      const mk = (label, i, title, cls) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'rt-chip' + (cls ? ' ' + cls : ''); b.textContent = label;
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(src === i)); b.title = title;
        b.onclick = () => choose(i, i < 0 ? 'Painting puts back the automatic stack' : `Painting from photo ${frames[i].photo}`);
        chips.appendChild(b);
      };
      mk('Stack', -1, 'The automatic stack (use it to undo painting in one area)', 'stack');
      frames.forEach((f, i) => mk(String(f.photo), i, f.used ? (f.ref ? 'Reference photo' : 'Used in the stack') : `Left out: ${f.why}`, f.used ? '' : 'unused'));
    }

    // ---------- view ----------
    function fit() {
      const r = stage.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      view.width = Math.round(r.width * dpr); view.height = Math.round(r.height * dpr);
      s = Math.min(view.width / W, view.height / H);
      tx = (view.width - W * s) / 2; ty = (view.height - H * s) / 2;
      draw();
    }
    function draw() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (dirty) { wctx.putImageData(img, 0, 0, dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0); dirty = null; }
        const g = view.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = '#0d1110'; g.fillRect(0, 0, view.width, view.height);
        g.setTransform(s, 0, 0, s, tx, ty);
        g.imageSmoothingEnabled = s < 2; g.imageSmoothingQuality = 'high';
        g.drawImage(peek ? cur.canvas : work, 0, 0);
        if (lens && !peek) {
          g.save(); g.beginPath(); g.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2); g.clip();
          g.drawImage(cur.canvas, 0, 0); g.restore();
          g.lineWidth = 2 / s; g.strokeStyle = '#4fc2b9'; g.beginPath(); g.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2); g.stroke();
        }
        if (cursor && mode === 'paint') {
          const r = brushR();
          g.lineWidth = 1.5 / s;
          g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(cursor.x, cursor.y, r, 0, Math.PI * 2); g.stroke();
          g.strokeStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(cursor.x, cursor.y, r + 1.5 / s, 0, Math.PI * 2); g.stroke();
        }
        if (peek) {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.font = `${14 * dpr}px system-ui, sans-serif`; g.fillStyle = 'rgba(0,0,0,.6)';
          const t = src < 0 ? 'Automatic stack' : `Photo ${frames[src].photo}`;
          g.fillRect(8 * dpr, 8 * dpr, g.measureText(t).width + 16 * dpr, 26 * dpr);
          g.fillStyle = '#fff'; g.fillText(t, 16 * dpr, 26 * dpr);
        }
      });
    }
    const toImg = (cx, cy) => { const r = view.getBoundingClientRect(); return { x: ((cx - r.left) * dpr - tx) / s, y: ((cy - r.top) * dpr - ty) / s }; };
    const brushR = () => (+sizeEl.value) * dpr / s / 2;       // slider is the on-screen diameter in CSS px
    function zoomAt(cx, cy, f) {
      const r = view.getBoundingClientRect(), px = (cx - r.left) * dpr, py = (cy - r.top) * dpr;
      const ns = Math.max(Math.min(view.width / W, view.height / H) * 0.8, Math.min(8, s * f));
      tx = px - (px - tx) * ns / s; ty = py - (py - ty) * ns / s; s = ns;
      draw();
    }

    // ---------- painting ----------
    function dab(cx, cy) {
      const r = brushR(), inner = r * (1 - 0.9 * (+softEl.value) / 100);
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W, Math.ceil(cx + r + 1));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H, Math.ceil(cy + r + 1));
      if (x0 >= x1 || y0 >= y1) return;
      const D = img.data, S = cur.data.data;
      for (let ty0 = Math.floor(y0 / TILE); ty0 <= Math.floor((y1 - 1) / TILE); ty0++) {
        for (let tx0 = Math.floor(x0 / TILE); tx0 <= Math.floor((x1 - 1) / TILE); tx0++) {
          const t = tile(tx0, ty0);
          const ax = Math.max(x0, t.x), bx = Math.min(x1, t.x + t.w), ay = Math.max(y0, t.y), by = Math.min(y1, t.y + t.h);
          for (let y = ay; y < by; y++) {
            const dy = y - cy;
            for (let x = ax; x < bx; x++) {
              const dx = x - cx, d = Math.sqrt(dx * dx + dy * dy);
              if (d >= r) continue;
              let a = d <= inner ? 1 : (r - d) / (r - inner);
              a = a * a * (3 - 2 * a);                                  // smoothstep edge
              const k = (y - t.y) * t.w + (x - t.x);
              if (a <= t.alpha[k]) continue;
              t.alpha[k] = a;
              const p = (y * W + x) * 4, q = k * 4, B = t.before;
              D[p] = B[q] + (S[p] - B[q]) * a; D[p + 1] = B[q + 1] + (S[p + 1] - B[q + 1]) * a; D[p + 2] = B[q + 2] + (S[p + 2] - B[q + 2]) * a;
            }
          }
        }
      }
      dirty = dirty ? { x0: Math.min(dirty.x0, x0), y0: Math.min(dirty.y0, y0), x1: Math.max(dirty.x1, x1), y1: Math.max(dirty.y1, y1) } : { x0, y0, x1, y1 };
      stroke.dabs++;
    }
    function tile(i, j) {
      const key = j * 100000 + i;
      let t = stroke.tiles.get(key);
      if (!t) {
        const x = i * TILE, y = j * TILE, w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
        const before = new Uint8ClampedArray(w * h * 4);
        for (let r = 0; r < h; r++) before.set(img.data.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4);
        t = { x, y, w, h, before, alpha: new Float32Array(w * h) };
        stroke.tiles.set(key, t);
      }
      return t;
    }
    function restore(st) {
      for (const t of st.tiles.values()) {
        for (let r = 0; r < t.h; r++) img.data.set(t.before.subarray(r * t.w * 4, (r + 1) * t.w * 4), ((t.y + r) * W + t.x) * 4);
        dirty = dirty ? { x0: Math.min(dirty.x0, t.x), y0: Math.min(dirty.y0, t.y), x1: Math.max(dirty.x1, t.x + t.w), y1: Math.max(dirty.y1, t.y + t.h) } : { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h };
      }
    }
    function lineTo(p) {
      const last = stroke.last, r = brushR(), step = Math.max(1, r * 0.2);
      const dx = p.x - last.x, dy = p.y - last.y, n = Math.ceil(Math.hypot(dx, dy) / step);
      for (let k = 1; k <= n; k++) dab(last.x + dx * k / n, last.y + dy * k / n);
      stroke.last = p;
    }
    function endStroke() {
      if (!stroke) return;
      for (const t of stroke.tiles.values()) t.alpha = null;    // only the "before" pixels are needed for undo
      if (stroke.tiles.size) { strokes.push(stroke); if (strokes.length > 40) strokes.shift(); }
      stroke = null; undoBtn.disabled = !strokes.length;
    }
    function cancelStroke() { if (stroke) { restore(stroke); stroke = null; draw(); } }

    // ---------- "sharpest here" ----------
    function rank(p) {
      return frames.map((f, i) => {
        const F = f.focus, fx = Math.floor(p.x / W * F.width), fy = Math.floor(p.y / H * F.height);
        let v = 0;
        for (let y = Math.max(0, fy - 1); y <= Math.min(F.height - 1, fy + 1); y++)
          for (let x = Math.max(0, fx - 1); x <= Math.min(F.width - 1, fx + 1); x++) v = Math.max(v, F.data[y * F.width + x]);
        return { i, v };
      }).sort((a, b) => b.v - a.v);
    }
    async function pick(p) {
      const r = Math.max(brushR(), 12 / s);
      const again = pickAt && Math.hypot(p.x - pickAt.x, p.y - pickAt.y) < r;
      if (again) rankPos = (rankPos + 1) % ranked.length;
      else { ranked = rank(p); rankPos = 0; pickAt = p; }
      const best = ranked[0].v || 1e-12, it = ranked[rankPos];
      lens = { x: pickAt.x, y: pickAt.y, r: r * 1.6 };
      const rel = Math.round(100 * it.v / best);
      await choose(it.i, `Photo ${frames[it.i].photo}: ${rankPos === 0 ? 'sharpest here' : `${rel}% as sharp as the best`} (${rankPos + 1} of ${ranked.length}). Tap again for the next, or Paint.`);
    }

    // ---------- input ----------
    const pts = new Map();
    let gesture = null, tap = null;
    on(view, 'pointerdown', e => {
      view.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        if (stroke && stroke.dabs < 8) cancelStroke(); else endStroke();
        const [a, b] = [...pts.values()];
        gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        tap = null; return;
      }
      if (pts.size > 2) return;
      const p = toImg(e.clientX, e.clientY);
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), p };
      if (mode === 'paint' && e.button === 0) {
        stroke = { tiles: new Map(), last: p, dabs: 0 }; lens = null;
        dab(p.x, p.y); draw();
      } else gesture = { pan: { x: e.clientX, y: e.clientY } };          // Pick and Move: drag pans, a tap picks
    });
    on(view, 'pointermove', e => {
      cursor = toImg(e.clientX, e.clientY);
      if (!pts.has(e.pointerId)) { if (mode === 'paint') draw(); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap = null;
      if (pts.size === 2 && gesture && gesture.d) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        tx += (cx - gesture.cx) * dpr; ty += (cy - gesture.cy) * dpr;
        zoomAt(cx, cy, d / gesture.d);
        gesture = { d, cx, cy };
      } else if (gesture && gesture.pan) {
        tx += (e.clientX - gesture.pan.x) * dpr; ty += (e.clientY - gesture.pan.y) * dpr;
        gesture.pan = { x: e.clientX, y: e.clientY }; draw();
      } else if (stroke) { lineTo(cursor); draw(); }
    });
    const up = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2 && gesture && gesture.d) gesture = null;
      if (!pts.size) {
        if (gesture && gesture.pan) gesture = null;
        if (stroke) endStroke();
        if (tap && mode === 'pick' && performance.now() - tap.t < 600) pick(tap.p);
        tap = null;
      }
    };
    on(view, 'pointerup', up); on(view, 'pointercancel', up);
    on(view, 'pointerleave', () => { cursor = null; draw(); });
    on(view, 'wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    on(window, 'resize', fit);

    function setMode(m) {
      mode = m;
      modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
      view.style.cursor = m === 'move' ? 'grab' : m === 'paint' ? 'none' : 'crosshair';
      if (m !== 'pick') lens = null;
      draw();
    }
    modeBtns.forEach(b => on(b, 'click', () => setMode(b.dataset.mode)));
    on(undoBtn, 'click', () => { const st = strokes.pop(); if (st) { restore(st); draw(); } undoBtn.disabled = !strokes.length; });
    const peekOn = e => { e.preventDefault(); peek = true; draw(); }, peekOff = () => { peek = false; draw(); };
    on(peekBtn, 'pointerdown', peekOn); on(peekBtn, 'pointerup', peekOff); on(peekBtn, 'pointerleave', peekOff); on(peekBtn, 'pointercancel', peekOff);
    on(peekBtn, 'keydown', e => { if (e.key === ' ' || e.key === 'Enter') peekOn(e); });
    on(peekBtn, 'keyup', peekOff);
    on(peekBtn, 'contextmenu', e => e.preventDefault());       // long-press must not open a menu
    on(sizeEl, 'input', () => { if (lens) lens.r = brushR() * 1.6; draw(); });
    on($('[data-rt=done]'), 'click', () => { endStroke(); close(); o.onDone(work, strokes.length > 0); });
    on($('[data-rt=cancel]'), 'click', () => {
      if (strokes.length && !confirm('Discard your retouching?')) return;
      close(); o.onCancel && o.onCancel();
    });

    let toastT = 0;
    function toast(m) { toastEl.textContent = m; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 4200); }

    function close() {
      listeners.forEach(([el, ev, fn, opt]) => el.removeEventListener(ev, fn, opt));
      cache.forEach(e => { e.canvas.width = e.canvas.height = 0; }); cache.clear();
      o.root.hidden = true; document.body.classList.remove('rt-open');
    }

    o.root.hidden = false; document.body.classList.add('rt-open');
    renderChips(); setMode('pick'); undoBtn.disabled = true;
    requestAnimationFrame(fit);
    toast('Tap a spot to see the photo that is sharpest there. Tap again to cycle. Then Paint over the halo.');
    // for testing: lets an automated check drive the brush without touch events
    return { choose, pick, paintAt: pts0 => { stroke = { tiles: new Map(), last: pts0[0], dabs: 0 }; dab(pts0[0].x, pts0[0].y); pts0.slice(1).forEach(lineTo); endStroke(); draw(); }, setMode, undo: () => undoBtn.click(), get strokes() { return strokes.length; }, get source() { return src; } };
  }

  root.SpoodRetouch = { open };
})(typeof self !== 'undefined' ? self : this);
