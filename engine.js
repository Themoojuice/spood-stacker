/* Salticid stacker engine — browser/Node port of stacker.py (OpenCV.js).
   stackFrames(cv, frames, opts) -> {data: Uint8ClampedArray (RGBA), width, height, log, ref}
   frames: [{data: Uint8ClampedArray RGBA, width, height}]
   opts: maxSide, onProgress(p, stage), onLog(msg), onSelection({used, left}),
         onFrame(frame) - optional; receives each lined-up photo cropped and finished
         like the stack ({photo, used, why, ref, width, height, data, focus}) for retouching.
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
    const masks = gray.map(g => validMask(cv, g));
    const order = orderFrames(cv, gray);
    const cy0 = Math.floor(H * .3), cy1 = Math.floor(H * .7), cx0 = Math.floor(W * .3), cx1 = Math.floor(W * .7);
    let ref = 0, best = -1;
    for (let i = 0; i < n; i++) {
      const roi = gray[i].roi(new cv.Rect(cx0, cy0, cx1 - cx0, cy1 - cy0));
      const f = focusMeasure(cv, roi, 4); const v = cv.mean(f)[0]; f.delete(); roi.delete();
      if (v > best) { best = v; ref = i; }
    }
    const refPos = order.indexOf(ref);
    say(`focus order ${order.map(o => o + 1).join(' ')}, reference photo ${ref + 1}`);
    progress(0.12, 'Working out focus order');
    await tick();

    // ---------- 3. global alignment ----------
    const srcPx = frames.map(f => f.srcPixels || f.width * f.height);
    const Hs = new Array(n); Hs[ref] = eye3();
    const inl = new Array(n).fill(9999), eccOk = new Array(n).fill(true);
    let done = 0;
    for (const dir of [-1, 1]) {
      let prev = ref, pos = refPos + dir;
      while (pos >= 0 && pos < n) {
        const cur = order[pos];
        const a = homography(cv, gray[cur], gray[prev], masks[cur], masks[prev]);
        let Hm = mul3(Hs[prev], a.H), best = a.inliers;
        if (prev !== ref) {
          const d = homography(cv, gray[cur], gray[ref], masks[cur], masks[ref]);
          if (d.inliers > 1.5 * a.inliers) { Hm = d.H; best = d.inliers; }
        }
        const r = eccRefine(cv, gray[cur], gray[ref], Hm, masks[ref]);
        Hs[cur] = r.H; inl[cur] = best; eccOk[cur] = r.ok;
        say(`photo ${cur + 1}: ${best} matches, fine-tune ${r.ok ? 'ok' : 'skipped'}`);
        prev = cur; pos += dir; done++;
        progress(0.12 + 0.33 * done / (n - 1), 'Lining up photos');
        await tick();
      }
    }
    const warped = new Array(n), wmask = new Array(n);
    for (let i = 0; i < n; i++) {
      const M = cv.matFromArray(3, 3, cv.CV_64F, Hs[i]);
      warped[i] = new cv.Mat(); cv.warpPerspective(rgb[i], warped[i], M, sz(W, H), cv.INTER_LANCZOS4, cv.BORDER_REFLECT);
      wmask[i] = new cv.Mat(); cv.warpPerspective(masks[i], wmask[i], M, sz(W, H), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete(); rgb[i].delete();
    }
    gray.forEach(g => g.delete()); masks.forEach(m => m.delete());

    // ---------- 4. local alignment (kept per photo only if it helps) ----------
    const wg = warped.map(m => toGray(cv, m));
    const agree = new Array(n).fill(1);
    done = 0;
    for (let k = 0; k < n; k++) {
      const cur = order[k];
      if (cur === ref) continue;
      const both = new cv.Mat(); cv.bitwise_and(wmask[ref], wmask[cur], both);
      const flow = denseFlow(cv, wg[ref], wg[cur], both);
      gateFlow(cv, flow, wg[ref], wg[cur]);
      const candG = remapMat(cv, wg[cur], flow, cv.INTER_LINEAR);
      const nccG = bandNCC(cv, wg[ref], wg[cur], both), nccF = bandNCC(cv, wg[ref], candG, both);
      if (nccF >= nccG + 0.01) {
        const cand = remapMat(cv, warped[cur], flow, cv.INTER_LANCZOS4);
        warped[cur].delete(); warped[cur] = cand;
        wg[cur].delete(); wg[cur] = candG;
        const mf = new cv.Mat(); wmask[cur].convertTo(mf, cv.CV_32F);
        const mr = remapMat(cv, mf, flow, cv.INTER_LINEAR); mf.delete();
        const mb = new cv.Mat(); cv.threshold(mr, mb, 0.5, 1, cv.THRESH_BINARY); mr.delete();
        wmask[cur].delete(); wmask[cur] = new cv.Mat(); mb.convertTo(wmask[cur], cv.CV_8U); mb.delete();
        agree[cur] = nccF;
        say(`photo ${cur + 1}: local correction kept (${nccG.toFixed(3)} → ${nccF.toFixed(3)})`);
      } else {
        candG.delete(); agree[cur] = nccG;
        say(`photo ${cur + 1}: local correction not needed`);
      }
      flow.delete(); both.delete(); done++;
      progress(0.45 + 0.2 * done / (n - 1), 'Correcting movement');
      await tick();
    }

    // ---------- 5. choose which photos to use ----------
    const keep = new Array(n).fill(true), why = new Array(n).fill('');
    // (a) photos that could not be lined up
    for (let i = 0; i < n; i++) if (i !== ref && inl[i] < 15 && !eccOk[i]) { keep[i] = false; why[i] = 'could not be lined up with the others'; }
    // (b) near-duplicates: keep the higher-resolution (then sharper) copy
    const thumbs = wg.map(g => { const s = new cv.Mat(); cv.resize(g, s, new cv.Size(0, 0), 0.25, 0.25, cv.INTER_AREA); return s; });
    const sharpT = thumbs.map(t => { const f = focusMeasure(cv, t, 2); const v = cv.mean(f)[0]; f.delete(); return v; });
    const allOn = new cv.Mat(thumbs[0].rows, thumbs[0].cols, cv.CV_8U, new cv.Scalar(1));
    const focusT = thumbs.map(t => focusMeasure(cv, t, 2));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (!keep[i] || !keep[j]) continue;
      const c = bandNCC(cv, thumbs[i], thumbs[j], allOn);
      // same picture AND same focus: with a steady camera, neighbouring focus slices
      // look alike at this size, but they are sharp in different places
      if (c > 0.985 && sameFocus(focusT[i].data32F, focusT[j].data32F)) {
        const better = (srcPx[i] > srcPx[j] * 1.1) ? i : (srcPx[j] > srcPx[i] * 1.1) ? j : (sharpT[i] >= sharpT[j] ? i : j);
        const worse = better === i ? j : i;
        if (worse === ref) continue;                     // never drop the reference
        keep[worse] = false; why[worse] = `near-duplicate of photo ${better + 1}`;
      }
    }
    allOn.delete(); thumbs.forEach(t => t.delete()); focusT.forEach(t => t.delete());
    // (c) photos that disagree with the reference almost everywhere (subject moved a lot)
    const ghostsAll = ghostWeights(cv, wg, ref);
    for (let i = 0; i < n; i++) {
      if (!keep[i] || i === ref) continue;
      const m = cv.mean(ghostsAll[i])[0];
      if (m < 0.25) { keep[i] = false; why[i] = 'the spider moved too much in it'; }
    }
    let idx = [...Array(n).keys()].filter(i => keep[i]);
    // (d) photos that add no sharp detail the others don't already have
    const share = winnerShare(cv, idx.map(i => wg[i]), idx.map(i => ghostsAll[i]));
    if (idx.length > 2) idx.forEach((i, k) => {
      if (i !== ref && share[k] < 0.003) { keep[i] = false; why[i] = 'adds nothing sharp the others lack'; }
    });
    idx = [...Array(n).keys()].filter(i => keep[i]);
    const left = [...Array(n).keys()].filter(i => !keep[i]);
    left.forEach(i => say(`photo ${i + 1} left out: ${why[i]}`));
    if (opts.onSelection) opts.onSelection({ used: idx.map(i => i + 1), left: left.map(i => ({ photo: i + 1, why: why[i] })) });
    say(`using ${idx.length} of ${n} photos`);

    const common = wmask[idx[0]].clone();
    for (const i of idx.slice(1)) cv.bitwise_and(common, wmask[i], common);
    wmask.forEach(m => m.delete());
    const box = largestRect(cv, common); common.delete();

    // ---------- 5b. hand the lined-up photos to the retouch brush ----------
    // Each is cropped and finished exactly like the stack, so painted pixels match.
    // Photos that could not be lined up are not offered.
    if (opts.onFrame) {
      const offer = [...Array(n).keys()].filter(i => keep[i] || !/lined up/.test(why[i]));
      for (let k = 0; k < offer.length; k++) {
        const i = offer[k];
        await opts.onFrame(exportFrame(cv, warped[i], wg[i], ghostsAll[i], box, {
          photo: i + 1, used: keep[i], why: why[i], ref: i === ref
        }));
        progress(0.65 + 0.03 * (k + 1) / offer.length, 'Keeping photos for retouching');
      }
    }
    for (const i of left) { warped[i].delete(); wg[i].delete(); ghostsAll[i].delete(); }
    const keptImgs = idx.map(i => warped[i]), keptGray = idx.map(i => wg[i]), ghosts = idx.map(i => ghostsAll[i]);
    progress(0.67, 'Merging');
    await tick();

    // ---------- 6. hybrid fusion ----------
    keptGray.forEach(m => m.delete());
    const fused = await fuseHybrid(cv, keptImgs, null, ghosts, p => progress(0.67 + 0.28 * p, 'Merging'), tick);
    keptImgs.forEach(m => m.delete()); ghosts.forEach(m => m.delete());

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

  function validMask(cv, g) {
    // dark vignette (lens clamp) = dark regions touching the frame edge
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 15, 15);
    const dark = new cv.Mat(); cv.threshold(b, dark, 0.12, 1, cv.THRESH_BINARY_INV); b.delete();
    const d8 = new cv.Mat(); dark.convertTo(d8, cv.CV_8U); dark.delete();
    const lab = new cv.Mat(); const nl = cv.connectedComponents(d8, lab); d8.delete();
    const L = lab.data32S, w = lab.cols, h = lab.rows;
    const edge = new Uint8Array(nl);
    for (let x = 0; x < w; x++) { edge[L[x]] = 1; edge[L[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { edge[L[y * w]] = 1; edge[L[y * w + w - 1]] = 1; }
    edge[0] = 0;
    const m = new cv.Mat(h, w, cv.CV_8U); const M = m.data;
    for (let i = 0; i < L.length; i++) M[i] = edge[L[i]] ? 0 : 1;
    lab.delete();
    const k = cv.Mat.ones(31, 31, cv.CV_8U); cv.erode(m, m, k); k.delete();
    return m;
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

  function homography(cv, srcG, dstG, mSrc, mDst) {
    // features on a downscaled copy (speed), H rescaled to full size
    const s = Math.min(1, 1600 / Math.max(srcG.cols, srcG.rows));
    const prep = (g, m) => {
      const r = new cv.Mat(); cv.resize(g, r, new cv.Size(0, 0), s, s, cv.INTER_AREA);
      const u = to8(cv, r); r.delete();
      const mm = new cv.Mat(); cv.resize(m, mm, new cv.Size(u.cols, u.rows), 0, 0, cv.INTER_NEAREST);
      return [u, mm];
    };
    const [a, ma] = prep(srcG, mSrc), [b, mb] = prep(dstG, mDst);
    const ak = new cv.AKAZE(); ak.setThreshold(0.0005);
    const k1 = new cv.KeyPointVector(), k2 = new cv.KeyPointVector(), d1 = new cv.Mat(), d2 = new cv.Mat();
    ak.detectAndCompute(a, ma, k1, d1); ak.detectAndCompute(b, mb, k2, d2);
    let res = { H: eye3(), inliers: 0 };
    if (k1.size() >= 20 && k2.size() >= 20) {
      const bf = new cv.BFMatcher(cv.NORM_HAMMING, false); const mv = new cv.DMatchVectorVector();
      bf.knnMatch(d1, d2, mv, 2);
      const p1 = [], p2 = [];
      for (let i = 0; i < mv.size(); i++) {
        const m = mv.get(i);
        if (m.size() < 2) { m.delete(); continue; }
        const x = m.get(0), y = m.get(1);
        if (x.distance < 0.8 * y.distance) {
          const q = k1.get(x.queryIdx).pt, t = k2.get(x.trainIdx).pt;
          p1.push(q.x, q.y); p2.push(t.x, t.y);
        }
        m.delete();
      }
      mv.delete(); bf.delete();
      if (p1.length / 2 >= 20) {
        const P1 = cv.matFromArray(p1.length / 2, 1, cv.CV_32FC2, p1), P2 = cv.matFromArray(p2.length / 2, 1, cv.CV_32FC2, p2);
        const inl = new cv.Mat();
        const Hm = cv.findHomography(P1, P2, cv.RANSAC, 3.0 * s + 0.5, inl, 5000, 0.999);
        if (Hm && !Hm.empty()) {
          const h = Array.from(Hm.data64F);
          // rescale: H_full = S^-1 H S
          const S = [s, 0, 0, 0, s, 0, 0, 0, 1], Si = [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1];
          res = { H: mul3(mul3(Si, h), S), inliers: cv.countNonZero(inl) };
        }
        if (Hm) Hm.delete(); inl.delete(); P1.delete(); P2.delete();
      }
    }
    [a, ma, b, mb, d1, d2].forEach(m => m.delete()); k1.delete(); k2.delete(); ak.delete();
    return res;
  }

  function gradMag(cv, g) {
    const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), 2, 2);
    const gx = new cv.Mat(), gy = new cv.Mat();
    cv.Sobel(b, gx, cv.CV_32F, 1, 0); cv.Sobel(b, gy, cv.CV_32F, 0, 1); b.delete();
    const m = new cv.Mat(); cv.magnitude(gx, gy, m); gx.delete(); gy.delete();
    cv.GaussianBlur(m, m, new cv.Size(0, 0), 2, 2);
    return m;
  }

  function eccRefine(cv, srcG, dstG, H, mask) {
    const scale = Math.min(0.5, 1100 / Math.max(srcG.cols, srcG.rows));
    const s0 = gradMag(cv, srcG), d0 = gradMag(cv, dstG);
    const s = new cv.Mat(), d = new cv.Mat(), m = new cv.Mat();
    cv.resize(s0, s, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.resize(d0, d, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.resize(mask, m, new cv.Size(d.cols, d.rows), 0, 0, cv.INTER_NEAREST);
    s0.delete(); d0.delete();
    const S = [scale, 0, 0, 0, scale, 0, 0, 0, 1], Si = [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1];
    const w0 = mul3(mul3(S, inv3(H)), Si);
    const Wm = cv.matFromArray(3, 3, cv.CV_32F, w0);
    let out = { H, ok: false };
    try {
      cv.findTransformECC(d, s, Wm, cv.MOTION_HOMOGRAPHY,
        new cv.TermCriteria(3, 200, 1e-6), m, 5);
      const w = Array.from(Wm.data32F);
      const Hn = inv3(mul3(mul3(Si, w), S));
      // sanity: reject wild refinements
      const drift = Math.abs(Hn[2] - H[2]) + Math.abs(Hn[5] - H[5]);
      if (isFinite(drift) && drift < 0.1 * Math.max(srcG.cols, srcG.rows)) out = { H: Hn, ok: true };
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
    const fs = new cv.Mat();
    cv.calcOpticalFlowFarneback(a, b, fs, 0.5, 5, 21, 3, 7, 1.5, 0);
    a.delete(); b.delete();
    const flow = new cv.Mat(); cv.resize(fs, flow, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); fs.delete();
    const F = flow.data32F; for (let i = 0; i < F.length; i++) F[i] /= s;
    // confidence: agreement of blurred images after warping
    const rb = new cv.Mat(), mb = new cv.Mat();
    cv.GaussianBlur(refG, rb, new cv.Size(0, 0), 2.5, 2.5); cv.GaussianBlur(movG, mb, new cv.Size(0, 0), 2.5, 2.5);
    const wb = remapMat(cv, mb, flow, cv.INTER_LINEAR); mb.delete();
    const conf = new cv.Mat(H, W, cv.CV_32F); const Cf = conf.data32F, R = rb.data32F, Wb = wb.data32F, Mk = mask.data;
    for (let i = 0; i < Cf.length; i++) Cf[i] = Mk[i] ? Math.exp(-Math.abs(Wb[i] - R[i]) * 255 / 12) : 0;
    rb.delete(); wb.delete();
    const smooth = 4 * Math.max(W, H) / 2212;
    const den = new cv.Mat(); cv.GaussianBlur(conf, den, new cv.Size(0, 0), smooth, smooth);
    const ch = new cv.MatVector(); cv.split(flow, ch);
    for (let c = 0; c < 2; c++) {
      const x = ch.get(c); cv.multiply(x, conf, x);
      cv.GaussianBlur(x, x, new cv.Size(0, 0), smooth, smooth);
      const X = x.data32F, D = den.data32F;
      for (let i = 0; i < X.length; i++) X[i] /= (D[i] + 1e-4);
      ch.set(c, x); x.delete();
    }
    cv.merge(ch, flow); ch.delete(); conf.delete(); den.delete();
    const maxPx = 0.04 * Math.max(W, H);
    for (let i = 0; i < F.length; i += 2) {
      const m = Math.hypot(F[i], F[i + 1]);
      if (m > maxPx) { F[i] *= maxPx / m; F[i + 1] *= maxPx / m; }
    }
    return flow;
  }

  function gateFlow(cv, flow, refG, movG) {
    const b = g => { const o = new cv.Mat(); cv.GaussianBlur(g, o, new cv.Size(0, 0), 3, 3); return o; };
    const r = b(refG), m = b(movG), wm0 = remapMat(cv, movG, flow, cv.INTER_LINEAR), wm = b(wm0); wm0.delete();
    const eg = new cv.Mat(), ef = new cv.Mat();
    cv.absdiff(m, r, eg); cv.absdiff(wm, r, ef);
    const sg = 15 * Math.max(refG.cols, refG.rows) / 2212;
    cv.GaussianBlur(eg, eg, new cv.Size(0, 0), sg, sg); cv.GaussianBlur(ef, ef, new cv.Size(0, 0), sg, sg);
    const A = new cv.Mat(eg.rows, eg.cols, cv.CV_32F), a = A.data32F, G = eg.data32F, Fv = ef.data32F;
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (G[i] - Fv[i] - 0.002) / (G[i] + 0.01) * 3));
    cv.GaussianBlur(A, A, new cv.Size(0, 0), sg, sg);
    const F = flow.data32F;
    for (let i = 0; i < a.length; i++) { F[2 * i] *= a[i]; F[2 * i + 1] *= a[i]; }
    [r, m, wm, eg, ef, A].forEach(x => x.delete());
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
    const band = g => {
      const x = new cv.Mat(), y = new cv.Mat();
      cv.GaussianBlur(g, x, new cv.Size(0, 0), 2, 2); cv.GaussianBlur(g, y, new cv.Size(0, 0), 10, 10);
      cv.subtract(x, y, x); y.delete(); return x;
    };
    const A = band(a), B = band(b), M = mask.data, p = A.data32F, q = B.data32F;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < p.length; i += 3) {             // subsample for speed
      if (!M[i]) continue;
      const u = p[i], v = q[i]; n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
    }
    A.delete(); B.delete();
    if (n < 10) return 0;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return cov / Math.sqrt(va * vb + 1e-12);
  }

  function sameFocus(A, B) {
    // Two photos are sharp in the same places if their sharpness ratio is the same
    // everywhere (a uniform ratio is allowed: a lower-resolution copy is softer overall).
    let ma = 0, mb = 0;
    for (let k = 0; k < A.length; k++) { if (A[k] > ma) ma = A[k]; if (B[k] > mb) mb = B[k]; }
    const ta = 0.02 * ma, tb = 0.02 * mb, r = [];
    for (let k = 0; k < A.length; k += 2) if (A[k] > ta || B[k] > tb) r.push(Math.log((A[k] + 1e-6 * ma) / (B[k] + 1e-6 * mb)));
    if (r.length < 50) return true;
    const med = Float64Array.from(r).sort()[r.length >> 1], lim = Math.log(1.6);
    let off = 0; for (const v of r) if (Math.abs(v - med) > lim) off++;
    return off / r.length < 0.05;
  }

  function winnerShare(cv, grays, ghosts) {
    // fraction of the frame where each photo is clearly the sharpest (at 1/4 size)
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
      if (bv > sv * 1.15) win[b]++;
    }
    fs.forEach(f => f.delete());
    return win.map(w => w / Math.max(1, counted));
  }

  function ghostWeights(cv, grays, ref, sigma = 6, tol = 0.06) {
    const R = new cv.Mat(); cv.GaussianBlur(grays[ref], R, new cv.Size(0, 0), sigma, sigma);
    const out = grays.map(g => {
      const b = new cv.Mat(); cv.GaussianBlur(g, b, new cv.Size(0, 0), sigma, sigma);
      const B = b.data32F, r = R.data32F;
      for (let i = 0; i < B.length; i++) {
        const d = Math.abs(B[i] - r[i]);
        B[i] = Math.min(1, Math.max(0, 1 - (d - tol) / tol));
      }
      cv.GaussianBlur(b, b, new cv.Size(0, 0), 4, 4);
      const h = new cv.Mat(); cv.resize(b, h, new cv.Size(Math.ceil(b.cols / 2), Math.ceil(b.rows / 2)), 0, 0, cv.INTER_AREA); b.delete();
      return h;
    });
    R.delete();
    return out;
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

  function pyrSizes(W, H) {
    const s = [[W, H]];
    for (let i = 0; i < LEVELS; i++) { const [w, h] = s[i]; s.push([Math.floor((w + 1) / 2), Math.floor((h + 1) / 2)]); }
    return s;
  }

  function gaussPyr(cv, m) {
    const g = [m.clone()];
    for (let i = 0; i < LEVELS; i++) { const d = new cv.Mat(); cv.pyrDown(g[i], d); g.push(d); }
    return g;
  }

  function lapPyr(cv, m) {
    const g = gaussPyr(cv, m), l = [];
    for (let i = 0; i < LEVELS; i++) {
      const u = new cv.Mat(); cv.pyrUp(g[i + 1], u, new cv.Size(g[i].cols, g[i].rows));
      const d = new cv.Mat(); cv.subtract(g[i], u, d); u.delete(); l.push(d);
    }
    l.push(g[LEVELS]);
    for (let i = 0; i < LEVELS; i++) g[i].delete();
    return l;
  }

  async function fuseHybrid(cv, imgs8, grays, ghosts, progress, tick) {
    const n = imgs8.length, W = imgs8[0].cols, H = imgs8[0].rows;
    // --- weights from relative sharpness, computed at half size (weights are smooth) ---
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2), half = new cv.Size(hw, hh);
    const Fh = [], texMax = new Float32Array(W * H), N = hw * hh, meanHalf = new Float32Array(N);
    for (let i = 0; i < n; i++) {
      // grey copy made on the fly (keeps memory down on phones)
      const gray = grays ? grays[i] : toGray(cv, imgs8[i]);
      const f = focusMeasure(cv, gray, 4);
      const s = new cv.Mat(); cv.resize(f, s, half, 0, 0, cv.INTER_AREA); f.delete(); Fh.push(s);
      const f2 = focusMeasure(cv, gray, 2), T = f2.data32F;
      for (let k = 0; k < T.length; k++) if (T[k] > texMax[k]) texMax[k] = T[k];
      f2.delete();
      const gs = new cv.Mat(); cv.resize(gray, gs, half, 0, 0, cv.INTER_AREA); const S = gs.data32F;
      for (let k = 0; k < N; k++) meanHalf[k] += S[k] / n;
      gs.delete(); if (!grays) gray.delete();
      await tick();
    }
    const Fmax = new Float32Array(N);
    for (const f of Fh) { const d = f.data32F; for (let k = 0; k < N; k++) if (d[k] > Fmax[k]) Fmax[k] = d[k]; }
    const gh = ghosts.map(g => { const s = new cv.Mat(); cv.resize(g, s, half, 0, 0, cv.INTER_AREA); return s; });
    for (let i = 0; i < n; i++) {
      const d = Fh[i].data32F, g = gh[i].data32F;
      for (let k = 0; k < N; k++) { const r = d[k] / (Fmax[k] + 1e-9); d[k] = r * r * r * r * g[k] + 1e-6; }
    }
    normalise(Fh, N);
    const meanG = cv.matFromArray(hh, hw, cv.CV_32F, meanHalf);
    for (let i = 0; i < n; i++) {
      const r = guidedFilter(cv, meanG, Fh[i], 4, 1e-4); const R = r.data32F;
      for (let k = 0; k < N; k++) R[k] = Math.max(0, R[k]) + 1e-6;
      Fh[i].delete(); Fh[i] = r;
    }
    meanG.delete(); gh.forEach(m => m.delete());
    normalise(Fh, N);

    // --- texture mask (where max-selection is allowed) ---
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

    // --- incremental pyramid accumulation ---
    const sizes = pyrSizes(W, H);
    const acc = sizes.map(([w, h]) => new Float32Array(w * h * 3));
    const bestE = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h).fill(-1));
    const bestC = sizes.slice(0, FINE).map(([w, h]) => new Float32Array(w * h * 3));
    for (let i = 0; i < n; i++) {
      const f = new cv.Mat(); imgs8[i].convertTo(f, cv.CV_32FC3, 1 / 255);
      const lp = lapPyr(cv, f); f.delete();
      const wf = new cv.Mat(); cv.resize(Fh[i], wf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      const gw = gaussPyr(cv, wf); wf.delete();
      let gg = null;
      if (FINE) { const gf = new cv.Mat(); cv.resize(ghosts[i], gf, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); gg = gaussPyr(cv, gf); gf.delete(); }
      for (let L = 0; L <= LEVELS; L++) {
        const C = lp[L].data32F, Wt = gw[L].data32F, A = acc[L];
        for (let k = 0, p = 0; k < Wt.length; k++, p += 3) {
          const w = Wt[k]; A[p] += w * C[p]; A[p + 1] += w * C[p + 1]; A[p + 2] += w * C[p + 2];
        }
        if (L < FINE) {
          const e = new cv.Mat(lp[L].rows, lp[L].cols, cv.CV_32F), E = e.data32F;
          for (let k = 0, p = 0; k < E.length; k++, p += 3) E[k] = Math.abs(C[p]) + Math.abs(C[p + 1]) + Math.abs(C[p + 2]);
          cv.GaussianBlur(e, e, new cv.Size(0, 0), 1, 1);
          const G = gg[L].data32F, BE = bestE[L], BC = bestC[L];
          for (let k = 0, p = 0; k < E.length; k++, p += 3) {
            const v = E[k] * G[k];
            if (v > BE[k]) { BE[k] = v; BC[p] = C[p]; BC[p + 1] = C[p + 1]; BC[p + 2] = C[p + 2]; }
          }
          e.delete();
        }
      }
      lp.forEach(m => m.delete()); gw.forEach(m => m.delete()); if (gg) gg.forEach(m => m.delete());
      progress((i + 1) / n * 0.9);
      await tick();
    }
    Fh.forEach(m => m.delete());
    // --- blend fine levels, collapse ---
    for (let L = 0; L < FINE; L++) {
      const T = tp[L].data32F, A = acc[L], B = bestC[L];
      for (let k = 0, p = 0; k < T.length; k++, p += 3) {
        const a = T[k];
        A[p] = a * B[p] + (1 - a) * A[p]; A[p + 1] = a * B[p + 1] + (1 - a) * A[p + 1]; A[p + 2] = a * B[p + 2] + (1 - a) * A[p + 2];
      }
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

  function largestRect(cv, common, f = 4) {
    const W = common.cols, H = common.rows;
    const e = new cv.Mat(); const k = cv.Mat.ones(f, f, cv.CV_8U); cv.erode(common, e, k); k.delete();
    const w = Math.floor(W / f), h = Math.floor(H / f), D = e.data;
    const heights = new Int32Array(w);
    let best = { a: 0, x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) heights[c] = D[r * f * W + c * f] ? heights[c] + 1 : 0;
      const st = [];
      for (let c = 0; c <= w; c++) {
        const cur = c < w ? heights[c] : 0; let start = c;
        while (st.length && st[st.length - 1][1] >= cur) {
          const [s, ht] = st.pop(); const a = ht * (c - s);
          if (a > best.a) best = { a, x0: s, y0: r - ht + 1, x1: c - 1, y1: r };
          start = s;
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
