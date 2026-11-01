/* Memory probe for the Spood Stacker engine: how big the WebAssembly heap gets, stage by stage.
   node tools/memprobe.js --cv <opencv.js> --engine <engine.js> --burst <dir> --side <maxSide> --out <prefix>
                          [--n <first N photos>] [--keepall] [--lazy] [--store disk] [--strips <rows>]
   --lazy        decode each photo only when the engine reaches it (as the app does)
   --store disk  park big images in files instead of memory (stands in for the app's scratch file)
   --strips N    merge in strips of N rows
   Writes <prefix>.png (unless it failed) and <prefix>.json: heap high-water per stage, time, log, error.
   The stock OpenCV.js grows its heap in big steps; for the true peak use an exact-growth build:
     python3 tools/patch_cv.py vendor/opencv-4.10.0-2g.js /tmp/opencv-measure.js 2047 exact */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const TOOLS = __dirname;
const { burstPhotos, decodeLikeApp, writeRGBA } = require(path.join(TOOLS, 'lib'));

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);

function loadCv(p) {
  return new Promise(resolve => {
    const cv = require(path.resolve(p));
    const fin = c => { try { delete c.then; } catch (e) {} resolve(c); };
    if (cv.Mat) fin(cv); else if (typeof cv.then === 'function') cv.then(fin); else cv.onRuntimeInitialized = () => fin(cv);
  });
}
function loadEngine(p) {
  const mod = { exports: {} };
  vm.runInThisContext('(function (module, exports) {' + fs.readFileSync(p, 'utf8') + '\n})', { filename: p }).call({}, mod, mod.exports);
  return mod.exports;
}

async function main() {
  const cvPath = arg('cv'), enginePath = arg('engine'), burst = arg('burst'), side = +arg('side', 3000), out = arg('out');
  const cv = await loadCv(cvPath);
  const engine = loadEngine(enginePath);
  let photos = burstPhotos(burst);
  if (arg('n')) photos = photos.slice(0, +arg('n'));
  const frames = [];
  if (flag('lazy')) {
    // decoded only when the engine asks (frame.read()), as the app could do inside the worker
    const sharp = require(path.join(TOOLS, 'node_modules', 'sharp'));
    for (const p of photos) {
      const meta = await sharp(p).metadata(), swap = (meta.orientation || 1) >= 5;
      const w0 = swap ? meta.height : meta.width, h0 = swap ? meta.width : meta.height, s = Math.min(1, side / Math.max(w0, h0));
      frames.push({ width: Math.round(w0 * s), height: Math.round(h0 * s), srcPixels: w0 * h0, taken: null, read: async () => (await decodeLikeApp(p, side)).data });
    }
  } else for (const p of photos) frames.push(await decodeLikeApp(p, side));
  let store = null;
  if (arg('store') === 'disk') {
    // parked images in files (stands in for OPFS in the browser), ranged reads and writes
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'park-')); let seq = 0;
    store = {
      put: u => { const f = path.join(dir, String(seq++)); const fd = fs.openSync(f, 'w+'); fs.writeSync(fd, u, 0, u.length, 0); return { fd, f, len: u.length }; },
      get: (h, off = 0, len = h.len - off) => { const b = Buffer.allocUnsafe(len); fs.readSync(h.fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); },
      set: (h, off, u) => { fs.writeSync(h.fd, u, 0, u.length, off); },
      drop: h => { try { fs.closeSync(h.fd); fs.unlinkSync(h.f); } catch (e) {} }
    };
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
  }
  const MiB = x => Math.round(x / 1048576);
  const heap = () => cv.HEAP8.length;
  const startHeap = heap();
  const timeline = [];          // every time the heap grew: at which stage
  const stagePeak = {};         // heap at the end of each stage
  let lastStage = 'start', lastHeap = startHeap, jsPeak = 0;
  const stageStart = {};        // seconds from the start when each stage began
  const sample = (p, s) => {
    const h = heap();
    if (s) lastStage = s.replace(/ \(\d+ of \d+\)/, '');
    if (!(lastStage in stageStart)) stageStart[lastStage] = +((Date.now() - (global.__t0 || Date.now())) / 1000).toFixed(1);
    if (h > lastHeap) { timeline.push({ stage: lastStage, p: +p.toFixed(3), heapMiB: MiB(h) }); lastHeap = h; }
    stagePeak[lastStage] = MiB(h);
    const mu = process.memoryUsage(); jsPeak = Math.max(jsPeak, mu.rss);
  };
  const log = [];
  const t0 = Date.now(); global.__t0 = t0;
  let res = null, err = null;
  try {
    res = await engine.stackFrames(cv, frames, { maxSide: side, keepAll: flag('keepall'), store, stripRows: +arg('strips', 0),
      onProgress: sample, onLog: m => { log.push(m); sample(0, null); } });
  } catch (e) {
    err = typeof e === 'number' && cv.exceptionFromPtr ? cv.exceptionFromPtr(e).msg : (e && e.message) || String(e);
  }
  sample(1, null);
  const secs = (Date.now() - t0) / 1000;
  const W = frames[0].width, H = frames[0].height;
  const info = {
    cv: path.basename(cvPath), engine: path.basename(enginePath), burst: path.basename(burst), n: photos.length,
    side, frame: `${W}x${H}`, ok: !err, error: err, secs,
    heapStartMiB: MiB(startHeap), heapPeakMiB: MiB(heap()), rssPeakMiB: MiB(jsPeak),
    result: res ? `${res.width}x${res.height}` : null, stagePeak, stageStart, timeline, log
  };
  if (res) await writeRGBA(out + '.png', res);
  fs.writeFileSync(out + '.json', JSON.stringify(info, null, 1));
  console.log(JSON.stringify({ ok: info.ok, error: err && err.slice(0, 120), n: info.n, frame: info.frame, secs, heapPeakMiB: info.heapPeakMiB, rssPeakMiB: info.rssPeakMiB, result: info.result, stagePeak, stageStart }));
}
main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
