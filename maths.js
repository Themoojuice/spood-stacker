/* "Watch the maths": an animated view of what the stacking engine is doing, drawn from its real
   intermediate data (engine.js opts.onPeek, passed on by worker.js), not a canned animation.
   SpoodMaths.create(canvas, { title, eq, cap, live, step }) -> view
     view.reset(n)            a new stack of n photos
     view.peek(name, data)    a preview from the engine ('photo', 'order', 'features', 'match',
                              'aligned', 'flow', 'winners', 'box', 'strip')
     view.progress(p, stage)  the engine's progress (0..1) and stage name
     view.log(line)           the engine's log lines (the last one runs along the bottom)
     view.start() / stop()    the animation loop (stop when the panel is hidden)
     view.frame(t)            draw one frame at time t (ms), for tests and picture-in-picture
   Scenes follow the engine's stages; each stays up long enough to be read, and catches up when
   the engine runs ahead. Nothing here talks back to the engine. */
(function (root) {
  'use strict';

  // ---------- colour ----------
  const ramp = stops => {                              // 256-entry LUT from [pos, '#rrggbb'] stops
    const lut = new Uint8ClampedArray(256 * 3), rgb = stops.map(([p, h]) => [p, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < rgb.length - 2 && t > rgb[k + 1][0]) k++;
      const a = rgb[k], b = rgb[k + 1], f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1)));
      for (let c = 1; c <= 3; c++) lut[i * 3 + c - 1] = a[c] + (b[c] - a[c]) * f;
    }
    return lut;
  };
  const MAGMA = ramp([[0, '#000004'], [0.22, '#311165'], [0.45, '#7b2382'], [0.65, '#c73d73'], [0.82, '#f9795d'], [0.93, '#fec488'], [1, '#fcfdbf']]);
  const DEPTH = ramp([[0, '#ffb35c'], [0.25, '#ff5d8f'], [0.5, '#b26cff'], [0.75, '#4b8dff'], [1, '#2fd3c3']]);
  const TEAL = ramp([[0, '#0b1716'], [0.5, '#1d6f68'], [1, '#9ff5ea']]);
  const css = (lut, t, a = 1) => { const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3; return `rgba(${lut[i]},${lut[i + 1]},${lut[i + 2]},${a})`; };
  const C = { bg: '#0b1110', ink: '#e6ece8', muted: '#8fa39a', accent: '#4fc2b9', warn: '#ff5d8f', amber: '#ffb35c', grid: 'rgba(143,163,154,.18)' };
  const MONO = '"JetBrains Mono", ui-monospace, monospace';

  // ---------- small helpers ----------
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const ease = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = n => Math.round(n).toLocaleString('en-AU');
  function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  /** RGB (or grey, ch 1) bytes -> canvas; map(i, rgbaOut) may recolour each pixel */
  function toCanvas(w, h, data, ch, map) {
    const c = canvasOf(w, h), g = c.getContext('2d'), im = g.createImageData(w, h), D = im.data;
    for (let i = 0, q = 0; i < w * h; i++, q += 4) {
      if (ch === 1) { D[q] = D[q + 1] = D[q + 2] = data[i]; } else { D[q] = data[i * ch]; D[q + 1] = data[i * ch + 1]; D[q + 2] = data[i * ch + 2]; }
      D[q + 3] = 255;
      if (map) map(i, D, q);
    }
    g.putImageData(im, 0, 0); return c;
  }
  /** where an image of aspect w:h sits inside rect r (letterboxed) */
  function fit(w, h, r) { const s = Math.min(r.w / w, r.h / h), fw = w * s, fh = h * s; return { x: r.x + (r.w - fw) / 2, y: r.y + (r.h - fh) / 2, w: fw, h: fh, s }; }
  const applyH = (h, x, y) => { const d = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; };
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function label(g, text, x, y, opt = {}) {
    g.save(); g.font = `${opt.weight || 500} ${opt.size || 11}px ${MONO}`; g.textAlign = opt.align || 'left'; g.textBaseline = opt.base || 'alphabetic';
    if (opt.bg) { const m = g.measureText(text), pw = m.width + 8, ph = (opt.size || 11) + 6, ox = opt.align === 'center' ? -pw / 2 : opt.align === 'right' ? -pw : 0;
      g.fillStyle = opt.bg; roundRect(g, x + ox - (opt.align ? 0 : 4), y - ph + 4, pw, ph, 4); g.fill(); }
    g.fillStyle = opt.color || C.ink; g.fillText(text, x, y); g.restore();
  }

  // ---------- the scenes, in the engine's order ----------
  // stage: the engine stage names that belong to the scene (to know when the engine has moved on)
  const SCENES = [
    { id: 'read', stage: ['Reading photos'], dwell: 4500,
      title: 'Where is each photo sharp?',
      eq: 'F = G<sub>σ</sub> ∗ (∇²I)²',
      cap: 'The Laplacian ∇²I measures how sharply brightness bends from pixel to pixel. Squared and smoothed, it glows wherever a photo is in focus: the stacker\'s sense of sharpness.' },
    { id: 'order', stage: ['Working out focus order'], dwell: 6500,
      title: 'Sorting the photos by depth of focus',
      eq: 'C<sub>ij</sub> = corr(log F<sub>i</sub>, log F<sub>j</sub>) &nbsp;·&nbsp; (D − C) v₂ = λ₂ v₂',
      cap: 'Each pair of photos is scored by how alike their sharp regions are (the grid). The second eigenvector of the graph Laplacian D − C, the Fiedler vector, lines them up from one end of the depth to the other. The photo sharpest in the centre becomes the reference.' },
    { id: 'features', stage: ['Lining up photos'], dwell: 5000,
      title: 'Finding landmarks (AKAZE)',
      eq: '∂<sub>t</sub>L = div(g(|∇L<sub>σ</sub>|) ∇L) &nbsp;·&nbsp; det ℋ = L<sub>xx</sub>L<sub>yy</sub> − L<sub>xy</sub>²',
      cap: 'Each photo is blurred by a diffusion that stops at edges, so outlines stay crisp at every scale. Where the Hessian determinant peaks (corners and blobs) a landmark is kept, with a binary fingerprint of its surroundings.' },
    { id: 'match', stage: ['Lining up photos'], dwell: 7000,
      title: 'Matching, then outvoting the liars (RANSAC)',
      eq: 'x′ ≃ H x, &nbsp; H ∈ ℝ<sup>3×3</sup> (8 degrees of freedom)',
      cap: 'Landmarks pair up with their closest fingerprint. RANSAC fits H to 4 random pairs thousands of times and keeps the fit most pairs agree with; the magenta pairs were outvoted.' },
    { id: 'aligned', stage: ['Lining up photos', 'Correcting movement'], dwell: 6000,
      title: 'Fine-tuning every line-up (ECC)',
      eq: 'max<sub>H</sub> ρ = ⟨î<sub>ref</sub>, î<sub>H</sub>⟩ / ‖î<sub>ref</sub>‖ ‖î<sub>H</sub>‖',
      cap: 'Each line-up is polished by maximising the correlation between the zero-mean photos, coarse to fine. The outlines show where every photo landed on the reference; the dotted path is your hand drifting through the burst.' },
    { id: 'flow', stage: ['Correcting movement'], dwell: 6000,
      title: 'Correcting what moved (optical flow)',
      eq: 'I(x) ≈ xᵀA x + bᵀx + c &nbsp;⇒&nbsp; d = −½ A⁻¹ Δb',
      cap: 'Farnebäck fits a quadratic surface to every neighbourhood of both photos; how the fit shifts is the motion. It runs both ways: where there-and-back doesn\'t land home (red), the plain line-up is trusted instead.' },
    { id: 'winners', stage: ['Choosing photos', 'Keeping photos for retouching'], dwell: 6500,
      title: 'Who\'s sharpest where',
      eq: 'w<sub>i</sub>(x) = F<sub>i</sub>(x) u<sub>i</sub>(x) / Σ<sub>j</sub> F<sub>j</sub>(x) u<sub>j</sub>(x)',
      cap: 'Every spot votes for the photo with the most focus energy there, counting only where that photo agrees with the reference and can be trusted (u). Coloured by focus order, the votes make a rough depth map.' },
    { id: 'merge', stage: ['Merging', 'Done'], dwell: 1e9,
      title: 'Blending band by band (Laplacian pyramid)',
      eq: 'L<sub>k</sub> = G<sub>k</sub> − ↑G<sub>k+1</sub> &nbsp;·&nbsp; R = Σ<sub>k</sub> ↑(Σ<sub>i</sub> w<sub>i</sub><sup>k</sup> L<sub>i</sub><sup>k</sup>)',
      cap: 'Each photo is split into bands of detail, from broad shading to single hairs. Broad bands blend smoothly by the weights; the finest come only from photos nearly as sharp as the best at that spot, so noise averages out.' }
  ];
  const STAGE_RANK = ['Reading photos', 'Working out focus order', 'Lining up photos', 'Correcting movement', 'Choosing photos', 'Keeping photos for retouching', 'Merging', 'Done'];

  function create(canvas, ui = {}) {
    const g = canvas.getContext('2d');
    let S, raf = 0, running = false, cssW = 0, cssH = 0, dpr = 1;

    function reset(n = 0) {
      S = { n, photos: [], order: null, feats: null, matches: [], aligned: null, flows: [], winners: null, box: null,
        strips: [], final: null, pyr: null, logs: [], p: 0, stage: 'Reading photos', scene: 0, sceneAt: performance.now(), sub: 0, subAt: performance.now(),
        trail: null, particles: null, flowShown: -1, lastPhoto: -1, lastPhotoAt: 0, done: false };
      setText();
    }

    // ---------- data in ----------
    function peek(name, d) {
      if (!S) reset();
      if (name === 'photo') {
        const t = d.thumb, f = d.focus;
        const thumb = toCanvas(t.w, t.h, t.data, 3);
        // the photo, darkened, with its focus measure glowing over it (magma: dark = soft, bright = sharp)
        const heat = toCanvas(t.w, t.h, t.data, 3, (i, D, q) => {
          const v = f ? f[i] / 255 : 0, a = clamp01((v - 0.28) / 0.6), k = Math.round(v * 255) * 3;
          D[q] = D[q] * 0.32 * (1 - a) + MAGMA[k] * a; D[q + 1] = D[q + 1] * 0.32 * (1 - a) + MAGMA[k + 1] * a; D[q + 2] = D[q + 2] * 0.32 * (1 - a) + MAGMA[k + 2] * a;
        });
        S.n = d.n || S.n;
        S.photos[d.i] = { thumb, heat, w: t.w, h: t.h, W: d.W, H: d.H, cf: d.centreFocus, at: performance.now() };
        S.lastPhoto = d.i; S.lastPhotoAt = performance.now();
      } else if (name === 'order') S.order = d;
      else if (name === 'features') S.feats = d;
      else if (name === 'match') S.matches.push(d);
      else if (name === 'aligned') S.aligned = d;
      else if (name === 'flow') {
        const tr = d.trust;
        d.trustCanvas = tr ? toCanvas(tr.w, tr.h, tr.data, 1, (i, D, q) => { const v = tr.data[i] / 255; D[q] = 255; D[q + 1] = 60; D[q + 2] = 110; D[q + 3] = Math.round(clamp01((0.6 - v) / 0.6) * 170); }) : null;
        S.flows.push(d);
      } else if (name === 'winners') {
        S.winners = d;
        const pos = new Map(d.order.map((ph, k) => [ph, d.order.length > 1 ? k / (d.order.length - 1) : 0]));
        d.canvas = toCanvas(d.w, d.h, d.val, 1, (i, D, q) => {
          const b = d.best[i];
          if (b === 255) { D[q] = 14; D[q + 1] = 20; D[q + 2] = 19; return; }
          const k = Math.round(pos.get(b) * 255) * 3, l = 0.35 + 0.65 * d.val[i] / 255;
          D[q] = DEPTH[k] * l; D[q + 1] = DEPTH[k + 1] * l; D[q + 2] = DEPTH[k + 2] * l;
        });
      } else if (name === 'box') S.box = d;
      else if (name === 'strip') {
        const c = toCanvas(d.data.w, d.data.h, d.data.data, 3);
        S.strips.push({ c, y0: d.y0, y1: d.y1, W: d.W, H: d.H, rgba: d.rgba, x0: d.x0 || 0, w: d.w || d.W });
        if (d.rgba || d.y1 >= d.H) S.final = true;
      }
    }
    function progress(p, stage) { if (!S) reset(); S.p = p; if (stage) S.stage = stage; if (p >= 1) S.done = true; }
    function log(m) { if (!S) reset(); S.logs.push(m); if (S.logs.length > 6) S.logs.shift(); }

    // ---------- which scene ----------
    const has = {
      read: () => S.photos.some(Boolean), order: () => !!S.order, features: () => !!S.feats, match: () => S.matches.length > 0,
      aligned: () => !!S.aligned, flow: () => S.flows.length > 0, winners: () => !!S.winners, merge: () => !!S.box || S.strips.length > 0
    };
    const engineRank = () => Math.max(0, STAGE_RANK.indexOf(S.stage));
    function pickScene(now) {
      if (S.hold) return;                                // tests: stay on the scene that was set
      // the furthest scene the engine has data for
      let avail = S.scene;
      for (let k = S.scene + 1; k < SCENES.length; k++) if (has[SCENES[k].id]()) avail = k;
      if (avail === S.scene) return;
      const cur = SCENES[S.scene], dwell = now - S.sceneAt;
      const behind = avail - S.scene;                    // the engine is this many scenes ahead
      const curStageDone = !cur.stage.some(st => STAGE_RANK.indexOf(st) >= engineRank());
      let need = behind >= 3 ? cur.dwell * 0.35 : behind === 2 ? cur.dwell * 0.6 : cur.dwell;
      if (engineRank() >= STAGE_RANK.indexOf('Merging')) need = Math.min(need, cur.dwell * 0.4);   // nearly done: don't miss the merge
      // move on when this scene has been up long enough and either the engine has left its stage
      // or the next scene's data is already in (the order and match scenes share stages)
      if (dwell >= need && (curStageDone || has[SCENES[S.scene + 1].id]())) {
        let next = S.scene + 1;
        while (next < avail && !has[SCENES[next].id]()) next++;
        S.scene = next; S.sceneAt = now; S.sub = 0; S.subAt = now; S.trail = null; S.particles = null;
        setText();
      }
    }
    function setText() {
      const sc = SCENES[S ? S.scene : 0];
      if (ui.title) ui.title.textContent = sc.title;
      if (ui.eq) ui.eq.innerHTML = sc.eq;
      if (ui.cap) ui.cap.textContent = sc.cap;
      if (ui.step) ui.step.textContent = `${(S ? S.scene : 0) + 1} / ${SCENES.length}`;
    }
    let liveText = '';
    function live(t) { if (t !== liveText) { liveText = t; if (ui.live) ui.live.textContent = t; } }

    // ---------- drawing ----------
    function size() {
      const r = canvas.getBoundingClientRect(), d = Math.min(2, root.devicePixelRatio || 1);   // 2x is sharp enough and half the pixels of 3x
      const w = Math.max(200, Math.round(r.width || canvas.width)), h = Math.max(150, Math.round(r.height || canvas.height));
      if (w !== cssW || h !== cssH || d !== dpr) { cssW = w; cssH = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); }
    }
    const area = () => ({ x: 10, y: 34, w: cssW - 20, h: cssH - 34 - 28 });
    function photoAt(i) { return S.photos[i] || S.photos.find(Boolean); }
    function orderPos(i) { const o = S.order ? S.order.order : null; if (!o || o.length < 2) return S.n > 1 ? i / (S.n - 1) : 0; return o.indexOf(i) / (o.length - 1); }

    function frame(now = performance.now()) {
      if (!S) reset();
      size();
      pickScene(now);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = C.bg; g.fillRect(0, 0, cssW, cssH);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      const sc = SCENES[S.scene], t = now - S.sceneAt;
      try { DRAW[sc.id](t, now); } catch (e) { label(g, String(e.message || e), 12, 40, { color: C.warn }); }
      // header: the engine's real stage and progress (the scene may trail it a little)
      g.fillStyle = 'rgba(79,194,185,.16)'; g.fillRect(10, 10, cssW - 20, 3);
      g.fillStyle = C.accent; g.fillRect(10, 10, (cssW - 20) * clamp01(S.p), 3);
      label(g, `${S.stage.toLowerCase()} · ${Math.round(S.p * 100)}%`, 10, 24, { size: 10, color: C.muted });
      label(g, `${S.scene + 1}/${SCENES.length}`, cssW - 10, 24, { size: 10, color: C.muted, align: 'right' });
      // footer: the engine's own words
      const last = S.logs[S.logs.length - 1];
      if (last) {
        g.save(); g.beginPath(); g.rect(10, cssH - 22, cssW - 20, 18); g.clip();
        label(g, '› ' + last, 12, cssH - 9, { size: 10, color: C.muted });
        g.restore();
      }
    }

    const DRAW = {
      read(t, now) {
        const A = area(), stripH = Math.min(46, A.h * 0.2), main = { x: A.x, y: A.y, w: A.w, h: A.h - stripH - 8 };
        // the newest photo for a moment, then a slow tour of all of them
        const arrived = S.photos.map((p, i) => p ? i : -1).filter(i => i >= 0);
        if (!arrived.length) { label(g, 'reading the first photo…', A.x + A.w / 2, A.y + A.h / 2, { align: 'center', color: C.muted }); return; }
        let cur = S.lastPhoto, since = now - S.lastPhotoAt;
        if (since > 2600) cur = arrived[Math.floor((since - 2600) / 2600 + arrived.indexOf(S.lastPhoto) + 1) % arrived.length];
        const p = S.photos[cur], r = fit(p.w, p.h, main), local = since > 2600 ? ((since - 2600) % 2600) : since;
        g.drawImage(p.thumb, r.x, r.y, r.w, r.h);
        g.save(); g.globalAlpha = 0.55; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
        const sweep = ease(local / 1300), yy = r.y + r.h * sweep;
        g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h * sweep); g.clip(); g.drawImage(p.heat, r.x, r.y, r.w, r.h); g.restore();
        if (sweep < 1) { g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip(); const gr = g.createLinearGradient(0, yy - 14, 0, yy + 2); gr.addColorStop(0, 'rgba(254,196,136,0)'); gr.addColorStop(1, 'rgba(254,196,136,.85)'); g.fillStyle = gr; g.fillRect(r.x, yy - 14, r.w, 16); g.restore(); }
        label(g, `photo ${cur + 1}`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
        // the burst as a filmstrip, each with its own focus glow
        const n = Math.max(S.n, arrived.length), cw = Math.min(stripH * 1.4, (A.w - (n - 1) * 3) / n);
        for (let i = 0; i < n; i++) {
          const x = A.x + i * (cw + 3), y = A.y + A.h - stripH, q = S.photos[i];
          if (!q) { g.strokeStyle = C.grid; g.strokeRect(x + 0.5, y + 0.5, cw - 1, stripH - 1); continue; }
          const rr = fit(q.w, q.h, { x, y, w: cw, h: stripH });
          g.drawImage(q.heat, rr.x, rr.y, rr.w, rr.h);
          if (i === cur) { g.strokeStyle = C.amber; g.lineWidth = 1.5; g.strokeRect(rr.x - 1, rr.y - 1, rr.w + 2, rr.h + 2); g.lineWidth = 1; }
        }
        live(`photo ${arrived.length} of ${S.n} read · bright = in focus`);
      },

      order(t) {
        const A = area(), o = S.order, n = S.n, C2 = o && o.C;
        const side = Math.min(A.h * 0.52, A.w * 0.46), mx = A.x, my = A.y + 4;
        if (C2) {
          // the similarity grid, filling in row by row
          const cell = side / n, shown = ease(t / 1800) * n * n;
          let max = 0; for (const row of C2) for (const v of row) if (v > max) max = v;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (i * n + j > shown) continue;
            g.fillStyle = css(TEAL, C2[i][j] / (max || 1)); g.fillRect(mx + j * cell, my + i * cell, Math.ceil(cell), Math.ceil(cell));
          }
          g.strokeStyle = C.grid; g.strokeRect(mx + 0.5, my + 0.5, side, side);
          label(g, 'C (photo × photo)', mx, my + side + 13, { size: 10, color: C.muted });
          // the Fiedler vector as bars beside it
          const fv = o.fiedler, fmax = Math.max(...fv.map(Math.abs)) || 1, bx = mx + side + 14, bw = A.w - side - 14;
          const bh = side / n, grow = ease((t - 1500) / 1500);
          g.strokeStyle = C.grid; g.beginPath(); g.moveTo(bx + bw / 2, my); g.lineTo(bx + bw / 2, my + side); g.stroke();
          for (let i = 0; i < n; i++) {
            const v = fv[i] / fmax * (bw / 2 - 4) * grow;
            g.fillStyle = css(DEPTH, o.order.indexOf(i) / Math.max(1, n - 1), 0.9);
            g.fillRect(bx + bw / 2 + Math.min(0, v), my + i * bh + bh * 0.15, Math.abs(v), Math.max(1, bh * 0.7));
          }
          label(g, 'v₂ (Fiedler vector)', bx, my + side + 13, { size: 10, color: C.muted });
        }
        // the photos sliding into focus order along a line
        const ly = A.y + side + 30, lh = A.y + A.h - ly, k = ease((t - 2600) / 2000);
        const tw = Math.min(lh * 1.3, (A.w - 4) / Math.max(1, n) - 3);
        for (let i = 0; i < n; i++) {
          const p = photoAt(i); if (!p) continue;
          const from = i, to = o ? o.order.indexOf(i) : i, pos = lerp(from, to, k);
          const x = A.x + pos * (tw + 3), rr = fit(p.w, p.h, { x, y: ly, w: tw, h: lh - 14 });
          g.drawImage(p.thumb, rr.x, rr.y, rr.w, rr.h);
          g.strokeStyle = css(DEPTH, to / Math.max(1, n - 1)); g.lineWidth = 2; g.strokeRect(rr.x, rr.y, rr.w, rr.h); g.lineWidth = 1;
          if (o && i === o.ref && k > 0.5) { label(g, 'ref', rr.x + rr.w / 2, rr.y - 3, { size: 9, align: 'center', color: C.amber }); g.strokeStyle = C.amber; g.lineWidth = 2; g.strokeRect(rr.x - 2, rr.y - 2, rr.w + 4, rr.h + 4); g.lineWidth = 1; }
          if (tw > 18) label(g, String(i + 1), rr.x + rr.w / 2, ly + lh - 2, { size: 9, align: 'center', color: C.muted });
        }
        live(o ? `focus order ${o.order.map(i => i + 1).join(' ')} · reference photo ${o.ref + 1}` : 'working out the focus order');
      },

      features(t) {
        const A = area(), F = S.feats, order = S.order ? S.order.order : S.photos.map((_, i) => i);
        const per = Math.max(1600, Math.min(2600, 9000 / Math.max(1, order.length))), k = Math.floor(t / per) % order.length, i = order[k], lt = t % per;
        const p = photoAt(i); if (!p || !F) return;
        const r = fit(p.w, p.h, A); g.drawImage(p.thumb, r.x, r.y, r.w, r.h);
        g.save(); g.globalAlpha = 0.35; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
        const pts = F.pts[i] || [], m = pts.length / 2, shown = Math.floor(ease(lt / (per * 0.6)) * m);
        for (let j = 0; j < shown; j++) {
          const age = (shown - j) / m, rad = 2.2 + 3 * clamp01(1 - age * 8);
          g.strokeStyle = j > shown - m * 0.08 ? C.amber : 'rgba(79,194,185,.9)';
          g.beginPath(); g.arc(r.x + pts[2 * j] * r.w, r.y + pts[2 * j + 1] * r.h, rad, 0, 6.283); g.stroke();
        }
        const count = Math.round(F.counts[i] * shown / Math.max(1, m));
        label(g, `photo ${i + 1}: ${fmt(count)} landmarks`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
        live(`photo ${i + 1}: ${fmt(F.counts[i])} landmarks (${Math.min(m, F.counts[i])} drawn)`);
      },

      match(t) {
        const A = area(), list = S.matches, per = 4200, m = list[Math.floor(t / per) % list.length], lt = t % per;
        const pa = photoAt(m.cur), pb = photoAt(m.against); if (!pa || !pb) return;
        const half = (A.w - 10) / 2, ih = A.h - 74, ra = fit(pa.w, pa.h, { x: A.x, y: A.y + 14, w: half, h: ih }), rb = fit(pb.w, pb.h, { x: A.x + half + 10, y: A.y + 14, w: half, h: ih });
        g.drawImage(pa.thumb, ra.x, ra.y, ra.w, ra.h); g.drawImage(pb.thumb, rb.x, rb.y, rb.w, rb.h);
        g.save(); g.globalAlpha = 0.3; g.fillStyle = C.bg; g.fillRect(ra.x, ra.y, ra.w, ra.h); g.fillRect(rb.x, rb.y, rb.w, rb.h); g.restore();
        label(g, `photo ${m.cur + 1}`, ra.x + ra.w / 2, ra.y - 3, { size: 10, align: 'center', color: C.muted });
        label(g, `photo ${m.against + 1}${S.order && m.against === S.order.ref ? ' (ref)' : ''}`, rb.x + rb.w / 2, rb.y - 3, { size: 10, align: 'center', color: C.muted });
        const W = m.W, H = m.H, P = (pts, r, j) => [r.x + pts[2 * j] / W * r.w, r.y + pts[2 * j + 1] / H * r.h];
        const grow = ease(lt / 900), judge = ease((lt - 1000) / 700);
        // outvoted pairs: drawn, then flagged magenta and faded
        const no = m.osrc.length / 2;
        for (let j = 0; j < no; j++) {
          if (j / no > grow) break;
          const [x1, y1] = P(m.osrc, ra, j), [x2, y2] = P(m.odst, rb, j);
          g.strokeStyle = judge > 0 ? `rgba(255,93,143,${0.85 * (1 - ease((lt - 2200) / 1200))})` : 'rgba(230,236,232,.35)';
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(lerp(x1, x2, grow), lerp(y1, y2, grow)); g.stroke();
        }
        const ni = m.isrc.length / 2;
        for (let j = 0; j < ni; j++) {
          if (j / ni > grow) break;
          const [x1, y1] = P(m.isrc, ra, j), [x2, y2] = P(m.idst, rb, j);
          g.strokeStyle = judge > 0 ? `rgba(79,194,185,${0.18 + 0.32 * judge})` : 'rgba(230,236,232,.22)';
          g.lineWidth = 0.7; g.beginPath(); g.moveTo(x1, y1); g.lineTo(lerp(x1, x2, grow), lerp(y1, y2, grow)); g.stroke(); g.lineWidth = 1;
          g.fillStyle = judge > 0 ? C.accent : C.ink; g.fillRect(x1 - 1, y1 - 1, 2, 2); if (grow >= 1) g.fillRect(x2 - 1, y2 - 1, 2, 2);
        }
        // the homography it found, as numbers
        const Hm = m.Hmat || m.H, rows = [0, 1, 2].map(rw => [0, 1, 2].map(c => { const v = Hm[rw * 3 + c]; return (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)).padStart(8); }).join(' '));
        const show = ease((lt - 2000) / 800), by = A.y + 14 + ih + 16;
        g.save(); g.globalAlpha = judge;
        label(g, `${fmt(m.inliers)} of ${fmt(m.cand)} pairs agree` + (m.rough ? ' · framed far apart: rough fit first' : ` · fine-tune ${m.ecc}`), A.x + A.w / 2, by, { size: 10, align: 'center', color: m.rough ? C.amber : C.accent });
        g.globalAlpha = show;
        const mx = A.x + A.w / 2 - 105;
        label(g, 'H =', mx, by + 30, { size: 11, color: C.amber });
        rows.forEach((row, k) => label(g, row, mx + 30, by + 17 + k * 13, { size: 10, color: C.ink }));
        g.restore();
        live(`photo ${m.cur + 1} → photo ${m.against + 1}: ${fmt(m.inliers)} of ${fmt(m.cand)} pairs agree on one plane`);
      },

      aligned(t) {
        const A = area(), al = S.aligned, ref = al.ref, p = photoAt(ref); if (!p) return;
        const W = al.W, H = al.H;
        // room around the reference for photos that landed outside it
        let minX = 0, minY = 0, maxX = W, maxY = H;
        al.Hs.forEach(h => { if (!h) return; [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y]) => { const [u, v] = applyH(h, x, y); minX = Math.min(minX, u); minY = Math.min(minY, v); maxX = Math.max(maxX, u); maxY = Math.max(maxY, v); }); });
        const r = fit(maxX - minX, maxY - minY, { x: A.x + 4, y: A.y + 4, w: A.w - 8, h: A.h - 8 }), s = r.s, X = x => r.x + (x - minX) * s, Y = y => r.y + (y - minY) * s;
        g.drawImage(p.thumb, X(0), Y(0), W * s, H * s);
        g.save(); g.globalAlpha = 0.5; g.fillStyle = C.bg; g.fillRect(X(0), Y(0), W * s, H * s); g.restore();
        const n = al.Hs.length, I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        al.Hs.forEach((h, i) => {
          if (!h) return;
          const k = ease((t - i * 180) / 1400), hh = h.map((v, j) => lerp(I[j], v, k));
          g.strokeStyle = css(DEPTH, orderPos(i), 0.9); g.lineWidth = i === ref ? 2 : 1.2;
          g.beginPath(); [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y], j) => { const [u, v] = applyH(hh, x, y); j ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)); }); g.closePath(); g.stroke();
        });
        g.lineWidth = 1;
        // the hand's path: where each photo's centre landed, in the order they were taken,
        // stretched about the reference's centre so a few pixels of drift can be seen
        const raw = al.Hs.map(h => h ? applyH(h, W / 2, H / 2) : null);
        let drift = 0; raw.forEach(c => { if (c) drift = Math.max(drift, Math.hypot(c[0] - W / 2, c[1] - H / 2)); });
        const mag = drift > 0 ? Math.max(1, Math.min(12, Math.round(0.22 * Math.min(W, H) / drift))) : 1;
        const pk = ease((t - 1800) / 1800), cs = raw.map(c => c ? [W / 2 + (c[0] - W / 2) * mag, H / 2 + (c[1] - H / 2) * mag] : null);
        g.setLineDash([3, 4]); g.strokeStyle = C.amber; g.beginPath();
        let started = false, drawn = 0; const upto = pk * (n - 1);
        cs.forEach((c, i) => { if (!c || i > upto + 1e-6) return; drawn = i; started ? g.lineTo(X(c[0]), Y(c[1])) : (g.moveTo(X(c[0]), Y(c[1])), started = true); });
        g.stroke(); g.setLineDash([]);
        cs.forEach((c, i) => { if (!c || i > upto) return; g.fillStyle = C.amber; g.beginPath(); g.arc(X(c[0]), Y(c[1]), 2.5, 0, 6.283); g.fill(); if (n <= 12 || i % 3 === 0) label(g, String(i + 1), X(c[0]) + 4, Y(c[1]) - 3, { size: 9, color: C.amber }); });
        if (mag > 1 && pk > 0) label(g, `path ×${mag}`, A.x + A.w - 6, A.y + 16, { size: 10, align: 'right', bg: 'rgba(11,17,16,.7)', color: C.amber });
        live(`${n} photos lined up on photo ${ref + 1} · the hand drifted up to ${fmt(drift)} px`);
        void drawn;
      },

      flow(t, now) {
        const A = area(), list = S.flows, per = 4000, k = Math.floor(t / per) % list.length, f = list[k], lt = t % per;
        const p = photoAt(f.cur); if (!p) return;
        const r = fit(p.w, p.h, A);
        g.drawImage(p.thumb, r.x, r.y, r.w, r.h);
        g.save(); g.globalAlpha = 0.5; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
        if (f.trustCanvas) { g.save(); g.globalAlpha = ease(lt / 800); g.drawImage(f.trustCanvas, r.x, r.y, r.w, r.h); g.restore(); }
        const G = f.grid; if (!G) return;
        let max = 0; for (let q = 0; q < G.u.length; q++) max = Math.max(max, Math.hypot(G.u[q], G.v[q]));
        // exaggerated so it can be seen: the largest shift is drawn as 6% of the frame's width.
        // disp: working-size pixels -> exaggerated on-screen pixels
        const gain = max > 1e-6 ? 0.06 * f.W / max : 0, disp = gain * r.w / f.W, cw = r.w / G.gw, ch = r.h / G.gh;
        const field = (x, y) => {                          // bilinear, x and y in grid cells
          const gx = Math.max(0, Math.min(G.gw - 1.001, x - 0.5)), gy = Math.max(0, Math.min(G.gh - 1.001, y - 0.5));
          const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, at = (a, b) => (b * G.gw + a);
          const i00 = at(x0, y0), i10 = at(Math.min(G.gw - 1, x0 + 1), y0), i01 = at(x0, Math.min(G.gh - 1, y0 + 1)), i11 = at(Math.min(G.gw - 1, x0 + 1), Math.min(G.gh - 1, y0 + 1));
          return [lerp(lerp(G.u[i00], G.u[i10], fx), lerp(G.u[i01], G.u[i11], fx), fy), lerp(lerp(G.v[i00], G.v[i10], fx), lerp(G.v[i01], G.v[i11], fx), fy)];
        };
        // particles drifting along the (exaggerated) flow, leaving trails
        if (!S.trail || S.flowShown !== k || S.trail.width !== Math.round(r.w * dpr)) {
          S.trail = canvasOf(Math.max(1, Math.round(r.w * dpr)), Math.max(1, Math.round(r.h * dpr))); S.flowShown = k;
          S.particles = [...Array(260)].map(() => ({ x: Math.random() * G.gw, y: Math.random() * G.gh, life: Math.random() * 60 }));
        }
        const tg = S.trail.getContext('2d');
        tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = 'rgba(0,0,0,.08)'; tg.fillRect(0, 0, S.trail.width, S.trail.height); tg.globalCompositeOperation = 'source-over';
        tg.lineWidth = 1.3 * dpr;
        for (const q of S.particles) {
          const [u, v] = field(q.x, q.y), sp = Math.hypot(u, v) / (max || 1);
          const nx = q.x + u * disp / cw * 0.045, ny = q.y + v * disp / ch * 0.045;
          const ang = Math.atan2(v, u) / 6.283 + 0.5;
          tg.strokeStyle = `hsla(${Math.round(ang * 360)},85%,${55 + 15 * sp}%,${0.25 + 0.7 * sp})`;
          tg.beginPath(); tg.moveTo(q.x * cw * dpr, q.y * ch * dpr); tg.lineTo(nx * cw * dpr, ny * ch * dpr); tg.stroke();
          q.x = nx; q.y = ny; q.life--;
          if (q.life < 0 || q.x < 0 || q.y < 0 || q.x > G.gw || q.y > G.gh || sp < 0.02 && Math.random() < 0.05) { q.x = Math.random() * G.gw; q.y = Math.random() * G.gh; q.life = 40 + Math.random() * 40; }
        }
        g.drawImage(S.trail, r.x, r.y, r.w, r.h);
        // the field itself as small arrows on a coarser grid
        g.strokeStyle = 'rgba(230,236,232,.55)'; g.lineWidth = 1;
        for (let y = 0; y < G.gh; y += 2) for (let x = 0; x < G.gw; x += 2) {
          const q = y * G.gw + x, u = G.u[q] * disp, v = G.v[q] * disp;
          const cx = r.x + (x + 0.5) * cw, cy = r.y + (y + 0.5) * ch, ex = cx + u, ey = cy + v;
          if (Math.hypot(ex - cx, ey - cy) < 1.5) continue;
          g.beginPath(); g.moveTo(cx, cy); g.lineTo(ex, ey); g.stroke();
        }
        const ex = Math.round(gain);
        label(g, `photo ${f.cur + 1} vs reference`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
        if (ex > 1) label(g, `shifts ×${ex}`, r.x + r.w - 6, r.y + 16, { size: 10, align: 'right', bg: 'rgba(11,17,16,.7)', color: C.amber });
        live(`photo ${f.cur + 1}: largest shift ${max.toFixed(1)} px · ` + (f.accepted ? `corrected ${Math.max(1, Math.round(f.share * 100))}% (match ${f.nccG.toFixed(3)} → ${f.nccF.toFixed(3)})` : 'no correction needed'));
        void now;
      },

      winners(t) {
        const A = area(), wn = S.winners, legendH = 34, r = fit(wn.w, wn.h, { x: A.x, y: A.y, w: A.w, h: A.h - legendH });
        // revealed from the centre outwards
        const k = ease(t / 1600), rad = k * Math.hypot(r.w, r.h) / 2;
        g.save(); g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, rad), 0, 6.283); g.clip();
        g.imageSmoothingEnabled = false; g.drawImage(wn.canvas, r.x, r.y, r.w, r.h); g.imageSmoothingEnabled = true; g.restore();
        // legend: the colour of each photo in focus order; left-out photos struck through
        const ly = A.y + A.h - legendH + 8, n = wn.order.length, cw = A.w / n, left = new Set(wn.left.map(l => l.i));
        wn.order.forEach((ph, j) => {
          g.fillStyle = css(DEPTH, n > 1 ? j / (n - 1) : 0, left.has(ph) ? 0.25 : 1); g.fillRect(A.x + j * cw, ly, Math.ceil(cw), 8);
          if (n <= 16 || j % Math.ceil(n / 12) === 0) label(g, String(ph + 1), A.x + j * cw + cw / 2, ly + 21, { size: 9, align: 'center', color: left.has(ph) ? C.warn : C.muted });
        });
        label(g, 'one end of the focus', A.x, ly - 3, { size: 9, color: C.muted });
        label(g, 'the other end', A.x + A.w, ly - 3, { size: 9, align: 'right', color: C.muted });
        wn.left.slice(0, 3).forEach((l, j) => label(g, `photo ${l.i + 1} left out: ${l.why}`, r.x + 6, r.y + 16 + j * 15, { size: 10, bg: 'rgba(11,17,16,.75)', color: C.warn }));
        live(`using ${wn.used.length} of ${n} photos · colour = which photo is sharpest there`);
      },

      merge(t, now) {
        const A = area(), bx = S.box, W = bx ? bx.W : (S.strips[0] && S.strips[0].W), H = bx ? bx.H : (S.strips[0] && S.strips[0].H);
        if (!W) return;
        const pyrH = Math.min(52, A.h * 0.2), main = { x: A.x, y: A.y + pyrH + 8, w: A.w, h: A.h - pyrH - 8 };
        // final: the cropped stack, filling the frame; before that, the whole working frame with
        // the depth map underneath and finished rows painted over it as each strip lands
        let fin = S.strips.find(s => s.rgba);
        if (!fin && bx && S.strips.length && Math.max(...S.strips.map(s => s.y1)) >= H) {
          // every strip is in: put them together once and keep only the crop, as the app will
          const sw = S.strips[0].c.width, sh = Math.round(H * sw / W), all = canvasOf(sw, sh), ag = all.getContext('2d');
          for (const st of S.strips) ag.drawImage(st.c, 0, Math.round(st.y0 / H * sh), sw, Math.max(1, Math.round((st.y1 - st.y0) / H * sh)));
          const b = bx.box, cw2 = Math.max(1, Math.round(b.w / W * sw)), ch2 = Math.max(1, Math.round(b.h / H * sh)), crop = canvasOf(cw2, ch2);
          crop.getContext('2d').drawImage(all, Math.round(b.x / W * sw), Math.round(b.y / H * sh), cw2, ch2, 0, 0, cw2, ch2);
          fin = { c: crop, rgba: true, w: b.w, y0: 0, y1: b.h, assembled: true };
          S.strips = [fin]; S.sceneAt = Math.min(S.sceneAt, now);
        }
        if (fin) {
          const r = fit(fin.c.width, fin.c.height, main), z = 1 + 0.04 * ease(t / 8000);
          g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
          g.drawImage(fin.c, r.x - r.w * (z - 1) / 2, r.y - r.h * (z - 1) / 2, r.w * z, r.h * z); g.restore();
        } else {
          const r = fit(W, H, main);
          if (S.winners) { g.save(); g.globalAlpha = 0.45; g.imageSmoothingEnabled = false; g.drawImage(S.winners.canvas, r.x, r.y, r.w, r.h); g.imageSmoothingEnabled = true; g.restore(); }
          let lowest = 0;
          for (const s of S.strips) {
            const y0 = r.y + s.y0 / H * r.h, h = (s.y1 - s.y0) / H * r.h;
            g.drawImage(s.c, r.x, y0, r.w, h + 0.5); lowest = Math.max(lowest, s.y1);
          }
          if (bx) { g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,179,92,.7)'; const b = bx.box; g.strokeRect(r.x + b.x / W * r.w, r.y + b.y / H * r.h, b.w / W * r.w, b.h / H * r.h); g.setLineDash([]); }
          if (lowest < H) {
            const yy = r.y + lowest / H * r.h, pulse = 0.5 + 0.5 * Math.sin(now / 260);
            const gr = g.createLinearGradient(0, yy, 0, yy + 18); gr.addColorStop(0, `rgba(79,194,185,${0.5 + 0.4 * pulse})`); gr.addColorStop(1, 'rgba(79,194,185,0)');
            g.fillStyle = gr; g.fillRect(r.x, yy, r.w, 18);
          }
          live(S.strips.length ? `merged rows 0–${fmt(lowest)} of ${fmt(H)}` : 'measuring texture and noise before merging');
        }
        if (fin) live(`done: ${fmt(fin.w)} × ${fmt(fin.y1 - fin.y0)} px from ${bx ? bx.used.length : '?'} photos`);
        // the pyramid of the reference photo, fine to coarse (worked out here, for the picture)
        if (!S.pyr) S.pyr = pyramid(photoAt(S.order ? S.order.ref : 0));
        if (S.pyr) {
          const L = S.pyr.length, tw = (A.w - (L - 1) * 6) / L, hl = Math.floor(now / 900) % L;
          S.pyr.forEach((c, i) => {
            const rr = fit(c.width, c.height, { x: A.x + i * (tw + 6), y: A.y, w: tw, h: pyrH - 12 });
            g.imageSmoothingEnabled = false; g.drawImage(c, rr.x, rr.y, rr.w, rr.h); g.imageSmoothingEnabled = true;
            g.strokeStyle = i === hl ? C.accent : C.grid; g.strokeRect(rr.x - 0.5, rr.y - 0.5, rr.w + 1, rr.h + 1);
            label(g, i < L - 1 ? `L${i}` : `G${i}`, rr.x + rr.w / 2, A.y + pyrH, { size: 9, align: 'center', color: i === hl ? C.accent : C.muted });
          });
        }
      }
    };

    /** a Laplacian pyramid of a photo's thumbnail: detail bands L0 (finest) .. and the coarse rest */
    function pyramid(p) {
      if (!p) return null;
      const w0 = p.w, h0 = p.h, src = p.thumb.getContext('2d').getImageData(0, 0, w0, h0).data;
      let G = { w: w0, h: h0, d: new Float32Array(w0 * h0) };
      for (let i = 0; i < w0 * h0; i++) G.d[i] = 0.299 * src[4 * i] + 0.587 * src[4 * i + 1] + 0.114 * src[4 * i + 2];
      const down = a => { const w = a.w >> 1, h = a.h >> 1, d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = 2 * y * a.w + 2 * x; d[y * w + x] = (a.d[q] + a.d[q + 1] + a.d[q + a.w] + a.d[q + a.w + 1]) / 4; } return { w, h, d }; };
      const up = (a, w, h) => { const d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(a.w - 1, (x - 0.5) / 2), sy = Math.min(a.h - 1, (y - 0.5) / 2), x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy)), x1 = Math.min(a.w - 1, x0 + 1), y1 = Math.min(a.h - 1, y0 + 1), fx = clamp01(sx - x0), fy = clamp01(sy - y0); d[y * w + x] = lerp(lerp(a.d[y0 * a.w + x0], a.d[y0 * a.w + x1], fx), lerp(a.d[y1 * a.w + x0], a.d[y1 * a.w + x1], fx), fy); } return d; };
      const out = [];
      for (let k = 0; k < 4 && G.w > 8; k++) {
        const nx = down(G), u = up(nx, G.w, G.h), band = new Uint8Array(G.w * G.h);
        for (let i = 0; i < band.length; i++) band[i] = Math.max(0, Math.min(255, 128 + (G.d[i] - u[i]) * (2.5 + k)));
        out.push(toCanvas(G.w, G.h, band, 1));
        G = nx;
      }
      out.push(toCanvas(G.w, G.h, Uint8Array.from(G.d, v => Math.max(0, Math.min(255, v))), 1));
      return out;
    }

    // ~30 frames a second: smooth enough, and leaves the phone's cores to the stacking
    let lastFrame = 0;
    function loop(now) { if (!running) return; if (now - lastFrame >= 31) { lastFrame = now; frame(now); } raf = requestAnimationFrame(loop); }
    reset();
    return {
      reset, peek, progress, log, frame,
      start() { if (running) return; running = true; raf = requestAnimationFrame(loop); },
      stop() { running = false; cancelAnimationFrame(raf); },
      get state() { return S; },
      scenes: SCENES
    };
  }

  root.SpoodMaths = { create, SCENES };
})(typeof self !== 'undefined' ? self : this);
