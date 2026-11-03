/* Salticid stacker engine — browser/Node port of stacker.py (OpenCV.js).
   stackFrames(cv, frames, opts) -> {data: Uint8ClampedArray (RGBA), width, height, log, ref}
   frames: [{data: Uint8ClampedArray RGBA, width, height, taken?, srcPixels?}] - or, instead of
           data, read(): async, returns the RGBA pixels (width x height); called once, when
           the engine reaches that photo - or file: a File the host's decodeImage(file, w, h)
           opens (helpers can open it too).
           taken: optional capture time in ms (EXIF or file name); a photo taken
           well apart from the rest is never the reference, but is otherwise judged
           like any other: used wherever it matches.
   opts: maxSide, onProgress(p, stage), onLog(msg), onSelection({used, left}),
         store: where big images are parked (see MEM_STORE); stripRows: merge in strips;
         pool: {size, limits, run(task, args, onProgress)} - helpers that run `tasks` side by
         side (only used when the store is shareable);
         onFrame(frame) - optional; receives each lined-up photo cropped and finished
         like the stack ({photo, used, why, ref, width, height, data, focus}) for retouching.
         onDebug(name, data) - optional, for the test tools: 'lined' / 'flowed' (the lined-up
         photos before / after local correction, plus trust maps), 'weights' (each used
         photo's share of the stack, half size), 'merged' (photos merged per spot).
   ref: 1-based number of the reference photo (the stack has its geometry and EXIF).  */
(function (root) {
  'use strict';

  const tick = () => new Promise(r => setTimeout(r, 0));

  function stackFrames(cv, frames, opts = {}) {
    return run(cv, frames, opts);
  }

  /* ---------- memory: how big a stack fits ----------
     OpenCV.js keeps everything in one WebAssembly heap with a hard ceiling (4 GiB in the build the
     app loads, 2 GiB in its fallback), however much memory the phone has. Big per-photo images
     wait outside it (park/unpark), full-size steps work in bands and the merge a strip of rows at
     a time, so what is left grows slowly with the working size and the number of photos. The
     figures are measured peaks in MiB (tools/memprobe.js, exact-growth build): 26 x 12 MP and
     10 x 12 MP (4000 x 3000), 26 x 50 MP (8160 x 6120). */
  const HEAP_CAP_MIB = 2047;
  const STRIP_CTX = 512;                                  // rows of context a strip carries (256 each side)
  const STRIP_JS_MIB = 512;                               // the merge's own (JS) buffers for one strip, at most
  /** Each stage's share of the run time, from measured costs (seconds per photo on a slow
      2-core machine with the SIMD build; mp = megapixels): at(stage, fraction done) -> 0..1. */
  function progressPlan(n, W, H, stripRows, retouch, pool) {
    const mp = W * H / 1e6, strips = stripRows ? stripRows / Math.max(1, stripRows - STRIP_CTX) : 1;
    // with helpers, a step that runs k at a time takes about 1 / (1 + 0.65 (k - 1)) as long
    const k = name => pool ? Math.max(1, Math.min(pool.size, (pool.limits && pool.limits[name]) || pool.size)) : 1;
    const cores = pool && pool.cores ? pool.cores : Infinity;     // more helpers than cores don't add speed
    const par = (name, tasks) => 1 + 0.65 * (Math.min(k(name), tasks, cores) - 1);
    const alignPar = pool ? 1 / (0.2 / par('features', n) + 0.8 / Math.min(1.6, par('chain', 2))) : 1;
    const cost = [
      ['read', n * 0.03 * mp], ['order', n * 0.05], ['align', (n - 1) * 1.3 / alignPar],
      ['warp', (n - 1) * 0.07 * mp / par('warp', n)], ['prep', n * 0.012 * mp], ['flow', (n - 1) * (0.55 + 0.13 * mp) / par('flow', n)],
      ['select', n * (0.25 + 0.036 * mp) / par('select', n)], ['export', retouch ? n * 0.035 * mp / par('exportFrame', n) : 0],
      ['merge', n * 0.165 * mp * strips / par('strip', stripRows ? Math.ceil(H / Math.max(1, stripRows - STRIP_CTX)) : 1)]];
    const total = cost.reduce((a, c) => a + c[1], 0), span = {};
    let acc = 0;
    for (const [k, c] of cost) { span[k] = [acc / total, (acc + c) / total]; acc += c; }
    return (k, f) => { const [a, b] = span[k]; return a + (b - a) * Math.min(1, Math.max(0, f)); };
  }
  /** Peak heap need in MiB, before the merge, for n photos at W x H. */
  function stagesNeedMiB(n, W, H) {
    const mp = W * H / 1e6, px = mp * 0.954, g = Math.min(1, mp / 1.92);   // px: MiB per byte a pixel
    const read = 34 + 2 * n * g + 7.9 * px;               // 26 x 12 MP: 176, 10 x 12 MP: 144, 26 x 50 MP: 464
    const align = 160 + 3 * n * g + 4 * px;               // features and fine-tune at <= 1600 px, the warp
    const flow = 18 + 2 * n * g + 17.65 * px;             // 26 x 12 MP: 272, 10 x 12 MP: 240, 26 x 50 MP: 912
    return Math.max(read, align, flow);
  }
  /** Peak heap need of the merge with strips of `rows` rows (context included). */
  function mergeNeedMiB(n, W, H, rows) {
    return 30 + (1.32 * n + 36.2) * W * Math.min(H, rows) / 1048576;   // 26 x 12 MP, 1792 rows: 512; 10 x 12 MP: 368
  }
  /** Strip height for the merge: as tall as fits within what the earlier stages need anyway (and
      a little more), with the merge's own buffers kept to STRIP_JS_MIB; taller strips repeat less
      context work. null = merge the whole frame at once. */
  function stripRowsFor(n, W, H, roomMiB) {
    const jsRows = Math.max(1024, Math.floor(STRIP_JS_MIB * 1048576 / (63 * W)));
    if (H <= jsRows && mergeNeedMiB(n, W, H, H) <= roomMiB) return null;
    for (let r = Math.floor(Math.min(H + STRIP_CTX, jsRows, 6144) / 64) * 64; r >= 1024; r -= 64) if (mergeNeedMiB(n, W, H, r) <= roomMiB) return r;
    return 1024;
  }
  /** Peak heap need in MiB for n photos at W x H (6% allowed for allocator slack), with the
      strip height it implies. budgetMiB caps the room given to the merge. */
  function heapNeedMiB(n, W, H, budgetMiB = Infinity) {
    const stages = stagesNeedMiB(n, W, H);
    const room = Math.min(Math.max(stages, 560), budgetMiB / 1.06);
    const stripRows = stripRowsFor(n, W, H, room);
    const need = Math.max(stages, mergeNeedMiB(n, W, H, stripRows || H));
    return { need: need * 1.06, stripRows };
  }
  /** The working size (long side) to stack at: the photos' own size, or opts.maxSide if
      smaller, stepped down until the memory need fits. native: [{width, height}].
      opts.lowMemory: a phone with 4 GB or less. opts.heapCapMiB: the OpenCV.js build's ceiling. */
  function planSize(native, opts = {}) {
    const n = native.length;
    const nativeSide = Math.max(...native.map(d => Math.max(d.width, d.height)));
    const budget = Math.min((opts.heapCapMiB || HEAP_CAP_MIB) * 0.9, opts.lowMemory ? 640 : 1400);
    const dims = side => {
      let W = 0, H = 0;
      for (const d of native) { const s = Math.min(1, side / Math.max(d.width, d.height)); W = Math.max(W, Math.round(d.width * s)); H = Math.max(H, Math.round(d.height * s)); }
      return [W, H];
    };
    const want = Math.min(nativeSide, opts.maxSide || Infinity);
    let side = want, [W, H] = dims(side), est = heapNeedMiB(n, W, H, budget);
    while (est.need > budget && side > 1200) {
      side = Math.max(1200, Math.floor(side * 0.94));
      [W, H] = dims(side); est = heapNeedMiB(n, W, H, budget);
    }
    const plan = { side, width: W, height: H, nativeSide, wanted: want, shrunk: side < want, stripRows: est.stripRows,
      needMiB: Math.round(est.need), budgetMiB: Math.round(budget), helpers: 0, limits: null };
    if (opts.helpers) Object.assign(plan, helperPlan(n, W, H, opts.helpers, opts.lowMemory ? 600 : 1600));
    return plan;
  }
  /** With k helpers sharing budgetMiB between them: how many may run each kind of step at once,
      and the strip height that finishes the merge soonest (each strip carries 512 rows of
      context, so more, thinner strips cost more work in all). */
  function helperPlan(n, W, H, k, budgetMiB) {
    const px = W * H / 1e6 * 0.954;
    const need = { flow: 18 + 20.7 * px, warp: 30 + 4 * px, exportFrame: 20 + 6 * px, texture: 20 + 2 * px };
    const stripNeed = rows => mergeNeedMiB(n, W, H, rows) + 63 * W * Math.min(H, rows) / 1048576;
    const limits = {};
    for (const t in need) limits[t] = Math.max(1, Math.min(k, Math.floor(budgetMiB / need[t])));
    // a retouch copy is also turned into a JPEG, which holds about three full-size RGBA copies
    // outside the heap while it runs: two at a time keeps that peak down for little time
    limits.exportFrame = Math.min(limits.exportFrame, 2);
    let best = null;
    for (let kk = 1; kk <= k; kk++) for (let m = 1; m <= 8; m++) {
      const core = Math.max(2 * STRIP_CF + 64, Math.ceil(H / (kk * m) / 64) * 64), rows = core + 2 * STRIP_OV;
      if (kk * stripNeed(rows) > budgetMiB) continue;
      const strips = Math.ceil(H / core), time = Math.ceil(strips / kk) * Math.min(H, rows);
      if (!best || time < best.time - 1) best = { time, rows, kk };
    }
    if (!best || best.time >= H) return { helpers: k, limits: Object.assign(limits, { strip: 1, noise: 1 }), stripRows: null };   // whole frame here
    limits.strip = best.kk; limits.noise = Math.max(1, Math.min(k, Math.floor(budgetMiB / (stripNeed(best.rows) * 0.6))));
    return { helpers: k, limits, stripRows: best.rows };
  }

  async function run(cv, frames, opts) {
    const progress = opts.onProgress || (() => {});
    const log = [];
    const say = m => { log.push(m); if (opts.onLog) opts.onLog(m); };
    const maxSide = opts.maxSide || 3000;
    // the final unsharp mask: 0.35 unless the caller (the app) sharpens the result itself
    const SHARPEN = opts.sharpen === undefined ? 0.35 : +opts.sharpen || 0;
    STORE = opts.store || MEM_STORE;
    const n = frames.length;
    if (n < 2) throw new Error('Add at least 2 photos of the same subject.');
    const trash = [];
    const hold = m => { trash.push(m); return m; };
    const free = (...ms) => ms.forEach(m => { if (m && !m.isDeleted()) m.delete(); });
    const sz = (w, h) => new cv.Size(w, h);
    // helper workers (each with its own OpenCV) that run the heavy per-photo and per-strip steps
    // side by side; without them (or when a parked image isn't where they can reach it) the same
    // steps run here one after another, with the same result
    const pool = opts.pool && opts.pool.size > 0 && STORE.shareable ? opts.pool : null;
    const runId = Math.random().toString(36).slice(2);
    const each = (name, list, onDone, onPart, keep) => runTasks(cv, pool, name, list, onDone, onPart, null, keep);

    // ---------- 1. load: RGBA -> RGB float-free 8-bit, common size ----------
    let W = 0, H = 0;
    for (const f of frames) {
      const s = Math.min(1, maxSide / Math.max(f.width, f.height));
      W = Math.max(W, Math.round(f.width * s)); H = Math.max(H, Math.round(f.height * s));
    }
    // the full-size grey is needed only here, for two numbers per photo; everything
    // before the warp works at <= 1600 px, so only that copy is kept, as 8-bit
    const pre = Math.min(1, 1600 / Math.max(W, H));
    // the progress bar moves by each stage's share of the time it takes, so it (and the time
    // left the app shows) runs evenly
    const at = progressPlan(n, W, H, opts.stripRows && H > opts.stripRows ? opts.stripRows : 0, !!opts.onFrame, opts.pool && opts.pool.size > 0 && STORE.shareable ? opts.pool : null);
    const cy0 = Math.floor(H * .3), cy1 = Math.floor(H * .7), cx0 = Math.floor(W * .3), cx1 = Math.floor(W * .7);
    const rgb = [], gray = [], centreFocus = new Array(n), repeatS = new Array(n);
    // small float copies for the focus order (512 x 384) and the clamp test (~200 px), made from
    // the float grey as before; the <= 1600 px grey itself is kept 8-bit
    const ordSmall = [], clampSmall = [];
    const cf = Math.min(1, 200 / Math.max(W, H)), cw = Math.max(8, Math.round(W * cf)), ch = Math.max(8, Math.round(H * cf));
    // each photo read (decoded only now if it came as a file), turned RGB and parked, and its
    // small copies made: side by side when there are helpers and the photos are files they can open
    const rjobs = frames.map((f, i) => ({ fw: f.width, fh: f.height, file: f.file, W, H, pre, cw, ch, centre: [cx0, cy0, cx1, cy1], dst: parkEmpty(H, W, cv.CV_8UC3, 3), i }));
    const byHelpers = pool && frames.every(f => f.file);
    const rres = await runTasks(cv, byHelpers ? pool : null, 'read', rjobs, k => progress(at('read', k / n), 'Reading photos'), () => {},
      async (a, i) => { if (!byHelpers && !a.file) { const f = frames[i]; a.data = f.read ? await f.read() : f.data; f.data = null; } });
    rres.forEach((r, i) => {
      rgb.push(rjobs[i].dst); centreFocus[i] = r.centreFocus; repeatS[i] = r.repeatS;
      ordSmall.push(cv.matFromArray(384, 512, cv.CV_32F, r.ord)); clampSmall.push(cv.matFromArray(ch, cw, cv.CV_32F, r.clamp));
      gray.push(cv.matFromArray(r.gray.rows, r.gray.cols, cv.CV_8U, r.gray.data));
    });
    rres.length = 0;
    say(`${n} photos, working size ${W}×${H}`);

    // ---------- 2. masks, order, reference ----------
    const masks = vignetteMasks(cv, clampSmall, W, H); // one shared mask, not one copy per photo
    if (opts.onDebug) opts.onDebug('masks', { width: W, height: H, masks: masks.map(m => Uint8Array.from(m.data)) });
    const order = orderFrames(cv, ordSmall);
    ordSmall.forEach(m => m.delete()); clampSmall.forEach(m => m.delete());
    const moment = moments(frames);
    if (moment.split) say(`taken at ${moment.groups} different moments (more than ${MOMENT_GAP / 1000} s apart)`);
    let ref = 0, best = -1;
    for (let i = 0; i < n; i++) {
      if (moment.apart[i]) continue;                   // the reference comes from the main burst
      const v = centreFocus[i];
      if (v > best) { best = v; ref = i; }
    }
    const refPos = order.indexOf(ref);
    const repeating = repeatS.some(v => v > REPEAT);
    const big = Math.max(W, H);
    if (repeating) say('repeating texture in view (a mesh?): lined up from features only');
    say(`focus order ${order.map(o => o + 1).join(' ')}, reference photo ${ref + 1}`);
    progress(at('order', 1), 'Working out focus order');
    await tick();

    // ---------- 3. global alignment ----------
    // Each photo's features first (side by side when there are helpers), then the line-ups: a
    // chain from the reference towards each end of the focus order, the two chains side by side.
    const srcPx = frames.map(f => f.srcPixels || f.width * f.height);
    const maskP = park(cv, masks[0].clone());            // the clamp mask (the same for every photo)
    const gd = gray.map(g => ({ data: new Uint8Array(g.data), rows: g.rows, cols: g.cols }));
    gray.forEach(g => g.delete());
    const fts = await each('features', gd.map(g => ({ g, mask: maskP, pre })), k => progress(at('align', 0.2 * k / n), 'Lining up photos'));
    const chainArgs = [-1, 1].map(dir => ({ dir, order, ref, refPos, grays: gd, feats: fts, mask: maskP, repeating, big, pre }));
    const lens = [refPos, n - 1 - refPos], part = [0, 0];
    const cres = await each('chain', chainArgs, () => {}, (c, f) => { part[c] = f * lens[c]; progress(at('align', 0.2 + 0.8 * (part[0] + part[1]) / Math.max(1, n - 1)), 'Lining up photos'); });
    const Hs = new Array(n); Hs[ref] = eye3();
    const inl = new Array(n).fill(9999), eccOk = new Array(n).fill(true);
    for (const r of cres) { for (const [i, h, nI, ok] of r.done) { Hs[i] = h; inl[i] = nI; eccOk[i] = ok; } r.logs.forEach(say); }
    gd.length = 0; fts.length = 0;
    // warped a band of rows at a time, straight into the parked copy (each output row depends
    // only on the line-up, so the bands join exactly)
    const warped = new Array(n), wmask = new Array(n), wjobs = [];
    progress(at('warp', 0), 'Lining up photos');
    for (let i = 0; i < n; i++) {
      if (Hs[i].every((v, k) => v === (k % 4 === 0 ? 1 : 0))) {
        // the reference: warping it would copy it pixel for pixel (interpolation at whole pixels)
        warped[i] = rgb[i]; rgb[i] = null; wmask[i] = park(cv, masks[i].clone());
        continue;
      }
      warped[i] = parkEmpty(H, W, cv.CV_8UC3, 3); wmask[i] = parkEmpty(H, W, cv.CV_8U, 1);
      wjobs.push({ i, args: { src: rgb[i], Hm: Hs[i], W, H, mask: maskP, img: warped[i], msk: wmask[i] } });
    }
    new Set(masks).forEach(m => m.delete());
    await each('warp', wjobs.map(j => j.args), k => progress(at('warp', k / wjobs.length), 'Lining up photos'));
    for (const j of wjobs) { STORE.drop(rgb[j.i].h); rgb[j.i] = null; }
    STORE.drop(maskP.h);

    // ---------- 3b. coverage ----------
    // A photo framed differently covers only part of the reference's view. Where it
    // has no pixels of its own it is filled from the photos that do, so its pyramid
    // has no false edges there; its weight is zero there (coverage maps, below).
    progress(at('prep', 0), 'Correcting movement');
    const covShare = fillUncovered(cv, warped, wmask, ref);
    progress(at('prep', 0.35), 'Correcting movement');
    covShare.forEach((c, i) => { if (i !== ref && c < 0.97) say(`photo ${i + 1}: covers ${Math.round(c * 100)}% of the reference's view`); });
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);

    // ---------- 4. local alignment, decided pixel by pixel ----------
    // The flow is worked out both ways (reference → photo and back). Where the two
    // agree, the correction is used; where they don't (an occlusion, a repeating
    // mesh, a moved leg) that spot keeps the plain line-up. trust[i] marks where the
    // photo can be believed: the two-way check passed, or the plain line-up already
    // agreed with the reference there.
    // greys kept as 8-bit (they come from 8-bit photos anyway); a float copy is made
    // only while one is in use (was a full-size float per photo, 4 bytes a pixel)
    const wg = warped.map((p, i) => {
      progress(at('prep', 0.35 + 0.55 * i / n), 'Correcting movement');
      const out = parkEmpty(H, W, cv.CV_8U, 1);
      for (let y0 = 0; y0 < H; y0 += BAND) { const y1 = Math.min(H, y0 + BAND), m = unpark(cv, p, y0, y1), g = gray8(cv, m); m.delete(); parkRows(out, y0, g); g.delete(); }
      return out;
    });
    const F = p => Fp(cv, p);                             // float grey of a parked 8-bit grey
    if (opts.onDebug) opts.onDebug('lined', { ref, width: W, height: H, grays: wg.map(g => Float32Array.from(pdata(g), v => v / 255)), Hs: Hs.map(h => h.slice()) });
    const trust = new Array(n).fill(null);
    // the reference's side of every comparison below is made once (small and half-size copies),
    // by whoever does the work
    const refKey = runId + ':ref';
    progress(at('prep', 1), 'Correcting movement');
    const fjobs = order.filter(c => c !== ref).map(cur => ({ cur, wg: wg[cur], wm: wmask[cur], img: warped[cur], wgRef: wg[ref], wmRef: wmask[ref], key: refKey, W, H, hw, hh }));
    const fres = await each('flow', fjobs, k => progress(at('flow', k / fjobs.length), 'Correcting movement'));
    fjobs.forEach((j, k) => {
      const cur = j.cur, r = fres[k];
      if (r.accepted) {
        STORE.drop(warped[cur].h); STORE.drop(wg[cur].h); STORE.drop(wmask[cur].h);
        warped[cur] = parkData(r.rgb, H, W, cv.CV_8UC3, 3); wg[cur] = parkData(r.g8, H, W, cv.CV_8U, 1); wmask[cur] = parkData(r.m8, H, W, cv.CV_8U, 1);
        say(`photo ${cur + 1}: local correction on ${Math.max(1, Math.round(r.share * 100))}% of it (${r.nccG.toFixed(3)} → ${r.nccF.toFixed(3)})`);
      } else say(`photo ${cur + 1}: local correction not needed`);
      trust[cur] = parkData(r.trust, hh, hw, cv.CV_8U, 1);   // 8-bit, parked
    });
    trust[ref] = park(cv, new cv.Mat(hh, hw, cv.CV_8U, new cv.Scalar(255)));
    if (opts.onDebug) opts.onDebug('flowed', { ref, width: W, height: H, grays: wg.map(g => Float32Array.from(pdata(g), v => v / 255)), trust: trust.map(t => Float32Array.from(pdata(t), v => v / 255)), hw, hh });

    // ---------- 5. choose which photos to use ----------
    const keep = new Array(n).fill(true), why = new Array(n).fill('');
    // (a) photos that could not be lined up
    for (let i = 0; i < n; i++) if (i !== ref && inl[i] < 15 && !eccOk[i]) { keep[i] = false; why[i] = 'could not be lined up with the others'; }
    // (a2) photos that matched far worse than the rest and could not be fine-tuned:
    //      usually the subject (or something big in frame) moved, not the camera
    const inlOthers = inl.filter((v, i) => i !== ref && keep[i]);
    const inlBest = inlOthers.length ? Math.max(...inlOthers) : 0;
    for (let i = 0; i < n; i++) {
      if (i === ref || !keep[i] || eccOk[i]) continue;
      if (inl[i] < WEAK_MATCH * inlBest) {
        keep[i] = false;
        why[i] = moment.apart[i] ? `taken ${gapText(moment.apart[i])} the others, and the subject had moved`
          : `matched the others poorly (${inl[i]} matches against ${inlBest}): the subject or camera moved`;
      }
    }
    // each photo's measurements for the choices below (thumbnails, agreement with the reference,
    // what it may contribute), worked out side by side when there are helpers
    const qs = Math.min(0.25, 1000 / Math.max(W, H));     // quarter size, at most 1000 px across
    const sres = await each('select', [...Array(n).keys()].map(i => ({ wg: wg[i], wm: wmask[i], trust: trust[i], wgRef: wg[ref], key: refKey, W, H, hw, hh, qs, judge: i !== ref })),
      k => progress(at('select', 0.85 * k / n), 'Choosing photos'));
    for (let i = 0; i < n; i++) { STORE.drop(trust[i].h); trust[i] = null; }
    // (b) near-duplicates: keep the higher-resolution (then sharper) copy.
    //     Compared only where both photos have pixels of their own.
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (!keep[i] || !keep[j]) continue;
      const A = sres[i].maskT, B = sres[j].maskT, both = new Uint8Array(A.length);
      let on = 0; for (let k = 0; k < A.length; k++) if ((both[k] = A[k] & B[k])) on++;
      const overlap = on / A.length;
      const c = overlap > 0.3 ? nccScore(sres[i].bandT, sres[j].bandT, both, 3) : 0;
      // same picture AND same focus: with a steady camera, neighbouring focus slices
      // look alike at this size, but they are sharp in different places
      // ...AND same framing: two separate shots at the same focus but framed apart
      // are not duplicates; they cover different ground and their detail can be merged
      if (c > 0.985 && sameFraming(Hs[i], Hs[j], W, H) && sameFocus(sres[i].focusT, sres[j].focusT, both)) {
        const better = (srcPx[i] > srcPx[j] * 1.1) ? i : (srcPx[j] > srcPx[i] * 1.1) ? j : (sres[i].sharpT >= sres[j].sharpT ? i : j);
        const worse = better === i ? j : i;
        if (worse !== ref) { keep[worse] = false; why[worse] = `near-duplicate of photo ${better + 1}`; }   // never drop the reference
      }
    }
    // (c) photos that disagree with the reference almost everywhere they overlap (subject moved a lot).
    // usable[i]: what each photo may contribute, pixel by pixel (half size): it agrees with
    // the reference there (ghost), has pixels of its own there (coverage, fading to 0 over a
    // short band at its edge so a photo that ends mid-frame leaves no seam), and its
    // line-up can be trusted there (trust).
    const usable = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = sres[i];
      if (keep[i] && i !== ref) {
        const gap = moment.apart[i];
        if (opts.keepAll) { /* test hook: judge nothing here */ }
        else if (r.m < 0.25) { keep[i] = false; why[i] = 'the spider moved too much in it'; }
        else if (r.sm < SUBJECT_MOVED) { keep[i] = false; why[i] = gap ? `taken ${gapText(gap)} the others, and the subject had moved` : 'the subject moved between photos'; }
        else if (gap) say(`photo ${i + 1}: taken ${gapText(gap)} the others; used wherever it matches`);
      }
      usable[i] = parkData(r.usable, hh, hw, cv.CV_8U, 1);  // 8-bit (0..1 in 1/255 steps), parked
      r.usable = r.maskT = null;
    }
    refCacheFree();
    let idx = [...Array(n).keys()].filter(i => keep[i]);
    // (d) photos that add no sharp detail the others don't already have
    const share = winnerShare(idx.map(i => sres[i].wf));
    sres.length = 0;
    if (idx.length > 2) idx.forEach((i, k) => {
      if (i !== ref && share[k] < 0.003) { keep[i] = false; why[i] = 'adds nothing sharp the others lack'; }
    });
    idx = [...Array(n).keys()].filter(i => keep[i]);
    const left = [...Array(n).keys()].filter(i => !keep[i]);
    left.forEach(i => say(`photo ${i + 1} left out: ${why[i]}`));
    if (opts.onSelection) opts.onSelection({ used: idx.map(i => i + 1), left: left.map(i => ({ photo: i + 1, why: why[i] })) });
    say(`using ${idx.length} of ${n} photos`);

    progress(at('select', 1), 'Choosing photos');
    // crop: everything at least one used photo really saw (not just what all of them saw)
    const seen = unpark(cv, wmask[idx[0]]);
    for (const i of idx.slice(1)) { const m = unpark(cv, wmask[i]); cv.bitwise_or(seen, m, seen); m.delete(); }
    const box = largestRect(cv, seen); seen.delete();

    // ---------- 5b. hand the lined-up photos to the retouch brush ----------
    // Each is cropped and finished exactly like the stack, so painted pixels match.
    // Photos that could not be lined up are not offered.
    if (opts.onFrame) {
      const offer = [...Array(n).keys()].filter(i => keep[i] || !/lined up/.test(why[i]));
      const ejobs = offer.map(i => ({ img: warped[i], g8: wg[i], usable: usable[i], box, sharpen: SHARPEN, encode: !!opts.encodeFrames, info: { photo: i + 1, used: keep[i], why: why[i], ref: i === ref } }));
      // handed on in order, each as soon as it and those before it are ready
      const ready = new Array(ejobs.length); let next = 0, chain = Promise.resolve();
      await each('exportFrame', ejobs, (k, fr, j) => {
        progress(at('export', k / ejobs.length), 'Keeping photos for retouching');
        ready[j] = fr;
        while (next < ejobs.length && ready[next]) { const f = ready[next]; ready[next++] = null; chain = chain.then(() => opts.onFrame(f)); }
        return chain;                                     // (one at a time when there are no helpers)
      });
      await chain;
    }
    for (const i of left) { STORE.drop(warped[i].h); STORE.drop(wg[i].h); STORE.drop(wmask[i].h); STORE.drop(usable[i].h); warped[i] = wg[i] = wmask[i] = usable[i] = null; }
    const keptImgs = idx.map(i => warped[i]), keptGray = idx.map(i => wg[i]), weights = idx.map(i => usable[i]), keptMask = idx.map(i => wmask[i]);
    progress(at('merge', 0), 'Merging');
    await tick();

    // ---------- 6. hybrid fusion ----------
    for (const i of idx) { STORE.drop(wg[i].h); wg[i] = null; }
    const debug = opts.onDebug ? (name, d) => opts.onDebug(name, Object.assign({ photos: idx.map(i => i + 1), box }, d)) : null;
    let out;
    if (opts.stripRows && H > opts.stripRows) {
      // merged and finished a band at a time; then cropped to the box, as RGBA
      const rgb = await fuseStrips(cv, keptImgs, weights, keptMask, p => progress(at('merge', p), 'Merging'), tick, opts.stripRows, each, SHARPEN);
      unparkAll(weights);
      const data = new Uint8ClampedArray(box.w * box.h * 4);
      for (let y = 0; y < box.h; y++) {
        let q = ((box.y + y) * W + box.x) * 3, d = y * box.w * 4;
        for (let x = 0; x < box.w; x++, q += 3, d += 4) { data[d] = rgb[q]; data[d + 1] = rgb[q + 1]; data[d + 2] = rgb[q + 2]; data[d + 3] = 255; }
      }
      out = { data, width: box.w, height: box.h, log, ref: ref + 1 };
    } else {
    const wMats = weights.map(p => unpark(cv, p)); unparkAll(weights);
    const fused = await fuseHybrid(cv, keptImgs, wMats, keptMask, p => progress(at('merge', p * 0.95), 'Merging'), tick, debug);
    wMats.forEach(m => m.delete());

    // ---------- 7. finish ----------
    const sharp = sharpenF(cv, fused, SHARPEN); fused.delete();
    const crop = sharp.roi(new cv.Rect(box.x, box.y, box.w, box.h));
    const u8 = new cv.Mat(); crop.convertTo(u8, cv.CV_8U, 255, 0.5); crop.delete(); sharp.delete();
    const rgba = new cv.Mat(); cv.cvtColor(u8, rgba, cv.COLOR_RGB2RGBA); u8.delete();
    out = { data: new Uint8ClampedArray(rgba.data), width: rgba.cols, height: rgba.rows, log, ref: ref + 1 };
    rgba.delete();
    }
    unparkAll(warped); unparkAll(wmask); unparkAll(wg);
    trash.forEach(m => free(m));
    progress(1, 'Done');
    say(`result ${out.width}×${out.height}`);
    return out;
  }

  // ---------- photo-selection thresholds ----------
  const MOMENT_GAP = 2000;          // ms between consecutive photos that starts a new "moment"
  const WEAK_MATCH = 0.25;          // fewer than this share of the best photo's matches, and no fine-tune
  const SUBJECT_MOVED = 0.65;       // subject agreement below this: moved (real bursts 0.96+, a photo shot from a step to the side 0.76, weevil 0.38)
  const REPEAT = 0.4;               // repeat score above this: a mesh-like pattern is in view (mesh 0.7-1.4, others <= 0.17)

  /** Groups photos into moments by capture time. apart[i] is the signed gap (ms)
      from photo i to the main moment (the largest group), or 0 if it is in it
      or has no time. Photos without a time are never treated as apart. */
  function moments(frames) {
    const n = frames.length, apart = new Array(n).fill(0);
    const timed = [...Array(n).keys()].filter(i => Number.isFinite(frames[i].taken)).sort((a, b) => frames[a].taken - frames[b].taken);
    if (timed.length < 2) return { apart, groups: 1, split: false };
    const groups = [[timed[0]]];
    for (let k = 1; k < timed.length; k++) {
      if (frames[timed[k]].taken - frames[timed[k - 1]].taken > MOMENT_GAP) groups.push([]);
      groups[groups.length - 1].push(timed[k]);
    }
    if (groups.length === 1) return { apart, groups: 1, split: false };
    // main = largest group; ties go to the earlier one
    const main = groups.reduce((a, g) => (g.length > a.length ? g : a), groups[0]);
    const t0 = frames[main[0]].taken, t1 = frames[main[main.length - 1]].taken;
    for (const g of groups) if (g !== main) for (const i of g) {
      const t = frames[i].taken; apart[i] = t > t1 ? t - t1 : t - t0;
    }
    return { apart, groups: groups.length, split: true };
  }

  function gapText(ms) {
    const s = Math.max(1, Math.round(Math.abs(ms) / 1000));
    const d = s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
    return `${d} ${ms > 0 ? 'after' : 'before'}`;
  }

  // ---------- helpers ----------
  /** The engine's own final sharpening (unsharp mask, radius 1.2) of a float image, as a new Mat.
      amount 0: a plain copy (the app sharpens the finished stack itself, so it can be adjusted). */
  function sharpenF(cv, f, amount) {
    const out = new cv.Mat();
    if (!(amount > 0)) { f.copyTo(out); return out; }
    const b = new cv.Mat(); cv.GaussianBlur(f, b, new cv.Size(0, 0), 1.2, 1.2);
    cv.addWeighted(f, 1 + amount, b, -amount, 0, out); b.delete();
    return out;
  }
  /** One lined-up photo, cropped and sharpened like the stack, plus a small map of where it
      is sharp (and agrees with the reference) for "sharpest here". img: the parked photo,
      g8: its parked 8-bit grey. Worked a band of rows at a time; each band carries enough
      rows around it that the result is the same as doing the whole frame at once. */
  function exportFrame(cv, img, g8, ghostHalf, box, info, amount = 0.35) {
    const W = img.cols, H = img.rows, m = 8, CTX = 24;
    const x0 = Math.max(0, box.x - m), x1 = Math.min(W, box.x + box.w + m);
    const data = new Uint8ClampedArray(box.w * box.h * 4);
    const f = new cv.Mat(box.h, box.w, cv.CV_32F);              // sharpness at full size
    for (let by = 0; by < box.h; by += BAND) {
      const b1 = Math.min(box.h, by + BAND);
      // sharpened colour: blur radius 4, so 8 rows either side are plenty
      const y0 = Math.max(0, box.y + by - m), y1 = Math.min(H, box.y + b1 + m);
      const rows = unpark(cv, img, y0, y1), big = rows.roi(new cv.Rect(x0, 0, x1 - x0, y1 - y0));
      const sh = new cv.Mat();
      if (amount > 0) { const bl = new cv.Mat(); cv.GaussianBlur(big, bl, new cv.Size(0, 0), 1.2, 1.2); cv.addWeighted(big, 1 + amount, bl, -amount, 0, sh); bl.delete(); }
      else big.copyTo(sh);
      big.delete(); rows.delete();
      const c = sh.roi(new cv.Rect(box.x - x0, box.y + by - y0, box.w, b1 - by));
      const rgba = new cv.Mat(); cv.cvtColor(c, rgba, cv.COLOR_RGB2RGBA); c.delete(); sh.delete();
      data.set(rgba.data, by * box.w * 4); rgba.delete();
      // sharpness: as focusMeasure on the box (its first blur sees past the box's edges, the
      // later steps stop at them), with CTX rows of the box either side of the band
      const e0 = Math.max(0, by - CTX), e1 = Math.min(box.h, b1 + CTX);
      const gy0 = Math.max(0, box.y + e0 - 4), gy1 = Math.min(H, box.y + e1 + 4), gx0 = Math.max(0, box.x - 4), gx1 = Math.min(W, box.x + box.w + 4);
      const gr = unpark(cv, g8, gy0, gy1), gc = gr.roi(new cv.Rect(gx0, 0, gx1 - gx0, gy1 - gy0)), gf = f32(cv, gc); gc.delete(); gr.delete();
      const view = gf.roi(new cv.Rect(box.x - gx0, box.y + e0 - gy0, box.w, e1 - e0));
      const fm = focusMeasure(cv, view, 4); view.delete(); gf.delete();
      f.data32F.set(fm.data32F.subarray((by - e0) * box.w, (b1 - e0) * box.w), by * box.w); fm.delete();
    }
    const fw = Math.ceil(box.w / 8), fh = Math.ceil(box.h / 8);
    const fs = new cv.Mat(); cv.resize(f, fs, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA); f.delete();
    const gh = ghostHalf.roi(new cv.Rect(Math.floor(box.x / 2), Math.floor(box.y / 2),
      Math.min(ghostHalf.cols - Math.floor(box.x / 2), Math.ceil(box.w / 2)), Math.min(ghostHalf.rows - Math.floor(box.y / 2), Math.ceil(box.h / 2))));
    const gs = new cv.Mat(); cv.resize(gh, gs, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA); gh.delete();
    cv.multiply(fs, gs, fs); gs.delete();
    const res = Object.assign({}, info, {
      width: box.w, height: box.h, data,
      focus: { width: fw, height: fh, data: new Float32Array(fs.data32F) }
    });
    fs.delete();
    return res;
  }


  /** How well a photo agrees with the reference where either of them is sharp
      (the subject), 0..1. The frame-wide mean is dominated by background, so a
      small subject that walked off barely moves it; this weights by sharpness. */
  function subjectAgreement(cv, refG, curG, ghostHalf, coverHalf) {
    const sz = new cv.Size(ghostHalf.cols, ghostHalf.rows);
    const half = g => {
      if (g.cols === sz.width && g.rows === sz.height) return focusMeasure(cv, g, 3);     // already half size
      const s = new cv.Mat(); cv.resize(g, s, sz, 0, 0, cv.INTER_AREA); const f = focusMeasure(cv, s, 3); s.delete(); return f;
    };
    const fr = half(refG), fc = half(curG), R = fr.data32F, C = fc.data32F, G = ghostHalf.data32F;
    const V = coverHalf ? coverHalf.data32F : null;           // only where the photo has pixels of its own
    const N = R.length, mx = new Float32Array(N);
    for (let k = 0; k < N; k++) mx[k] = V && V[k] < 0.5 ? 0 : Math.max(R[k], C[k]);
    fr.delete(); fc.delete();
    const sorted = Float32Array.from(mx.filter((v, k) => k % 5 === 0 && v > 0)).sort();
    const top = sorted[Math.floor(sorted.length * 0.99)] || 1e-9;
    let sw = 0, sg = 0;
    for (let k = 0; k < N; k++) {
      const w = Math.min(1, mx[k] / top);
      if (w < 0.1) continue;
      sw += w; sg += w * G[k];
    }
    return sw > 0 ? sg / sw : 1;
  }

  function eye3() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
  function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return r;
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }

  function toGray(cv, rgb8) {
    const g = new cv.Mat(); cv.cvtColor(rgb8, g, cv.COLOR_RGB2GRAY);
    const f = new cv.Mat(); g.convertTo(f, cv.CV_32F, 1 / 255); g.delete();
    return f;
  }
  // 8-bit grey, and its float copy (f32(gray8(x)) is bit-identical to toGray(x))
  function gray8(cv, rgb8) { const g = new cv.Mat(); cv.cvtColor(rgb8, g, cv.COLOR_RGB2GRAY); return g; }
  function f32(cv, g8) { const f = new cv.Mat(); g8.convertTo(f, cv.CV_32F, 1 / 255); return f; }
  // a big image parked outside the WASM heap (which this OpenCV.js build caps at 1 GiB),
  // copied back in only while it is being worked on. In the browser this could be an OPFS file.
  // parked images go through a store: {put(u8, temp) -> h, get(h, off, len) -> u8, read(h, off, dst),
  // set(h, off, u8), drop(h)}. put's temp: u8 is a view into the WASM heap, so copy it if kept as it is;
  // read: straight into dst (a Mat's pixels), no in-between buffer left for the garbage collector.
  // Memory by default; the probe can pass a disk store (in the browser: an OPFS file).
  const MEM_STORE = { put: (u, temp) => temp ? u.slice() : u, alloc: len => new Uint8Array(len), get: (h, off = 0, len = h.length - off) => h.subarray(off, off + len), read: (h, off, dst) => dst.set(h.subarray(off, off + dst.length)), set: (h, off, u) => h.set(u, off), drop: () => {} };
  let STORE = MEM_STORE;
  function park(cv, m) {
    const p = { rows: m.rows, cols: m.cols, mtype: m.type(), bpp: m.data.length / (m.rows * m.cols), h: STORE.put(m.data, true) };
    m.delete(); return p;
  }
  /** rows r0..r1 (default all) of a parked image, as a new Mat */
  function unpark(cv, p, r0 = 0, r1 = p.rows) {
    const m = new cv.Mat(r1 - r0, p.cols, p.mtype), row = p.cols * p.bpp, b = p.base || 0;
    if (STORE.read) STORE.read(p.h, (b + r0) * row, m.data); else m.data.set(STORE.get(p.h, (b + r0) * row, (r1 - r0) * row));
    return m;
  }
  /** the parked buffer (or a view's rows); the memory store hands out a view, no copy */
  function pdata(p) { const row = p.cols * p.bpp; return STORE.get(p.h, (p.base || 0) * row, p.rows * row); }
  /** rows y0..y1 of a parked image, as a parked image of its own (no copy) */
  function pview(p, y0, y1) { return Object.assign({}, p, { base: (p.base || 0) + y0, rows: y1 - y0 }); }
  function unparkAll(list) { for (const p of list) if (p) STORE.drop(p.h); }
  /** pixels already in a JS array, parked as they are */
  function parkData(u8, rows, cols, mtype, bpp) { return { rows, cols, mtype, bpp, h: STORE.put(u8) }; }
  /** the float grey of a parked 8-bit grey */
  function Fp(cv, p) { const m = unpark(cv, p), f = f32(cv, m); m.delete(); return f; }
  /** A parked image to be filled in a band of rows at a time (parkRows). */
  function parkEmpty(rows, cols, mtype, bpp) {
    const len = rows * cols * bpp;
    return { rows, cols, mtype, bpp, h: STORE.alloc ? STORE.alloc(len) : STORE.put(new Uint8Array(len)) };
  }
  /** Rows from r0 of a parked image replaced by a Mat's pixels (same width and type). */
  function parkRows(p, r0, m) { STORE.set(p.h, ((p.base || 0) + r0) * p.cols * p.bpp, m.data); }
  const BAND = 512;                                       // rows per band for full-size steps done in bands
  /** A float copy of an 8-bit grey (the <= 1600 px greys are kept 8-bit); g itself if float. */
  function asF(cv, g) { return g.type() === cv.CV_8U ? f32(cv, g) : g; }

  function focusMeasure(cv, g, sigma) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 0.8, 0.8);
    const l = new cv.Mat(); cv.Laplacian(b, l, cv.CV_32F, 3); b.delete();
    cv.multiply(l, l, l);
    const o = new cv.Mat(); cv.GaussianBlur(l, o, new cv.Size(0, 0), sigma, sigma); l.delete();
    return o;
  }

  /** Where each photo has usable pixels (1) vs the black clamp edge of a clip-on
      lens (0). The clamp is fixed to the phone, so it sits in the same place in every
      photo, and its inner edge is the rim of the lens: a circle (or an ellipse) round
      the frame. Candidates are near-black regions touching the frame edge; the clamp is
      accepted only if the ones present in (almost) every photo are matched by the
      outside of one circle or ellipse, with lit scene just inside its rim. A black
      night background, or a dark subject crossing the frame edge, follows the
      subject's outline instead, and is kept. */
  function vignetteMasks(cv, grays, W, H) {
    // the mask is the same for every photo, so one Mat is shared (was n full-size copies)
    const n = grays.length;
    const all = () => new Array(n).fill(new cv.Mat(H, W, cv.CV_8U, new cv.Scalar(1)));
    const model = clampModel(cv, grays, W, H);
    if (!model) return all();
    // the clamp's edge is soft (an out-of-focus lens barrel): keep 2.5% of the frame clear of it
    const { cx, cy, asp, R } = model, margin = 0.025 * Math.max(W, H);
    const m = new cv.Mat(H, W, cv.CV_8U), M = m.data, R2 = (R - margin) * (R - margin);
    for (let y = 0, k = 0; y < H; y++) {
      const dy = (y - cy) * asp;
      for (let x = 0; x < W; x++, k++) { const dx = x - cx; M[k] = dx * dx + dy * dy < R2 ? 1 : 0; }
    }
    return new Array(n).fill(m);
  }

  /** Fits the clamp's rim, at about 200 px wide. Returns {cx, cy, asp, R} in full-size
      pixels (outside the rim is clamp; asp stretches y: 1 = circle, W/H = an ellipse
      shaped like the frame), or null when there is no clamp. */
  function clampModel(cv, grays, W, H) {
    const n = grays.length;
    const f = Math.min(1, 200 / Math.max(W, H)), qw = Math.max(8, Math.round(W * f)), qh = Math.max(8, Math.round(H * f)), N = qw * qh;
    const cnt = new Uint8Array(N);
    for (const g0 of grays) {
      const g = asF(cv, g0), s = new cv.Mat(); cv.resize(g, s, new cv.Size(qw, qh), 0, 0, cv.INTER_AREA); if (g !== g0) g.delete();
      const b = new cv.Mat(); cv.GaussianBlur(s, b, new cv.Size(0, 0), 15 * f, 15 * f);
      const dark = new cv.Mat(); cv.threshold(b, dark, 0.12, 1, cv.THRESH_BINARY_INV); b.delete();
      const d8 = new cv.Mat(); dark.convertTo(d8, cv.CV_8U); dark.delete();
      const lab = new cv.Mat(); const nl = cv.connectedComponents(d8, lab); d8.delete();
      const L = lab.data32S, V = s.data32F;
      const edge = new Uint8Array(nl);
      for (let x = 0; x < qw; x++) { edge[L[x]] = 1; edge[L[(qh - 1) * qw + x]] = 1; }
      for (let y = 0; y < qh; y++) { edge[L[y * qw]] = 1; edge[L[y * qw + qw - 1]] = 1; }
      edge[0] = 0;
      // near-black regions only (median brightness under 0.06)
      const vals = new Map();
      for (let k = 0; k < N; k++) { const c = L[k]; if (!edge[c]) continue; let v = vals.get(c); if (!v) vals.set(c, v = []); v.push(V[k]); }
      const black = new Uint8Array(nl);
      for (const [c, v] of vals) { v.sort((p, q) => p - q); black[c] = v[v.length >> 1] < 0.06 ? 1 : 0; }
      for (let k = 0; k < N; k++) if (black[L[k]]) cnt[k]++;
      lab.delete(); s.delete();
    }
    const need = Math.max(1, Math.ceil(0.75 * n)), D = new Uint8Array(N);
    let A = 0;
    for (let k = 0; k < N; k++) if (cnt[k] >= need) { D[k] = 1; A++; }
    if (A < 0.003 * N) return null;
    // best rim: the outside of a circle or frame-shaped ellipse that matches D (IoU)
    const maxD = Math.ceil(Math.hypot(qw, qh * W / H)) + 2;
    const tot = new Float64Array(maxD), drk = new Float64Array(maxD);
    const score = (cx, cy, asp) => {
      tot.fill(0); drk.fill(0);
      for (let y = 0, k = 0; y < qh; y++) {
        const dy = (y + 0.5 - cy) * asp;
        for (let x = 0; x < qw; x++, k++) {
          const b = Math.min(maxD - 1, Math.floor(Math.hypot(x + 0.5 - cx, dy)));
          tot[b]++; if (D[k]) drk[b]++;
        }
      }
      let ot = 0, od = 0, best = { iou: 0, R: maxD };
      for (let r = maxD - 1; r > 0; r--) {
        ot += tot[r]; od += drk[r];
        const iou = od / (ot + A - od);
        if (iou > best.iou) best = { iou, R: r };
      }
      return best;
    };
    let best = { iou: 0 };
    for (const asp of [1, W / H]) {
      for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
        const cx = qw / 2 + i * 0.05 * qw, cy = qh / 2 + j * 0.05 * qh, r = score(cx, cy, asp);
        if (r.iou > best.iou) best = { iou: r.iou, R: r.R, cx, cy, asp };
      }
    }
    if (!best.cx) return null;
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {          // refine the centre
      const cx = best.cx + i * 0.0125 * qw, cy = best.cy + j * 0.0125 * qh, r = score(cx, cy, best.asp);
      if (r.iou > best.iou) best = { iou: r.iou, R: r.R, cx, cy, asp: best.asp };
    }
    // the rim must be clean: lit scene just inside it, clamp just outside it
    const band = 0.04 * Math.max(qw, qh);
    let inN = 0, inD = 0, outN = 0, outD = 0, outside = 0;
    for (let y = 0, k = 0; y < qh; y++) {
      const dy = (y + 0.5 - best.cy) * best.asp;
      for (let x = 0; x < qw; x++, k++) {
        const d = Math.hypot(x + 0.5 - best.cx, dy);
        if (d >= best.R) outside++;
        if (d < best.R - 1 && d >= best.R - 1 - band) { inN++; inD += D[k]; }
        else if (d >= best.R && d < best.R + band) { outN++; outD += D[k]; }
      }
    }
    // and it must be out at the frame's edge: a rim tighter than 60% of the half-diagonal
    // would be a round subject on a black background, not a lens
    const halfDiag = Math.hypot(qw / 2, qh / 2 * best.asp);
    const ok = best.iou >= 0.8 && outN > 0 && outD / outN >= 0.85 && (inN === 0 || inD / inN <= 0.3) &&
      outside <= 0.4 * N && best.R >= 0.6 * halfDiag;
    if (!ok) return null;
    return { cx: best.cx / f, cy: best.cy / f, asp: best.asp, R: best.R / f, iou: best.iou };
  }

  /** Fills the part of each lined-up photo that lies outside its own pixels with
      the average of the photos that do have pixels there (the reference where
      nobody does), so pyramids see no false edges at a photo's border.
      Returns, per photo, the share of the reference's view it covers. */
  function fillUncovered(cv, warped, wmask, ref) {
    // same as before, a band of rows at a time through the store (works for a disk store too)
    const n = warped.length, W = warped[0].cols, H = warped[0].rows, BAND = 128;
    let refArea = 0; const both = new Array(n).fill(0);
    for (let r0 = 0; r0 < H; r0 += BAND) {
      const r1 = Math.min(H, r0 + BAND), N = (r1 - r0) * W;
      const D = warped.map(p => STORE.get(p.h, r0 * W * 3, N * 3)), Mk = wmask.map(p => STORE.get(p.h, r0 * W, N));
      const sum = new Float32Array(N * 3), cnt = new Uint8Array(N);
      for (let i = 0; i < n; i++) {
        const Di = D[i], M = Mk[i];
        for (let k = 0, q = 0; k < N; k++, q += 3) if (M[k]) { sum[q] += Di[q]; sum[q + 1] += Di[q + 1]; sum[q + 2] += Di[q + 2]; cnt[k]++; }
      }
      const R = D[ref], MR = Mk[ref];
      for (let k = 0; k < N; k++) if (MR[k]) refArea++;
      for (let i = 0; i < n; i++) {
        const Di = D[i], M = Mk[i]; let changed = false;
        for (let k = 0, q = 0; k < N; k++, q += 3) {
          if (M[k]) { if (MR[k]) both[i]++; continue; }
          if (cnt[k]) { const c = cnt[k]; Di[q] = sum[q] / c + 0.5; Di[q + 1] = sum[q + 1] / c + 0.5; Di[q + 2] = sum[q + 2] / c + 0.5; changed = true; }
          else if (i !== ref) { Di[q] = R[q]; Di[q + 1] = R[q + 1]; Di[q + 2] = R[q + 2]; changed = true; }
        }
        if (changed) STORE.set(warped[i].h, r0 * W * 3, Di);
      }
    }
    return both.map(b => refArea ? b / refArea : 1);
  }

  /** A photo's coverage at half size: 1 well inside its own pixels, easing to 0
      over a band of ~1.5% of the frame at its border. */
  function coverMap(cv, mask8, hw, hh) {
    const m = new cv.Mat(); cv.resize(mask8, m, new cv.Size(hw, hh), 0, 0, cv.INTER_NEAREST);
    // distance to the nearest pixel outside the photo (the frame edge counts as inside)
    const p = new cv.Mat(); cv.copyMakeBorder(m, p, 1, 1, 1, 1, cv.BORDER_REPLICATE); m.delete();
    const d = new cv.Mat(); cv.distanceTransform(p, d, cv.DIST_L2, 3); p.delete();
    const c = d.roi(new cv.Rect(1, 1, hw, hh)), out = c.clone(); c.delete(); d.delete();
    const band = Math.max(4, 0.015 * Math.max(hw, hh)), O = out.data32F;
    for (let k = 0; k < O.length; k++) { const t = Math.min(1, O[k] / band); O[k] = t * t * (3 - 2 * t); }
    return out;
  }

  /** Two photos are framed the same if their line-ups put every corner within
      0.5% of the frame of each other (an edited or resized copy of one shot). */
  function sameFraming(Ha, Hb, W, H) {
    const lim = 0.005 * Math.max(W, H);
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]]) {
      const pa = applyH(Ha, x, y), pb = applyH(Hb, x, y);
      if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > lim) return false;
    }
    return true;
  }
  function applyH(h, x, y) { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; }
  function maskedMean(A, C) {
    let s = 0, w = 0;
    for (let k = 0; k < A.length; k++) { s += A[k] * C[k]; w += C[k]; }
    return w > 1e-6 ? s / w : 0;
  }

  function orderFrames(cv, grays) {
    const n = grays.length;
    if (n < 3) return [...Array(n).keys()];
    const V = grays.map(g0 => {
      const g = asF(cv, g0), s = new cv.Mat(); cv.resize(g, s, new cv.Size(512, 384), 0, 0, cv.INTER_AREA); if (g !== g0) g.delete();
      const f = focusMeasure(cv, s, 6); s.delete();
      const d = Float64Array.from(f.data32F, x => Math.log(x + 1e-7)); f.delete();
      let mu = 0; for (const x of d) mu += x; mu /= d.length;
      let sd = 0; for (const x of d) sd += (x - mu) ** 2; sd = Math.sqrt(sd / d.length) || 1;
      for (let i = 0; i < d.length; i++) d[i] = (d[i] - mu) / sd;
      return d;
    });
    const C = [...Array(n)].map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      let s = 0; const a = V[i], b = V[j];
      for (let k = 0; k < a.length; k++) s += a[k] * b[k];
      C[i][j] = C[j][i] = Math.max(0, Math.min(1, s / a.length));
    }
    const Lp = C.map((row, i) => row.map((v, j) => (i === j ? row.reduce((p, q) => p + q, 0) - v : -v)));
    const { vals, vecs } = jacobi(Lp);
    const idx = [...vals.keys()].sort((a, b) => vals[a] - vals[b]);
    const fied = idx[1];
    return [...Array(n).keys()].sort((a, b) => vecs[a][fied] - vecs[b][fied]);
  }

  function jacobi(A0) {
    const n = A0.length, A = A0.map(r => Float64Array.from(r));
    const V = [...Array(n)].map((_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] ** 2;
      if (off < 1e-18) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    return { vals: A.map((r, i) => r[i]), vecs: V };
  }

  function to8(cv, g) { const u = new cv.Mat(); g.convertTo(u, cv.CV_8U, 255); return u; }

  /** AKAZE features of one photo on a downscaled copy, found once and reused for
      every pair the photo is matched in. */
  function features(cv, cache, i, g, m, pre) {
    if (cache && cache.has(i)) return cache.get(i);
    // g arrives already at the feature scale `pre` (same resize as before, done at load)
    const s = pre;
    const u = g.type() === cv.CV_8U ? g.clone() : to8(cv, g);
    const mm = new cv.Mat(); cv.resize(m, mm, new cv.Size(u.cols, u.rows), 0, 0, cv.INTER_NEAREST);
    const ak = new cv.AKAZE(); ak.setThreshold(0.0005);
    const kv = new cv.KeyPointVector(), d = new cv.Mat();
    ak.detectAndCompute(u, mm, kv, d);
    const pts = new Float32Array(kv.size() * 2);
    for (let k = 0; k < kv.size(); k++) { const p = kv.get(k).pt; pts[2 * k] = p.x; pts[2 * k + 1] = p.y; }
    kv.delete(); ak.delete(); u.delete(); mm.delete();
    const f = { s, pts, d, n: pts.length / 2 };
    if (cache) cache.set(i, f);
    return f;
  }

  function homography(cv, srcG, dstG, mSrc, mDst, cache, iSrc, iDst, pre) {
    // features on a downscaled copy (speed), H rescaled to full size
    const F1 = features(cv, cache, iSrc, srcG, mSrc, pre), F2 = features(cv, cache, iDst, dstG, mDst, pre);
    const s = F1.s, d1 = F1.d, d2 = F2.d;
    let res = { H: eye3(), inliers: 0 };
    if (F1.n >= 20 && F2.n >= 20) {
      const bf = new cv.BFMatcher(cv.NORM_HAMMING, false); const mv = new cv.DMatchVectorVector();
      bf.knnMatch(d1, d2, mv, 2);
      const p1 = [], p2 = [], w1 = [], w2 = [];       // w: looser ratio test, for the rough fallback
      for (let i = 0; i < mv.size(); i++) {
        const m = mv.get(i);
        if (m.size() < 2) { m.delete(); continue; }
        const x = m.get(0), y = m.get(1);
        if (x.distance < 0.92 * y.distance) {
          w1.push(F1.pts[2 * x.queryIdx], F1.pts[2 * x.queryIdx + 1]); w2.push(F2.pts[2 * x.trainIdx], F2.pts[2 * x.trainIdx + 1]);
        }
        if (x.distance < 0.8 * y.distance) {
          p1.push(F1.pts[2 * x.queryIdx], F1.pts[2 * x.queryIdx + 1]); p2.push(F2.pts[2 * x.trainIdx], F2.pts[2 * x.trainIdx + 1]);
        }
        m.delete();
      }
      mv.delete(); bf.delete();
      if (p1.length / 2 >= 20) {
        const fit = (q1, q2, thr) => {
          const P1 = cv.matFromArray(q1.length / 2, 1, cv.CV_32FC2, q1), P2 = cv.matFromArray(q2.length / 2, 1, cv.CV_32FC2, q2);
          const inl = new cv.Mat();
          const Hm = cv.findHomography(P1, P2, cv.RANSAC, thr, inl, 5000, 0.999);
          let out = null;
          if (Hm && !Hm.empty()) {
            const src = [], dst = [], I = inl.data;
            for (let i = 0; i < I.length; i++) if (I[i]) { src.push(q1[2 * i], q1[2 * i + 1]); dst.push(q2[2 * i], q2[2 * i + 1]); }
            out = { h: Array.from(Hm.data64F), inliers: src.length / 2, src, dst };
          }
          if (Hm) Hm.delete(); inl.delete(); P1.delete(); P2.delete();
          return out;
        };
        let best = fit(p1, p2, 3.0 * s + 0.5);
        // A photo framed far from the rest (turned, zoomed, shot from a step to the side)
        // with a 3D subject in it: few matches fit one exact plane, so the strict fit finds
        // too few. Look for the rough turn-shift-zoom first, which tolerates parallax, then
        // fit the plane to the matches that agree with it.
        let rough = false;
        if (!best || best.inliers < 40) {
          // the looser ratio test keeps more true matches on fine, similar-looking detail
          // (fungal strands, setae); the turn-shift-zoom consensus sorts them out
          const sim = similarityInliers(w1, w2, 8 * s + 1);
          if (sim.keep.length >= 12 && (!best || sim.keep.length > best.inliers)) {
            const q1 = [], q2 = [];
            for (const i of sim.keep) { q1.push(w1[2 * i], w1[2 * i + 1]); q2.push(w2[2 * i], w2[2 * i + 1]); }
            const loose = q1.length >= 16 ? fit(q1, q2, 8 * s + 1) : null;
            const [A, B, tx, ty] = sim.model;
            best = loose && loose.inliers >= 0.7 * sim.keep.length ? loose
              : { h: [A, -B, tx, B, A, ty, 0, 0, 1], inliers: sim.keep.length, src: q1, dst: q2 };
            rough = true;                                  // a starting point: fine-tuning decides
          }
        }
        if (best) {
          // rescale: H_full = S^-1 H S
          const S = [s, 0, 0, 0, s, 0, 0, 0, 1], Si = [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1];
          res = { H: mul3(mul3(Si, best.h), S), inliers: best.inliers, src: best.src.map(v => v / s), dst: best.dst.map(v => v / s), rough };
        }
      }
    }
    if (!cache) { d1.delete(); d2.delete(); }
    return res;
  }

  /** RANSAC for a turn + shift + zoom (two matches fix one), then the indices of the
      matches within thr of the best one. Tolerates the parallax a full homography
      fit with a tight threshold rejects. */
  function similarityInliers(p1, p2, thr) {
    const n = p1.length / 2; if (n < 2) return [];
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const t2 = thr * thr; let bestN = 0, bestM = null;
    const count = (a, b, tx, ty) => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        const x = p1[2 * i], y = p1[2 * i + 1];
        const dx = a * x - b * y + tx - p2[2 * i], dy = b * x + a * y + ty - p2[2 * i + 1];
        if (dx * dx + dy * dy < t2) c++;
      }
      return c;
    };
    for (let it = 0; it < 3000; it++) {
      const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n); if (i === j) continue;
      const ux = p1[2 * j] - p1[2 * i], uy = p1[2 * j + 1] - p1[2 * i + 1];
      const vx = p2[2 * j] - p2[2 * i], vy = p2[2 * j + 1] - p2[2 * i + 1];
      const d = ux * ux + uy * uy; if (d < 100) continue;
      const a = (ux * vx + uy * vy) / d, b = (ux * vy - uy * vx) / d;
      const sc = Math.hypot(a, b); if (sc < 0.6 || sc > 1.7) continue;           // a lean-in, not a teleport
      const tx = p2[2 * i] - (a * p1[2 * i] - b * p1[2 * i + 1]), ty = p2[2 * i + 1] - (b * p1[2 * i] + a * p1[2 * i + 1]);
      const c = count(a, b, tx, ty);
      if (c > bestN) { bestN = c; bestM = [a, b, tx, ty]; }
    }
    if (!bestM) return { keep: [], model: null };
    // refit on the inliers (least squares), then collect them again
    let [a, b, tx, ty] = bestM;
    for (let pass = 0; pass < 2; pass++) {
      const idx = [];
      for (let i = 0; i < n; i++) {
        const x = p1[2 * i], y = p1[2 * i + 1];
        const dx = a * x - b * y + tx - p2[2 * i], dy = b * x + a * y + ty - p2[2 * i + 1];
        if (dx * dx + dy * dy < t2) idx.push(i);
      }
      if (idx.length < 3) break;
      let mx = 0, my = 0, nx = 0, ny = 0;
      for (const i of idx) { mx += p1[2 * i]; my += p1[2 * i + 1]; nx += p2[2 * i]; ny += p2[2 * i + 1]; }
      mx /= idx.length; my /= idx.length; nx /= idx.length; ny /= idx.length;
      let sxx = 0, sab = 0, sba = 0;
      for (const i of idx) {
        const ux = p1[2 * i] - mx, uy = p1[2 * i + 1] - my, vx = p2[2 * i] - nx, vy = p2[2 * i + 1] - ny;
        sxx += ux * ux + uy * uy; sab += ux * vx + uy * vy; sba += ux * vy - uy * vx;
      }
      if (sxx <= 0) break;
      a = sab / sxx; b = sba / sxx; tx = nx - (a * mx - b * my); ty = ny - (b * mx + a * my);
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = p1[2 * i], y = p1[2 * i + 1];
      const dx = a * x - b * y + tx - p2[2 * i], dy = b * x + a * y + ty - p2[2 * i + 1];
      if (dx * dx + dy * dy < t2) out.push(i);
    }
    return { keep: out, model: [a, b, tx, ty] };
  }

  function gradMag(cv, g, sigma = 2) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), sigma, sigma);
    const gx = new cv.Mat(), gy = new cv.Mat();
    cv.Sobel(b, gx, cv.CV_32F, 1, 0); cv.Sobel(b, gy, cv.CV_32F, 0, 1); b.delete();
    const m = new cv.Mat(); cv.magnitude(gx, gy, m); gx.delete(); gy.delete();
    cv.GaussianBlur(m, m, new cv.Size(0, 0), sigma, sigma);
    return m;
  }

  /** Median distance between where a line-up puts matched features and where they were matched. */
  function pairError(H, pairs) {
    const e = [], S = pairs.src, D = pairs.dst;
    for (let i = 0; i + 1 < S.length; i += 2) { const p = applyH(H, S[i], S[i + 1]); e.push(Math.hypot(p[0] - D[i], p[1] - D[i + 1])); }
    if (!e.length) return 0;
    e.sort((x, y) => x - y); return e[e.length >> 1];
  }

  /** ECC fine-tuning of a line-up. The result must still agree with the matched
      features. With repeating texture in view (an insect screen) ECC locks onto
      whichever cells are nearest and shears the background while the subject's
      features stay put, and two photos fine-tuned that way end up a fraction of a
      cell apart; there the features' line-up is kept and the flow does the rest. */
  function eccRefine(cv, srcG, dstG, H, mask, pairs, repeating, rough, big, pre) {
    if (repeating) return { H, ok: false, skipped: true };
    // srcG/dstG are the <= 1600 px greys (scale `pre`); big is the full working size
    if (rough) {
      // a rough start (photo framed far from the rest): first line up the overall shapes,
      // blurred enough that focus differences don't matter, then the usual fine-tune
      const c = eccStage(cv, srcG, dstG, H, mask, Math.min(0.25, 500 / big), 0.006 * big, 100, pre);
      if (c && (!pairs || pairError(c, pairs) < Math.max(12, 0.012 * big))) H = c;
      else return { H, ok: false };
    }
    // half size first (a quarter of the work per step, most of the steps), then a few
    // steps at the working size; each stops once the change is under 1e-5
    const half = eccStage(cv, srcG, dstG, H, mask, Math.min(0.25, 550 / big), 2, 100, pre);
    const Hn = eccStage(cv, srcG, dstG, half || H, mask, Math.min(0.5, 1100 / big), 2, 25, pre);
    if (!Hn) return { H, ok: false };
    const e0 = pairs ? pairError(H, pairs) : 0, e1 = pairs ? pairError(Hn, pairs) : 0;
    if (!(e1 < Math.max(4, 0.004 * big, 2 * e0))) return { H, ok: false };
    return { H: Hn, ok: true };
  }

  /** How strongly fine detail repeats (an insect screen, woven fabric), 0 = not at all.
      The autocorrelation of fine detail falls away from zero shift; a repeating
      pattern makes it come back up at the repeat distance. The score is how far it
      rebounds (the best local peak above the lowest point on the way out to it). */
  function repeatScore(cv, g) {
    const s = Math.min(1, 1024 / Math.max(g.cols, g.rows));
    const r = new cv.Mat(); cv.resize(g, r, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    const b = new cv.Mat(); cv.GaussianBlur(r, b, new cv.Size(0, 0), 6, 6);
    const hp = new cv.Mat(); cv.subtract(r, b, hp); b.delete(); r.delete();
    const W = hp.cols, H = hp.rows;
    const F = new cv.Mat(); cv.dft(hp, F, cv.DFT_COMPLEX_OUTPUT); hp.delete();
    const Fd = F.data32F;
    for (let i = 0; i < Fd.length; i += 2) { Fd[i] = Fd[i] * Fd[i] + Fd[i + 1] * Fd[i + 1]; Fd[i + 1] = 0; }
    const A = new cv.Mat(); cv.dft(F, A, cv.DFT_INVERSE | cv.DFT_REAL_OUTPUT | cv.DFT_SCALE); F.delete();
    const D = A.data32F, a0 = D[0] || 1e-12;
    const val = (dx, dy) => D[((dy + H) % H) * W + ((dx + W) % W)] / a0;
    const rmax = Math.floor(Math.min(W, H) / 4);
    let best = 0;
    for (let dy = -rmax; dy <= rmax; dy++) for (let dx = 0; dx <= rmax; dx++) {
      const rr = dx * dx + dy * dy; if (rr < 9 || rr > rmax * rmax) continue;
      const v = val(dx, dy); if (v < 0.15) continue;
      let peak = true;
      for (let j = -1; j <= 1 && peak; j++) for (let i = -1; i <= 1; i++) if ((i || j) && val(dx + i, dy + j) > v) { peak = false; break; }
      if (!peak) continue;
      let lo = v; const steps = Math.ceil(Math.sqrt(rr) * 2);
      for (let t = 1; t < steps; t++) lo = Math.min(lo, val(Math.round(dx * t / steps), Math.round(dy * t / steps)));
      best = Math.max(best, v - lo);
    }
    A.delete();
    return best;
  }

  function eccStage(cv, srcG, dstG, H, mask, scale, sigma, iters = 100, pre = 1) {
    // shrink first, then gradients at that size (blur scaled to match): same result, a
    // fraction of the work. The greys arrive at scale `pre` already.
    const s0 = new cv.Mat(), d0 = new cv.Mat(), m = new cv.Mat();
    const sF = asF(cv, srcG), dF = asF(cv, dstG);
    cv.resize(sF, s0, new cv.Size(0, 0), scale / pre, scale / pre, cv.INTER_AREA);
    cv.resize(dF, d0, new cv.Size(0, 0), scale / pre, scale / pre, cv.INTER_AREA);
    if (sF !== srcG) sF.delete(); if (dF !== dstG) dF.delete();
    const sg = Math.max(0.5, sigma * scale);
    const s = gradMag(cv, s0, sg), d = gradMag(cv, d0, sg);
    cv.resize(mask, m, new cv.Size(d.cols, d.rows), 0, 0, cv.INTER_NEAREST);
    s0.delete(); d0.delete();
    const S = [scale, 0, 0, 0, scale, 0, 0, 0, 1], Si = [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1];
    const Wm = cv.matFromArray(3, 3, cv.CV_32F, mul3(mul3(S, inv3(H)), Si));
    let out = null;
    try {
      cv.findTransformECC(d, s, Wm, cv.MOTION_HOMOGRAPHY, new cv.TermCriteria(3, iters, 1e-5), m, 5);
      const Hn = inv3(mul3(mul3(Si, Array.from(Wm.data32F)), S));
      if (Hn.every(isFinite)) out = Hn;
    } catch (e) { if (typeof process !== "undefined" && process.env.ECCDBG) console.log("ECC err", typeof e === "number" && cv.exceptionFromPtr ? cv.exceptionFromPtr(e).msg : e); }
    [s, d, m, Wm].forEach(x => x.delete());
    return out;
  }

  /** The reference's side of the flow stage, made once: the small defocus-equalised copy the
      flow is worked out on, the shrunk copy the gate compares with, its half-size copy and blur
      (ghost maps, subject agreement) and its band-passed copy (the detail-correlation check). */
  function refCache(cv, refF, hw, hh) {
    const W = refF.cols, H = refF.rows, s = Math.min(1, 1100 / Math.max(W, H));
    const a = flowPrep(cv, refF, s), af = new cv.Mat(); a.convertTo(af, cv.CV_32F);
    const w = Math.round(W * s), h = Math.round(H * s);
    const rs = new cv.Mat(); cv.resize(refF, rs, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const half = halfOf(cv, refF, hw, hh);
    const blurHalf = new cv.Mat(); cv.GaussianBlur(half, blurHalf, new cv.Size(0, 0), 3, 3);
    const f = W > 1200 ? 0.5 : 1;                          // as bandNCC: half size for big photos
    const band = nccBand(cv, f === 1 ? refF : half, f);
    return { W, H, s, a, af, rs, half, blurHalf, f, band, free() { [a, af, rs, half, blurHalf, band].forEach(m => m.delete()); } };
  }
  function flowPrep(cv, g, s) {
    const W = g.cols, H = g.rows;
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 2.5, 2.5);
    const r = new cv.Mat(); cv.resize(b, r, new cv.Size(Math.round(W * s), Math.round(H * s)), 0, 0, cv.INTER_AREA); b.delete();
    const u = to8(cv, r); r.delete(); return u;
  }
  /** Half size (each 2 x 2 block averaged). */
  function halfOf(cv, g, hw, hh) { const o = new cv.Mat(); cv.resize(g, o, new cv.Size(hw, hh), 0, 0, cv.INTER_AREA); return o; }

  /** Farneback at reduced size on defocus-equalised images, then masked normalised-convolution
      smoothing (mirrors stacker.py). Returns the flow at that working size (fs, in its own
      pixels) and the two-way check (fb); flowField() gives it at full size, band by band. */
  function denseFlow(cv, rc, movG, mask) {
    const W = rc.W, H = rc.H, s = rc.s;
    const a = rc.a, b = flowPrep(cv, movG, s);
    const fs = new cv.Mat(), bs = new cv.Mat();
    cv.calcOpticalFlowFarneback(a, b, fs, 0.5, 5, 21, 3, 7, 1.5, 0);   // reference -> photo
    cv.calcOpticalFlowFarneback(b, a, bs, 0.5, 5, 21, 3, 7, 1.5, 0);   // photo -> reference
    // two-way check: following the flow there and back should land where it started
    // (within ~1 px at this size). It fails at occlusions and on repeating texture.
    const bw = remapMat(cv, bs, fs, cv.INTER_LINEAR); bs.delete();
    const fb = new cv.Mat(fs.rows, fs.cols, cv.CV_32F), FB = fb.data32F, Fl = fs.data32F, Bw = bw.data32F;
    for (let i = 0; i < FB.length; i++) {
      const e = Math.hypot(Fl[2 * i] + Bw[2 * i], Fl[2 * i + 1] + Bw[2 * i + 1]);
      FB[i] = Math.min(1, Math.max(0, 1 - (e - 1) / 2));
    }
    bw.delete();
    // smoothness check: real parallax and body shifts change gently across the frame;
    // flow that ripples (locked onto different cells of a repeating mesh from place to
    // place) passes the two-way check but bends straight threads into waves
    const rip = flowRipple(cv, fs);
    for (let i = 0; i < FB.length; i++) FB[i] *= Math.min(1, Math.max(0, 1 - (rip[i] - 0.08) / 0.12));
    cv.GaussianBlur(fb, fb, new cv.Size(0, 0), 2, 2);
    // confidence: agreement of the blurred images after warping, where the two-way check
    // passes; the flow is smoothed by it (normalised convolution), all at the working size
    const w = fs.cols, h = fs.rows;
    const af = rc.af, bf = new cv.Mat(); b.convertTo(bf, cv.CV_32F); b.delete();
    const wb = remapMat(cv, bf, fs, cv.INTER_LINEAR); bf.delete();
    const ms = new cv.Mat(); cv.resize(mask, ms, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
    const conf = new cv.Mat(h, w, cv.CV_32F); const Cf = conf.data32F, R = af.data32F, Wb = wb.data32F, Mk = ms.data, FBs = fb.data32F;
    for (let i = 0; i < Cf.length; i++) Cf[i] = Mk[i] ? Math.exp(-Math.abs(Wb[i] - R[i]) / 12) * FBs[i] : 0;
    wb.delete(); ms.delete();
    const smooth = 4 * s * Math.max(W, H) / 2212;
    const den = new cv.Mat(); cv.GaussianBlur(conf, den, new cv.Size(0, 0), smooth, smooth);
    const ch = new cv.MatVector(); cv.split(fs, ch);
    for (let c = 0; c < 2; c++) {
      const x = ch.get(c); cv.multiply(x, conf, x);
      cv.GaussianBlur(x, x, new cv.Size(0, 0), smooth, smooth);
      const X = x.data32F, D = den.data32F;
      for (let i = 0; i < X.length; i++) X[i] = X[i] / (D[i] + 1e-4) * FBs[i];   // where the two-way check fails, keep the plain line-up
      ch.set(c, x); x.delete();
    }
    cv.merge(ch, fs); ch.delete(); conf.delete(); den.delete();
    return { fs, fb, s, W, H };
  }

  /** How fast a flow field changes from pixel to pixel (px per px, lightly smoothed). */
  function flowRipple(cv, flow) {
    const ch = new cv.MatVector(); cv.split(flow, ch);
    const R = new cv.Mat(flow.rows, flow.cols, cv.CV_32F, new cv.Scalar(0));
    for (let c = 0; c < 2; c++) {
      const x = ch.get(c), gx = new cv.Mat(), gy = new cv.Mat();
      cv.GaussianBlur(x, x, new cv.Size(0, 0), 1, 1);
      cv.Sobel(x, gx, cv.CV_32F, 1, 0, 3, 0.125); cv.Sobel(x, gy, cv.CV_32F, 0, 1, 3, 0.125);
      const A = R.data32F, X = gx.data32F, Y = gy.data32F;
      for (let i = 0; i < A.length; i++) A[i] += Math.abs(X[i]) + Math.abs(Y[i]);
      x.delete(); gx.delete(); gy.delete();
    }
    ch.delete();
    cv.GaussianBlur(R, R, new cv.Size(0, 0), 3, 3);
    const out = Float32Array.from(R.data32F); R.delete();
    return out;
  }

  /** Where the flow really improves the line-up (0..1, at the flow's working size). The full-size
      flow, as it would be brought back down to the working size, is warped against the plain
      line-up there. */
  function gateFlow(cv, fl, rc, movG) {
    const W = fl.W, H = fl.H, k = fl.s, w = fl.fs.cols, h = fl.fs.rows;
    const rs = rc.rs, ms = new cv.Mat(); cv.resize(movG, ms, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    // the full-size flow (made from fs: upsized, in full-size pixels, clamped) sampled back down
    // to w x h the way cv.resize(INTER_LINEAR) samples, times k
    const fs = new cv.Mat(h, w, cv.CV_32FC2), FS = fs.data32F, F = fl.fs.data32F;
    const ux = linearTaps(W, w), uy = linearTaps(H, h), dx = linearTaps(w, W), dy = linearTaps(h, H), maxPx = 0.04 * Math.max(W, H), near = maxPx * maxPx * 0.999;
    const full = (x, y, out) => {                       // full-size flow at pixel (x, y), not yet gated
      const r0 = uy.i0[y], r1 = Math.min(h - 1, r0 + 1), wy = uy.w1[y], c0 = ux.i0[x], c1 = Math.min(w - 1, c0 + 1), wx = ux.w1[x];
      const p00 = 2 * (r0 * w + c0), p01 = 2 * (r0 * w + c1), p10 = 2 * (r1 * w + c0), p11 = 2 * (r1 * w + c1);
      let u = Math.fround(Math.fround(F[p00] * (1 - wx) + F[p01] * wx) * (1 - wy) + Math.fround(F[p10] * (1 - wx) + F[p11] * wx) * wy);
      let v = Math.fround(Math.fround(F[p00 + 1] * (1 - wx) + F[p01 + 1] * wx) * (1 - wy) + Math.fround(F[p10 + 1] * (1 - wx) + F[p11 + 1] * wx) * wy);
      u = Math.fround(u / k); v = Math.fround(v / k);
      if (u * u + v * v > near) { const m = Math.hypot(u, v); if (m > maxPx) { u = Math.fround(u * (maxPx / m)); v = Math.fround(v * (maxPx / m)); } }
      out[0] = u; out[1] = v;
    };
    const q00 = [0, 0], q01 = [0, 0], q10 = [0, 0], q11 = [0, 0];
    for (let y = 0, o = 0; y < h; y++) {
      const r0 = dy.i0[y], r1 = Math.min(H - 1, r0 + 1), wy = dy.w1[y];
      for (let x = 0; x < w; x++, o += 2) {
        const c0 = dx.i0[x], c1 = Math.min(W - 1, c0 + 1), wx = dx.w1[x];
        full(c0, r0, q00); full(c1, r0, q01); full(c0, r1, q10); full(c1, r1, q11);
        FS[o] = ((q00[0] * (1 - wx) + q01[0] * wx) * (1 - wy) + (q10[0] * (1 - wx) + q11[0] * wx) * wy) * k;
        FS[o + 1] = ((q00[1] * (1 - wx) + q01[1] * wx) * (1 - wy) + (q10[1] * (1 - wx) + q11[1] * wx) * wy) * k;
      }
    }
    const b = g => { const o = new cv.Mat(); cv.GaussianBlur(g, o, new cv.Size(0, 0), 3 * k, 3 * k); return o; };
    const r = b(rs), m = b(ms), wm0 = remapMat(cv, ms, fs, cv.INTER_LINEAR), wm = b(wm0); wm0.delete();
    const eg = new cv.Mat(), ef = new cv.Mat();
    cv.absdiff(m, r, eg); cv.absdiff(wm, r, ef);
    const sg = 15 * k * Math.max(W, H) / 2212;
    cv.GaussianBlur(eg, eg, new cv.Size(0, 0), sg, sg); cv.GaussianBlur(ef, ef, new cv.Size(0, 0), sg, sg);
    const A = new cv.Mat(eg.rows, eg.cols, cv.CV_32F), a = A.data32F, G = eg.data32F, Fv = ef.data32F;
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (G[i] - Fv[i] - 0.002) / (G[i] + 0.01) * 3));
    cv.GaussianBlur(A, A, new cv.Size(0, 0), sg, sg);
    [ms, fs, r, m, wm, eg, ef].forEach(x => x.delete());
    const out = Float32Array.from(A.data32F); A.delete();
    return out;
  }

  /** Where cv.resize(INTER_LINEAR) samples when resizing n source pixels to dst: per destination
      pixel, the first source pixel and the weight of the next. */
  function linearTaps(dst, n) {
    const scale = n / dst, i0 = new Int32Array(dst), w1 = new Float32Array(dst);
    for (let d = 0; d < dst; d++) {
      let f = Math.fround((d + 0.5) * scale - 0.5), s = Math.floor(f); f -= s;
      if (s < 0) { f = 0; s = 0; }
      if (s >= n - 1) { f = 0; s = n - 1; }
      i0[d] = s; w1[d] = f;
    }
    return { i0, w1 };
  }

  /** The local correction at full size, made a band of rows at a time from the flow at its
      working size and the gate: upsized, in full-size pixels, clamped to 4% of the frame,
      times the gate. Nothing full-size is kept: each use makes the rows it needs. */
  function flowField(fl, gate) {
    const W = fl.W, H = fl.H, s = fl.s, w = fl.fs.cols, h = fl.fs.rows, F = Float32Array.from(fl.fs.data32F), A = gate;
    const tx = linearTaps(W, w), ty = linearTaps(H, h), maxPx = 0.04 * Math.max(W, H), near = maxPx * maxPx * 0.999;
    const c1 = Int32Array.from(tx.i0, c => Math.min(w - 1, c + 1));
    // a working-size row interpolated across the full width (u, v, gate), as cv.resize's
    // horizontal pass does it (in single precision); cached by row, since neighbouring output
    // rows share their source rows
    const rowCache = new Map();
    const hrow = r => {
      let e = rowCache.get(r);
      if (e) return e;
      e = { u: new Float32Array(W), v: new Float32Array(W), g: new Float32Array(W) };
      const b = r * w;
      for (let x = 0; x < W; x++) {
        const p0 = b + tx.i0[x], p1 = b + c1[x], wx = tx.w1[x], ix = 1 - wx;
        e.u[x] = F[2 * p0] * ix + F[2 * p1] * wx; e.v[x] = F[2 * p0 + 1] * ix + F[2 * p1 + 1] * wx; e.g[x] = A[p0] * ix + A[p1] * wx;
      }
      if (rowCache.size > 4) rowCache.delete(rowCache.keys().next().value);
      rowCache.set(r, e);
      return e;
    };
    /** rows y0..y1: fx, fy = the correction (pixels), or with maps the source position */
    function band(y0, y1, fx, fy, maps) {
      for (let y = y0, o = 0; y < y1; y++) {
        const r0 = ty.i0[y], wy = ty.w1[y], iy = 1 - wy, R0 = hrow(r0), R1 = hrow(Math.min(h - 1, r0 + 1));
        const U0 = R0.u, V0 = R0.v, G0 = R0.g, U1 = R1.u, V1 = R1.v, G1 = R1.g;
        for (let x = 0; x < W; x++, o++) {
          // then the vertical pass
          let u = Math.fround(U0[x] * iy + U1[x] * wy), v = Math.fround(V0[x] * iy + V1[x] * wy);
          u = Math.fround(u / s); v = Math.fround(v / s);
          if (u * u + v * v > near) { const m = Math.hypot(u, v); if (m > maxPx) { u = Math.fround(u * (maxPx / m)); v = Math.fround(v * (maxPx / m)); } }
          const g = Math.fround(G0[x] * iy + G1[x] * wy);
          u = Math.fround(u * g); v = Math.fround(v * g);
          if (maps) { fx[o] = x + u; fy[o] = y + v; } else { fx[o] = u; fy[o] = v; }
        }
      }
    }
    return {
      /** share of the overlap (8-bit mask) that the correction moves by more than 0.5 px */
      movedShare(mask) {
        const M = mask.data; let a = 0, mv = 0;
        const fx = new Float32Array(BAND * W), fy = new Float32Array(BAND * W);
        for (let y0 = 0; y0 < H; y0 += BAND) {
          const y1 = Math.min(H, y0 + BAND); band(y0, y1, fx, fy, false);
          for (let k = y0 * W, o = 0; k < y1 * W; k++, o++) { if (!M[k]) continue; a++; if (fx[o] * fx[o] + fy[o] * fy[o] > 0.25) mv++; }
        }
        return a ? mv / a : 0;
      },
      /** src (full size) resampled through the correction, handed to sink(y0, mat) a band at a time */
      remap(cv, src, interp, sink) {
        for (let y0 = 0; y0 < H; y0 += BAND) {
          const y1 = Math.min(H, y0 + BAND);
          const mx = new cv.Mat(y1 - y0, W, cv.CV_32F), my = new cv.Mat(y1 - y0, W, cv.CV_32F);
          band(y0, y1, mx.data32F, my.data32F, true);
          const o = new cv.Mat(); cv.remap(src, o, mx, my, interp, cv.BORDER_REFLECT); mx.delete(); my.delete();
          sink(y0, o); o.delete();
        }
      }
    };
  }

  function remapMat(cv, src, flow, interp) {
    const H = flow.rows, W = flow.cols;
    const mx = new cv.Mat(H, W, cv.CV_32F), my = new cv.Mat(H, W, cv.CV_32F);
    const X = mx.data32F, Y = my.data32F, F = flow.data32F;
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) { X[i] = x + F[2 * i]; Y[i] = y + F[2 * i + 1]; }
    const out = new cv.Mat(); cv.remap(src, out, mx, my, interp, cv.BORDER_REFLECT);
    mx.delete(); my.delete();
    return out;
  }

  /** The detail band (between blur 2 and blur 10, scaled by f) that bandNCC compares. */
  function nccBand(cv, g, f) {
    const x = new cv.Mat(), y = new cv.Mat();
    cv.GaussianBlur(g, x, new cv.Size(0, 0), 2 * f, 2 * f); cv.GaussianBlur(g, y, new cv.Size(0, 0), 10 * f, 10 * f);
    cv.subtract(x, y, x); y.delete(); return x;
  }
  /** The overlap mask at bandNCC's working size. */
  function halfMask(cv, mask, rc) {
    if (rc.f === 1) return mask.clone();
    const o = new cv.Mat(); cv.resize(mask, o, new cv.Size(Math.round(mask.cols * rc.f), Math.round(mask.rows * rc.f)), 0, 0, cv.INTER_NEAREST); return o;
  }
  /** bandNCC(reference, g, mask), with the reference's side from the cache. gHalf: g at half
      size if already made. mH: halfMask() of the overlap. */
  function nccWith(cv, rc, g, gHalf, mH) {
    let small = g;
    if (rc.f !== 1) small = gHalf || halfOf(cv, g, rc.half.cols, rc.half.rows);
    const B = nccBand(cv, small, rc.f); if (small !== g && small !== gHalf) small.delete();
    const r = nccScore(rc.band.data32F, B.data32F, mH.data, rc.f === 1 ? 3 : 1); B.delete();
    return r;
  }
  function nccScore(p, q, M, step) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < p.length; i += step) {
      if (!M[i]) continue;
      const u = p[i], v = q[i]; n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
    }
    if (n < 10) return 0;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return cov / Math.sqrt(va * vb + 1e-12);
  }

  function bandNCC(cv, a, b, mask) {
    // at half size for big photos (the band is 2-10 px at full size, 1-5 at half: same band)
    const f = a.cols > 1200 ? 0.5 : 1;
    const small = (m, interp) => { if (f === 1) return m; const o = new cv.Mat(); cv.resize(m, o, new cv.Size(Math.round(m.cols * f), Math.round(m.rows * f)), 0, 0, interp); return o; };
    const a2 = small(a, cv.INTER_AREA), b2 = small(b, cv.INTER_AREA), m2 = small(mask, cv.INTER_NEAREST);
    const band = g => {
      const x = new cv.Mat(), y = new cv.Mat();
      cv.GaussianBlur(g, x, new cv.Size(0, 0), 2 * f, 2 * f); cv.GaussianBlur(g, y, new cv.Size(0, 0), 10 * f, 10 * f);
      cv.subtract(x, y, x); y.delete(); return x;
    };
    const A = band(a2), B = band(b2), M = m2.data, p = A.data32F, q = B.data32F;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const step = f === 1 ? 3 : 1;                         // subsample for speed
    for (let i = 0; i < p.length; i += step) {
      if (!M[i]) continue;
      const u = p[i], v = q[i]; n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
    }
    A.delete(); B.delete();
    if (f !== 1) { a2.delete(); b2.delete(); m2.delete(); }
    if (n < 10) return 0;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return cov / Math.sqrt(va * vb + 1e-12);
  }

  function sameFocus(A, B, M) {
    // Two photos are sharp in the same places if their sharpness ratio is the same
    // everywhere (a uniform ratio is allowed: a lower-resolution copy is softer overall).
    // M (optional): only where both photos have pixels of their own.
    let ma = 0, mb = 0;
    for (let k = 0; k < A.length; k++) { if (M && !M[k]) continue; if (A[k] > ma) ma = A[k]; if (B[k] > mb) mb = B[k]; }
    const ta = 0.02 * ma, tb = 0.02 * mb, r = [];
    for (let k = 0; k < A.length; k += 2) if ((!M || M[k]) && (A[k] > ta || B[k] > tb)) r.push(Math.log((A[k] + 1e-6 * ma) / (B[k] + 1e-6 * mb)));
    if (r.length < 50) return true;
    const med = Float64Array.from(r).sort()[r.length >> 1], lim = Math.log(1.6);
    let off = 0; for (const v of r) if (Math.abs(v - med) > lim) off++;
    return off / r.length < 0.05;
  }

  /** fraction of the frame where each photo is the sharpest or close to it (at 1/4 size; fs:
      each photo's sharpness there times what it may contribute); a near-equal photo still adds
      something: its detail is merged in */
  function winnerShare(fs) {
    const N = fs[0].length, win = new Array(fs.length).fill(0);
    let maxAll = 0; for (const f of fs) for (const v of f) if (v > maxAll) maxAll = v;
    let counted = 0;
    for (let k = 0; k < N; k++) {
      let b = -1, bv = 0, sv = 0;
      for (let i = 0; i < fs.length; i++) { const v = fs[i][k]; if (v > bv) { sv = bv; bv = v; b = i; } else if (v > sv) sv = v; }
      if (bv < maxAll * 0.01) continue;                // nothing in focus here at all
      counted++;
      for (let i = 0; i < fs.length; i++) if (fs[i][k] >= 0.8 * bv) win[i]++;
    }
    return win.map(w => w / Math.max(1, counted));
  }

  /** How well a photo agrees with the (already blurred) reference, 0..1, worked out at half
      size: both are compared blurred, so a difference in focus alone doesn't count. g: the
      photo's grey at half size; refBlurHalf: the reference's, blurred by 3. */
  function ghostHalf(cv, refBlurHalf, g, tol = 0.06) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 3, 3);
    const B = b.data32F, r = refBlurHalf.data32F;
    for (let i = 0; i < B.length; i++) {
      const d = Math.abs(B[i] - r[i]);
      B[i] = Math.min(1, Math.max(0, 1 - (d - tol) / tol));
    }
    cv.GaussianBlur(b, b, new cv.Size(0, 0), 2, 2);
    return b;
  }

  function guidedFilter(cv, I, p, r, eps) {
    const k = new cv.Size(2 * r + 1, 2 * r + 1);
    const box = m => { const o = new cv.Mat(); cv.boxFilter(m, o, -1, k); return o; };
    const Ip = new cv.Mat(), II = new cv.Mat(); cv.multiply(I, p, Ip); cv.multiply(I, I, II);
    const mI = box(I), mp = box(p), mIp = box(Ip), mII = box(II);
    Ip.delete(); II.delete();
    const a = new cv.Mat(I.rows, I.cols, cv.CV_32F), b = new cv.Mat(I.rows, I.cols, cv.CV_32F);
    const A = a.data32F, Bv = b.data32F, MI = mI.data32F, MP = mp.data32F, MIP = mIp.data32F, MII = mII.data32F;
    for (let i = 0; i < A.length; i++) {
      const v = MII[i] - MI[i] * MI[i], c = MIP[i] - MI[i] * MP[i];
      A[i] = c / (v + eps); Bv[i] = MP[i] - A[i] * MI[i];
    }
    [mI, mp, mIp, mII].forEach(m => m.delete());
    const ma = box(a), mb = box(b); a.delete(); b.delete();
    const out = new cv.Mat(I.rows, I.cols, cv.CV_32F), O = out.data32F, I0 = I.data32F, MA = ma.data32F, MB = mb.data32F;
    for (let i = 0; i < O.length; i++) O[i] = MA[i] * I0[i] + MB[i];
    ma.delete(); mb.delete();
    return out;
  }

  const LEVELS = 6, FINE = 3;
  // multi-photo detail: a photo joins the merge at a spot once it is at least
  // MERGE_FROM of the sharpest photo's detail there (fully from MERGE_FULL), and
  // only as far as its detail agrees with the sharpest photo's (ROBUST x noise)
  const MERGE_FROM = 0.55, MERGE_FULL = 0.9, ROBUST = 2.5;
  // halo guard: from this pyramid level up, a photo is weighted by its worst sharpness (relative
  // to the sharpest photo) within the level's reach, not by its sharpness at the spot itself
  let HALO_FROM = 2, HALO_P = 4;
  // spill check: beside something sharp in front, a photo whose large-scale brightness differs
  // from the photo that has that thing sharp by SPILL_TAU (0..1 grey) keeps half its weight there
  let SPILL = true, SPILL_TAU = 0.02, SPILL_R = 6;
  // fill: where no photo has real detail (smooth background), weights come from the nearest
  // detail instead (within ~FILL_S half-size px). Real detail: the sharpest photo's focus is
  // FILL_K times the blurriest's or more (half-way at FILL_K)
  let FILL = true, FILL_K = 4, FILL_S = 12;

  function pyrSizes(W, H) {
    const s = [[W, H]];
    for (let i = 0; i < LEVELS; i++) { const [w, h] = s[i]; s.push([Math.floor((w + 1) / 2), Math.floor((h + 1) / 2)]); }
    return s;
  }

  function gaussPyr(cv, m, levels = LEVELS, own = false) {
    const g = [own ? m : m.clone()];                 // own = take m over instead of copying it
    for (let i = 0; i < levels; i++) { const d = new cv.Mat(); cv.pyrDown(g[i], d); g.push(d); }
    return g;
  }

  /** Laplacian pyramid; with levels < LEVELS only the finest `levels` bands. */
  function lapPyr(cv, m, levels = LEVELS) {
    // takes m over (the caller must not delete it) and turns each Gaussian level into
    // its band in place: one full-size float copy at a time instead of three (and no clone)
    const full = levels >= LEVELS, L = full ? LEVELS : levels;
    const g = gaussPyr(cv, m, L, true);
    for (let i = 0; i < L; i++) {
      const u = new cv.Mat(); cv.pyrUp(g[i + 1], u, new cv.Size(g[i].cols, g[i].rows));
      cv.subtract(g[i], u, g[i]); u.delete();
    }
    if (!full) { g[L].delete(); g.length = L; }
    return g;
  }

  /** Local detail energy of one pyramid band (sum over colour channels, lightly smoothed). */
  function bandEnergy(cv, lap) {
    const e = new cv.Mat(lap.rows, lap.cols, cv.CV_32F), E = e.data32F, C = lap.data32F;
    for (let k = 0, p = 0; k < E.length; k++, p += 3) E[k] = Math.abs(C[p]) + Math.abs(C[p + 1]) + Math.abs(C[p + 2]);
    cv.GaussianBlur(e, e, new cv.Size(0, 0), 1, 1);
    return e;
  }

  /** imgs8: lined-up photos (8-bit RGB). weights: per photo, half size, 0..1 —
      where it may contribute (has pixels, agrees with the reference, can be trusted).
      valid: per photo, full size 8-bit — where it has pixels of its own. */
  async function fuseHybrid(cv, imgs8, weights, valid, progress, tick, debug, stats) {
    // stats = {lo, hi, noise} for the whole frame, when this call merges one strip of it
    const n = imgs8.length, W = imgs8[0].cols, H = imgs8[0].rows;
    // --- weights from relative sharpness, computed at half size (weights are smooth) ---
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2), half = new cv.Size(hw, hh);
    const Fh = [], texMax = new Float32Array(W * H), N = hw * hh, meanHalf = new Float32Array(N);
    const qw = Math.floor((hw + 1) / 2), qh = Math.floor((hh + 1) / 2), quarter = new cv.Size(qw, qh), NQ = qw * qh;
    const Lq = [];                                     // each photo's large-scale brightness, quarter size
    for (let i = 0; i < n; i++) {
      // grey copy made on the fly (keeps memory down on phones)
      const im = unpark(cv, imgs8[i]), gray = toGray(cv, im); im.delete();
      const f = focusMeasure(cv, gray, 4);
      const s = new cv.Mat(); cv.resize(f, s, half, 0, 0, cv.INTER_AREA); f.delete(); Fh.push(s);
      const f2 = focusMeasure(cv, gray, 2), T = f2.data32F, V = pdata(valid[i]);
      for (let k = 0; k < T.length; k++) if (V[k] && T[k] > texMax[k]) texMax[k] = T[k];
      f2.delete();
      const gs = new cv.Mat(); cv.resize(gray, gs, half, 0, 0, cv.INTER_AREA); const S = gs.data32F;
      for (let k = 0; k < N; k++) meanHalf[k] += S[k] / n;
      if (SPILL) {
        const q = new cv.Mat(); cv.resize(gs, q, quarter, 0, 0, cv.INTER_AREA); cv.GaussianBlur(q, q, new cv.Size(0, 0), 1, 1);
        const u = new cv.Mat(); q.convertTo(u, cv.CV_8U, 255, 0); q.delete(); Lq.push(u);
      }
      gs.delete(); gray.delete();
      progress((i + 1) / n * 0.22);
      await tick();
    }
    // the sharpest photo at each spot, among those that have pixels there
    const Fmax = new Float32Array(N), Fmin = new Float32Array(N).fill(Infinity);
    for (let i = 0; i < n; i++) {
      const d = Fh[i].data32F, g = weights[i].data;
      for (let k = 0; k < N; k++) if (g[k] > 0.02 * 255) { if (d[k] > Fmax[k]) Fmax[k] = d[k]; if (d[k] < Fmin[k]) Fmin[k] = d[k]; }
    }
    // real detail: the sharpest photo has far more than the blurriest (over a smooth
    // background every photo is about as flat as the others, noise and all)
    const detail = new Float32Array(N), DK4 = FILL_K ** 4;
    for (let k = 0; k < N; k++) { const r = Fmax[k] / (Fmin[k] + 1e-12), r4 = isFinite(r) ? r ** 4 : 0; detail[k] = r4 / (r4 + DK4); }
    const sorted = Float32Array.from(texMax.filter((_, k) => k % 7 === 0)).sort();
    const lo = stats ? stats.lo : sorted[Math.floor(sorted.length * .35)], hi = stats ? stats.hi : sorted[Math.floor(sorted.length * .65)];
    const sizes = pyrSizes(W, H);

    // --- spill check. A photo focused behind a leg shows the leg blurred into a glow over the
    //     background beside it (displaced, too, when the leg moved with parallax). The photo
    //     with the leg sharp shows that background blurred but clean, and it is the photo with
    //     the most detail nearby (the leg's crisp outline). Beside it (where that photo isn't
    //     the sharp one itself), each photo's weight drops as its large-scale brightness
    //     (blur radius ~4 px) parts from that clean photo's: a glow is a few percent of the
    //     leg's brightness spread over the background; blurred texture barely moves it. ---
    if (SPILL && n > 1) {
      const kd = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * SPILL_R + 1, 2 * SPILL_R + 1));
      const bestD = new Float32Array(NQ).fill(-1), cIdx = new Uint8Array(NQ), rc = new Float32Array(NQ), Lc = new Uint8Array(NQ);
      const Fq = i => { const q = new cv.Mat(); cv.resize(Fh[i], q, quarter, 0, 0, cv.INTER_AREA); return q; };
      for (let i = 0; i < n; i++) {
        const q = Fq(i), gq = new cv.Mat(); cv.resize(weights[i], gq, quarter, 0, 0, cv.INTER_AREA);
        const Q = q.data32F, G = gq.data; for (let k = 0; k < NQ; k++) if (G[k] < 128) Q[k] = 0;      // only where it is usable
        const d = new cv.Mat(); cv.dilate(q, d, kd); const D = d.data32F;
        for (let k = 0; k < NQ; k++) if (D[k] > bestD[k]) { bestD[k] = D[k]; cIdx[k] = i; }
        q.delete(); d.delete(); gq.delete();
      }
      const fmq = new cv.Mat(); cv.resize(cv.matFromArray(hh, hw, cv.CV_32F, Fmax), fmq, quarter, 0, 0, cv.INTER_AREA); const FM = fmq.data32F;
      for (let i = 0; i < n; i++) {
        const q = Fq(i), Q = q.data32F, L = Lq[i].data;
        for (let k = 0; k < NQ; k++) if (cIdx[k] === i) { rc[k] = Q[k] / (FM[k] + 1e-12); Lc[k] = L[k]; }
        q.delete();
      }
      // only over smooth backgrounds, where a glow shows: over texture (bark, a leaf's veins)
      // the photos' large-scale brightness differs anyway, and a glow hides in the texture
      const dq = new cv.Mat(); cv.resize(cv.matFromArray(hh, hw, cv.CV_32F, detail), dq, quarter, 0, 0, cv.INTER_AREA); const cq = Float32Array.from(dq.data32F); dq.delete();
      fmq.delete(); kd.delete();
      const tau = SPILL_TAU * 255;
      for (let i = 0; i < n; i++) {
        const pq = new cv.Mat(qh, qw, cv.CV_32F), P = pq.data32F, L = Lq[i].data;
        for (let k = 0; k < NQ; k++) {
          if (cIdx[k] === i || rc[k] >= 0.5) { P[k] = 1; continue; }
          const d = Math.abs(L[k] - Lc[k]) / tau, pen = d <= 1 ? 1 : d >= 3 ? 0 : (3 - d) / 2;
          P[k] = 1 - (1 - pen) * (1 - cq[k]);
        }
        const ph = new cv.Mat(); cv.resize(pq, ph, half, 0, 0, cv.INTER_LINEAR); pq.delete();
        const PH = ph.data32F, G = weights[i].data;
        for (let k = 0; k < N; k++) G[k] = Math.round(G[k] * PH[k]);
        ph.delete(); Lq[i].delete();
      }
    } else Lq.forEach(m => m.delete());

    // --- halo guard. Next to a leg, a photo focused behind it shows the leg blurred into a
    //     glow over the background, and one focused on the leg shows the background blurred.
    //     A band of detail at level L reaches about 2^L px, so from HALO_FROM up each photo is
    //     weighted by its worst relative sharpness within that reach (a min-pyramid): beside a
    //     depth edge that favours the photos that are decent on both sides of it, so neither
    //     the glow nor the blurred background lands there. Elsewhere it is the same photo as
    //     at the spot itself. ---
    const guard = [];
    if (HALO_FROM <= LEVELS) {
      const eps = Math.max(lo, 1e-8), k3 = cv.Mat.ones(3, 3, cv.CV_8U);
      for (let i = 0; i < n; i++) {
        const d = Fh[i].data32F;
        let e = new cv.Mat(hh, hw, cv.CV_32F); const E = e.data32F;
        for (let k = 0; k < N; k++) E[k] = Math.min(1, (d[k] + eps) / (Fmax[k] + eps));
        const lv = [];
        for (let L = 1; L <= LEVELS; L++) {
          if (L > 1) {
            const er = new cv.Mat(); cv.erode(e, er, k3); e.delete();
            e = new cv.Mat(); cv.resize(er, e, new cv.Size(sizes[L][0], sizes[L][1]), 0, 0, cv.INTER_NEAREST); er.delete();
          }
          if (L >= HALO_FROM) { const u = new cv.Mat(); e.convertTo(u, cv.CV_8U, 255, 0); lv[L] = u; }
        }
        e.delete(); guard.push(lv);
      }
      k3.delete();
    }
    for (let i = 0; i < n; i++) {
      const d = Fh[i].data32F, g = weights[i].data;
      for (let k = 0; k < N; k++) { const r = Math.min(1, d[k] / (Fmax[k] + 1e-9)); d[k] = r * r * r * r * g[k] / 255 + 1e-6; }
    }
    normalise(Fh, N);
    const meanG = cv.matFromArray(hh, hw, cv.CV_32F, meanHalf);
    for (let i = 0; i < n; i++) {
      const r = guidedFilter(cv, meanG, Fh[i], 4, 1e-4); const R = r.data32F;
      for (let k = 0; k < N; k++) R[k] = Math.max(0, R[k]) + 1e-6;
      Fh[i].delete(); Fh[i] = r;
    }
    meanG.delete();
    normalise(Fh, N);
    // --- fill. Over a smooth background (out-of-focus foliage, sky) no photo has detail, so
    //     the sharpness weights there are noise and every photo gets a say, including those
    //     with a nearby leg blurred into a glow over it. There, take the weights of the
    //     nearest detail instead: next to a leg, the photo that has that leg sharp, which shows
    //     the background beside it clean. Where there is detail, nothing changes. ---
    if (FILL && n > 1) {
      const conf = cv.matFromArray(hh, hw, cv.CV_32F, detail), CF = conf.data32F;
      const den = new cv.Mat(); cv.GaussianBlur(conf, den, new cv.Size(0, 0), FILL_S, FILL_S); const DN = den.data32F;
      for (let i = 0; i < n; i++) {
        const w = Fh[i].data32F, t = new cv.Mat(hh, hw, cv.CV_32F), TT = t.data32F;
        for (let k = 0; k < N; k++) TT[k] = w[k] * CF[k];
        cv.GaussianBlur(t, t, new cv.Size(0, 0), FILL_S, FILL_S);
        for (let k = 0; k < N; k++) if (DN[k] > 1e-3) w[k] = CF[k] * w[k] + (1 - CF[k]) * TT[k] / DN[k];
        t.delete();
      }
      conf.delete(); den.delete();
      normalise(Fh, N);
    }
    if (debug) debug('weights', { width: hw, height: hh, maps: Fh.map(m => Float32Array.from(m.data32F)) });

    // --- texture mask (where detail is taken from the sharpest photos, not averaged) ---
    const tex = cv.matFromArray(H, W, cv.CV_32F, texMax);
    const tb = new cv.Mat(); cv.GaussianBlur(tex, tb, new cv.Size(0, 0), 25, 25);
    const TM = new cv.Mat(H, W, cv.CV_32F), tm = TM.data32F, TB = tb.data32F;
    for (let k = 0; k < tm.length; k++) {
      const t = texMax[k] / (TB[k] + 1e-6);
      const a = Math.min(1, Math.max(0, t / 0.5));
      const gate = Math.min(1, Math.max(0, (texMax[k] - lo) / (hi - lo + 1e-9)));
      tm[k] = a * gate;
    }
    tex.delete(); tb.delete();
    cv.GaussianBlur(TM, TM, new cv.Size(0, 0), 3, 3);
    const tp = gaussPyr(cv, TM, LEVELS, true);

    // --- pass 1: weighted pyramid at every level; at the fine levels, find the
    //     sharpest photo at each spot (and the noise level of each band) ---
    const acc = sizes.map(([w, h]) => new Float32Array(w * h * 3));
    const accH = sizes.map(([w, h], L) => L >= HALO_FROM ? new Float32Array(w * h * 3) : null);
    const sumH = sizes.map(([w, h], L) => L >= HALO_FROM ? new Float32Array(w * h) : null);
    const bestE = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h).fill(-1));
    const bestC = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h * 3));
    const noise = stats ? stats.noise.slice() : new Array(FINE).fill(Infinity);
    const ghostPyr = i => {
      const wF = f32(cv, weights[i]), gf = new cv.Mat(); cv.resize(wF, gf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); wF.delete();
      return gaussPyr(cv, gf, FINE, true);
    };
    for (let i = 0; i < n; i++) {
      const im = unpark(cv, imgs8[i]), f = new cv.Mat(); im.convertTo(f, cv.CV_32FC3, 1 / 255); im.delete();
      const lp = lapPyr(cv, f);
      const wf = new cv.Mat(); cv.resize(Fh[i], wf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      const gw = gaussPyr(cv, wf, LEVELS, true);
      const gg = ghostPyr(i);
      for (let L = 0; L <= LEVELS; L++) {
        const C = lp[L].data32F, Wt = gw[L].data32F, A = acc[L];
        for (let k = 0, p = 0; k < Wt.length; k++, p += 3) {
          const w = Wt[k]; A[p] += w * C[p]; A[p + 1] += w * C[p + 1]; A[p + 2] += w * C[p + 2];
        }
        if (L >= HALO_FROM) {
          const gL = new cv.Mat(); cv.resize(weights[i], gL, new cv.Size(sizes[L][0], sizes[L][1]), 0, 0, cv.INTER_AREA);
          const G = gL.data, Eg = guard[i][L].data, AH = accH[L], SH = sumH[L];
          for (let k = 0, p = 0; k < G.length; k++, p += 3) {
            const r = Eg[k] / 255, w = Math.pow(r, HALO_P) * G[k] / 255 + 1e-12;
            AH[p] += w * C[p]; AH[p + 1] += w * C[p + 1]; AH[p + 2] += w * C[p + 2]; SH[k] += w;
          }
          gL.delete(); guard[i][L].delete();
        }
        if (L < FINE) {
          const e = bandEnergy(cv, lp[L]), E = e.data32F, C2 = lp[L].data32F;
          const G = gg[L].data32F, BE = bestE[L], BC = bestC[L];
          // noise of this band: the typical detail where this photo is out of focus
          const smp = []; for (let k = 0, p = 0; k < E.length; k += 37, p += 111) if (G[k] > 0.5) smp.push(Math.abs(C2[p]) + Math.abs(C2[p + 1]) + Math.abs(C2[p + 2]));
          if (!stats && smp.length > 100) { smp.sort((x, y) => x - y); noise[L] = Math.min(noise[L], smp[smp.length >> 2]); }
          for (let k = 0, p = 0; k < E.length; k++, p += 3) {
            const v = E[k] * G[k];
            if (v > BE[k]) { BE[k] = v; BC[p] = C2[p]; BC[p + 1] = C2[p + 1]; BC[p + 2] = C2[p + 2]; }
          }
          e.delete();
        }
      }
      lp.forEach(m => m.delete()); gw.forEach(m => m.delete()); gg.forEach(m => m.delete());
      progress(0.25 + (i + 1) / n * 0.43);
      await tick();
    }
    Fh.forEach(m => m.delete());
    for (let L = HALO_FROM; L <= LEVELS; L++) {
      const A = acc[L], AH = accH[L], SH = sumH[L];
      for (let k = 0, p = 0; k < SH.length; k++, p += 3) {
        if (SH[k] < 1e-9) continue;                    // no photo has a say here: keep the plain blend
        A[p] = AH[p] / SH[k]; A[p + 1] = AH[p + 1] / SH[k]; A[p + 2] = AH[p + 2] / SH[k];
      }
      accH[L] = sumH[L] = null;
    }

    // --- pass 2: fine detail merged from every photo that is nearly as sharp as the
    //     best one at that spot and agrees with it. The single sharpest photo carries
    //     its own noise; averaging in its near-equals cancels some of it, while a
    //     photo whose detail differs (a slightly different line-up, a moved leg) is
    //     left out of that spot. ---
    const num = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h * 3));
    const den = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h));
    const count = debug ? new Uint8Array(sizes[1][0] * sizes[1][1]) : null;
    for (let i = 0; i < n; i++) {
      const im = unpark(cv, imgs8[i]), f = new cv.Mat(); im.convertTo(f, cv.CV_32FC3, 1 / 255); im.delete();
      const lp = lapPyr(cv, f, FINE);
      const gg = ghostPyr(i);
      for (let L = 0; L < FINE; L++) {
        const e = bandEnergy(cv, lp[L]), E = e.data32F, C = lp[L].data32F, G = gg[L].data32F;
        const BE = bestE[L], BC = bestC[L], NU = num[L], DE = den[L];
        const lim = ROBUST * (isFinite(noise[L]) ? Math.max(noise[L], 1e-4) : 0.01);
        for (let k = 0, p = 0; k < E.length; k++, p += 3) {
          const be = BE[k]; if (be <= 0) continue;
          const rel = E[k] * G[k] / be;
          if (rel < MERGE_FROM) continue;
          let s = Math.min(1, (rel - MERGE_FROM) / (MERGE_FULL - MERGE_FROM)); s *= s;
          const d = (Math.abs(C[p] - BC[p]) + Math.abs(C[p + 1] - BC[p + 1]) + Math.abs(C[p + 2] - BC[p + 2])) / lim;
          const w = s / (1 + d * d);
          if (w < 1e-3) continue;
          NU[p] += w * C[p]; NU[p + 1] += w * C[p + 1]; NU[p + 2] += w * C[p + 2]; DE[k] += w;
          if (count && L === 1 && w > 0.25) count[k]++;
        }
        e.delete();
      }
      lp.forEach(m => m.delete()); gg.forEach(m => m.delete());
      progress(0.68 + (i + 1) / n * 0.28);
      await tick();
    }
    if (debug) debug('merged', { width: sizes[1][0], height: sizes[1][1], count });

    // --- blend fine levels, collapse ---
    for (let L = 0; L < FINE; L++) {
      const T = tp[L].data32F, A = acc[L], B = bestC[L], NU = num[L], DE = den[L];
      for (let k = 0, p = 0; k < T.length; k++, p += 3) {
        const a = T[k], d = DE[k];
        const m0 = d > 0 ? NU[p] / d : B[p], m1 = d > 0 ? NU[p + 1] / d : B[p + 1], m2 = d > 0 ? NU[p + 2] / d : B[p + 2];
        A[p] = a * m0 + (1 - a) * A[p]; A[p + 1] = a * m1 + (1 - a) * A[p + 1]; A[p + 2] = a * m2 + (1 - a) * A[p + 2];
      }
      num[L] = den[L] = bestC[L] = bestE[L] = null;
    }
    tp.forEach(m => m.delete());
    let img = cv.matFromArray(sizes[LEVELS][1], sizes[LEVELS][0], cv.CV_32FC3, acc[LEVELS]);
    for (let L = LEVELS - 1; L >= 0; L--) {
      const [w, h] = sizes[L];
      const u = new cv.Mat(); cv.pyrUp(img, u, new cv.Size(w, h)); img.delete();
      const U = u.data32F, A = acc[L]; for (let k = 0; k < U.length; k++) U[k] += A[k];
      img = u; acc[L] = null;
    }
    progress(1);
    return img;
  }

  /** The merge done a band of rows at a time, so its memory follows the band's height, not
      the frame's. Each strip is merged with 256 rows of context above and below (enough for the
      fine levels to be exact and the coarse ones nearly so), sharpened, and cross-faded into its
      neighbour over 256 rows. Thresholds that must be the same everywhere (texture percentiles,
      band noise) are measured on the whole frame first. Returns the finished 8-bit RGB frame. */
  /** Strip layout for the merge: each strip's own rows (y0..y1) and the rows it is merged
      with (e0..e1: 256 rows of context above and below). */
  const STRIP_OV = 256, STRIP_CF = 128;
  function stripSpans(H, maxRows) {
    const core = Math.max(2 * STRIP_CF + 64, Math.floor((maxRows - 2 * STRIP_OV) / 64) * 64), out = [];
    for (let y0 = 0; y0 < H; y0 += core) { const y1 = Math.min(H, y0 + core); out.push({ y0, y1, e0: Math.max(0, y0 - STRIP_OV), e1: Math.min(H, y1 + STRIP_OV) }); }
    return out;
  }
  const to8px = v => { const r = Math.round(v * 255 + 0.5); return r < 0 ? 0 : r > 255 ? 255 : r; };

  /** The merge done a band of rows at a time, so its memory follows the band's height, not
      the frame's. Each strip is merged with 256 rows of context above and below (enough for the
      fine levels to be exact and the coarse ones nearly so), sharpened, and cross-faded into its
      neighbour over 256 rows. Thresholds that must be the same everywhere (texture percentiles,
      band noise) are measured on the whole frame first. The per-photo measurements and the
      strips are tasks (each() runs them, side by side when it can). Returns the finished 8-bit
      RGB frame. */
  async function fuseStrips(cv, imgs8, weights, valid, progress, tick, maxRows, each, sharpen = 0.35) {
    const n = imgs8.length, W = imgs8[0].cols, H = imgs8[0].rows, CF = STRIP_CF;
    const spans = stripSpans(H, maxRows);
    // --- pre-pass 1: texture thresholds from the sharpest fine detail at every 7th pixel ---
    const texS = new Float32Array(Math.ceil(W * H / 7));
    await each('texture', imgs8.map((img, i) => ({ img, valid: valid[i], W, H, spans })), (k, t) => {
      for (let q = 0; q < texS.length; q++) if (t[q] > texS[q]) texS[q] = t[q];
      progress(0.08 * k / n);
    }, undefined, false);
    const sorted = texS.slice().sort();
    const lo = sorted[Math.floor(sorted.length * .35)], hi = sorted[Math.floor(sorted.length * .65)];
    // --- pre-pass 2: each band's noise, from the middle strip (as the whole-frame merge measures it) ---
    const mid = spans[Math.floor(spans.length / 2)];
    const nres = await each('noise', imgs8.map((img, i) => ({ img, weights: weights[i], W, e0: mid.e0, e1: mid.e1 })), k => progress(0.08 + 0.08 * k / n));
    const noise = new Array(FINE).fill(Infinity);
    for (const r of nres) for (let L = 0; L < FINE; L++) noise[L] = Math.min(noise[L], r[L]);
    // --- the strips ---
    const out = new Uint8Array(W * H * 3), row = W * 3;
    const rowsAll = spans.reduce((a, sp) => a + sp.e1 - sp.e0, 0);
    const sres = new Array(spans.length);
    const place = (s, r) => {                             // a strip's finished rows, cross-faded into the one before
      const { y0 } = spans[s];
      out.set(r.plain, r.plainStart * row);
      if (s) {
        const P = sres[s - 1].fout, S = r.fin;
        for (let y = y0 - CF; y < y0 + CF; y++) {
          const w = (y - (y0 - CF) + 0.5) / (2 * CF), pr = (y - (y0 - CF)) * row, dst = y * row;
          for (let k = 0; k < row; k++) out[dst + k] = to8px(P[pr + k] * (1 - w) + S[pr + k] * w);
        }
        sres[s - 1].fout = null; r.fin = null;
      }
      r.plain = null;
    };
    let placed = 0;
    const partial = new Array(spans.length).fill(0), show = () => progress(0.16 + 0.84 * spans.reduce((a, sp, k) => a + (sp.e1 - sp.e0) * partial[k], 0) / rowsAll);
    await each('strip', spans.map((sp, s) => ({ s, sp, last: s === spans.length - 1, W, H, imgs: imgs8, weights, valid, stats: { lo, hi, noise }, sharpen })), (k, r, s) => {
      partial[s] = 1; show();
      sres[s] = r;
      while (placed < spans.length && sres[placed]) place(placed++, sres[placed - 1]);
    }, (s, f) => { partial[s] = Math.min(0.99, f); show(); }, false);
    progress(1);
    return out;
  }

  /* ---------- tasks ----------
     The heavy per-photo and per-strip steps as self-contained jobs: plain arguments in (numbers,
     arrays, parked-image handles), plain results out. The app hands them to helper workers, each
     with its own OpenCV, and runs several at once; run here one after another they give exactly
     the same result. They read and write parked images only through STORE (into space the
     caller made) and never park anything new themselves. */
  const tasks = {
    /** one photo read: decoded (from a.file, by the host's decodeImage) or given (a.data, RGBA at
        fw x fh), turned RGB at the working size and written into a.dst; returns its centre
        sharpness, repeat score, <= 1600 px 8-bit grey and the small float copies for the focus
        order (512 x 384) and the clamp test (cw x ch) */
    async read(cv, a) {
      const { fw, fh, W, H, pre, cw, ch } = a, [cx0, cy0, cx1, cy1] = a.centre;
      const fdata = a.file ? await root.decodeImage(a.file, fw, fh) : a.data;
      if (!fdata || fdata.length !== fw * fh * 4) throw new Error(`Photo ${a.i + 1} could not be read.`);
      // RGBA -> RGB here, so the heap never holds the RGBA copy
      const rgbJ = new Uint8Array(fw * fh * 3);
      for (let k = 0, q = 0; q < rgbJ.length; k += 4, q += 3) { rgbJ[q] = fdata[k]; rgbJ[q + 1] = fdata[k + 1]; rgbJ[q + 2] = fdata[k + 2]; }
      let c3 = cv.matFromArray(fh, fw, cv.CV_8UC3, rgbJ);
      if (c3.cols !== W || c3.rows !== H) {
        const r = new cv.Mat(); cv.resize(c3, r, new cv.Size(W, H), 0, 0, (c3.cols > W ? cv.INTER_AREA : cv.INTER_CUBIC));
        c3.delete(); c3 = r;
      }
      const g8 = gray8(cv, c3);
      parkRows(a.dst, 0, c3); c3.delete();                 // the photo waits outside the WASM heap
      const res = {};
      // sharpness in the centre (a float copy of just that part, with a margin so the blur sees
      // the same neighbours it would in the whole picture)
      { const m = 16, r = new cv.Rect(cx0 - m, cy0 - m, cx1 - cx0 + 2 * m, cy1 - cy0 + 2 * m);
        const gr = g8.roi(r), gf = f32(cv, gr); gr.delete();
        const roi = gf.roi(new cv.Rect(m, m, cx1 - cx0, cy1 - cy0));
        const fm = focusMeasure(cv, roi, 4); res.centreFocus = cv.mean(fm)[0]; fm.delete(); roi.delete(); gf.delete(); }
      const g = f32(cv, g8); g8.delete();
      res.repeatS = repeatScore(cv, g);
      let sm = g;
      if (pre < 1) { sm = new cv.Mat(); cv.resize(g, sm, new cv.Size(0, 0), pre, pre, cv.INTER_AREA); g.delete(); }
      const o = new cv.Mat(); cv.resize(sm, o, new cv.Size(512, 384), 0, 0, cv.INTER_AREA); res.ord = Float32Array.from(o.data32F); o.delete();
      const c = new cv.Mat(); cv.resize(sm, c, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA); res.clamp = Float32Array.from(c.data32F); c.delete();
      const g8s = to8(cv, sm); sm.delete();
      res.gray = { data: new Uint8Array(g8s.data), rows: g8s.rows, cols: g8s.cols }; g8s.delete();
      return res;
    },
    /** one photo's features (AKAZE, on its <= 1600 px grey) */
    features(cv, a) {
      const g = cv.matFromArray(a.g.rows, a.g.cols, cv.CV_8U, a.g.data), m = unpark(cv, a.mask);
      const f = features(cv, null, 0, g, m, a.pre); g.delete(); m.delete();
      const out = { s: f.s, pts: f.pts, n: f.n, drows: f.d.rows, dcols: f.d.cols, d: new Uint8Array(f.d.data) };
      f.d.delete();
      return out;
    },
    /** the line-ups along one direction of the focus order, from the reference outwards: each
        photo matched with the one before it (and with the reference), then fine-tuned */
    chain(cv, a, report = () => {}) {
      const { dir, order, ref, refPos, repeating, big, pre } = a, n = order.length;
      const mask = unpark(cv, a.mask), grays = new Map(), feats = new Map(), logs = [], done = [];
      const gray = i => { if (!grays.has(i)) { const g = a.grays[i]; grays.set(i, cv.matFromArray(g.rows, g.cols, cv.CV_8U, g.data)); } return grays.get(i); };
      a.feats.forEach((f, i) => feats.set(i, { s: f.s, pts: f.pts, n: f.n, d: f.drows ? cv.matFromArray(f.drows, f.dcols, cv.CV_8U, f.d) : new cv.Mat() }));
      const Hs = new Map([[ref, eye3()]]);
      const steps = dir < 0 ? refPos : n - 1 - refPos;
      let prev = ref, pos = refPos + dir, k = 0;
      while (pos >= 0 && pos < n) {
        const cur = order[pos];
        let h = homography(cv, gray(cur), gray(prev), mask, mask, feats, cur, prev, pre);
        let Hm = mul3(Hs.get(prev), h.H), best = h.inliers;
        // the matched features, in reference coordinates: the fine-tune must still agree with them
        let pairs = { src: h.src || [], dst: (h.dst || []).map((v, j, D) => j % 2 ? null : applyH(Hs.get(prev), v, D[j + 1])).filter(Boolean).flat() };
        if (prev !== ref) {
          const d = homography(cv, gray(cur), gray(ref), mask, mask, feats, cur, ref, pre);
          if (d.inliers > 1.5 * h.inliers || (h.rough && !d.rough && d.inliers >= 20)) { Hm = d.H; best = d.inliers; pairs = { src: d.src || [], dst: d.dst || [] }; h = d; }
        }
        const r = eccRefine(cv, gray(cur), gray(ref), Hm, mask, pairs, repeating, h.rough, big, pre);
        if (h.rough && r.ok) logs.push(`photo ${cur + 1}: framed well apart from the others; lined up by its overall shape first`);
        Hs.set(cur, r.H); done.push([cur, r.H, best, r.ok || !!r.skipped]);
        logs.push(`photo ${cur + 1}: ${best} matches${r.skipped ? '' : `, fine-tune ${r.ok ? 'ok' : 'skipped'}`}`);
        prev = cur; pos += dir;
        report(++k / Math.max(1, steps));
      }
      mask.delete(); grays.forEach(g => g.delete()); feats.forEach(f => f.d.delete());
      return { done, logs };
    },
    /** a photo warped onto the reference, a band of rows at a time, into a.img (and its mask into a.msk) */
    warp(cv, a) {
      const { W, H } = a, src = unpark(cv, a.src), mask = unpark(cv, a.mask);
      for (let y0 = 0; y0 < H; y0 += BAND) {
        const y1 = Math.min(H, y0 + BAND), M = cv.matFromArray(3, 3, cv.CV_64F, mul3([1, 0, 0, 0, 1, -y0, 0, 0, 1], a.Hm));
        // bicubic: as sharp as Lanczos here (no visible difference on real stacks; closer to the
        // truth on every synthetic scene, with less ringing on noise) at a quarter of the cost
        const wp = new cv.Mat(); cv.warpPerspective(src, wp, M, new cv.Size(W, y1 - y0), cv.INTER_CUBIC, cv.BORDER_REFLECT);
        parkRows(a.img, y0, wp); wp.delete();
        const wm = new cv.Mat(); cv.warpPerspective(mask, wm, M, new cv.Size(W, y1 - y0), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
        parkRows(a.msk, y0, wm); wm.delete();
        M.delete();
      }
      src.delete(); mask.delete();
      return null;
    },
    /** local correction of one photo against the reference: where it can be trusted (half size,
        8-bit) and, if the correction helps, the corrected photo, grey and mask */
    flow(cv, a) {
      const { W, H, hw, hh } = a, rc = refCacheFor(cv, a.wgRef, a.key, hw, hh);
      const wmRef = unpark(cv, a.wmRef), wmCur = unpark(cv, a.wm);
      const both = new cv.Mat(); cv.bitwise_and(wmRef, wmCur, both); wmRef.delete();
      const curF = Fp(cv, a.wg), curH = halfOf(cv, curF, hw, hh);
      const plain = ghostHalf(cv, rc.blurHalf, curH);
      // the flow stays at its working size (~1100 px); full-size values are made a band of
      // rows at a time, only where they are used
      const fl = denseFlow(cv, rc, curF, both);
      const field = flowField(fl, gateFlow(cv, fl, rc, curF));
      const share = field.movedShare(both);
      let candG = null;
      if (share > 0) {
        candG = new cv.Mat(H, W, cv.CV_32F);
        field.remap(cv, curF, cv.INTER_LINEAR, (y0, m) => candG.data32F.set(m.data32F, y0 * W));
      }
      const mH = halfMask(cv, both, rc), nccG = nccWith(cv, rc, curF, curH, mH);
      curF.delete(); curH.delete();
      const nccF = candG ? nccWith(cv, rc, candG, null, mH) : -1;
      mH.delete();
      const res = { share, nccG, nccF, accepted: false };
      if (candG && nccF >= nccG + 0.002) {
        res.accepted = true;
        const wsrc = unpark(cv, a.img); res.rgb = new Uint8Array(W * H * 3);
        field.remap(cv, wsrc, cv.INTER_LANCZOS4, (y0, m) => res.rgb.set(m.data, y0 * W * 3)); wsrc.delete();
        const g8 = new cv.Mat(); candG.convertTo(g8, cv.CV_8U, 255); res.g8 = new Uint8Array(g8.data); g8.delete();
        const mf = new cv.Mat(); wmCur.convertTo(mf, cv.CV_32F); res.m8 = new Uint8Array(W * H);
        field.remap(cv, mf, cv.INTER_LINEAR, (y0, mr) => {
          const mb = new cv.Mat(); cv.threshold(mr, mb, 0.5, 1, cv.THRESH_BINARY);
          const b8 = new cv.Mat(); mb.convertTo(b8, cv.CV_8U); mb.delete(); res.m8.set(b8.data, y0 * W); b8.delete();
        });
        mf.delete();
      }
      if (candG) candG.delete();
      const fbH = new cv.Mat(); cv.resize(fl.fb, fbH, new cv.Size(hw, hh), 0, 0, cv.INTER_LINEAR); fl.fs.delete(); fl.fb.delete();
      const T = fbH.data32F, P = plain.data32F;
      for (let q = 0; q < T.length; q++) T[q] = Math.max(T[q], P[q]);
      const t8 = new cv.Mat(); fbH.convertTo(t8, cv.CV_8U, 255, 0.5); res.trust = new Uint8Array(t8.data); t8.delete();
      fbH.delete(); plain.delete(); both.delete(); wmCur.delete();
      return res;
    },
    /** one photo's measurements for choosing which photos to use: thumbnails for the near-duplicate
        check, its agreement with the reference (m, sm), what it may contribute (usable, half size,
        8-bit) and its sharpness times that at quarter size (for "adds nothing sharp") */
    select(cv, a) {
      const { hw, hh, qs } = a, rc = refCacheFor(cv, a.wgRef, a.key, hw, hh);
      const quarter = m => { const o = new cv.Mat(); cv.resize(m, o, new cv.Size(0, 0), qs, qs, m.type() === cv.CV_8U ? cv.INTER_NEAREST : cv.INTER_AREA); return o; };
      const gF = Fp(cv, a.wg), thumb = quarter(gF), wmi = unpark(cv, a.wm), mT = quarter(wmi);
      const fT = focusMeasure(cv, thumb, 2), bT = nccBand(cv, thumb, 1);
      const res = { maskT: new Uint8Array(mT.data), sharpT: cv.mean(fT)[0], bandT: Float32Array.from(bT.data32F), focusT: Float32Array.from(fT.data32F) };
      mT.delete(); bT.delete(); thumb.delete();
      const curH = halfOf(cv, gF, hw, hh); gF.delete();
      const g = ghostHalf(cv, rc.blurHalf, curH), cover = coverMap(cv, wmi, hw, hh); wmi.delete();
      if (a.judge) { res.m = maskedMean(g.data32F, cover.data32F); res.sm = subjectAgreement(cv, rc.half, curH, g, cover); }
      curH.delete();
      const tm = unpark(cv, a.trust), U = g.data32F, C = cover.data32F, T = tm.data;
      for (let q = 0; q < U.length; q++) U[q] *= C[q] * T[q] / 255;
      tm.delete(); cover.delete();
      const u8 = new cv.Mat(); g.convertTo(u8, cv.CV_8U, 255); g.delete();
      res.usable = new Uint8Array(u8.data);
      const uF = f32(cv, u8); u8.delete();
      const gh = new cv.Mat(); cv.resize(uF, gh, new cv.Size(fT.cols, fT.rows), 0, 0, cv.INTER_AREA); uF.delete();
      cv.multiply(fT, gh, fT); gh.delete();
      res.wf = Float32Array.from(fT.data32F); fT.delete();
      return res;
    },
    /** one lined-up photo cropped and finished like the stack, for the retouch brush */
    exportFrame(cv, a) {
      const u8 = unpark(cv, a.usable), uF = f32(cv, u8); u8.delete();
      const fr = exportFrame(cv, a.img, a.g8, uF, a.box, a.info, a.sharpen); uF.delete();
      return fr;
    },
    /** one photo's sharpest fine detail at every 7th pixel (texture thresholds for the merge) */
    texture(cv, a) {
      const { W, H } = a, texS = new Float32Array(Math.ceil(W * H / 7));
      for (const { y0, y1 } of a.spans) {
        const lo = Math.max(0, y0 - 16), hi = Math.min(H, y1 + 16);
        const im = unpark(cv, a.img, lo, hi), g = toGray(cv, im); im.delete();
        const f2 = focusMeasure(cv, g, 2), T = f2.data32F; g.delete();
        const V = STORE.get(a.valid.h, y0 * W, (y1 - y0) * W);
        for (let y = y0; y < y1; y++) {
          let k = y * W, k7 = Math.ceil(k / 7) * 7;                   // global index, multiples of 7 only
          const rowEnd = k + W;
          for (; k7 < rowEnd; k7 += 7) { const x = k7 - y * W, t = T[(y - lo) * W + x]; if (V[(y - y0) * W + x] && t > texS[k7 / 7]) texS[k7 / 7] = t; }
        }
        f2.delete();
      }
      return texS;
    },
    /** one photo's noise level in each fine band, from rows e0..e1 */
    noise(cv, a) {
      const { W, e0, e1 } = a, out = new Array(FINE).fill(Infinity);
      const im = unpark(cv, a.img, e0, e1), f = new cv.Mat(); im.convertTo(f, cv.CV_32FC3, 1 / 255); im.delete();
      const lp = lapPyr(cv, f, FINE);
      const wc = unpark(cv, a.weights, e0 / 2, Math.ceil(e1 / 2)), wF = f32(cv, wc); wc.delete();
      const gf = new cv.Mat(); cv.resize(wF, gf, new cv.Size(W, e1 - e0), 0, 0, cv.INTER_LINEAR); wF.delete();
      const gg = gaussPyr(cv, gf, FINE, true);
      for (let L = 0; L < FINE; L++) {
        const C2 = lp[L].data32F, G = gg[L].data32F, smp = [];
        for (let k = 0, q = 0; k < G.length; k += 37, q += 111) if (G[k] > 0.5) smp.push(Math.abs(C2[q]) + Math.abs(C2[q + 1]) + Math.abs(C2[q + 2]));
        if (smp.length > 100) { smp.sort((x, y) => x - y); out[L] = smp[smp.length >> 2]; }
      }
      lp.forEach(m => m.delete()); gg.forEach(m => m.delete());
      return out;
    },
    /** one strip merged and sharpened: its finished rows (8-bit) and its cross-fade zones (float) */
    async strip(cv, a, report = () => {}) {
      const { W, H, sp, s, last } = a, { y0, y1, e0, e1 } = sp, CF = STRIP_CF, row = W * 3;
      const views = a.imgs.map(p => pview(p, e0, e1)), vv = a.valid.map(p => pview(p, e0, e1));
      const ws = a.weights.map(p => unpark(cv, p, e0 / 2, Math.ceil(e1 / 2)));
      const fused = await fuseHybrid(cv, views, ws, vv, report, () => Promise.resolve(), null, a.stats);
      ws.forEach(m => m.delete());
      const b = sharpenF(cv, fused, a.sharpen === undefined ? 0.35 : a.sharpen); fused.delete();
      const S = b.data32F;
      const plainStart = s ? y0 + CF : 0, plainEnd = last ? H : y1 - CF;
      const plain = new Uint8Array(Math.max(0, plainEnd - plainStart) * row);
      for (let y = plainStart, o = 0; y < plainEnd; y++) { const src = (y - e0) * row; for (let k = 0; k < row; k++, o++) plain[o] = to8px(S[src + k]); }
      const fin = s ? Float32Array.from(S.subarray((y0 - CF - e0) * row, (y0 + CF - e0) * row)) : null;
      const fout = last ? null : Float32Array.from(S.subarray((y1 - CF - e0) * row, (y1 + CF - e0) * row));
      b.delete();
      return { plain, plainStart, fin, fout };
    }
  };

  /** Runs tasks[name] on each argument set: on the pool's helpers when there is a pool and every
      parked image involved is in shared storage, otherwise here, one by one. onDone(count done,
      result, index) as each finishes. Results in the order given. */
  async function runTasks(cv, pool, name, list, onDone = () => {}, onPart = () => {}, before = null, keep = true) {
    const out = new Array(list.length);
    if (pool && list.every(a => sharedOnly(a))) {
      if (STORE.sync) STORE.sync();                       // what this worker wrote, readable by the helpers
      const limit = Math.max(1, Math.min(pool.size, (pool.limits && pool.limits[name]) || pool.size));
      let done = 0, next = 0;
      const lane = async () => { while (next < list.length) { const i = next++; const r = await pool.run(name, list[i], f => onPart(i, f)); if (keep) out[i] = r; onDone(++done, r, i); } };
      await Promise.all([...Array(Math.min(limit, list.length))].map(lane));
    } else {
      for (let i = 0; i < list.length; i++) {
        if (before) await before(list[i], i);
        const r = await tasks[name](cv, list[i], f => onPart(i, f)); list[i].data = null;
        if (keep) out[i] = r;
        await onDone(i + 1, r, i); await tick();
      }
    }
    return out;
  }
  /** true if no parked image in the arguments was kept in this worker's memory (the scratch
      file was full) */
  function sharedOnly(a) {
    if (!a || typeof a !== 'object') return true;
    if (a.h && typeof a.h === 'object' && 'mem' in a.h) return false;
    for (const k in a) if (typeof a[k] === 'object' && !ArrayBuffer.isView(a[k]) && !sharedOnly(a[k])) return false;
    return true;
  }
  /** The reference's flow-stage products (refCache), made once per worker for each run. */
  let RC = null;
  function refCacheFor(cv, wgRef, key, hw, hh) {
    if (RC && RC.key === key) return RC.rc;
    refCacheFree();
    const f = Fp(cv, wgRef), rc = refCache(cv, f, hw, hh); f.delete();
    RC = { key, rc };
    return rc;
  }
  function refCacheFree() { if (RC) { RC.rc.free(); RC = null; } }

  function normalise(maps, N) {
    const S = new Float32Array(N);
    for (const m of maps) { const d = m.data32F; for (let k = 0; k < N; k++) S[k] += d[k]; }
    for (const m of maps) { const d = m.data32F; for (let k = 0; k < N; k++) d[k] /= S[k]; }
  }

  /** Largest rectangle inside the mask whose shape stays within 15% of the frame's
      own (so a landscape burst isn't cropped to a portrait strip), from the maximal
      rectangles of a 1/f-scale mask. */
  function largestRect(cv, common, f = 4) {
    const W = common.cols, H = common.rows, ar = W / H;
    const e = new cv.Mat(); const k = cv.Mat.ones(f, f, cv.CV_8U); cv.erode(common, e, k); k.delete();
    const w = Math.floor(W / f), h = Math.floor(H / f), D = e.data;
    const heights = new Int32Array(w);
    let best = { a: 0 };
    const consider = (x0, y0, x1, y1) => {
      let cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      if (cw / ch > ar * 1.15) cw = Math.floor(ch * ar * 1.15); else if (cw / ch < ar / 1.15) ch = Math.floor(cw * 1.15 / ar);
      if (cw * ch <= best.a) return;
      const cx = x0 + Math.floor((x1 - x0 + 1 - cw) / 2), cy = y0 + Math.floor((y1 - y0 + 1 - ch) / 2);
      best = { a: cw * ch, x0: cx, y0: cy, x1: cx + cw - 1, y1: cy + ch - 1 };
    };
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) heights[c] = D[r * f * W + c * f] ? heights[c] + 1 : 0;
      const st = [];
      for (let c = 0; c <= w; c++) {
        const cur = c < w ? heights[c] : 0; let start = c;
        while (st.length && st[st.length - 1][1] >= cur) {
          const [s0, ht] = st.pop();
          if (ht > 0) consider(s0, r - ht + 1, c - 1, r);
          start = s0;
        }
        st.push([start, cur]);
      }
    }
    e.delete();
    if (!best.a) return { x: 0, y: 0, w: W, h: H };
    const x = best.x0 * f + f, y = best.y0 * f + f;
    const x1 = Math.min(W - 1, (best.x1 + 1) * f - 1 - f), y1 = Math.min(H - 1, (best.y1 + 1) * f - 1 - f);
    return { x, y, w: x1 - x + 1, h: y1 - y + 1 };
  }

  /** for helper workers: run tasks against their own handle on the shared scratch storage */
  function useStore(store) { STORE = store || MEM_STORE; }
  /** for experiments: the halo guard's first level (LEVELS + 1 = off) and exponent */
  function tune(o) {
    if ('haloFrom' in o) HALO_FROM = o.haloFrom; if ('haloP' in o) HALO_P = o.haloP;
    if ('fill' in o) FILL = o.fill; if ('fillK' in o) FILL_K = o.fillK; if ('fillS' in o) FILL_S = o.fillS;
    if ('spill' in o) SPILL = o.spill; if ('spillTau' in o) SPILL_TAU = o.spillTau; if ('spillR' in o) SPILL_R = o.spillR;
  }
  const api = { tune, stackFrames, planSize, heapNeedMiB, tasks, useStore, refCacheFree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SalticidStacker = api;
})(typeof self !== 'undefined' ? self : this);
