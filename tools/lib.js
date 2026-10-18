/* Shared helpers for the compare tool: OpenCV.js in Node, photo decoding that
   matches the app, and image registration. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function needSharp() {
  try { return require('sharp'); } catch (e) {
    console.error('The compare tool needs the "sharp" image library. Run:  cd tools && npm install');
    process.exit(2);
  }
}

let cvPromise = null;
function loadCv() {
  if (!cvPromise) cvPromise = new Promise(resolve => {
    const cv = require(path.join(ROOT, 'vendor', 'opencv-4.10.0.js'));
    const fin = c => { try { delete c.then; } catch (e) { /* ignore */ } resolve(c); };
    if (cv.Mat) fin(cv);
    else if (typeof cv.then === 'function') cv.then(fin);
    else cv.onRuntimeInitialized = () => fin(cv);
  });
  return cvPromise;
}

const IMG = /\.(jpe?g|png|webp)$/i;
/** Photos of a burst, in name order (the app sorts by time, then name). */
function burstPhotos(dir) {
  return fs.readdirSync(dir).filter(f => IMG.test(f) && !/^(gold|truth|zerene|helicon)/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(f => path.join(dir, f));
}

/** Decode like the app does: apply EXIF orientation, then shrink so the long
    side is at most maxSide (high-quality resampling). */
async function decodeLikeApp(file, maxSide) {
  const sharp = needSharp();
  const img = sharp(file).rotate();
  const meta = await sharp(file).metadata();
  const swap = (meta.orientation || 1) >= 5;
  const w0 = swap ? meta.height : meta.width, h0 = swap ? meta.width : meta.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const { data } = await img.resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: w, height: h, srcPixels: w0 * h0 };
}

async function readRGBA(file, maxSide) {
  const sharp = needSharp();
  let img = sharp(file).rotate();
  if (maxSide) img = img.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

async function writeRGBA(file, img, opts = {}) {
  const sharp = needSharp();
  let s = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length),
    { raw: { width: img.width, height: img.height, channels: 4 } });
  s = /\.png$/i.test(file) ? s.png({ compressionLevel: 6 }) : s.jpeg({ quality: opts.quality || 92 });
  await s.toFile(file);
}

// ---------- OpenCV helpers ----------
function grayF(cv, rgba) {
  const m = cv.matFromArray(rgba.height, rgba.width, cv.CV_8UC4, rgba.data);
  const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY); m.delete();
  const f = new cv.Mat(); g.convertTo(f, cv.CV_32F, 1 / 255); g.delete();
  return f;
}

function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Homography mapping points of `mov` into `ref` (AKAZE + RANSAC, then ECC).
    Returns {H, inliers, ok}. Both arguments are RGBA images. */
function register(cv, mov, ref) {
  const gm = grayF(cv, mov), gr = grayF(cv, ref);
  const s = Math.min(1, 1400 / Math.max(gm.cols, gm.rows, gr.cols, gr.rows));
  const small = g => {
    const r = new cv.Mat(); cv.resize(g, r, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    const u = new cv.Mat(); r.convertTo(u, cv.CV_8U, 255); r.delete(); return u;
  };
  const a = small(gm), b = small(gr);
  const ak = new cv.AKAZE(); ak.setThreshold(0.0005);
  const k1 = new cv.KeyPointVector(), k2 = new cv.KeyPointVector(), d1 = new cv.Mat(), d2 = new cv.Mat();
  const none = new cv.Mat();
  ak.detectAndCompute(a, none, k1, d1); ak.detectAndCompute(b, none, k2, d2);
  let H = [1, 0, 0, 0, 1, 0, 0, 0, 1], inliers = 0;
  if (k1.size() >= 10 && k2.size() >= 10) {
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), mv = new cv.DMatchVectorVector();
    bf.knnMatch(d1, d2, mv, 2);
    const p1 = [], p2 = [];
    for (let i = 0; i < mv.size(); i++) {
      const m = mv.get(i);
      if (m.size() === 2) {
        const x = m.get(0), y = m.get(1);
        if (x.distance < 0.8 * y.distance) { const q = k1.get(x.queryIdx).pt, t = k2.get(x.trainIdx).pt; p1.push(q.x, q.y); p2.push(t.x, t.y); }
      }
      m.delete();
    }
    mv.delete(); bf.delete();
    if (p1.length >= 20) {
      const P1 = cv.matFromArray(p1.length / 2, 1, cv.CV_32FC2, p1), P2 = cv.matFromArray(p2.length / 2, 1, cv.CV_32FC2, p2);
      const inl = new cv.Mat();
      const Hm = cv.findHomography(P1, P2, cv.RANSAC, 2.0, inl, 5000, 0.999);
      if (Hm && !Hm.empty()) {
        const S = [s, 0, 0, 0, s, 0, 0, 0, 1], Si = [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1];
        H = mul3(mul3(Si, Array.from(Hm.data64F)), S); inliers = cv.countNonZero(inl);
      }
      if (Hm) Hm.delete(); inl.delete(); P1.delete(); P2.delete();
    }
  }
  [a, b, d1, d2, none].forEach(m => m.delete()); k1.delete(); k2.delete(); ak.delete();

  // ECC fine-tune on intensity at up to 1600 px (sub-pixel, needed for 1:1 crops)
  let ok = false;
  const es = Math.min(1, 1600 / Math.max(gr.cols, gr.rows));
  const R = new cv.Mat(), M = new cv.Mat();
  cv.resize(gr, R, new cv.Size(0, 0), es, es, cv.INTER_AREA); cv.resize(gm, M, new cv.Size(0, 0), es, es, cv.INTER_AREA);
  const S = [es, 0, 0, 0, es, 0, 0, 0, 1], Si = [1 / es, 0, 0, 0, 1 / es, 0, 0, 0, 1];
  // ECC warp maps template (ref) coordinates to input (mov) coordinates
  const Wm = cv.matFromArray(3, 3, cv.CV_32F, mul3(mul3(S, inv3(H)), Si));
  try {
    const mask = new cv.Mat();
    cv.findTransformECC(R, M, Wm, cv.MOTION_HOMOGRAPHY, new cv.TermCriteria(3, 100, 1e-6), mask, 3);
    mask.delete();
    const Hn = inv3(mul3(mul3(Si, Array.from(Wm.data32F)), S));
    if (Hn.every(isFinite) && Math.abs(Hn[2] - H[2]) + Math.abs(Hn[5] - H[5]) < 0.05 * Math.max(gr.cols, gr.rows)) { H = Hn; ok = true; }
  } catch (e) { /* keep feature homography */ }
  [R, M, Wm, gm, gr].forEach(m => m.delete());
  return { H, inliers, ok };
}

/** Warp an RGBA image by H into a canvas of size (w, h); also returns a validity mask. */
function warpRGBA(cv, img, H, w, h) {
  const src = cv.matFromArray(img.height, img.width, cv.CV_8UC4, img.data);
  const Hm = cv.matFromArray(3, 3, cv.CV_64F, H);
  const out = new cv.Mat(); cv.warpPerspective(src, out, Hm, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const ones = new cv.Mat(img.height, img.width, cv.CV_8U, new cv.Scalar(255));
  const vm = new cv.Mat(); cv.warpPerspective(ones, vm, Hm, new cv.Size(w, h), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const k = cv.Mat.ones(5, 5, cv.CV_8U); cv.erode(vm, vm, k); k.delete();
  const res = { data: new Uint8ClampedArray(out.data), width: w, height: h, valid: new Uint8Array(vm.data) };
  [src, Hm, out, ones, vm].forEach(m => m.delete());
  return res;
}

module.exports = { ROOT, needSharp, loadCv, burstPhotos, decodeLikeApp, readRGBA, writeRGBA, grayF, register, warpRGBA, mul3, inv3 };
