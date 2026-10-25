/* Salticid stacker engine — browser/Node port of stacker.py (OpenCV.js).
   stackFrames(cv, frames, opts) -> {data: Uint8ClampedArray (RGBA), width, height, log, ref}
   frames: [{data: Uint8ClampedArray RGBA, width, height, taken?}]
           taken: optional capture time in ms (EXIF or file name); photos taken
           well apart from the rest are checked harder for a moved subject.
   opts: maxSide, onProgress(p, stage), onLog(msg), onSelection({used, left}),
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

  async function run(cv, frames, opts) {
    const progress = opts.onProgress || (() => {});
    const log = [];
    const say = m => { log.push(m); if (opts.onLog) opts.onLog(m); };
    const maxSide = opts.maxSide || 3000;
    const n = frames.length;
    if (n < 2) throw new Error('Add at least 2 photos of the same subject.');
    const trash = [];
    const hold = m => { trash.push(m); return m; };
    const free = (...ms) => ms.forEach(m => { if (m && !m.isDeleted()) m.delete(); });
    const sz = (w, h) => new cv.Size(w, h);

    // ---------- 1. load: RGBA -> RGB float-free 8-bit, common size ----------
    let W = 0, H = 0;
    for (const f of frames) {
      const s = Math.min(1, maxSide / Math.max(f.width, f.height));
      W = Math.max(W, Math.round(f.width * s)); H = Math.max(H, Math.round(f.height * s));
    }
    const rgb = [], gray = [];
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const rgba = cv.matFromArray(f.height, f.width, cv.CV_8UC4, f.data);
      const c3 = new cv.Mat(); cv.cvtColor(rgba, c3, cv.COLOR_RGBA2RGB); rgba.delete();
      if (c3.cols !== W || c3.rows !== H) {
        const r = new cv.Mat(); cv.resize(c3, r, sz(W, H), 0, 0, (c3.cols > W ? cv.INTER_AREA : cv.INTER_CUBIC));
        c3.delete(); rgb.push(r);
      } else rgb.push(c3);
      gray.push(toGray(cv, rgb[i]));
      f.data = null;                                   // let the browser reclaim the decode
      progress(0.02 + 0.06 * (i + 1) / n, 'Reading photos');
      await tick();
    }
    say(`${n} photos, working size ${W}×${H}`);

    // ---------- 2. masks, order, reference ----------
    const masks = vignetteMasks(cv, gray);
    const order = orderFrames(cv, gray);
    const cy0 = Math.floor(H * .3), cy1 = Math.floor(H * .7), cx0 = Math.floor(W * .3), cx1 = Math.floor(W * .7);
    const moment = moments(frames);
    if (moment.split) say(`taken at ${moment.groups} different moments (more than ${MOMENT_GAP / 1000} s apart)`);
    let ref = 0, best = -1;
    for (let i = 0; i < n; i++) {
      if (moment.apart[i]) continue;                   // the reference comes from the main burst
      const roi = gray[i].roi(new cv.Rect(cx0, cy0, cx1 - cx0, cy1 - cy0));
      const f = focusMeasure(cv, roi, 4); const v = cv.mean(f)[0]; f.delete(); roi.delete();
      if (v > best) { best = v; ref = i; }
    }
    const refPos = order.indexOf(ref);
    const repeating = gray.some(g => repeatScore(cv, g) > REPEAT);
    if (repeating) say('repeating texture in view (a mesh?): lined up from features only');
    say(`focus order ${order.map(o => o + 1).join(' ')}, reference photo ${ref + 1}`);
    progress(0.12, 'Working out focus order');
    await tick();

    // ---------- 3. global alignment ----------
    const srcPx = frames.map(f => f.srcPixels || f.width * f.height);
    const Hs = new Array(n); Hs[ref] = eye3();
    const inl = new Array(n).fill(9999), eccOk = new Array(n).fill(true);
    const feats = new Map();                          // each photo's features, found once
    let done = 0;
    for (const dir of [-1, 1]) {
      let prev = ref, pos = refPos + dir;
      while (pos >= 0 && pos < n) {
        const cur = order[pos];
        let a = homography(cv, gray[cur], gray[prev], masks[cur], masks[prev], feats, cur, prev);
        let Hm = mul3(Hs[prev], a.H), best = a.inliers;
        // the matched features, in reference coordinates: the fine-tune must still agree with them
        let pairs = { src: a.src || [], dst: (a.dst || []).map((v, j, D) => j % 2 ? null : applyH(Hs[prev], v, D[j + 1])).filter(Boolean).flat() };
        if (prev !== ref) {
          const d = homography(cv, gray[cur], gray[ref], masks[cur], masks[ref], feats, cur, ref);
          if (d.inliers > 1.5 * a.inliers || (a.rough && !d.rough && d.inliers >= 20)) { Hm = d.H; best = d.inliers; pairs = { src: d.src || [], dst: d.dst || [] }; a = d; }
        }
        const r = eccRefine(cv, gray[cur], gray[ref], Hm, masks[ref], pairs, repeating, a.rough);
        if (a.rough && r.ok) say(`photo ${cur + 1}: framed well apart from the others; lined up by its overall shape first`);
        Hs[cur] = r.H; inl[cur] = best; eccOk[cur] = r.ok || !!r.skipped;
        say(`photo ${cur + 1}: ${best} matches${r.skipped ? '' : `, fine-tune ${r.ok ? 'ok' : 'skipped'}`}`);
        prev = cur; pos += dir; done++;
        progress(0.12 + 0.33 * done / (n - 1), 'Lining up photos');
        await tick();
      }
    }
    feats.forEach(f => f.d.delete()); feats.clear();
    const warped = new Array(n), wmask = new Array(n);
    for (let i = 0; i < n; i++) {
      const M = cv.matFromArray(3, 3, cv.CV_64F, Hs[i]);
      warped[i] = new cv.Mat(); cv.warpPerspective(rgb[i], warped[i], M, sz(W, H), cv.INTER_LANCZOS4, cv.BORDER_REFLECT);
      wmask[i] = new cv.Mat(); cv.warpPerspective(masks[i], wmask[i], M, sz(W, H), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete(); rgb[i].delete();
    }
    gray.forEach(g => g.delete()); masks.forEach(m => m.delete());

    // ---------- 3b. coverage ----------
    // A photo framed differently covers only part of the reference's view. Where it
    // has no pixels of its own it is filled from the photos that do, so its pyramid
    // has no false edges there; its weight is zero there (coverage maps, below).
    const covShare = fillUncovered(cv, warped, wmask, ref);
    covShare.forEach((c, i) => { if (i !== ref && c < 0.97) say(`photo ${i + 1}: covers ${Math.round(c * 100)}% of the reference's view`); });
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);

    // ---------- 4. local alignment, decided pixel by pixel ----------
    // The flow is worked out both ways (reference → photo and back). Where the two
    // agree, the correction is used; where they don't (an occlusion, a repeating
    // mesh, a moved leg) that spot keeps the plain line-up. trust[i] marks where the
    // photo can be believed: the two-way check passed, or the plain line-up already
    // agreed with the reference there.
    const wg = warped.map(m => toGray(cv, m));
    if (opts.onDebug) opts.onDebug('lined', { ref, width: W, height: H, grays: wg.map(g => Float32Array.from(g.data32F)), Hs: Hs.map(h => h.slice()) });
    const trust = new Array(n).fill(null);
    const refBlur = new cv.Mat(); cv.GaussianBlur(wg[ref], refBlur, sz(0, 0), 6, 6);
    done = 0;
    for (let k = 0; k < n; k++) {
      const cur = order[k];
      if (cur === ref) continue;
      const both = new cv.Mat(); cv.bitwise_and(wmask[ref], wmask[cur], both);
      const plain = ghostMap(cv, refBlur, wg[cur], hw, hh);
      const { flow, fb } = denseFlow(cv, wg[ref], wg[cur], both);
      gateFlow(cv, flow, wg[ref], wg[cur]);
      const share = movedShare(flow, both);
      const maps = share > 0 ? flowMaps(cv, flow) : null;          // built once, used for every remap below
      const candG = maps ? remapWith(cv, wg[cur], maps, cv.INTER_LINEAR) : null;
      const nccG = bandNCC(cv, wg[ref], wg[cur], both), nccF = candG ? bandNCC(cv, wg[ref], candG, both) : -1;
      if (candG && nccF >= nccG + 0.002) {
        const cand = remapWith(cv, warped[cur], maps, cv.INTER_LANCZOS4);
        warped[cur].delete(); warped[cur] = cand;
        wg[cur].delete(); wg[cur] = candG;
        const mf = new cv.Mat(); wmask[cur].convertTo(mf, cv.CV_32F);
        const mr = remapWith(cv, mf, maps, cv.INTER_LINEAR); mf.delete();
        const mb = new cv.Mat(); cv.threshold(mr, mb, 0.5, 1, cv.THRESH_BINARY); mr.delete();
        wmask[cur].delete(); wmask[cur] = new cv.Mat(); mb.convertTo(wmask[cur], cv.CV_8U); mb.delete();
        say(`photo ${cur + 1}: local correction on ${Math.max(1, Math.round(share * 100))}% of it (${nccG.toFixed(3)} → ${nccF.toFixed(3)})`);
      } else {
        if (candG) candG.delete();
        say(`photo ${cur + 1}: local correction not needed`);
      }
      const fbH = new cv.Mat(); cv.resize(fb, fbH, sz(hw, hh), 0, 0, cv.INTER_LINEAR); fb.delete();
      const T = fbH.data32F, P = plain.data32F;
      for (let q = 0; q < T.length; q++) T[q] = Math.max(T[q], P[q]);
      trust[cur] = new cv.Mat(); fbH.convertTo(trust[cur], cv.CV_8U, 255, 0.5);   // 8-bit: phones are short of memory
      fbH.delete(); plain.delete();
      if (maps) { maps[0].delete(); maps[1].delete(); }
      flow.delete(); both.delete(); done++;
      progress(0.45 + 0.2 * done / (n - 1), 'Correcting movement');
      await tick();
    }
    refBlur.delete();
    trust[ref] = new cv.Mat(hh, hw, cv.CV_8U, new cv.Scalar(255));
    if (opts.onDebug) opts.onDebug('flowed', { ref, width: W, height: H, grays: wg.map(g => Float32Array.from(g.data32F)), trust: trust.map(t => Float32Array.from(t.data, v => v / 255)), hw, hh });

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
    // (b) near-duplicates: keep the higher-resolution (then sharper) copy.
    //     Compared only where both photos have pixels of their own.
    const quarter = m => { const s = new cv.Mat(); cv.resize(m, s, new cv.Size(0, 0), 0.25, 0.25, m.type() === cv.CV_8U ? cv.INTER_NEAREST : cv.INTER_AREA); return s; };
    const thumbs = wg.map(quarter), maskT = wmask.map(quarter);
    const sharpT = thumbs.map(t => { const f = focusMeasure(cv, t, 2); const v = cv.mean(f)[0]; f.delete(); return v; });
    const focusT = thumbs.map(t => focusMeasure(cv, t, 2));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (!keep[i] || !keep[j]) continue;
      const bothT = new cv.Mat(); cv.bitwise_and(maskT[i], maskT[j], bothT);
      const overlap = cv.countNonZero(bothT) / (bothT.rows * bothT.cols);
      const c = overlap > 0.3 ? bandNCC(cv, thumbs[i], thumbs[j], bothT) : 0;
      // same picture AND same focus: with a steady camera, neighbouring focus slices
      // look alike at this size, but they are sharp in different places
      // ...AND same framing: two separate shots at the same focus but framed apart
      // are not duplicates; they cover different ground and their detail can be merged
      if (c > 0.985 && sameFraming(Hs[i], Hs[j], W, H) && sameFocus(focusT[i].data32F, focusT[j].data32F, bothT.data)) {
        const better = (srcPx[i] > srcPx[j] * 1.1) ? i : (srcPx[j] > srcPx[i] * 1.1) ? j : (sharpT[i] >= sharpT[j] ? i : j);
        const worse = better === i ? j : i;
        if (worse !== ref) { keep[worse] = false; why[worse] = `near-duplicate of photo ${better + 1}`; }   // never drop the reference
      }
      bothT.delete();
    }
    thumbs.forEach(t => t.delete()); maskT.forEach(t => t.delete()); focusT.forEach(t => t.delete());
    // (c) photos that disagree with the reference almost everywhere they overlap (subject moved a lot).
    // usable[i]: what each photo may contribute, pixel by pixel (half size): it agrees with
    // the reference there (ghost), has pixels of its own there (coverage, fading to 0 over a
    // short band at its edge so a photo that ends mid-frame leaves no seam), and its
    // line-up can be trusted there (trust).
    const refG6 = new cv.Mat(); cv.GaussianBlur(wg[ref], refG6, sz(0, 0), 6, 6);
    const usable = new Array(n);
    for (let i = 0; i < n; i++) {
      const g = ghostMap(cv, refG6, wg[i], hw, hh), cover = coverMap(cv, wmask[i], hw, hh);
      if (keep[i] && i !== ref) {
        const m = maskedMean(g.data32F, cover.data32F);
        const sm = subjectAgreement(cv, wg[ref], wg[i], g, cover);
        const gap = moment.apart[i];
        if (opts.keepAll) { /* test hook: judge nothing here */ }
        else if (m < 0.25) { keep[i] = false; why[i] = 'the spider moved too much in it'; }
        else if (sm < SUBJECT_MOVED) { keep[i] = false; why[i] = gap ? `taken ${gapText(gap)} the others, and the subject had moved` : 'the subject moved between photos'; }
        else if (gap && sm < SUBJECT_MOVED_APART) { keep[i] = false; why[i] = `taken ${gapText(gap)} the others, and the subject had moved a little`; }
        else if (gap) say(`photo ${i + 1}: taken ${gapText(gap)} the others but lines up well, kept`);
      }
      const U = g.data32F, C = cover.data32F, T = trust[i].data;
      for (let q = 0; q < U.length; q++) U[q] *= C[q] * T[q] / 255;
      usable[i] = g; cover.delete(); trust[i].delete(); trust[i] = null;
    }
    refG6.delete();
    let idx = [...Array(n).keys()].filter(i => keep[i]);
    // (d) photos that add no sharp detail the others don't already have
    const share = winnerShare(cv, idx.map(i => wg[i]), idx.map(i => usable[i]));
    if (idx.length > 2) idx.forEach((i, k) => {
      if (i !== ref && share[k] < 0.003) { keep[i] = false; why[i] = 'adds nothing sharp the others lack'; }
    });
    idx = [...Array(n).keys()].filter(i => keep[i]);
    const left = [...Array(n).keys()].filter(i => !keep[i]);
    left.forEach(i => say(`photo ${i + 1} left out: ${why[i]}`));
    if (opts.onSelection) opts.onSelection({ used: idx.map(i => i + 1), left: left.map(i => ({ photo: i + 1, why: why[i] })) });
    say(`using ${idx.length} of ${n} photos`);

    // crop: everything at least one used photo really saw (not just what all of them saw)
    const seen = wmask[idx[0]].clone();
    for (const i of idx.slice(1)) cv.bitwise_or(seen, wmask[i], seen);
    const box = largestRect(cv, seen); seen.delete();

    // ---------- 5b. hand the lined-up photos to the retouch brush ----------
    // Each is cropped and finished exactly like the stack, so painted pixels match.
    // Photos that could not be lined up are not offered.
    if (opts.onFrame) {
      const offer = [...Array(n).keys()].filter(i => keep[i] || !/lined up/.test(why[i]));
      for (let k = 0; k < offer.length; k++) {
        const i = offer[k];
        await opts.onFrame(exportFrame(cv, warped[i], wg[i], usable[i], box, {
          photo: i + 1, used: keep[i], why: why[i], ref: i === ref
        }));
        progress(0.65 + 0.03 * (k + 1) / offer.length, 'Keeping photos for retouching');
      }
    }
    for (const i of left) { warped[i].delete(); wg[i].delete(); usable[i].delete(); wmask[i].delete(); }
    const keptImgs = idx.map(i => warped[i]), keptGray = idx.map(i => wg[i]), weights = idx.map(i => usable[i]), keptMask = idx.map(i => wmask[i]);
    progress(0.67, 'Merging');
    await tick();

    // ---------- 6. hybrid fusion ----------
    keptGray.forEach(m => m.delete());
    const debug = opts.onDebug ? (name, d) => opts.onDebug(name, Object.assign({ photos: idx.map(i => i + 1), box }, d)) : null;
    const fused = await fuseHybrid(cv, keptImgs, weights, keptMask, p => progress(0.67 + 0.28 * p, 'Merging'), tick, debug);
    keptImgs.forEach(m => m.delete()); weights.forEach(m => m.delete()); keptMask.forEach(m => m.delete());

    // ---------- 7. finish ----------
    const b = new cv.Mat(); cv.GaussianBlur(fused, b, sz(0, 0), 1.2, 1.2);
    const sharp = new cv.Mat(); cv.addWeighted(fused, 1.35, b, -0.35, 0, sharp); b.delete(); fused.delete();
    const crop = sharp.roi(new cv.Rect(box.x, box.y, box.w, box.h));
    const u8 = new cv.Mat(); crop.convertTo(u8, cv.CV_8U, 255, 0.5); crop.delete(); sharp.delete();
    const rgba = new cv.Mat(); cv.cvtColor(u8, rgba, cv.COLOR_RGB2RGBA); u8.delete();
    const out = { data: new Uint8ClampedArray(rgba.data), width: rgba.cols, height: rgba.rows, log, ref: ref + 1 };
    rgba.delete();
    trash.forEach(m => free(m));
    progress(1, 'Done');
    say(`result ${out.width}×${out.height}`);
    return out;
  }

  // ---------- photo-selection thresholds ----------
  const MOMENT_GAP = 2000;          // ms between consecutive photos that starts a new "moment"
  const WEAK_MATCH = 0.25;          // fewer than this share of the best photo's matches, and no fine-tune
  const SUBJECT_MOVED = 0.65;       // subject agreement below this: moved (real bursts 0.96+, a photo shot from a step to the side 0.76, weevil 0.38)
  const SUBJECT_MOVED_APART = 0.95; // stricter for photos from a different moment
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
  /** One lined-up photo, cropped and sharpened like the stack, plus a small
      map of where it is sharp (and agrees with the reference) for "sharpest here". */
  function exportFrame(cv, img8, gray, ghostHalf, box, info) {
    const W = img8.cols, H = img8.rows, m = 8;
    const x0 = Math.max(0, box.x - m), y0 = Math.max(0, box.y - m);
    const x1 = Math.min(W, box.x + box.w + m), y1 = Math.min(H, box.y + box.h + m);
    const big = img8.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const bl = new cv.Mat(); cv.GaussianBlur(big, bl, new cv.Size(0, 0), 1.2, 1.2);
    const sh = new cv.Mat(); cv.addWeighted(big, 1.35, bl, -0.35, 0, sh); bl.delete(); big.delete();
    const c = sh.roi(new cv.Rect(box.x - x0, box.y - y0, box.w, box.h));
    const rgba = new cv.Mat(); cv.cvtColor(c, rgba, cv.COLOR_RGB2RGBA); c.delete(); sh.delete();
    // sharpness map at 1/8 size, weighted down where the spider moved
    const g = gray.roi(new cv.Rect(box.x, box.y, box.w, box.h));
    const f = focusMeasure(cv, g, 4); g.delete();
    const fw = Math.ceil(box.w / 8), fh = Math.ceil(box.h / 8);
    const fs = new cv.Mat(); cv.resize(f, fs, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA); f.delete();
    const gh = ghostHalf.roi(new cv.Rect(Math.floor(box.x / 2), Math.floor(box.y / 2),
      Math.min(ghostHalf.cols - Math.floor(box.x / 2), Math.ceil(box.w / 2)), Math.min(ghostHalf.rows - Math.floor(box.y / 2), Math.ceil(box.h / 2))));
    const gs = new cv.Mat(); cv.resize(gh, gs, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA); gh.delete();
    cv.multiply(fs, gs, fs); gs.delete();
    const res = Object.assign({}, info, {
      width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data),
      focus: { width: fw, height: fh, data: new Float32Array(fs.data32F) }
    });
    rgba.delete(); fs.delete();
    return res;
  }


  /** How well a photo agrees with the reference where either of them is sharp
      (the subject), 0..1. The frame-wide mean is dominated by background, so a
      small subject that walked off barely moves it; this weights by sharpness. */
  function subjectAgreement(cv, refG, curG, ghostHalf, coverHalf) {
    const sz = new cv.Size(ghostHalf.cols, ghostHalf.rows);
    const half = g => { const s = new cv.Mat(); cv.resize(g, s, sz, 0, 0, cv.INTER_AREA); const f = focusMeasure(cv, s, 3); s.delete(); return f; };
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

  function focusMeasure(cv, g, sigma) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 0.8, 0.8);
    const l = new cv.Mat(); cv.Laplacian(b, l, cv.CV_32F, 3); b.delete();
    cv.multiply(l, l, l);
    const o = new cv.Mat(); cv.GaussianBlur(l, o, new cv.Size(0, 0), sigma, sigma); l.delete();
    return o;
  }

  /** Where each photo has usable pixels (1) vs the black clamp edge of a clip-on
      lens (0). A dark region touching the frame edge is the clamp only if it is
      nearly black inside and, when there are enough photos, sits in the same place
      in most of them: the clamp moves with the camera, a dark subject (a black
      caterpillar crossing the frame edge) does not. */
  function vignetteMasks(cv, grays) {
    const n = grays.length, W = grays[0].cols, H = grays[0].rows;
    const q = 4, qw = Math.max(8, Math.round(W / q)), qh = Math.max(8, Math.round(H / q)), N = qw * qh;
    const labs = [], vals = [], edges = [];
    const frac = new Float32Array(N);
    for (const g of grays) {
      const s = new cv.Mat(); cv.resize(g, s, new cv.Size(qw, qh), 0, 0, cv.INTER_AREA);
      const b = new cv.Mat(); cv.GaussianBlur(s, b, new cv.Size(0, 0), 15 / q, 15 / q);
      const dark = new cv.Mat(); cv.threshold(b, dark, 0.12, 1, cv.THRESH_BINARY_INV); b.delete();
      const d8 = new cv.Mat(); dark.convertTo(d8, cv.CV_8U); dark.delete();
      const lab = new cv.Mat(); const nl = cv.connectedComponents(d8, lab); d8.delete();
      const L = Int32Array.from(lab.data32S); lab.delete();
      const edge = new Uint8Array(nl);
      for (let x = 0; x < qw; x++) { edge[L[x]] = 1; edge[L[(qh - 1) * qw + x]] = 1; }
      for (let y = 0; y < qh; y++) { edge[L[y * qw]] = 1; edge[L[y * qw + qw - 1]] = 1; }
      edge[0] = 0;
      for (let k = 0; k < N; k++) if (edge[L[k]]) frac[k] += 1 / n;
      labs.push(L); vals.push(Float32Array.from(s.data32F)); edges.push(edge); s.delete();
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const L = labs[i], V = vals[i], edge = edges[i];
      // per edge-touching dark region: its median brightness and how consistently it is there
      const bins = new Map();
      for (let k = 0; k < N; k++) {
        const c = L[k]; if (!edge[c]) continue;
        let r = bins.get(c); if (!r) { r = { v: [], f: 0, a: 0 }; bins.set(c, r); }
        if (r.a % 3 === 0) r.v.push(V[k]);
        r.f += frac[k]; r.a++;
      }
      const isClamp = new Uint8Array(edge.length);
      for (const [c, r] of bins) {
        r.v.sort((x, y) => x - y);
        const med = r.v[r.v.length >> 1], steady = r.f / r.a;
        isClamp[c] = (med < 0.035 || (med < 0.06 && (n < 4 || steady >= 0.6))) ? 1 : 0;
        if (n >= 4 && steady < 0.6) isClamp[c] = 0;
      }
      const mq = new cv.Mat(qh, qw, cv.CV_8U), M = mq.data;
      for (let k = 0; k < N; k++) M[k] = isClamp[L[k]] ? 0 : 1;
      const m = new cv.Mat(); cv.resize(mq, m, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST); mq.delete();
      // keep well clear of the clamp: its edge is soft (an out-of-focus lens barrel)
      const r = Math.max(31, Math.round(0.025 * Math.max(W, H))) | 1;
      const k = cv.Mat.ones(r, r, cv.CV_8U); cv.erode(m, m, k); k.delete();
      out.push(m);
    }
    return out;
  }

  /** Fills the part of each lined-up photo that lies outside its own pixels with
      the average of the photos that do have pixels there (the reference where
      nobody does), so pyramids see no false edges at a photo's border.
      Returns, per photo, the share of the reference's view it covers. */
  function fillUncovered(cv, warped, wmask, ref) {
    const n = warped.length, N = warped[0].rows * warped[0].cols;
    const sum = new Float32Array(N * 3), cnt = new Uint8Array(N);
    for (let i = 0; i < n; i++) {
      const D = warped[i].data, M = wmask[i].data;
      for (let k = 0, p = 0; k < N; k++, p += 3) if (M[k]) { sum[p] += D[p]; sum[p + 1] += D[p + 1]; sum[p + 2] += D[p + 2]; cnt[k]++; }
    }
    const R = warped[ref].data, MR = wmask[ref].data;
    let refArea = 0; for (let k = 0; k < N; k++) if (MR[k]) refArea++;
    const share = new Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const D = warped[i].data, M = wmask[i].data;
      let both = 0;
      for (let k = 0, p = 0; k < N; k++, p += 3) {
        if (M[k]) { if (MR[k]) both++; continue; }
        if (cnt[k]) { const c = cnt[k]; D[p] = sum[p] / c + 0.5; D[p + 1] = sum[p + 1] / c + 0.5; D[p + 2] = sum[p + 2] / c + 0.5; }
        else if (i !== ref) { D[p] = R[p]; D[p + 1] = R[p + 1]; D[p + 2] = R[p + 2]; }
      }
      share[i] = refArea ? both / refArea : 1;
    }
    return share;
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

  /** Share of a photo's overlap that the local correction actually moves (> 0.5 px). */
  function movedShare(flow, mask) {
    const F = flow.data32F, M = mask.data;
    let a = 0, m = 0;
    for (let k = 0; k < M.length; k++) {
      if (!M[k]) continue; a++;
      if (F[2 * k] * F[2 * k] + F[2 * k + 1] * F[2 * k + 1] > 0.25) m++;
    }
    return a ? m / a : 0;
  }

  function orderFrames(cv, grays) {
    const n = grays.length;
    if (n < 3) return [...Array(n).keys()];
    const V = grays.map(g => {
      const s = new cv.Mat(); cv.resize(g, s, new cv.Size(512, 384), 0, 0, cv.INTER_AREA);
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
  function features(cv, cache, i, g, m) {
    if (cache && cache.has(i)) return cache.get(i);
    const s = Math.min(1, 1600 / Math.max(g.cols, g.rows));
    const r = new cv.Mat(); cv.resize(g, r, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    const u = to8(cv, r); r.delete();
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

  function homography(cv, srcG, dstG, mSrc, mDst, cache, iSrc, iDst) {
    // features on a downscaled copy (speed), H rescaled to full size
    const F1 = features(cv, cache, iSrc, srcG, mSrc), F2 = features(cv, cache, iDst, dstG, mDst);
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
  function eccRefine(cv, srcG, dstG, H, mask, pairs, repeating, rough) {
    if (repeating) return { H, ok: false, skipped: true };
    const big = Math.max(srcG.cols, srcG.rows);
    if (rough) {
      // a rough start (photo framed far from the rest): first line up the overall shapes,
      // blurred enough that focus differences don't matter, then the usual fine-tune
      const c = eccStage(cv, srcG, dstG, H, mask, Math.min(0.25, 500 / big), 0.006 * big);
      if (c && (!pairs || pairError(c, pairs) < Math.max(12, 0.012 * big))) H = c;
      else return { H, ok: false };
    }
    // half size first (a quarter of the work per step, most of the steps), then a few
    // steps at the working size; each stops once the change is under 1e-5
    const half = eccStage(cv, srcG, dstG, H, mask, Math.min(0.25, 550 / big), 2, 100);
    const Hn = eccStage(cv, srcG, dstG, half || H, mask, Math.min(0.5, 1100 / big), 2, 25);
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

  function eccStage(cv, srcG, dstG, H, mask, scale, sigma, iters = 100) {
    // shrink first, then gradients at that size (blur scaled to match): same result, a
    // fraction of the work
    const s0 = new cv.Mat(), d0 = new cv.Mat(), m = new cv.Mat();
    cv.resize(srcG, s0, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.resize(dstG, d0, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
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

  function denseFlow(cv, refG, movG, mask) {
    // Farneback at reduced size on defocus-equalised images, then masked
    // normalised-convolution smoothing and clamping (mirrors stacker.py).
    const W = refG.cols, H = refG.rows;
    const s = Math.min(1, 1100 / Math.max(W, H));
    const prep = g => {
      const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 2.5, 2.5);
      const r = new cv.Mat(); cv.resize(b, r, new cv.Size(Math.round(W * s), Math.round(H * s)), 0, 0, cv.INTER_AREA); b.delete();
      const u = to8(cv, r); r.delete(); return u;
    };
    const a = prep(refG), b = prep(movG);
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
    // passes; the flow is smoothed by it (normalised convolution). All at the working size,
    // then brought up to full size once.
    const w = fs.cols, h = fs.rows;
    const af = new cv.Mat(), bf = new cv.Mat(); a.convertTo(af, cv.CV_32F); b.convertTo(bf, cv.CV_32F);
    a.delete(); b.delete();
    const wb = remapMat(cv, bf, fs, cv.INTER_LINEAR); bf.delete();
    const ms = new cv.Mat(); cv.resize(mask, ms, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
    const conf = new cv.Mat(h, w, cv.CV_32F); const Cf = conf.data32F, R = af.data32F, Wb = wb.data32F, Mk = ms.data, FBs = fb.data32F;
    for (let i = 0; i < Cf.length; i++) Cf[i] = Mk[i] ? Math.exp(-Math.abs(Wb[i] - R[i]) / 12) * FBs[i] : 0;
    af.delete(); wb.delete(); ms.delete();
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
    const flow = new cv.Mat(); cv.resize(fs, flow, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); fs.delete();
    const maxPx = 0.04 * Math.max(W, H), F2 = flow.data32F;
    for (let i = 0; i < F2.length; i += 2) {
      F2[i] /= s; F2[i + 1] /= s;
      const m = Math.hypot(F2[i], F2[i + 1]);
      if (m > maxPx) { F2[i] *= maxPx / m; F2[i + 1] *= maxPx / m; }
    }
    return { flow, fb };
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

  function gateFlow(cv, flow, refG, movG) {
    // worked out at the flow's own working size (the gate is smooth); applied at full size
    const W = refG.cols, H = refG.rows, k = Math.min(1, 1100 / Math.max(W, H));
    const w = Math.round(W * k), h = Math.round(H * k);
    const shrink = g => { const o = new cv.Mat(); cv.resize(g, o, new cv.Size(w, h), 0, 0, cv.INTER_AREA); return o; };
    const rs = shrink(refG), ms = shrink(movG);
    const fs = new cv.Mat(); cv.resize(flow, fs, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    const FS = fs.data32F; for (let i = 0; i < FS.length; i++) FS[i] *= k;
    const b = g => { const o = new cv.Mat(); cv.GaussianBlur(g, o, new cv.Size(0, 0), 3 * k, 3 * k); return o; };
    const r = b(rs), m = b(ms), wm0 = remapMat(cv, ms, fs, cv.INTER_LINEAR), wm = b(wm0); wm0.delete();
    const eg = new cv.Mat(), ef = new cv.Mat();
    cv.absdiff(m, r, eg); cv.absdiff(wm, r, ef);
    const sg = 15 * k * Math.max(W, H) / 2212;
    cv.GaussianBlur(eg, eg, new cv.Size(0, 0), sg, sg); cv.GaussianBlur(ef, ef, new cv.Size(0, 0), sg, sg);
    const A = new cv.Mat(eg.rows, eg.cols, cv.CV_32F), a = A.data32F, G = eg.data32F, Fv = ef.data32F;
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (G[i] - Fv[i] - 0.002) / (G[i] + 0.01) * 3));
    cv.GaussianBlur(A, A, new cv.Size(0, 0), sg, sg);
    const Af = new cv.Mat(); cv.resize(A, Af, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
    const F = flow.data32F, af = Af.data32F;
    for (let i = 0; i < af.length; i++) { F[2 * i] *= af[i]; F[2 * i + 1] *= af[i]; }
    [rs, ms, fs, r, m, wm, eg, ef, A, Af].forEach(x => x.delete());
  }

  function flowMaps(cv, flow) {
    const H = flow.rows, W = flow.cols;
    const mx = new cv.Mat(H, W, cv.CV_32F), my = new cv.Mat(H, W, cv.CV_32F);
    const X = mx.data32F, Y = my.data32F, F = flow.data32F;
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) { X[i] = x + F[2 * i]; Y[i] = y + F[2 * i + 1]; }
    return [mx, my];
  }
  function remapWith(cv, src, maps, interp) {
    const out = new cv.Mat(); cv.remap(src, out, maps[0], maps[1], interp, cv.BORDER_REFLECT);
    return out;
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

  function winnerShare(cv, grays, ghosts) {
    // fraction of the frame where each photo is the sharpest or close to it (at 1/4
    // size); a near-equal photo still adds something: its detail is merged in
    const fs = grays.map((g, k) => {
      const s = new cv.Mat(); cv.resize(g, s, new cv.Size(0, 0), 0.25, 0.25, cv.INTER_AREA);
      const f = focusMeasure(cv, s, 2); s.delete();
      const gh = new cv.Mat(); cv.resize(ghosts[k], gh, new cv.Size(f.cols, f.rows), 0, 0, cv.INTER_AREA);
      cv.multiply(f, gh, f); gh.delete();
      return f;
    });
    const N = fs[0].rows * fs[0].cols, win = new Array(fs.length).fill(0);
    let maxAll = 0; for (const f of fs) for (const v of f.data32F) if (v > maxAll) maxAll = v;
    let counted = 0;
    for (let k = 0; k < N; k++) {
      let b = -1, bv = 0, sv = 0;
      for (let i = 0; i < fs.length; i++) { const v = fs[i].data32F[k]; if (v > bv) { sv = bv; bv = v; b = i; } else if (v > sv) sv = v; }
      if (bv < maxAll * 0.01) continue;                // nothing in focus here at all
      counted++;
      for (let i = 0; i < fs.length; i++) if (fs[i].data32F[k] >= 0.8 * bv) win[i]++;
    }
    fs.forEach(f => f.delete());
    return win.map(w => w / Math.max(1, counted));
  }

  /** How well a photo agrees with the (already blurred) reference, 0..1 at half
      size. Both are compared blurred, so a difference in focus alone doesn't count. */
  function ghostMap(cv, refBlur, g, hw, hh, sigma = 6, tol = 0.06) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), sigma, sigma);
    const B = b.data32F, r = refBlur.data32F;
    for (let i = 0; i < B.length; i++) {
      const d = Math.abs(B[i] - r[i]);
      B[i] = Math.min(1, Math.max(0, 1 - (d - tol) / tol));
    }
    cv.GaussianBlur(b, b, new cv.Size(0, 0), 4, 4);
    const h = new cv.Mat(); cv.resize(b, h, new cv.Size(hw, hh), 0, 0, cv.INTER_AREA); b.delete();
    return h;
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

  function pyrSizes(W, H) {
    const s = [[W, H]];
    for (let i = 0; i < LEVELS; i++) { const [w, h] = s[i]; s.push([Math.floor((w + 1) / 2), Math.floor((h + 1) / 2)]); }
    return s;
  }

  function gaussPyr(cv, m, levels = LEVELS) {
    const g = [m.clone()];
    for (let i = 0; i < levels; i++) { const d = new cv.Mat(); cv.pyrDown(g[i], d); g.push(d); }
    return g;
  }

  /** Laplacian pyramid; with levels < LEVELS only the finest `levels` bands. */
  function lapPyr(cv, m, levels = LEVELS) {
    const full = levels >= LEVELS;
    const g = gaussPyr(cv, m, full ? LEVELS : levels), l = [];
    for (let i = 0; i < (full ? LEVELS : levels); i++) {
      const u = new cv.Mat(); cv.pyrUp(g[i + 1], u, new cv.Size(g[i].cols, g[i].rows));
      const d = new cv.Mat(); cv.subtract(g[i], u, d); u.delete(); l.push(d);
    }
    if (full) l.push(g[LEVELS]); else g[levels].delete();
    for (let i = 0; i < (full ? LEVELS : levels); i++) g[i].delete();
    return l;
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
  async function fuseHybrid(cv, imgs8, weights, valid, progress, tick, debug) {
    const n = imgs8.length, W = imgs8[0].cols, H = imgs8[0].rows;
    // --- weights from relative sharpness, computed at half size (weights are smooth) ---
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2), half = new cv.Size(hw, hh);
    const Fh = [], texMax = new Float32Array(W * H), N = hw * hh, meanHalf = new Float32Array(N);
    for (let i = 0; i < n; i++) {
      // grey copy made on the fly (keeps memory down on phones)
      const gray = toGray(cv, imgs8[i]);
      const f = focusMeasure(cv, gray, 4);
      const s = new cv.Mat(); cv.resize(f, s, half, 0, 0, cv.INTER_AREA); f.delete(); Fh.push(s);
      const f2 = focusMeasure(cv, gray, 2), T = f2.data32F, V = valid[i].data;
      for (let k = 0; k < T.length; k++) if (V[k] && T[k] > texMax[k]) texMax[k] = T[k];
      f2.delete();
      const gs = new cv.Mat(); cv.resize(gray, gs, half, 0, 0, cv.INTER_AREA); const S = gs.data32F;
      for (let k = 0; k < N; k++) meanHalf[k] += S[k] / n;
      gs.delete(); gray.delete();
      await tick();
    }
    // the sharpest photo at each spot, among those that have pixels there
    const Fmax = new Float32Array(N);
    for (let i = 0; i < n; i++) { const d = Fh[i].data32F, g = weights[i].data32F; for (let k = 0; k < N; k++) if (g[k] > 0.02 && d[k] > Fmax[k]) Fmax[k] = d[k]; }
    for (let i = 0; i < n; i++) {
      const d = Fh[i].data32F, g = weights[i].data32F;
      for (let k = 0; k < N; k++) { const r = Math.min(1, d[k] / (Fmax[k] + 1e-9)); d[k] = r * r * r * r * g[k] + 1e-6; }
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
    if (debug) debug('weights', { width: hw, height: hh, maps: Fh.map(m => Float32Array.from(m.data32F)) });

    // --- texture mask (where detail is taken from the sharpest photos, not averaged) ---
    const tex = cv.matFromArray(H, W, cv.CV_32F, texMax);
    const tb = new cv.Mat(); cv.GaussianBlur(tex, tb, new cv.Size(0, 0), 25, 25);
    const sorted = Float32Array.from(texMax.filter((_, k) => k % 7 === 0)).sort();
    const lo = sorted[Math.floor(sorted.length * .35)], hi = sorted[Math.floor(sorted.length * .65)];
    const TM = new cv.Mat(H, W, cv.CV_32F), tm = TM.data32F, TB = tb.data32F;
    for (let k = 0; k < tm.length; k++) {
      const t = texMax[k] / (TB[k] + 1e-6);
      const a = Math.min(1, Math.max(0, t / 0.5));
      const gate = Math.min(1, Math.max(0, (texMax[k] - lo) / (hi - lo + 1e-9)));
      tm[k] = a * gate;
    }
    tex.delete(); tb.delete();
    cv.GaussianBlur(TM, TM, new cv.Size(0, 0), 3, 3);
    const tp = gaussPyr(cv, TM); TM.delete();

    // --- pass 1: weighted pyramid at every level; at the fine levels, find the
    //     sharpest photo at each spot (and the noise level of each band) ---
    const sizes = pyrSizes(W, H);
    const acc = sizes.map(([w, h]) => new Float32Array(w * h * 3));
    const bestE = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h).fill(-1));
    const bestC = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h * 3));
    const noise = new Array(FINE).fill(Infinity);
    const ghostPyr = i => {
      const gf = new cv.Mat(); cv.resize(weights[i], gf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      const gg = gaussPyr(cv, gf, FINE); gf.delete(); return gg;
    };
    for (let i = 0; i < n; i++) {
      const f = new cv.Mat(); imgs8[i].convertTo(f, cv.CV_32FC3, 1 / 255);
      const lp = lapPyr(cv, f); f.delete();
      const wf = new cv.Mat(); cv.resize(Fh[i], wf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      const gw = gaussPyr(cv, wf); wf.delete();
      const gg = ghostPyr(i);
      for (let L = 0; L <= LEVELS; L++) {
        const C = lp[L].data32F, Wt = gw[L].data32F, A = acc[L];
        for (let k = 0, p = 0; k < Wt.length; k++, p += 3) {
          const w = Wt[k]; A[p] += w * C[p]; A[p + 1] += w * C[p + 1]; A[p + 2] += w * C[p + 2];
        }
        if (L < FINE) {
          const e = bandEnergy(cv, lp[L]), E = e.data32F, C2 = lp[L].data32F;
          const G = gg[L].data32F, BE = bestE[L], BC = bestC[L];
          // noise of this band: the typical detail where this photo is out of focus
          const smp = []; for (let k = 0, p = 0; k < E.length; k += 37, p += 111) if (G[k] > 0.5) smp.push(Math.abs(C2[p]) + Math.abs(C2[p + 1]) + Math.abs(C2[p + 2]));
          if (smp.length > 100) { smp.sort((x, y) => x - y); noise[L] = Math.min(noise[L], smp[smp.length >> 2]); }
          for (let k = 0, p = 0; k < E.length; k++, p += 3) {
            const v = E[k] * G[k];
            if (v > BE[k]) { BE[k] = v; BC[p] = C2[p]; BC[p + 1] = C2[p + 1]; BC[p + 2] = C2[p + 2]; }
          }
          e.delete();
        }
      }
      lp.forEach(m => m.delete()); gw.forEach(m => m.delete()); gg.forEach(m => m.delete());
      progress((i + 1) / n * 0.6);
      await tick();
    }
    Fh.forEach(m => m.delete());

    // --- pass 2: fine detail merged from every photo that is nearly as sharp as the
    //     best one at that spot and agrees with it. The single sharpest photo carries
    //     its own noise; averaging in its near-equals cancels some of it, while a
    //     photo whose detail differs (a slightly different line-up, a moved leg) is
    //     left out of that spot. ---
    const num = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h * 3));
    const den = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h));
    const count = debug ? new Uint8Array(sizes[1][0] * sizes[1][1]) : null;
    for (let i = 0; i < n; i++) {
      const f = new cv.Mat(); imgs8[i].convertTo(f, cv.CV_32FC3, 1 / 255);
      const lp = lapPyr(cv, f, FINE); f.delete();
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
      progress(0.6 + (i + 1) / n * 0.3);
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
      const l = cv.matFromArray(h, w, cv.CV_32FC3, acc[L]);
      img = new cv.Mat(); cv.add(u, l, img); u.delete(); l.delete();
      acc[L] = null;
    }
    progress(1);
    return img;
  }

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

  const api = { stackFrames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SalticidStacker = api;
})(typeof self !== 'undefined' ? self : this);
