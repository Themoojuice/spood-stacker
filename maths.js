/* "Watch the maths": an animated view of what the stacking engine is doing, drawn from its real
   intermediate data (engine.js opts.onPeek, passed on by worker.js), not a canned animation.
   SpoodMaths.create(canvas, { title, eq, cap, live }) -> view
     view.reset(n)            a new stack of n photos
     view.peek(name, data)    a preview from the engine ('photo', 'order', 'features', 'match',
                              'aligned', 'flow', 'winners', 'box', 'strip')
     view.progress(p, stage)  the engine's progress (0..1) and stage name
     view.log(line)           the engine's log lines (the last one runs along the bottom)
     view.start() / stop()    the animation loop (stop when the panel is hidden)
     view.frame(t)            draw one frame at time t (ms), for tests and picture-in-picture
   How it moves:
   - Pacing: each scene gets a share of the time the stack still needs (from the engine's own
     progress, which is calibrated to time), so a short stack shows every scene briskly and a long
     one lingers. A scene never ends before the next one's data is in; when the engine runs ahead
     (or reaches the merge) the view catches up.
   - Continuity: each photo is one object ("sprite") that glides between scenes - filmstrip, focus
     line, match pair, deck, legend - under a camera that drifts and pushes in.
   - Touch: tap to hold the current scene (the stack carries on), swipe right to look back at an
     earlier scene, left to come forward again; tap a photo in the filmstrip to see its focus map.
   - With the phone's reduce-motion setting, things cut and cross-fade instead of gliding.
   The title and equation are drawn in the canvas; ui.title / eq / cap / live get the same words
   (for screen readers, and the caption under "What's this?"). Nothing here talks back to the
   engine. */
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
  const C = { bg: '#0b1110', ink: '#e6ece8', muted: '#8fa39a', accent: '#4fc2b9', warn: '#ff5d8f', amber: '#ffb35c', grid: 'rgba(143,163,154,.18)', glass: 'rgba(11,17,16,.82)' };
  const MONO = '"JetBrains Mono", ui-monospace, monospace';
  const DISPLAY = '"Bricolage Grotesque", system-ui, sans-serif';
  const SERIF = '"STIX Two Text", "Cambria Math", "Noto Serif", Georgia, serif';

  // ---------- small helpers ----------
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
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
    g.save(); g.font = `${opt.weight || 500} ${opt.size || 11}px ${opt.font || MONO}`; g.textAlign = opt.align || 'left'; g.textBaseline = opt.base || 'alphabetic';
    if (opt.alpha != null) g.globalAlpha *= opt.alpha;
    if (opt.bg) { const m = g.measureText(text), pw = m.width + 8, ph = (opt.size || 11) + 6, ox = opt.align === 'center' ? -pw / 2 : opt.align === 'right' ? -pw : 0;
      g.fillStyle = opt.bg; roundRect(g, x + ox - (opt.align ? 0 : 4), y - ph + 4, pw, ph, 4); g.fill(); }
    g.fillStyle = opt.color || C.ink; g.fillText(text, x, y); g.restore();
  }
  /** an equation written with <sub>, <sup> and &nbsp; (as in SCENES), as runs for the canvas */
  function eqRuns(src) {
    const runs = [], re = /<(sub|sup)>(.*?)<\/\1>/g; let last = 0, m;
    const text = s => s.replace(/&nbsp;/g, ' ');
    while ((m = re.exec(src))) { if (m.index > last) runs.push({ t: text(src.slice(last, m.index)), k: 0 }); runs.push({ t: text(m[2]), k: m[1] === 'sub' ? 1 : -1 }); last = m.index + m[0].length; }
    if (last < src.length) runs.push({ t: text(src.slice(last)), k: 0 });
    return runs;
  }
  /** draws an equation in one line, shrinking it (down to 10 px) to fit maxW; returns its width */
  function drawEq(g, src, x, y, maxW, size = 14, color = C.accent) {
    const runs = eqRuns(src);
    const width = s => { let w = 0; for (const r of runs) { g.font = `italic ${r.k ? s * 0.68 : s}px ${SERIF}`; w += g.measureText(r.t).width; } return w; };
    let s = size; while (s > 10 && width(s) > maxW) s -= 0.5;
    let cx = x; g.save(); g.fillStyle = color; g.textBaseline = 'alphabetic';
    for (const r of runs) {
      g.font = `italic ${r.k ? s * 0.68 : s}px ${SERIF}`;
      g.fillText(r.t, cx, y + (r.k === 1 ? s * 0.28 : r.k === -1 ? -s * 0.38 : 0));
      cx += g.measureText(r.t).width;
    }
    g.restore(); return cx - x;
  }

  // ---------- the scenes, in the engine's order ----------
  // stage: the engine stage names that belong to the scene; nominal: how long it wants (ms) on a
  // stack of ordinary length; weight: its share of the time left
  const SCENES = [
    { id: 'read', stage: ['Reading photos'], nominal: 5000, weight: 1,
      title: 'Where is each photo sharp?',
      eq: 'F = G<sub>σ</sub> ∗ (∇²I)²',
      cap: 'The Laplacian ∇²I measures how sharply brightness bends from pixel to pixel. Squared and smoothed, it glows wherever a photo is in focus: the stacker\'s sense of sharpness.' },
    { id: 'order', stage: ['Working out focus order'], nominal: 6500, weight: 0.9,
      title: 'Sorting the photos by depth of focus',
      eq: 'C<sub>ij</sub> = corr(log F<sub>i</sub>, log F<sub>j</sub>) &nbsp;·&nbsp; (D − C) v₂ = λ₂ v₂',
      cap: 'Each pair of photos is scored by how alike their sharp regions are (the grid). The second eigenvector of the graph Laplacian D − C, the Fiedler vector, lines them up from one end of the depth to the other. The photo sharpest in the centre becomes the reference.' },
    { id: 'features', stage: ['Lining up photos'], nominal: 6000, weight: 1,
      title: 'Finding landmarks (AKAZE)',
      eq: '∂<sub>t</sub>L = div(g(|∇L<sub>σ</sub>|) ∇L) &nbsp;·&nbsp; det ℋ = L<sub>xx</sub>L<sub>yy</sub> − L<sub>xy</sub>²',
      cap: 'Each photo is blurred by a diffusion that stops at edges, so outlines stay crisp at every scale. Where the Hessian determinant peaks (corners and blobs) a landmark is kept, with a binary fingerprint of its surroundings.' },
    { id: 'match', stage: ['Lining up photos'], nominal: 8000, weight: 1.3,
      title: 'Matching, then outvoting the liars',
      eq: 'x′ ≃ H x, &nbsp; H ∈ ℝ<sup>3×3</sup> (RANSAC)',
      cap: 'Landmarks pair up with their closest fingerprint. RANSAC fits the homography H to 4 random pairs thousands of times and keeps the fit most pairs agree with; the magenta pairs were outvoted.' },
    { id: 'aligned', stage: ['Lining up photos', 'Correcting movement'], nominal: 6500, weight: 1,
      title: 'Fine-tuning every line-up (ECC)',
      eq: 'max<sub>H</sub> ρ = ⟨î<sub>ref</sub>, î<sub>H</sub>⟩ / ‖î<sub>ref</sub>‖ ‖î<sub>H</sub>‖',
      cap: 'Each line-up is polished by maximising the correlation between the zero-mean photos, coarse to fine. The outlines show where every photo landed on the reference; the dotted path is your hand drifting through the burst.' },
    { id: 'flow', stage: ['Correcting movement'], nominal: 7000, weight: 1.1,
      title: 'Correcting what moved (optical flow)',
      eq: 'I(x) ≈ xᵀA x + bᵀx + c &nbsp;⇒&nbsp; d = −½ A⁻¹ Δb',
      cap: 'Farnebäck fits a quadratic surface to every neighbourhood of both photos; how the fit shifts is the motion. It runs both ways: where there-and-back doesn\'t land home (red), the plain line-up is trusted instead.' },
    { id: 'winners', stage: ['Choosing photos', 'Keeping photos for retouching'], nominal: 8000, weight: 1.1,
      title: 'Who\'s sharpest where',
      eq: 'w<sub>i</sub>(x) = F<sub>i</sub>(x) u<sub>i</sub>(x) / Σ<sub>j</sub> F<sub>j</sub>(x) u<sub>j</sub>(x)',
      cap: 'Every spot votes for the photo with the most focus energy there, counting only where that photo agrees with the reference and can be trusted (u). Coloured by focus order, the votes make a rough depth map.' },
    { id: 'merge', stage: ['Merging', 'Done'], nominal: 9000, weight: 1.6,
      title: 'Blending band by band (Laplacian pyramid)',
      eq: 'L<sub>k</sub> = G<sub>k</sub> − ↑G<sub>k+1</sub> &nbsp;·&nbsp; R = Σ<sub>k</sub> ↑(Σ<sub>i</sub> w<sub>i</sub><sup>k</sup> L<sub>i</sub><sup>k</sup>)',
      cap: 'Each photo is split into bands of detail, from broad shading to single hairs. Broad bands blend smoothly by the weights; the finest come only from photos nearly as sharp as the best at that spot, so noise averages out.' }
  ];
  const STAGE_RANK = ['Reading photos', 'Working out focus order', 'Lining up photos', 'Correcting movement', 'Choosing photos', 'Keeping photos for retouching', 'Merging', 'Done'];
  const MERGE = SCENES.length - 1;
  const HUD_TOP = 72, HUD_BOTTOM = 34;                 // the glass strips over the picture

  // frame rate and pixel density (localStorage 'spood-maths-tune' = '{"fps":20,"dpr":1.5}' for tests)
  const TUNE = Object.assign({ fps: 30, idle: 12, dpr: 2 }, (() => { try { return JSON.parse(localStorage.getItem('spood-maths-tune') || '{}'); } catch (e) { return {}; } })());

  function create(canvas, ui = {}) {
    const g = canvas.getContext('2d');
    const reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let S, raf = 0, running = false, cssW = 0, cssH = 0, dpr = 1, lastNow = 0;

    function reset(n = 0) {
      const now = performance.now();
      S = { n, photos: [], order: null, feats: null, matches: [], aligned: null, flows: [], winners: null, box: null,
        strips: [], pyr: null, logs: [], p: 0, stage: 'Reading photos', t0: now, done: false,
        // the scene the engine's pace calls for (auto) and the one on screen (scene: the same,
        // unless the viewer swiped back)
        auto: 0, autoAt: now, autoScale: 1, scene: 0, sceneAt: now, scale: 1, manual: false, held: false,
        spr: [], cam: null, camT: null, trail: null, particles: null, flowShown: -1,
        lastPhoto: -1, lastPhotoAt: 0, pick: -1, pickAt: 0, winMasks: [], shown: new Set([0]), busyUntil: 0 };
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
        S.n = Math.max(S.n, d.n || 0);
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
        d.pos = pos;
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
      }
    }
    function progress(p, stage) {
      if (!S) reset();
      if (p > S.p || p === 0) S.p = p;
      if (stage) S.stage = stage;
      if (p >= 1) S.done = true;
    }
    function log(m) { if (!S) reset(); S.logs.push(m); if (S.logs.length > 6) S.logs.shift(); }

    // ---------- pacing: which scene, for how long ----------
    const has = {
      read: () => S.photos.some(Boolean), order: () => !!S.order, features: () => !!S.feats, match: () => S.matches.length > 0,
      aligned: () => !!S.aligned, flow: () => S.flows.length > 0, winners: () => !!S.winners, merge: () => !!S.box || S.strips.length > 0
    };
    const engineRank = () => Math.max(0, STAGE_RANK.indexOf(S.stage));
    /** seconds the stack still needs, from its own progress (calibrated to time), or null this early */
    function remaining(now) {
      const el = (now - S.t0) / 1000;
      return S.p >= 0.02 && el > 1 ? Math.max(0, el / S.p - el) : null;
    }
    /** how long scene k should stay up, given e ms already spent on it */
    function planned(k, e, now) {
      const sc = SCENES[k], R = remaining(now);
      let D = sc.nominal;
      if (R !== null) {
        let W = 0; for (let j = k; j < SCENES.length; j++) W += SCENES[j].weight;
        D = (R * 1000 + e) * sc.weight / W;
      }
      D = clamp(D, sc.nominal * 0.45, sc.nominal * 2.2);
      // the engine is merging and the view is two or more scenes short of it: hurry, so the merge
      // isn't missed (one scene short, the shares above already leave the merge most of the time)
      if (k < MERGE - 1 && engineRank() >= STAGE_RANK.indexOf('Merging')) D = Math.min(D, sc.nominal * 0.45);
      return D;
    }
    function advance(now, dt) {
      if (S.freeze) return;                              // tests: stay on the scene that was set
      if (S.held) { S.autoAt += dt; if (!S.manual) S.sceneAt += dt; return; }   // held: time stands still for the scene
      let avail = S.auto;
      for (let k = S.auto + 1; k < SCENES.length; k++) if (has[SCENES[k].id]()) avail = k;
      if (avail === S.auto) return;
      const e = now - S.autoAt;
      if (e < planned(S.auto, e, now)) return;
      let next = S.auto + 1;
      while (next < avail && !has[SCENES[next].id]()) next++;
      S.auto = next; S.autoAt = now;
      S.autoScale = reduced ? 1 : clamp(planned(next, 0, now) / SCENES[next].nominal, 0.5, 1.6);
      S.shown.add(next);
      if (!S.manual) show(next, now, S.autoScale);
    }
    /** keep the full frame rate for the next ms (otherwise the view idles at a lower rate) */
    function busy(ms, now = performance.now()) { S.busyUntil = Math.max(S.busyUntil, now + ms); }
    function show(k, now, scale = 1) {
      busy(2600 * scale, now);
      S.scene = k; S.sceneAt = now; S.scale = scale; S.trail = null; S.particles = null; S.flowShown = -1;
      setText();
    }
    function setText() {
      const sc = SCENES[S ? S.scene : 0];
      if (ui.title) ui.title.textContent = sc.title;
      if (ui.eq) ui.eq.innerHTML = sc.eq;
      if (ui.cap) ui.cap.textContent = sc.cap;
    }
    let liveText = '';
    function live(t) { if (t !== liveText) { liveText = t; if (ui.live) ui.live.textContent = t; } }

    // ---------- geometry ----------
    function size() {
      const r = canvas.getBoundingClientRect(), d = Math.min(TUNE.dpr, root.devicePixelRatio || 1);   // 2x is sharp enough and half the pixels of 3x
      const w = Math.max(200, Math.round(r.width || canvas.width)), h = Math.max(200, Math.round(r.height || canvas.height));
      if (w !== cssW || h !== cssH || d !== dpr) { cssW = w; cssH = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); S.trail = null; }
    }
    /** the picture's area, between the glass strips */
    const area = () => ({ x: 10, y: HUD_TOP + 6, w: cssW - 20, h: cssH - HUD_TOP - HUD_BOTTOM - 12 });
    function photoAt(i) { return S.photos[i] || S.photos.find(Boolean); }
    function orderPos(i) { const o = S.order ? S.order.order : null; if (!o || o.length < 2) return S.n > 1 ? i / (S.n - 1) : 0; return o.indexOf(i) / (o.length - 1); }
    /** photo indices in focus order once it's known, else in the order taken */
    function seq() { const ids = S.photos.map((p, i) => p ? i : -1).filter(i => i >= 0); return S.order ? S.order.order.filter(i => S.photos[i]) : ids; }

    // ---------- sprites: one per photo, gliding between the places scenes give them ----------
    function sprite(i) {
      return S.spr[i] || (S.spr[i] = { x: 0, y: 0, w: 0, h: 0, a: 0, look: 0, z: 0, t: null, fresh: true });
    }
    /** scene layouts call this: where photo i should be (rect in picture coordinates) */
    function place(i, r, o = {}) { const s = sprite(i); s.t = { x: r.x, y: r.y, w: r.w, h: r.h, a: o.a == null ? 1 : o.a, look: o.look || 0, z: o.z || 0 }; }
    /** a row of photos (in the given order) at y, h tall; returns their rects by photo index */
    function strip(ids, y, h, x0 = null, w0 = null, gap = 3) {
      const A = area(), x = x0 == null ? A.x : x0, w = w0 == null ? A.w : w0, n = Math.max(1, ids.length);
      const p = S.photos.find(Boolean), asp = p ? p.w / p.h : 4 / 3, cw = Math.min(h * asp, (w - (n - 1) * gap) / n), total = n * cw + (n - 1) * gap;
      const out = {};
      ids.forEach((id, k) => { out[id] = fit(asp, 1, { x: x + (w - total) / 2 + k * (cw + gap), y, w: cw, h }); });
      return out;
    }
    function moveSprites(dt) {
      const k = reduced ? 1 : 1 - Math.exp(-dt / 420), ka = reduced ? 1 : 1 - Math.exp(-dt / 260);
      for (const s of S.spr) {
        if (!s || !s.t) continue;
        if (Math.abs(s.x - s.t.x) + Math.abs(s.y - s.t.y) + Math.abs(s.w - s.t.w) > 0.6 || Math.abs(s.a - s.t.a) > 0.01) busy(60);
        if (s.fresh) { Object.assign(s, s.t, { a: 0 }); s.fresh = false; }   // a new photo fades in where it belongs
        else if (s.a < 0.03 && s.t.a > s.a) Object.assign(s, { x: s.t.x, y: s.t.y, w: s.t.w, h: s.t.h });   // an unseen photo doesn't glide: it appears in its new place
        s.x = lerp(s.x, s.t.x, k); s.y = lerp(s.y, s.t.y, k); s.w = lerp(s.w, s.t.w, k); s.h = lerp(s.h, s.t.h, k);
        s.a = lerp(s.a, s.t.a, ka); s.look = lerp(s.look, s.t.look, ka); s.z = s.t.z;
      }
    }
    function drawSprites() {
      const list = S.spr.map((s, i) => [s, i]).filter(([s, i]) => s && s.a > 0.01 && S.photos[i]).sort((a, b) => a[0].z - b[0].z);
      for (const [s, i] of list) {
        const p = S.photos[i];
        g.save(); g.globalAlpha = s.a;
        g.drawImage(p.thumb, s.x, s.y, s.w, s.h);
        if (s.look > 0.01) { g.globalAlpha = s.a * s.look; g.drawImage(p.heat, s.x, s.y, s.w, s.h); }
        g.restore();
      }
    }
    const R = i => S.spr[i] || { x: 0, y: 0, w: 1, h: 1, a: 0 };     // where photo i is drawn right now
    /** within a scene the big picture cross-fades from one photo to the next (the filmstrip stays put);
        returns how far the new one has faded in */
    function swap(key, now) { if (key !== S.mainKey) { S.mainPrev = S.mainKey; S.mainKey = key; S.mainAt = now; busy(key[0] === 'm' ? 3200 : 1800, now); } return reduced ? 1 : ease((now - S.mainAt) / 450); }
    function photoIn(i, r, a) { const p = S.photos[i]; if (!p || a <= 0.01) return; g.save(); g.globalAlpha *= a; g.drawImage(p.thumb, r.x, r.y, r.w, r.h); g.restore(); }
    /** the filmstrip along the bottom of the picture, the photo on show raised and ringed */
    function filmstrip(ids, on, stripH, a = 0.45) {
      const A = area(), slots = strip(ids, A.y + A.h - stripH, stripH);
      for (const j of ids) { const r = Object.assign({}, slots[j]); if (on.includes(j)) r.y -= 4; place(j, r, { a: on.includes(j) ? 1 : a, z: on.includes(j) ? 1 : 0 }); }
      return slots;
    }
    /** amber rings round photos in the filmstrip (drawn where the photos are: outside the camera) */
    function ring(ids) {
      g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const j of ids) { const r = R(j); if (r.a < 0.05) continue; g.strokeStyle = C.amber; g.lineWidth = 1.5; g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2); }
      g.restore();
    }

    // ---------- camera ----------
    function moveCamera(dt, now) {
      const A = area(), home = { z: 1, x: A.x + A.w / 2, y: A.y + A.h / 2 };
      const T = Object.assign({}, home, S.camT || {});
      if (!reduced && !T.still) { T.z *= 1 + 0.012 * Math.sin(now / 5300); T.x += 3 * Math.sin(now / 7100); T.y += 2.5 * Math.sin(now / 6100); }   // breathing
      if (!S.cam || reduced) S.cam = Object.assign({}, T);
      const k = 1 - Math.exp(-dt / 900);
      if (Math.abs(S.cam.z - T.z) > 0.004 || Math.abs(S.cam.x - T.x) + Math.abs(S.cam.y - T.y) > 2) busy(60);
      S.cam.z = lerp(S.cam.z, T.z, k); S.cam.x = lerp(S.cam.x, T.x, k); S.cam.y = lerp(S.cam.y, T.y, k);
    }
    function camTransform() {
      const A = area(), z = S.cam.z;
      g.setTransform(dpr * z, 0, 0, dpr * z, dpr * (A.x + A.w / 2 - z * S.cam.x), dpr * (A.y + A.h / 2 - z * S.cam.y));
    }

    // ---------- a frame ----------
    function frame(now = performance.now()) {
      if (!S) reset();
      const dt = clamp(lastNow ? now - lastNow : 16, 0, 200); lastNow = now;
      size();
      advance(now, dt);
      const sc = SCENES[S.scene], t = (now - S.sceneAt) / (S.manual ? 1 : S.scale);   // scene time, at its nominal pace
      S.camT = null;
      for (const s of S.spr) if (s) s.t = Object.assign({}, s.t || { x: 0, y: 0, w: 0, h: 0 }, { a: 0 });   // unplaced photos fade out where they are
      const L = SCENE[sc.id];
      try { if (L.layout) L.layout(t, now); } catch (e) { /* drawn below */ }
      moveSprites(dt); moveCamera(dt, now);

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = C.bg; g.fillRect(0, 0, cssW, cssH);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';   // 'high' costs a lot to draw and looks the same here
      // the picture, under the camera
      g.save();
      g.beginPath(); g.rect(0, HUD_TOP - 8, cssW, cssH - HUD_TOP - HUD_BOTTOM + 16); g.clip();
      drawSprites();                                     // the photos themselves stay out of the camera's moves
      camTransform();
      const fade = reduced ? 1 : ease(t / 450);
      g.globalAlpha = fade;
      try { L.draw(t, now); } catch (e) { g.setTransform(dpr, 0, 0, dpr, 0, 0); label(g, String(e.message || e), 12, HUD_TOP + 20, { color: C.warn }); }
      g.restore();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      hud(now);
    }

    // ---------- the glass strips: title, equation, progress, the engine's own words ----------
    function hud(now) {
      const sc = SCENES[S.scene];
      let gr = g.createLinearGradient(0, 0, 0, HUD_TOP);
      gr.addColorStop(0, 'rgba(11,17,16,.97)'); gr.addColorStop(0.82, 'rgba(11,17,16,.9)'); gr.addColorStop(1, 'rgba(11,17,16,0)');
      g.fillStyle = gr; g.fillRect(0, 0, cssW, HUD_TOP);
      gr = g.createLinearGradient(0, cssH - HUD_BOTTOM - 8, 0, cssH);
      gr.addColorStop(0, 'rgba(11,17,16,0)'); gr.addColorStop(0.3, 'rgba(11,17,16,.9)'); gr.addColorStop(1, 'rgba(11,17,16,.97)');
      g.fillStyle = gr; g.fillRect(0, cssH - HUD_BOTTOM - 8, cssW, HUD_BOTTOM + 8);
      // the engine's real progress (the scene may trail it a little)
      g.fillStyle = 'rgba(79,194,185,.16)'; g.fillRect(0, 0, cssW, 3);
      g.fillStyle = C.accent; g.fillRect(0, 0, cssW * clamp01(S.p), 3);
      label(g, `${S.stage.toLowerCase()} · ${Math.round(S.p * 100)}%`, 12, 17, { size: 10, color: C.muted });
      // where we are among the scenes: filled = on screen, ringed = reached
      for (let k = 0; k < SCENES.length; k++) {
        const x = cssW - 14 - (SCENES.length - 1 - k) * 11, y = 13;
        g.beginPath(); g.arc(x, y, k === S.scene ? 3.4 : 2.6, 0, 6.283);
        if (k === S.scene) { g.fillStyle = C.accent; g.fill(); }
        else if (k <= S.auto) { g.strokeStyle = C.muted; g.lineWidth = 1.2; g.stroke(); }
        else { g.fillStyle = 'rgba(143,163,154,.25)'; g.fill(); }
      }
      let ts = 15; g.font = `700 ${ts}px ${DISPLAY}`; while (ts > 11 && g.measureText(sc.title).width > cssW - 24) { ts -= 0.5; g.font = `700 ${ts}px ${DISPLAY}`; }
      label(g, sc.title, 12, 40, { size: ts, weight: 700, font: DISPLAY, color: C.ink });
      drawEq(g, sc.eq, 12, 61, cssW - 24, 14);
      // the scene's live numbers, then the engine's last log line
      g.save(); g.beginPath(); g.rect(10, cssH - HUD_BOTTOM, cssW - 20, HUD_BOTTOM); g.clip();
      let ls = 10.5; g.font = `500 ${ls}px ${MONO}`; while (ls > 8.5 && g.measureText(liveText).width > cssW - 24) { ls -= 0.5; g.font = `500 ${ls}px ${MONO}`; }
      label(g, liveText, 12, cssH - 19, { size: ls, color: C.amber });
      const last = S.logs[S.logs.length - 1];
      if (last) label(g, '› ' + last, 12, cssH - 6, { size: 9.5, color: C.muted });
      g.restore();
      // held, or looking back
      const pill = S.manual ? `looking back · swipe ‹ for now` : S.held ? 'held · tap to go on' : '';
      if (pill) label(g, pill, cssW / 2, HUD_TOP + 14, { size: 10, align: 'center', bg: 'rgba(255,179,92,.92)', color: '#1a1206', weight: 600 });
      void now;
    }

    // ---------- the scenes ----------
    const SCENE = {
      read: {
        layout(t, now) {
          const A = area(), stripH = Math.min(46, A.h * 0.16), main = { x: A.x, y: A.y, w: A.w, h: A.h - stripH - 12 };
          const arrived = S.photos.map((p, i) => p ? i : -1).filter(i => i >= 0);
          if (!arrived.length) return;
          // the newest photo for a moment, then a slow tour of all of them (or the one tapped)
          let cur = S.lastPhoto, since = now - S.lastPhotoAt;
          if (since > 2600) cur = arrived[Math.floor((since - 2600) / 2600 + arrived.indexOf(S.lastPhoto) + 1) % arrived.length];
          if (S.pick >= 0 && now - S.pickAt < 5000) cur = S.pick;
          if (cur !== S.readCur) { S.readPrev = S.readCur; S.readCur = cur; S.readSwap = now; busy(1900, now); }
          S.readMain = main;
          const slots = strip([...Array(Math.max(S.n, arrived.length)).keys()], A.y + A.h - stripH, stripH);
          S.readSlots = slots;
          for (const i of arrived) place(i, slots[i], { look: 1 });
          S.camT = { z: 1.015 };
        },
        draw(t, now) {
          const cur = S.readCur;
          if (cur == null) { const A = area(); label(g, 'reading the first photo…', A.x + A.w / 2, A.y + A.h / 2, { align: 'center', color: C.muted }); return; }
          const p = S.photos[cur], r = fit(p.w, p.h, S.readMain), mix = reduced ? 1 : ease((now - (S.readSwap || 0)) / 450);
          // the photo before it, fading out underneath
          if (S.readPrev != null && S.photos[S.readPrev] && mix < 1) { const q = S.photos[S.readPrev], rq = fit(q.w, q.h, S.readMain); g.save(); g.globalAlpha *= 1 - mix; g.drawImage(q.heat, rq.x, rq.y, rq.w, rq.h); g.restore(); }
          g.save(); g.globalAlpha *= mix; g.drawImage(p.thumb, r.x, r.y, r.w, r.h); g.restore();
          // the focus glow sweeping down the photo on screen
          const local = now - (S.readSwap || 0);
          const sweep = reduced ? 1 : ease((local - 250) / 1300), yy = r.y + r.h * sweep;
          g.save(); g.globalAlpha *= 0.55 * mix; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
          g.save(); g.globalAlpha *= mix; g.beginPath(); g.rect(r.x, r.y, r.w, r.h * sweep); g.clip(); g.drawImage(p.heat, r.x, r.y, r.w, r.h); g.restore();
          if (sweep < 1) { g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip(); const gr = g.createLinearGradient(0, yy - 14, 0, yy + 2); gr.addColorStop(0, 'rgba(254,196,136,0)'); gr.addColorStop(1, 'rgba(254,196,136,.85)'); g.fillStyle = gr; g.fillRect(r.x, yy - 14, r.w, 16); g.restore(); }
          label(g, `photo ${cur + 1}`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
          // the one on show is ringed in the filmstrip; empty places are the photos still to come
          g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
          for (const [i, sl] of Object.entries(S.readSlots || {})) {
            if (+i === cur || !S.photos[i]) { g.strokeStyle = +i === cur ? C.amber : C.grid; g.lineWidth = +i === cur ? 1.5 : 1; g.strokeRect(sl.x - 0.5, sl.y - 0.5, sl.w + 1, sl.h + 1); }
          }
          g.restore();
          const arrived = S.photos.filter(Boolean).length;
          live(`photo ${arrived} of ${S.n} read · bright = in focus${arrived > 1 ? ' · tap one to look' : ''}`);
        }
      },

      order: {
        layout(t) {
          const A = area(), o = S.order, n = S.n, side = Math.min(A.h * 0.5, A.w * 0.46);
          const ly = A.y + side + 30, lh = A.y + A.h - ly, ids = [...Array(n).keys()].filter(i => S.photos[i]);
          // first in the order taken, then sliding into focus order
          const into = t > 2600 && o;
          const slots = strip(into ? o.order.filter(i => S.photos[i]) : ids, ly, lh - 14);
          S.orderSlots = slots;
          for (const i of ids) place(i, slots[i], { z: o && i === o.ref ? 1 : 0 });
          S.camT = { z: 1, still: true };
        },
        draw(t, now) {
          const A = area(), o = S.order, n = S.n, C2 = o && o.C;
          const side = Math.min(A.h * 0.5, A.w * 0.46), mx = A.x, my = A.y + 4;
          const settled = t > 4800, pulse = settled && o ? o.order[Math.floor((t - 4800) / 700) % o.order.length] : -1;
          if (C2) {
            // the similarity grid, filling in row by row
            const cell = side / n, shown = (reduced ? 1 : ease(t / 1800)) * n * n;
            let max = 0; for (const row of C2) for (const v of row) if (v > max) max = v;
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
              if (i * n + j > shown) continue;
              g.fillStyle = css(TEAL, C2[i][j] / (max || 1)); g.fillRect(mx + j * cell, my + i * cell, Math.ceil(cell), Math.ceil(cell));
            }
            if (pulse >= 0) { g.strokeStyle = C.amber; g.lineWidth = 1.5; g.strokeRect(mx, my + pulse * cell, side, cell); g.strokeRect(mx + pulse * cell, my, cell, side); g.lineWidth = 1; }
            g.strokeStyle = C.grid; g.strokeRect(mx + 0.5, my + 0.5, side, side);
            label(g, 'C (photo × photo)', mx, my + side + 13, { size: 10, color: C.muted });
            // the Fiedler vector as bars beside it
            const fv = o.fiedler, fmax = Math.max(...fv.map(Math.abs)) || 1, bx = mx + side + 14, bw = A.w - side - 14;
            const bh = side / n, grow = reduced ? 1 : ease((t - 1500) / 1500);
            g.strokeStyle = C.grid; g.beginPath(); g.moveTo(bx + bw / 2, my); g.lineTo(bx + bw / 2, my + side); g.stroke();
            for (let i = 0; i < n; i++) {
              const v = fv[i] / fmax * (bw / 2 - 4) * grow;
              g.fillStyle = css(DEPTH, o.order.indexOf(i) / Math.max(1, n - 1), i === pulse ? 1 : 0.85);
              g.fillRect(bx + bw / 2 + Math.min(0, v), my + i * bh + bh * 0.15, Math.abs(v), Math.max(1, bh * 0.7));
            }
            label(g, `v₂ (Fiedler vector)${o.lambda2 ? '' : ''}`, bx, my + side + 13, { size: 10, color: C.muted });
          }
          // the line of photos: depth colour round each, the reference ringed, numbers (on the photos: outside the camera)
          g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
          for (const i of Object.keys(S.orderSlots || {}).map(Number)) {
            const r = R(i), to = o ? o.order.indexOf(i) : i;
            g.strokeStyle = css(DEPTH, to / Math.max(1, n - 1)); g.lineWidth = i === pulse ? 3 : 2; g.strokeRect(r.x, r.y, r.w, r.h); g.lineWidth = 1;
            if (o && i === o.ref && t > 3600) { label(g, 'ref', r.x + r.w / 2, r.y - 3, { size: 9, align: 'center', color: C.amber }); g.strokeStyle = C.amber; g.lineWidth = 2; g.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4); g.lineWidth = 1; }
            if (r.w > 16) label(g, String(i + 1), r.x + r.w / 2, r.y + r.h + 11, { size: 9, align: 'center', color: i === pulse ? C.amber : C.muted });
          }
          g.restore();
          live(o ? `focus order ${o.order.map(i => i + 1).join(' ')} · reference photo ${o.ref + 1}` : 'working out the focus order');
          void now;
        }
      },

      features: {
        layout(t, now) {
          const A = area(), F = S.feats, ids = seq(), stripH = Math.min(34, A.h * 0.12);
          const per = clamp(SCENES[2].nominal / Math.max(1, Math.min(ids.length, 4)), 1600, 2600);
          const k = Math.floor(t / per) % Math.max(1, ids.length), i = ids[k], lt = t % per;
          S.featCur = i; S.featLt = lt; S.featPer = per;
          const main = { x: A.x, y: A.y, w: A.w, h: A.h - stripH - 14 };
          filmstrip(ids, [i], stripH);
          S.featMix = swap('f' + i, now); S.featMain = main;
          // push in towards where the landmarks crowd
          const r = fit(S.photos[i].w, S.photos[i].h, main), pts = F && F.pts[i];
          let cx = 0.5, cy = 0.5;
          if (pts && pts.length) { let sx = 0, sy = 0; for (let j = 0; j < pts.length; j += 2) { sx += pts[j]; sy += pts[j + 1]; } cx = lerp(0.5, sx / (pts.length / 2), 0.5); cy = lerp(0.5, sy / (pts.length / 2), 0.5); }
          S.camT = { z: 1 + 0.07 * ease(lt / per), x: r.x + r.w * cx, y: r.y + r.h * cy };
        },
        draw() {
          const F = S.feats, i = S.featCur; if (!F || i == null) return;
          const fr = j => fit(S.photos[j].w, S.photos[j].h, S.featMain), r = fr(i), lt = S.featLt, per = S.featPer, mix = S.featMix;
          if (S.mainPrev && S.mainPrev[0] === 'f' && mix < 1) photoIn(+S.mainPrev.slice(1), fr(+S.mainPrev.slice(1)), 1 - mix);
          photoIn(i, r, mix);
          ring([i]);
          g.save(); g.globalAlpha *= mix;
          g.save(); g.globalAlpha *= 0.35; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
          const pts = F.pts[i] || [], m = pts.length / 2, shown = Math.floor((reduced ? 1 : ease(lt / (per * 0.6))) * m);
          // the newest few in amber and growing, the rest teal: two paths a frame
          const fresh = shown - m * 0.08;
          for (const [from, to, col] of [[0, Math.max(0, Math.floor(fresh)), 'rgba(79,194,185,.9)'], [Math.max(0, Math.floor(fresh)), shown, C.amber]]) {
            g.strokeStyle = col; g.beginPath();
            for (let j = from; j < to; j++) {
              const age = (shown - j) / m, rad = (2.2 + 3 * clamp01(1 - age * 8)) / S.cam.z, x = r.x + pts[2 * j] * r.w, y = r.y + pts[2 * j + 1] * r.h;
              g.moveTo(x + rad, y); g.arc(x, y, rad, 0, 6.283);
            }
            g.stroke();
          }
          const count = Math.round(F.counts[i] * shown / Math.max(1, m));
          label(g, `photo ${i + 1}: ${fmt(count)} landmarks`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
          g.restore();
          live(`photo ${i + 1}: ${fmt(F.counts[i])} landmarks (${Math.min(m, F.counts[i])} drawn)`);
        }
      },

      match: {
        layout(t, now) {
          const A = area(), list = S.matches, ids = seq(), stripH = Math.min(30, A.h * 0.1);
          const per = clamp(SCENES[3].nominal / Math.max(1, Math.min(list.length, 3)), 2600, 4200);
          const m = list[Math.floor(t / per) % list.length]; S.matchCur = m; S.matchLt = t % per;
          const half = (A.w - 10) / 2, ih = A.h - 74 - stripH - 6;
          filmstrip(ids, [m.cur, m.against], stripH, 0.35);
          S.matchMix = swap('m' + list.indexOf(m), now);
          S.matchBoxes = [{ x: A.x, y: A.y + 14, w: half, h: ih }, { x: A.x + half + 10, y: A.y + 14, w: half, h: ih }];
          S.matchBy = A.y + 14 + ih + 16;
          S.camT = { z: 1 };
        },
        draw() {
          const A = area(), m = S.matchCur, lt = S.matchLt; if (!m) return;
          const [ba, bb] = S.matchBoxes, mix = S.matchMix, fr = (j, b) => fit(S.photos[j].w, S.photos[j].h, b);
          const ra = fr(m.cur, ba), rb = fr(m.against, bb);
          if (S.mainPrev && S.mainPrev[0] === 'm' && mix < 1) { const pm = S.matches[+S.mainPrev.slice(1)]; if (pm) { photoIn(pm.cur, fr(pm.cur, ba), 1 - mix); photoIn(pm.against, fr(pm.against, bb), 1 - mix); } }
          photoIn(m.cur, ra, mix); photoIn(m.against, rb, mix);
          ring([m.cur, m.against]);
          g.save(); g.globalAlpha *= mix;
          g.save(); g.globalAlpha *= 0.3; g.fillStyle = C.bg; g.fillRect(ra.x, ra.y, ra.w, ra.h); g.fillRect(rb.x, rb.y, rb.w, rb.h); g.restore();
          label(g, `photo ${m.cur + 1}`, ra.x + ra.w / 2, ra.y - 3, { size: 10, align: 'center', color: C.muted });
          label(g, `photo ${m.against + 1}${S.order && m.against === S.order.ref ? ' (ref)' : ''}`, rb.x + rb.w / 2, rb.y - 3, { size: 10, align: 'center', color: C.muted });
          const W = m.W, H = m.H, P = (pts, r, j) => [r.x + pts[2 * j] / W * r.w, r.y + pts[2 * j + 1] / H * r.h];
          const grow = reduced ? 1 : ease(lt / 900), judge = reduced ? 1 : ease((lt - 1000) / 700);
          // outvoted pairs: drawn, then flagged magenta and faded
          const no = m.osrc.length / 2, ni = m.isrc.length / 2;
          g.strokeStyle = judge > 0 ? `rgba(255,93,143,${0.85 * (1 - ease((lt - 2200) / 1200))})` : 'rgba(230,236,232,.35)';
          g.beginPath();
          for (let j = 0; j < no && j / no <= grow; j++) { const [x1, y1] = P(m.osrc, ra, j), [x2, y2] = P(m.odst, rb, j); g.moveTo(x1, y1); g.lineTo(lerp(x1, x2, grow), lerp(y1, y2, grow)); }
          g.stroke();
          g.strokeStyle = judge > 0 ? `rgba(79,194,185,${0.18 + 0.32 * judge})` : 'rgba(230,236,232,.22)'; g.lineWidth = 0.7; g.beginPath();
          for (let j = 0; j < ni && j / ni <= grow; j++) { const [x1, y1] = P(m.isrc, ra, j), [x2, y2] = P(m.idst, rb, j); g.moveTo(x1, y1); g.lineTo(lerp(x1, x2, grow), lerp(y1, y2, grow)); }
          g.stroke(); g.lineWidth = 1;
          g.fillStyle = judge > 0 ? C.accent : C.ink; g.beginPath();
          for (let j = 0; j < ni && j / ni <= grow; j++) { const [x1, y1] = P(m.isrc, ra, j); g.rect(x1 - 1, y1 - 1, 2, 2); if (grow >= 1) { const [x2, y2] = P(m.idst, rb, j); g.rect(x2 - 1, y2 - 1, 2, 2); } }
          g.fill();
          // the homography it found, as numbers
          const Hm = m.Hmat || m.H, rows = [0, 1, 2].map(rw => [0, 1, 2].map(c => { const v = Hm[rw * 3 + c]; return (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)).padStart(8); }).join(' '));
          const show = reduced ? 1 : ease((lt - 2000) / 800), by = S.matchBy;
          g.save(); g.globalAlpha *= judge;
          label(g, `${fmt(m.inliers)} of ${fmt(m.cand)} pairs agree` + (m.rough ? ' · framed far apart: rough fit first' : ` · fine-tune ${m.ecc}`), A.x + A.w / 2, by, { size: 10, align: 'center', color: m.rough ? C.amber : C.accent });
          g.globalAlpha = g.globalAlpha / Math.max(judge, 1e-3) * show;
          const mx = A.x + A.w / 2 - 105;
          label(g, 'H =', mx, by + 30, { size: 11, color: C.amber });
          rows.forEach((row, k) => label(g, row, mx + 30, by + 17 + k * 13, { size: 10, color: C.ink }));
          g.restore();
          g.restore();
          live(`photo ${m.cur + 1} → photo ${m.against + 1}: ${fmt(m.inliers)} of ${fmt(m.cand)} pairs agree on one plane`);
        }
      },

      aligned: {
        frame() {
          const A = area(), al = S.aligned, W = al.W, H = al.H;
          let minX = 0, minY = 0, maxX = W, maxY = H;
          al.Hs.forEach(h => { if (!h) return; [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y]) => { const [u, v] = applyH(h, x, y); minX = Math.min(minX, u); minY = Math.min(minY, v); maxX = Math.max(maxX, u); maxY = Math.max(maxY, v); }); });
          const r = fit(maxX - minX, maxY - minY, { x: A.x + 4, y: A.y + 4, w: A.w - 8, h: A.h - 8 });
          return { s: r.s, X: x => r.x + (x - minX) * r.s, Y: y => r.y + (y - minY) * r.s };
        },
        layout(t) {
          const al = S.aligned, f = SCENE.aligned.frame(), W = al.W, H = al.H, rect = { x: f.X(0), y: f.Y(0), w: W * f.s, h: H * f.s };
          // the deck collapses onto the reference: every photo glides onto it, see-through
          for (const i of seq()) place(i, rect, { a: i === al.ref ? 1 : t < 1400 ? 0.45 : 0, z: i === al.ref ? 0 : 1 });
          S.camT = { z: 1, still: true };
        },
        draw(t, now) {
          const al = S.aligned, ref = al.ref, W = al.W, H = al.H, f = SCENE.aligned.frame(), X = f.X, Y = f.Y;
          g.save(); g.globalAlpha *= 0.45; g.fillStyle = C.bg; g.fillRect(X(0), Y(0), W * f.s, H * f.s); g.restore();
          const n = al.Hs.length, I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
          // replayed every few seconds once settled, so it never sits still
          const tt = t < 9000 ? t : (t - 9000) % 6000 + 400;
          if (tt < 3800) busy(60, now);
          al.Hs.forEach((h, i) => {
            if (!h) return;
            const k = reduced ? 1 : ease((tt - i * 180) / 1400), hh = h.map((v, j) => lerp(I[j], v, k));
            g.strokeStyle = css(DEPTH, orderPos(i), 0.9); g.lineWidth = i === ref ? 2 : 1.2;
            g.beginPath(); [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y], j) => { const [u, v] = applyH(hh, x, y); j ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)); }); g.closePath(); g.stroke();
          });
          g.lineWidth = 1;
          // the hand's path: where each photo's centre landed, in the order they were taken,
          // stretched about the reference's centre so a few pixels of drift can be seen
          const raw = al.Hs.map(h => h ? applyH(h, W / 2, H / 2) : null);
          let drift = 0; raw.forEach(c => { if (c) drift = Math.max(drift, Math.hypot(c[0] - W / 2, c[1] - H / 2)); });
          const mag = drift > 0 ? Math.max(1, Math.min(12, Math.round(0.22 * Math.min(W, H) / drift))) : 1;
          const pk = reduced ? 1 : ease((tt - 1800) / 1800), cs = raw.map(c => c ? [W / 2 + (c[0] - W / 2) * mag, H / 2 + (c[1] - H / 2) * mag] : null);
          g.setLineDash([3, 4]); g.strokeStyle = C.amber; g.beginPath();
          let started = false; const upto = pk * (n - 1);
          cs.forEach((c, i) => { if (!c || i > upto + 1e-6) return; started ? g.lineTo(X(c[0]), Y(c[1])) : (g.moveTo(X(c[0]), Y(c[1])), started = true); });
          g.stroke(); g.setLineDash([]);
          cs.forEach((c, i) => { if (!c || i > upto) return; g.fillStyle = C.amber; g.beginPath(); g.arc(X(c[0]), Y(c[1]), 2.5, 0, 6.283); g.fill(); if (n <= 12 || i % 3 === 0) label(g, String(i + 1), X(c[0]) + 4, Y(c[1]) - 3, { size: 9, color: C.amber }); });
          const A = area();
          if (mag > 1 && pk > 0) label(g, `path ×${mag}`, A.x + A.w - 6, A.y + 16, { size: 10, align: 'right', bg: 'rgba(11,17,16,.7)', color: C.amber });
          live(`${n} photos lined up on photo ${ref + 1} · the hand drifted up to ${fmt(drift)} px`);
        }
      },

      flow: {
        layout(t, now) {
          const A = area(), list = S.flows, ids = seq(), stripH = Math.min(30, A.h * 0.1);
          const per = clamp(SCENES[5].nominal / Math.max(1, Math.min(list.length, 3)), 2600, 4000);
          const k = Math.floor(t / per) % list.length, f = list[k];
          S.flowCur = f; S.flowK = k; S.flowLt = t % per;
          const main = { x: A.x, y: A.y, w: A.w, h: A.h - stripH - 14 };
          filmstrip(ids, [f.cur], stripH, 0.4);
          S.flowMix = swap('w' + k, now); S.flowMain = main;
          S.camT = { z: 1.02 };
        },
        draw() {
          const f = S.flowCur, k = S.flowK, lt = S.flowLt; if (!f) return;
          if (!reduced) busy(60);                          // the particles are always moving
          const fr = j => fit(S.photos[j].w, S.photos[j].h, S.flowMain), r = fr(f.cur), mix = S.flowMix;
          if (S.mainPrev && S.mainPrev[0] === 'w' && mix < 1) { const pf = S.flows[+S.mainPrev.slice(1)]; if (pf) photoIn(pf.cur, fr(pf.cur), 1 - mix); }
          photoIn(f.cur, r, mix);
          ring([f.cur]);
          g.save(); g.globalAlpha *= mix; this.over(f, k, lt, r); g.restore();
        },
        over(f, k, lt, r) {
          g.save(); g.globalAlpha *= 0.5; g.fillStyle = C.bg; g.fillRect(r.x, r.y, r.w, r.h); g.restore();
          if (f.trustCanvas) { g.save(); g.globalAlpha *= reduced ? 1 : ease(lt / 800); g.drawImage(f.trustCanvas, r.x, r.y, r.w, r.h); g.restore(); }
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
          if (!reduced) {
            // particles drifting along the (exaggerated) flow, leaving trails. The trail layer is
            // kept at 1x (it's soft anyway) and the strokes are batched by colour: a few paths a frame
            const tw = Math.max(1, Math.round(r.w)), th = Math.max(1, Math.round(r.h));
            if (!S.trail || S.flowShown !== k || Math.abs(S.trail.width - tw) > 4) {
              S.trail = canvasOf(tw, th); S.flowShown = k;
              S.particles = [...Array(200)].map(() => ({ x: Math.random() * G.gw, y: Math.random() * G.gh, life: Math.random() * 60 }));
            }
            const tg = S.trail.getContext('2d'), sx = S.trail.width / G.gw, sy = S.trail.height / G.gh;
            tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = 'rgba(0,0,0,.08)'; tg.fillRect(0, 0, S.trail.width, S.trail.height); tg.globalCompositeOperation = 'source-over';
            tg.lineWidth = 1.3;
            const buckets = new Map();                    // hue (12 steps) x speed (3 steps) -> segments
            for (const q of S.particles) {
              const [u, v] = field(q.x, q.y), sp = Math.hypot(u, v) / (max || 1);
              const nx = q.x + u * disp / cw * 0.045, ny = q.y + v * disp / ch * 0.045;
              const key = (Math.round((Math.atan2(v, u) / 6.283 + 0.5) * 12) % 12) * 3 + Math.min(2, Math.floor(sp * 3));
              let seg = buckets.get(key); if (!seg) buckets.set(key, seg = []);
              seg.push(q.x * sx, q.y * sy, nx * sx, ny * sy);
              q.x = nx; q.y = ny; q.life--;
              if (q.life < 0 || q.x < 0 || q.y < 0 || q.x > G.gw || q.y > G.gh || sp < 0.02 && Math.random() < 0.05) { q.x = Math.random() * G.gw; q.y = Math.random() * G.gh; q.life = 40 + Math.random() * 40; }
            }
            for (const [key, seg] of buckets) {
              const hue = Math.floor(key / 3) * 30, spd = (key % 3 + 0.5) / 3;
              tg.strokeStyle = `hsla(${hue},85%,${55 + 15 * spd}%,${0.25 + 0.7 * spd})`;
              tg.beginPath(); for (let j = 0; j < seg.length; j += 4) { tg.moveTo(seg[j], seg[j + 1]); tg.lineTo(seg[j + 2], seg[j + 3]); } tg.stroke();
            }
            g.drawImage(S.trail, r.x, r.y, r.w, r.h);
          }
          // the field itself as small arrows on a coarser grid
          g.strokeStyle = 'rgba(230,236,232,.55)'; g.lineWidth = 1; g.beginPath();
          for (let y = 0; y < G.gh; y += 2) for (let x = 0; x < G.gw; x += 2) {
            const q = y * G.gw + x, u = G.u[q] * disp, v = G.v[q] * disp;
            const cx = r.x + (x + 0.5) * cw, cy = r.y + (y + 0.5) * ch, ex = cx + u, ey = cy + v;
            if (Math.hypot(ex - cx, ey - cy) < 1.5) continue;
            g.moveTo(cx, cy); g.lineTo(ex, ey);
          }
          g.stroke();
          const ex = Math.round(gain);
          label(g, `photo ${f.cur + 1} vs reference`, r.x + 6, r.y + 16, { size: 11, bg: 'rgba(11,17,16,.7)' });
          if (ex > 1) label(g, `shifts ×${ex}`, r.x + r.w - 6, r.y + 16, { size: 10, align: 'right', bg: 'rgba(11,17,16,.7)', color: C.amber });
          live(`photo ${f.cur + 1}: largest shift ${max.toFixed(1)} px · ` + (f.accepted ? `corrected ${Math.max(1, Math.round(f.share * 100))}% (match ${f.nccG.toFixed(3)} → ${f.nccF.toFixed(3)})` : 'no correction needed'));
        }
      },

      winners: {
        layout(t) {
          const A = area(), wn = S.winners, n = wn.order.length, thumbH = Math.min(34, A.h * 0.11), legendH = thumbH + 30;
          const r = fit(wn.w, wn.h, { x: A.x, y: A.y, w: A.w, h: A.h - legendH - 4 });
          S.winRect = r; S.winLegendY = A.y + A.h - legendH + thumbH + 6;
          // each photo sits above its colour in the legend; the one being shown rises
          const left = new Set(wn.left.map(l => l.i)), cw = A.w / n;
          const settled = t > 2200, focus = settled ? wn.used[Math.floor((t - 2200) / 1400) % wn.used.length] : -1;
          if (focus !== S.winFocus) busy(700);
          S.winFocus = focus;
          wn.order.forEach((ph, j) => {
            if (!S.photos[ph]) return;
            const p = S.photos[ph], box = fit(p.w, p.h, { x: A.x + j * cw + 1, y: S.winLegendY - thumbH - 4, w: cw - 2, h: thumbH });
            if (ph === focus) { box.y -= 6; }
            place(ph, box, { a: left.has(ph) ? 0.3 : 1, z: ph === focus ? 2 : 0 });
          });
          S.camT = { z: 1, still: true };
        },
        draw(t) {
          const A = area(), wn = S.winners, r = S.winRect, n = wn.order.length;
          // revealed from the centre outwards
          const k = reduced ? 1 : ease(t / 1600), rad = k * Math.hypot(r.w, r.h) / 2;
          g.save(); g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, rad), 0, 6.283); g.clip();
          g.imageSmoothingEnabled = false;
          const focus = S.winFocus;
          if (focus >= 0) {
            // once settled: one photo at a time lights up where it won the vote
            g.globalAlpha *= 0.35; g.drawImage(wn.canvas, r.x, r.y, r.w, r.h); g.globalAlpha /= 0.35;
            g.drawImage(winMask(focus), r.x, r.y, r.w, r.h);
          } else g.drawImage(wn.canvas, r.x, r.y, r.w, r.h);
          g.imageSmoothingEnabled = true; g.restore();
          // legend: the colour of each photo in focus order; left-out photos struck through
          g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
          const ly = S.winLegendY, cw = A.w / n, left = new Set(wn.left.map(l => l.i));
          wn.order.forEach((ph, j) => {
            g.fillStyle = css(DEPTH, n > 1 ? j / (n - 1) : 0, left.has(ph) ? 0.25 : 1); g.fillRect(A.x + j * cw, ly, Math.ceil(cw), 6);
            if (ph === focus) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.strokeRect(A.x + j * cw + 0.5, ly - 0.5, cw - 1, 7); g.lineWidth = 1; }
            if (n <= 16 || j % Math.ceil(n / 12) === 0 || ph === focus) label(g, String(ph + 1), A.x + j * cw + cw / 2, ly + 17, { size: 9, align: 'center', color: left.has(ph) ? C.warn : ph === focus ? C.ink : C.muted });
          });
          g.restore();
          wn.left.slice(0, 3).forEach((l, j) => label(g, `photo ${l.i + 1} left out: ${l.why}`, r.x + 6, r.y + 16 + j * 15, { size: 10, bg: 'rgba(11,17,16,.75)', color: C.warn }));
          if (focus >= 0) {
            const share = winShare(focus);
            live(`photo ${focus + 1} is the sharpest across ${share < 1 ? share.toFixed(1) : Math.round(share)}% of what's in focus`);
          } else live(`using ${wn.used.length} of ${n} photos · colour = which photo is sharpest there`);
        }
      },

      merge: {
        layout(t) {
          // the photos go into the merge: they shrink into the middle of the frame and fade
          const A = area(), c = { x: A.x + A.w / 2 - 8, y: A.y + A.h / 2 - 6, w: 16, h: 12 };
          for (const i of seq()) place(i, t < 300 ? R(i) : c, { a: t < 900 ? 0.6 : 0 });
          S.camT = { z: 1 };
        },
        draw(t, now) {
          const A = area(), bx = S.box, W = bx ? bx.W : (S.strips[0] && S.strips[0].W), H = bx ? bx.H : (S.strips[0] && S.strips[0].H);
          if (!W) return;
          const pyrH = Math.min(52, A.h * 0.18), main = { x: A.x, y: A.y + pyrH + 8, w: A.w, h: A.h - pyrH - 8 };
          // final: the cropped stack, filling the frame; before that, the whole working frame with
          // the depth map underneath and finished rows painted over it as each strip lands
          let fin = S.strips.find(s => s.rgba);
          if (!fin && bx && S.strips.length && Math.max(...S.strips.map(s => s.y1)) >= H) {
            // every strip is in: put them together once and keep only the crop, as the app will
            const sw = S.strips[0].c.width, sh = Math.round(H * sw / W), all = canvasOf(sw, sh), ag = all.getContext('2d');
            for (const st of S.strips) ag.drawImage(st.c, 0, Math.round(st.y0 / H * sh), sw, Math.max(1, Math.round((st.y1 - st.y0) / H * sh)));
            const b = bx.box, cw2 = Math.max(1, Math.round(b.w / W * sw)), ch2 = Math.max(1, Math.round(b.h / H * sh)), crop = canvasOf(cw2, ch2);
            crop.getContext('2d').drawImage(all, Math.round(b.x / W * sw), Math.round(b.y / H * sh), cw2, ch2, 0, 0, cw2, ch2);
            fin = { c: crop, rgba: true, w: b.w, y0: 0, y1: b.h, assembled: true, at: now };
            S.strips = [fin];
          }
          if (fin) {
            if (!fin.at) fin.at = now;
            const r = fit(fin.c.width, fin.c.height, main), z = 1 + 0.04 * ease((now - fin.at) / 8000);
            g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
            g.drawImage(fin.c, r.x - r.w * (z - 1) / 2, r.y - r.h * (z - 1) / 2, r.w * z, r.h * z); g.restore();
            live(`done: ${fmt(fin.w)} × ${fmt(fin.y1 - fin.y0)} px from ${bx ? bx.used.length : '?'} photos`);
          } else {
            const r = fit(W, H, main);
            if (S.winners) { g.save(); g.globalAlpha *= 0.45; g.imageSmoothingEnabled = false; g.drawImage(S.winners.canvas, r.x, r.y, r.w, r.h); g.imageSmoothingEnabled = true; g.restore(); }
            let lowest = 0;
            for (const s of S.strips) {
              const y0 = r.y + s.y0 / H * r.h, h = (s.y1 - s.y0) / H * r.h;
              g.drawImage(s.c, r.x, y0, r.w, h + 0.5); lowest = Math.max(lowest, s.y1);
            }
            if (bx) { g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,179,92,.7)'; const b = bx.box; g.strokeRect(r.x + b.x / W * r.w, r.y + b.y / H * r.h, b.w / W * r.w, b.h / H * r.h); g.setLineDash([]); }
            if (lowest < H) {
              busy(60, now);                               // the edge of the merged rows pulses
              const yy = r.y + lowest / H * r.h, pulse = 0.5 + 0.5 * Math.sin(now / 260);
              const gr = g.createLinearGradient(0, yy, 0, yy + 18); gr.addColorStop(0, `rgba(79,194,185,${0.5 + 0.4 * pulse})`); gr.addColorStop(1, 'rgba(79,194,185,0)');
              g.fillStyle = gr; g.fillRect(r.x, yy, r.w, 18);
            }
            live(S.strips.length ? `merged rows 0–${fmt(lowest)} of ${fmt(H)}` : 'measuring texture and noise before merging');
          }
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
          void t;
        }
      }
    };

    /** the vote map with only photo ph's wins lit (made once per photo) */
    function winMask(ph) {
      if (S.winMasks[ph]) return S.winMasks[ph];
      const wn = S.winners, k = Math.round(wn.pos.get(ph) * 255) * 3;
      let won = 0;
      const c = toCanvas(wn.w, wn.h, wn.val, 1, (i, D, q) => {
        if (wn.best[i] !== ph) { D[q + 3] = 0; return; }
        won++; const l = 0.55 + 0.45 * wn.val[i] / 255; D[q] = DEPTH[k] * l + 40; D[q + 1] = DEPTH[k + 1] * l + 40; D[q + 2] = DEPTH[k + 2] * l + 40;
      });
      let any = 0; for (let i = 0; i < wn.best.length; i++) if (wn.best[i] !== 255) any++;
      c.share = 100 * won / Math.max(1, any);
      return (S.winMasks[ph] = c);
    }
    const winShare = ph => winMask(ph).share;

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

    // ---------- touch: tap to hold, swipe to look back ----------
    let down = null;
    canvas.style.touchAction = 'pan-y';                  // vertical drags still scroll the page
    canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', e => {
      if (!down || !S) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y, dt = performance.now() - down.t, now = performance.now();
      down = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        // right = back to an earlier scene, left = forward again, as far as the engine has got
        const reached = [...S.shown].sort((a, b) => a - b), at = reached.indexOf(S.scene);
        const to = dx > 0 ? reached[Math.max(0, at - 1)] : reached[Math.min(reached.length - 1, at + 1)];
        if (to === S.auto) { S.manual = false; show(S.auto, now, S.autoScale); S.sceneAt = S.autoAt; }
        else if (to != null && to !== S.scene) { S.manual = true; show(to, now, 1); }
        return;
      }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 500) {
        // a tap on a photo in the reading filmstrip shows that photo; anywhere else holds or releases
        if (SCENES[S.scene].id === 'read' && S.readSlots) {
          const rc = canvas.getBoundingClientRect(), px = e.clientX - rc.left, py = e.clientY - rc.top;
          for (const [i, sl] of Object.entries(S.readSlots)) {
            if (S.photos[i] && px >= sl.x - 2 && px <= sl.x + sl.w + 2 && py >= sl.y - 4 && py <= sl.y + sl.h + 4) { S.pick = +i; S.pickAt = now; return; }
          }
        }
        S.held = !S.held;
      }
    });

    let lastFrame = 0;
    // ~30 frames a second while something moves, ~12 while the scene only breathes
    function loop(now) {
      if (!running) return;
      const every = S && now < S.busyUntil ? 1000 / TUNE.fps : 1000 / TUNE.idle;
      if (now - lastFrame >= every - 2) { lastFrame = now; frame(now); }
      raf = requestAnimationFrame(loop);
    }
    reset();
    return {
      reset, peek, progress, log, frame,
      start() { if (running) return; running = true; lastNow = 0; raf = requestAnimationFrame(loop); },
      stop() { running = false; cancelAnimationFrame(raf); },
      get state() { return S; },
      scenes: SCENES
    };
  }

  root.SpoodMaths = { create, SCENES };
})(typeof self !== 'undefined' ? self : this);
