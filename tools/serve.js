/* Stacking server: the phone sends a burst, this computer stacks it with the same engine the app
   uses (engine.js, OpenCV.js, several cores) and hands the result back. For stacking off the phone:
   on a laptop at home, or any always-on machine.

     cd tools && npm install          (once)
     node tools/serve.js [--port 8790] [--helpers N]

   Then open http://<this computer's address>:8790 on the phone (same Wi-Fi), pick the photos and
   go: the page shows the progress and the result, and the phone is free while it works.
   From elsewhere: put the computer on Tailscale and use its https://<name>.ts.net address
   (`tailscale serve 8790`), which also lets the installed app talk to it.

   API (what the page uses; the app can use the same):
     POST /stack        body: 4-byte big-endian header length, JSON header
                        { files: [{ name, size, taken }], opts: { tame } }, then the files' bytes
                        -> { id }
     GET  /jobs/<id>    -> { state: queued|reading|stacking|done|failed, p, stage, log, result, error }
     GET  /jobs/<id>/stack.png   the stack, unsharpened, lossless (for the app to finish like its own)
     GET  /jobs/<id>/stack.jpg   the stack sharpened like the app's default and saved at quality 95, 4:4:4,
                                 with the reference photo's EXIF (date, GPS, camera) */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { loadCv, decodeLikeApp } = require('./lib');
const sharp = require('sharp');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 8790);
const HELPERS = +arg('helpers', Math.max(0, Math.min(4, os.cpus().length - 1)));
const engine = require(path.join(ROOT, 'engine.js'));
const jobs = new Map(), queue = [];
let busy = false, cvP = loadCv(), poolP = HELPERS ? require('./pool-node').makePool(HELPERS, path.join(ROOT, 'engine.js')) : Promise.resolve(null);

/** parked images in files (as the app parks them in its scratch file), shareable by the helper threads */
function diskStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spood-park-')); let seq = 0;
  return {
    dir, shareable: true,
    put: u => { const f = path.join(dir, String(seq++)); const fd = fs.openSync(f, 'w+'); fs.writeSync(fd, u, 0, u.length, 0); return { fd, f, len: u.length }; },
    alloc: len => { const f = path.join(dir, String(seq++)); const fd = fs.openSync(f, 'w+'); fs.ftruncateSync(fd, len); return { fd, f, len }; },
    get: (h, off = 0, len = h.len - off) => { const b = Buffer.allocUnsafe(len); fs.readSync(h.fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); },
    read: (h, off, dst) => { fs.readSync(h.fd, dst, 0, dst.length, off); },
    set: (h, off, u) => { fs.writeSync(h.fd, u, 0, u.length, off); },
    drop: h => { if (!h || h.dropped) return; h.dropped = true; try { fs.closeSync(h.fd); fs.unlinkSync(h.f); } catch (e) { /* gone */ } },
    close() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

async function stackJob(job) {
  const cv = await cvP, pool = await poolP, t0 = Date.now();
  const say = m => { job.log.push(m); if (job.log.length > 200) job.log.shift(); };
  const store = diskStore();
  try {
    job.state = 'stacking';
    // each photo's displayed size (EXIF orientation applied), then the app's own memory plan
    const native = [];
    for (const f of job.files) { const m = await sharp(f.path).metadata(); const sw = (m.orientation || 1) >= 5; native.push({ width: sw ? m.height : m.width, height: sw ? m.width : m.height }); }
    const plan = engine.planSize(native, { maxSide: Infinity, heapCapMiB: 4096, helpers: pool ? pool.size : 0 });
    say(`working size ${plan.width}×${plan.height} on ${pool ? pool.size + ' helper threads' : 'one thread'}`);
    const frames = job.files.map((f, i) => {
      const s = Math.min(1, plan.side / Math.max(native[i].width, native[i].height));
      return { width: Math.round(native[i].width * s), height: Math.round(native[i].height * s), srcPixels: native[i].width * native[i].height, taken: f.taken,
        read: async () => (await decodeLikeApp(f.path, plan.side)).data };
    });
    const out = await engine.stackFrames(cv, frames, {
      maxSide: plan.side, stripRows: plan.stripRows, store, sharpen: 0, tame: !!job.opts.tame,
      pool: pool ? { size: pool.size, limits: plan.limits, cores: os.cpus().length, run: (n, a, p) => pool.run(n, a, p) } : undefined,
      onProgress: (p, s) => { job.p = p; if (s) job.stage = s; },
      onLog: say,
      onSelection: s => { job.selection = s; }
    });
    const png = path.join(job.dir, 'stack.png'), jpg = path.join(job.dir, 'stack.jpg');
    const raw = sharp(Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length), { raw: { width: out.width, height: out.height, channels: 4 } });
    await raw.clone().png({ compressionLevel: 3 }).toFile(png);
    // the finished JPEG: sharpened (roughly the app's 70% default; the app re-sharpens its own copy),
    // full colour detail, and the reference photo's EXIF so iNaturalist can read date and place
    const ref = job.files[(out.ref || 1) - 1], E = require(path.join(ROOT, 'exif.js'));
    let jb = await raw.clone().removeAlpha().sharpen({ sigma: 1.0, m1: 0, m2: 0.7 }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    try {                                                 // the reference photo's EXIF, with the new size (as the app does)
      const tiff = E.readExif(fs.readFileSync(ref.path).subarray(0, 1 << 20));
      if (tiff) jb = Buffer.from(E.insertExif(new Uint8Array(jb), E.patchExif(tiff, out.width, out.height)));
    } catch (e) { say('could not copy the EXIF: ' + e.message); }
    fs.writeFileSync(jpg, jb);
    job.result = { width: out.width, height: out.height, ref: out.ref, selection: job.selection || null, secs: (Date.now() - t0) / 1000 };
    job.state = 'done'; job.p = 1; job.stage = 'Done';
    say(`stacked ${job.files.length} photos in ${job.result.secs.toFixed(0)} s → ${out.width}×${out.height}`);
  } catch (e) {
    job.state = 'failed'; job.error = typeof e === 'number' ? `OpenCV error ${e}` : (e && e.message) || String(e); say('failed: ' + job.error);
  } finally {
    store.close();
    // photos are kept only while the job is fresh; the result stays an hour
    for (const f of job.files) fs.rm(f.path, { force: true }, () => {});
    setTimeout(() => { fs.rmSync(job.dir, { recursive: true, force: true }); jobs.delete(job.id); }, 3600e3).unref();
  }
}
async function pump() { if (busy || !queue.length) return; busy = true; const job = queue.shift(); await stackJob(job); busy = false; pump(); }

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

/** the upload: header length, JSON header, then each file's bytes, streamed to disk */
function receive(req, res) {
  const id = Math.random().toString(36).slice(2, 10), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spood-job-'));
  const job = { id, dir, state: 'reading', p: 0, stage: 'Receiving photos', log: [], files: [], opts: {}, at: Date.now() };
  let head = null, buf = Buffer.alloc(0), hlen = -1, fi = 0, left = 0, fd = null, got = 0;
  const nextFile = () => {
    while (head && fi < head.files.length && left === 0) {
      if (fd !== null) { fs.closeSync(fd); fd = null; fi++; if (fi >= head.files.length) return; }
      const f = head.files[fi], p = path.join(dir, String(fi).padStart(3, '0') + path.extname(f.name || '.jpg').toLowerCase());
      job.files.push({ path: p, name: f.name, taken: f.taken == null ? null : +f.taken });
      fd = fs.openSync(p, 'w'); left = f.size;
      if (left === 0) continue;
    }
  };
  req.on('data', chunk => {
    got += chunk.length;
    if (!head) {
      buf = Buffer.concat([buf, chunk]);
      if (hlen < 0 && buf.length >= 4) hlen = buf.readUInt32BE(0);
      if (hlen < 0 || buf.length < 4 + hlen) return;
      head = JSON.parse(buf.subarray(4, 4 + hlen).toString('utf8')); job.opts = head.opts || {};
      chunk = buf.subarray(4 + hlen); buf = null; nextFile();
    }
    let off = 0;
    while (off < chunk.length && fd !== null) {
      const n = Math.min(left, chunk.length - off);
      fs.writeSync(fd, chunk, off, n); off += n; left -= n;
      if (left === 0) nextFile();
    }
    if (head) job.p = 0; job.stage = `Receiving photos (${(got / 1048576).toFixed(0)} MB)`;
  });
  req.on('end', () => {
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    if (!head || job.files.length < 2) { send(res, 400, { error: 'Send at least 2 photos.' }); return; }
    job.state = 'queued'; job.stage = queue.length || busy ? 'Waiting for the previous stack' : 'Starting';
    jobs.set(id, job); queue.push(job); pump();
    send(res, 200, { id });
  });
  req.on('error', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true' }); res.end(); return; }
  if (req.method === 'POST' && u.pathname === '/stack') return receive(req, res);
  const m = u.pathname.match(/^\/jobs\/([a-z0-9]+)(\/stack\.(png|jpg))?$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'No such stack (results are kept for an hour).' });
    if (!m[2]) return send(res, 200, { state: job.state, p: job.p, stage: job.stage, log: job.log.slice(-12), result: job.result || null, error: job.error || null, queued: queue.indexOf(job) + 1 });
    if (job.state !== 'done') return send(res, 409, { error: 'Not ready yet.' });
    const f = path.join(job.dir, 'stack.' + m[3]);
    res.writeHead(200, { 'Content-Type': m[3] === 'png' ? 'image/png' : 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': `inline; filename="spood-stack-${job.id}.${m[3]}"` });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === '/' || u.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(__dirname, 'serve-page.html')), 'text/html; charset=utf-8');
  send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  console.log(`Spood Stacker server: ${HELPERS} helper threads. Open on the phone (same Wi-Fi):`);
  for (const a of addrs) console.log(`  http://${a}:${PORT}`);
});
