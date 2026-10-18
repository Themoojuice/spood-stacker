#!/usr/bin/env node
/* Compare two versions of the stacking engine on the same bursts.

   node tools/compare.js [options] [burst folders...]

   --a SPEC     baseline   (default: git:gold if that tag exists, else git:HEAD)
   --b SPEC     candidate  (default: engine.js as it is on disk now)
                SPEC is a file path, git:<ref> (engine.js at that commit/tag/branch),
                or py:<path to stacker.py> (the laptop version)
   --size N     working size, long side in pixels (default 3000, like the app)
   --crops N    close-up crops per burst (default 6)
   --out DIR    where the contact sheets go (default compare-out/<time>)
   --fresh      re-run everything (results are otherwise cached per engine version)

   Bursts default to every folder under tests/bursts/. A burst folder holds the
   photos, plus optionally truth/NN.png (synthetic all-in-focus answer in frame NN's
   geometry) or gold.jpg (e.g. a Zerene/Helicon stack of the same burst).

   For each burst it writes a contact sheet: both results, a map of where they
   differ, and 1:1 close-ups of the regions that differ most (with the truth or
   gold image beside them when there is one), plus index.html with the numbers. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const L = require('./lib');

const args = process.argv.slice(2);
const opt = { size: 3000, crops: 6, fresh: false, bursts: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--a') opt.a = args[++i];
  else if (a === '--b') opt.b = args[++i];
  else if (a === '--size') opt.size = +args[++i];
  else if (a === '--crops') opt.crops = +args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--fresh') opt.fresh = true;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('/*', '')); process.exit(0); }
  else opt.bursts.push(a);
}

const git = (...a) => execFileSync('git', ['-C', L.ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const hasTag = t => { try { git('rev-parse', '--verify', '--quiet', `refs/tags/${t}`); return true; } catch (e) { return false; } };
opt.a = opt.a || (hasTag('gold') ? 'git:gold' : 'git:HEAD');
opt.b = opt.b || 'engine.js';

const CACHE = path.join(L.ROOT, 'tests', '.cache');
fs.mkdirSync(CACHE, { recursive: true });

/** Turn a SPEC into something runnable: {label, kind, file, hash}. */
function resolve(spec) {
  if (spec.startsWith('git:')) {
    const ref = spec.slice(4);
    let src, sha;
    try { src = git('show', `${ref}:engine.js`); sha = git('rev-parse', '--short', ref).trim(); }
    catch (e) { throw new Error(`No engine.js at git ref "${ref}"`); }
    const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
    const file = path.join(CACHE, `engine-${hash}.js`);
    fs.writeFileSync(file, src);
    return { label: `${ref} (${sha})`, kind: 'js', file, hash };
  }
  if (spec.startsWith('py:')) {
    const file = path.resolve(spec.slice(3));
    const hash = 'py' + crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    return { label: `${path.basename(file)} (Python)`, kind: 'py', file, hash };
  }
  const file = path.resolve(spec);
  const src = fs.readFileSync(file);
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  const rel = path.relative(L.ROOT, file);
  let label = rel && !rel.startsWith('..') ? rel : path.basename(file);
  try { if (git('diff', '--quiet', 'HEAD', '--', file) === '') label += ' (committed)'; } catch (e) { label += ' (uncommitted changes)'; }
  return { label, kind: 'js', file, hash };
}

function burstKey(dir) {
  const h = crypto.createHash('sha1');
  for (const p of L.burstPhotos(dir)) { const s = fs.statSync(p); h.update(p + s.size + s.mtimeMs); }
  return h.digest('hex').slice(0, 10);
}

/** Run one engine on one burst (or reuse the cached result). */
function runEngine(eng, dir) {
  const prefix = path.join(CACHE, `${eng.hash}-${opt.size}-${path.basename(dir)}-${burstKey(dir)}`);
  if (!opt.fresh && fs.existsSync(prefix + '.json') && fs.existsSync(prefix + '.png')) {
    return Object.assign(JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')), { png: prefix + '.png', cached: true });
  }
  process.stdout.write(`  running ${eng.label} on ${path.basename(dir)} … `);
  const t0 = Date.now();
  let r;
  if (eng.kind === 'js') {
    r = spawnSync(process.execPath, ['--max-old-space-size=6000', path.join(__dirname, 'run-engine.js'), eng.file, dir, String(opt.size), prefix],
      { encoding: 'utf8', env: process.env });
  } else {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    r = spawnSync(py, [eng.file, dir, '-o', prefix + '.png', '--max-side', String(opt.size), '--no-exif'], { encoding: 'utf8' });
    if (r.status === 0) {
      const m = /reference: frame (\d+)/.exec(r.stdout) || [];
      fs.writeFileSync(prefix + '.json', JSON.stringify({ secs: (Date.now() - t0) / 1000, ref: +(m[1] || 0), log: r.stdout.split('\n'), selection: null }));
    }
  }
  if (r.status !== 0) { console.log('failed'); throw new Error((r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')); }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return Object.assign(JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')), { png: prefix + '.png', cached: false });
}

// ---------- measurements ----------
function toMatF(cv, img) {
  const m = cv.matFromArray(img.height, img.width, cv.CV_8UC4, img.data);
  const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY); m.delete();
  const f = new cv.Mat(); g.convertTo(f, cv.CV_32F, 1 / 255); g.delete(); return f;
}

/** PSNR (colour) and SSIM (grey) of `img` against `truth` warped into img's frame. */
function vsTruth(cv, img, truthW) {
  const n = img.width * img.height, A = img.data, T = truthW.data, V = truthW.valid;
  let se = 0, cnt = 0;
  const use = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // skip the lens-clamp vignette: the stack crops it away anyway
    if (!V[i] || T[p] + T[p + 1] + T[p + 2] < 40) continue;
    use[i] = 1; cnt++;
    for (let c = 0; c < 3; c++) { const d = A[p + c] - T[p + c]; se += d * d; }
  }
  const psnr = 10 * Math.log10(255 * 255 / (se / Math.max(1, cnt * 3)));
  const x = toMatF(cv, img), y = toMatF(cv, truthW);
  const G = m => { const o = new cv.Mat(); cv.GaussianBlur(m, o, new cv.Size(0, 0), 1.5, 1.5); return o; };
  const xx = new cv.Mat(), yy = new cv.Mat(), xy = new cv.Mat();
  cv.multiply(x, x, xx); cv.multiply(y, y, yy); cv.multiply(x, y, xy);
  const mx = G(x), my = G(y), sxx = G(xx), syy = G(yy), sxy = G(xy);
  const MX = mx.data32F, MY = my.data32F, SXX = sxx.data32F, SYY = syy.data32F, SXY = sxy.data32F;
  const C1 = 0.01 ** 2, C2 = 0.03 ** 2;
  let ss = 0, k = 0;
  for (let i = 0; i < n; i++) {
    if (!use[i]) continue;
    const vx = SXX[i] - MX[i] * MX[i], vy = SYY[i] - MY[i] * MY[i], cxy = SXY[i] - MX[i] * MY[i];
    ss += ((2 * MX[i] * MY[i] + C1) * (2 * cxy + C2)) / ((MX[i] ** 2 + MY[i] ** 2 + C1) * (vx + vy + C2)); k++;
  }
  [x, y, xx, yy, xy, mx, my, sxx, syy, sxy].forEach(m => m.delete());
  return { psnr, ssim: ss / Math.max(1, k) };
}

/** Per-pixel difference (0..1) of two aligned images, lightly blurred so
    sub-pixel resampling noise does not count as a difference. */
function diffMap(cv, a, bW) {
  const x = toMatF(cv, a), y = toMatF(cv, bW);
  cv.GaussianBlur(x, x, new cv.Size(0, 0), 1.2, 1.2); cv.GaussianBlur(y, y, new cv.Size(0, 0), 1.2, 1.2);
  const d = new cv.Mat(); cv.absdiff(x, y, d); x.delete(); y.delete();
  // colour shifts count too (hue halos): add mean abs RGB difference
  const D = d.data32F, A = a.data, B = bW.data, V = bW.valid;
  for (let i = 0, p = 0; i < D.length; i++, p += 4) {
    if (!V[i]) { D[i] = 0; continue; }
    const c = (Math.abs(A[p] - B[p]) + Math.abs(A[p + 1] - B[p + 1]) + Math.abs(A[p + 2] - B[p + 2])) / (3 * 255);
    D[i] = Math.max(D[i], 0.5 * c);
  }
  return d;
}

/** Greedy pick of the K non-overlapping windows with the most of `score`. */
function pickCrops(cv, score, size, K) {
  const f = 4, w = Math.floor(score.cols / f), h = Math.floor(score.rows / f);
  const s = new cv.Mat(); cv.resize(score, s, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  const box = new cv.Mat(); const k = Math.max(3, Math.round(size / f)) | 1;
  cv.boxFilter(s, box, -1, new cv.Size(k, k), new cv.Point(-1, -1), true, cv.BORDER_CONSTANT);
  const B = box.data32F, half = Math.floor(k / 2), out = [];
  for (let n = 0; n < K; n++) {
    let bi = -1, bv = 0;
    for (let y = half; y < h - half; y++) for (let x = half; x < w - half; x++) { const v = B[y * w + x]; if (v > bv) { bv = v; bi = y * w + x; } }
    if (bi < 0 || bv <= 0) break;
    const cx = bi % w, cy = Math.floor(bi / w);
    out.push({ x: Math.max(0, Math.min(score.cols - size, cx * f - size / 2 | 0)), y: Math.max(0, Math.min(score.rows - size, cy * f - size / 2 | 0)), score: bv });
    for (let y = Math.max(0, cy - k); y < Math.min(h, cy + k); y++) for (let x = Math.max(0, cx - k); x < Math.min(w, cx + k); x++) B[y * w + x] = 0;
  }
  s.delete(); box.delete();
  return out;
}

function heat(cv, a, d, gain) {
  const n = a.width * a.height, out = new Uint8ClampedArray(n * 4), A = a.data, D = d.data32F;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = 0.22 * (0.3 * A[p] + 0.59 * A[p + 1] + 0.11 * A[p + 2]);
    const v = Math.min(1, D[i] * gain);
    out[p] = g + 255 * Math.min(1, v * 2); out[p + 1] = g + 255 * Math.max(0, v * 2 - 1); out[p + 2] = g + 160 * Math.sin(Math.PI * v); out[p + 3] = 255;
  }
  return { data: out, width: a.width, height: a.height };
}

function cropOf(img, c, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = c.y + y; if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < size; x++) {
      const sx = c.x + x; if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4, d = (y * size + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}

// ---------- the contact sheet ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = (x, y, s, size = 22, fill = '#e8ece9', weight = 400) =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;

async function rawPng(img, w, h) {
  const sharp = L.needSharp();
  let s = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } });
  if (w) s = s.resize(w, h, { kernel: 'lanczos3', fit: 'fill' });
  return s.png().toBuffer();
}

const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

/** A gain that makes the biggest differences bright whatever their size. */
function heatGain(d) {
  const v = Float32Array.from(d.data32F.filter((x, i) => i % 5 === 0 && x > 0)).sort();
  const p = v.length ? v[Math.floor(v.length * 0.995)] : 0;
  return Math.max(4, Math.min(200, Math.round(0.85 / (p || 1e-3))));
}

async function sheet(file, burst, A, B, imgA, imgB, refImg, refKind, d, crops, size, mA, mB, identical) {
  const sharp = L.needSharp();
  const pad = 20, ow = 600, oh = Math.round(ow * imgA.height / imgA.width);
  const cols = refImg ? 3 : 2, perRow = refImg ? 2 : 3, tile = size;
  const cropW = cols * tile + (cols - 1) * 6, rowW = perRow * cropW + (perRow - 1) * pad;
  const W = Math.max(3 * ow + 2 * pad, rowW) + 2 * pad;
  const head = 128, ovY = head, cropsY = ovY + oh + 70;
  const rows = Math.ceil(crops.length / perRow), Ht = cropsY + rows * (tile + 50) + pad + 40;
  const layers = [], svg = [];
  const ox = [pad, pad + ow + pad, pad + 2 * (ow + pad)];
  layers.push({ input: await rawPng(imgA, ow, oh), left: ox[0], top: ovY });
  layers.push({ input: await rawPng(imgB, ow, oh), left: ox[1], top: ovY });
  const gain = heatGain(d);
  layers.push({ input: await rawPng(heat(null, imgA, d, gain), ow, oh), left: ox[2], top: ovY });
  const fmt = (m, r) => [`${r.secs.toFixed(1)} s`, r.selection ? `${r.selection.used.length}/${r.photos ? r.photos.length : '?'} photos` : '',
    `ref ${r.ref}`, `${r.width}×${r.height}`, m ? `PSNR ${m.psnr.toFixed(2)} dB · SSIM ${m.ssim.toFixed(4)}` : ''].filter(Boolean).join(' · ');
  svg.push(text(pad, 40, burst, 30, '#ffffff', 700));
  svg.push(text(ox[0], 82, clip('A  ' + A.label, 52), 20, '#9fd6ff', 700), text(ox[0], 108, fmt(mA, A.run), 17, '#b8c2bc'));
  svg.push(text(ox[1], 82, clip('B  ' + B.label, 52), 20, '#ffcf8a', 700), text(ox[1], 108, fmt(mB, B.run), 17, '#b8c2bc'));
  svg.push(text(ox[2], 82, 'Where A and B differ', 20, '#ffffff', 700),
    text(ox[2], 108, identical ? 'nowhere: identical output' : `brighter = bigger difference (×${gain})`, 17, '#b8c2bc'));
  if (identical) svg.push(text(ox[1], 40, 'Identical output', 22, '#7fe0c0', 700));
  else if (mA && mB) {
    const dp = mB.psnr - mA.psnr, ds = mB.ssim - mA.ssim;
    const col = dp > 0.05 ? '#7fe0c0' : dp < -0.05 ? '#ff8a8a' : '#b8c2bc';
    svg.push(text(ox[1], 40, `B vs A against truth: ${dp >= 0 ? '+' : ''}${dp.toFixed(2)} dB PSNR, ${ds >= 0 ? '+' : ''}${ds.toFixed(4)} SSIM`, 22, col, 700));
  }
  const sx = ow / imgA.width;
  crops.forEach((c, i) => {
    for (const k of [0, 2]) svg.push(`<rect x="${ox[k] + c.x * sx}" y="${ovY + c.y * sx}" width="${size * sx}" height="${size * sx}" fill="none" stroke="#fff" stroke-width="2"/>`,
      text(ox[k] + c.x * sx + 4, ovY + c.y * sx + 20, String(i + 1), 18, '#fff', 700));
  });
  svg.push(text(pad, cropsY - 22, `Close-ups at 1:1, ${identical ? 'largest error against the ' + (refKind || 'reference') : 'largest A/B differences first'}` +
    `  ·  A | B${refImg ? ' | ' + refKind : ''}`, 20, '#ffffff', 700));
  for (let i = 0; i < crops.length; i++) {
    const r = Math.floor(i / perRow), q = i % perRow, x0 = pad + q * (cropW + pad), y0 = cropsY + r * (tile + 50);
    const set = [imgA, imgB].concat(refImg ? [refImg] : []);
    for (let j = 0; j < set.length; j++) layers.push({ input: await rawPng(cropOf(set[j], crops[i], size)), left: x0 + j * (tile + 6), top: y0 });
    svg.push(text(x0, y0 + tile + 24, `${i + 1}`, 18, '#fff', 700));
  }
  const svgBuf = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}">${svg.join('')}</svg>`);
  layers.push({ input: svgBuf, left: 0, top: 0 });
  await sharp({ create: { width: W, height: Ht, channels: 3, background: '#141917' } }).composite(layers).jpeg({ quality: 90 }).toFile(file);
}

async function main() {
  const A = resolve(opt.a), B = resolve(opt.b);
  let bursts = opt.bursts.map(b => path.resolve(b));
  if (!bursts.length) {
    const base = path.join(L.ROOT, 'tests', 'bursts');
    bursts = fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.statSync(d).isDirectory() && L.burstPhotos(d).length >= 2) : [];
  }
  if (!bursts.length) { console.error('No bursts. Put each burst in its own folder under tests/bursts/, or name folders on the command line.'); process.exit(2); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const out = path.resolve(opt.out || path.join(L.ROOT, 'compare-out', stamp));
  fs.mkdirSync(out, { recursive: true });
  console.log(`A: ${A.label}\nB: ${B.label}\n${bursts.length} burst(s), working size ${opt.size}px → ${out}`);
  const cv = await L.loadCv();
  const rows = [];
  for (const dir of bursts) {
    const name = path.basename(dir);
    console.log(`\n${name}`);
    let ra, rb;
    try { ra = runEngine(A, dir); rb = runEngine(B, dir); }
    catch (e) { console.log('  ' + e.message.replace(/\n/g, '\n  ')); rows.push({ name, error: e.message }); continue; }
    A.run = ra; B.run = rb;
    const imgA = await L.readRGBA(ra.png), imgB = await L.readRGBA(rb.png);
    ra.width = imgA.width; ra.height = imgA.height; rb.width = imgB.width; rb.height = imgB.height;
    const reg = L.register(cv, imgB, imgA);
    const bW = L.warpRGBA(cv, imgB, reg.H, imgA.width, imgA.height);
    const d = diffMap(cv, imgA, bW);
    const D = d.data32F; let sum = 0, big = 0, mx = 0;
    for (const v of D) { sum += v; if (v > 6 / 255) big++; if (v > mx) mx = v; }
    const meanDiff = sum / D.length * 255, changedPct = 100 * big / D.length;
    const identical = mx < 1.5 / 255;

    // truth (synthetic) or gold (another stacker's output) to show beside the crops
    let refImg = null, refKind = '', mA = null, mB = null;
    const truthFor = r => { const f = path.join(dir, 'truth', String(r.ref).padStart(2, '0') + '.png'); return r.ref && fs.existsSync(f) ? f : null; };
    const goldFile = fs.readdirSync(dir).find(f => /^(gold|zerene|helicon)[^/]*\.(jpe?g|png|tiff?)$/i.test(f));
    if (truthFor(ra) || truthFor(rb)) {
      refKind = 'truth';
      for (const [r, img, set] of [[ra, imgA, 'A'], [rb, imgB, 'B']]) {
        const tf = truthFor(r); if (!tf) continue;
        const t = await L.readRGBA(tf, opt.size), rg = L.register(cv, t, img), tw = L.warpRGBA(cv, t, rg.H, img.width, img.height);
        const m = vsTruth(cv, img, tw);
        if (set === 'A') { mA = m; refImg = tw; } else mB = m;
      }
      if (!refImg && truthFor(rb)) { const t = await L.readRGBA(truthFor(rb), opt.size); refImg = L.warpRGBA(cv, t, L.register(cv, t, imgA).H, imgA.width, imgA.height); }
    } else if (goldFile) {
      refKind = goldFile.replace(/\.[^.]+$/, '');
      const g = await L.readRGBA(path.join(dir, goldFile), opt.size);   // gold stacks are often full size
      refImg = L.warpRGBA(cv, g, L.register(cv, g, imgA).H, imgA.width, imgA.height);
    }

    const size = Math.max(160, Math.min(360, Math.round(Math.min(imgA.width, imgA.height) / 4)));
    let score = d;
    if (identical && refImg) {          // nothing to compare: show where both miss the truth most
      score = diffMap(cv, imgA, refImg);
    }
    const crops = pickCrops(cv, score, size, opt.crops);
    if (score !== d) score.delete();
    const file = path.join(out, `${name}.jpg`);
    await sheet(file, name, A, B, imgA, bW, refImg, refKind, d, crops, size, mA, mB, identical);
    d.delete();
    const row = { name, a: { secs: ra.secs, ref: ra.ref, used: ra.selection && ra.selection.used.length, size: [ra.width, ra.height], ...(mA || {}) },
      b: { secs: rb.secs, ref: rb.ref, used: rb.selection && rb.selection.used.length, size: [rb.width, rb.height], ...(mB || {}) },
      meanDiff, changedPct, identical, registration: { inliers: reg.inliers, ecc: reg.ok }, sheet: path.basename(file) };
    rows.push(row);
    console.log(`  ${identical ? 'identical' : `differs: mean ${meanDiff.toFixed(2)}/255, ${changedPct.toFixed(2)}% of pixels by more than 6/255`}` +
      (mA && mB ? ` · PSNR vs truth A ${mA.psnr.toFixed(2)} → B ${mB.psnr.toFixed(2)} dB · SSIM ${mA.ssim.toFixed(4)} → ${mB.ssim.toFixed(4)}` : '') +
      `\n  sheet: ${file}`);
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ a: A.label, b: B.label, size: opt.size, rows }, null, 1));
  fs.writeFileSync(path.join(out, 'index.html'), indexHtml(A, B, rows));
  console.log(`\nIndex: ${path.join(out, 'index.html')}`);
}

function indexHtml(A, B, rows) {
  const n = (v, d = 2) => (v === undefined || v === null || Number.isNaN(v)) ? '–' : (+v).toFixed(d);
  const delta = (a, b, d) => (a === undefined || b === undefined) ? '' : `<b class="${b - a > 0 ? 'up' : b - a < 0 ? 'down' : ''}">${b - a >= 0 ? '+' : ''}${(b - a).toFixed(d)}</b>`;
  const tr = rows.map(r => r.error ? `<tr><td>${esc(r.name)}</td><td colspan="6" class="down">${esc(r.error)}</td></tr>` : `<tr>
    <td><a href="#${esc(r.name)}">${esc(r.name)}</a></td>
    <td>${r.identical ? '<span class="same">identical</span>' : `${n(r.changedPct)}% changed`}</td>
    <td>${n(r.a.psnr)} → ${n(r.b.psnr)} ${delta(r.a.psnr, r.b.psnr, 2)}</td>
    <td>${n(r.a.ssim, 4)} → ${n(r.b.ssim, 4)} ${delta(r.a.ssim, r.b.ssim, 4)}</td>
    <td>${n(r.a.secs, 1)} → ${n(r.b.secs, 1)} s</td>
    <td>${r.a.used ?? '–'} → ${r.b.used ?? '–'}</td></tr>`).join('');
  const imgs = rows.filter(r => !r.error).map(r => `<h2 id="${esc(r.name)}">${esc(r.name)}</h2><a href="${esc(r.sheet)}"><img src="${esc(r.sheet)}" alt="Contact sheet for ${esc(r.name)}"></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Engine compare</title>
<style>body{margin:0;padding:20px 16px;background:#141917;color:#e8ece9;font:15px/1.5 system-ui,sans-serif}main{max-width:1900px;margin:0 auto}
table{border-collapse:collapse;margin:12px 0 24px}td,th{padding:6px 12px;border-bottom:1px solid #2c3733;text-align:left}th{color:#9aa8a0;font-weight:600}
a{color:#7fd3cb}img{max-width:100%;height:auto;border-radius:8px}.up{color:#7fe0c0}.down{color:#ff8a8a}.same{color:#7fe0c0}code{color:#ffcf8a}</style></head>
<body><main><h1>Engine compare</h1><p>A: <code>${esc(A.label)}</code><br>B: <code>${esc(B.label)}</code><br>Working size ${opt.size}px. PSNR/SSIM are against the synthetic truth (higher is better); blank where a burst has none.</p>
<table><tr><th>Burst</th><th>A vs B</th><th>PSNR dB (A → B)</th><th>SSIM (A → B)</th><th>Time</th><th>Photos used</th></tr>${tr}</table>${imgs}</main></body></html>`;
}

main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
