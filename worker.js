/* Runs the stacking engine off the main thread so the screen stays responsive.
   The page hands over the photo files themselves; each is decoded here only when the
   engine reaches it, so a long burst never sits in memory as full-size pixels at once. */
importScripts('cvload.js', 'exif.js', 'engine.js');

/* Helpers: up to 4 more workers, each with its own OpenCV, that run the heavy per-photo and
   per-strip steps side by side (the phone has the cores; one worker uses one). They read and
   write parked images in the same scratch file. Started now, so they are ready by the time a
   stack starts. */
const HELPERS = new URLSearchParams(self.location.search).has('helpers')            // a test can set the number
  ? Math.max(0, Math.min(8, +new URLSearchParams(self.location.search).get('helpers') || 0))
  : Math.min(4, Math.max(1, navigator.hardwareConcurrency || 4), (navigator.deviceMemory || 8) <= 4 ? 2 : 4);
class HelperPool {
  constructor(n) {
    this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this.seq = 0; this.heaps = new Map();
    this.ready = Promise.all([...Array(n)].map(() => new Promise(resolve => {
      const w = new Worker('helper.js');
      w.onmessage = e => {
        const m = e.data;
        if (m.ready) { this.workers.push(w); this.idle.push(w); resolve(); this.pump(); return; }
        if ('progress' in m) { const job = this.pending.get(m.id); if (job && job.onProgress) job.onProgress(m.progress); return; }
        const job = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.heap) this.heaps.set(w, m.heap);
        if (job.broadcast) job.w = null; else this.idle.push(w);
        if (m.error) job.reject(new Error(m.error)); else job.resolve(m.result);
        this.pump();
      };
      w.onerror = e => { e.preventDefault(); resolve(); for (const job of this.pending.values()) job.reject(new Error(e.message || 'A helper stopped.')); this.pending.clear(); };
    })));
  }
  get size() { return this.workers.length; }
  stop() { this.workers.forEach(w => w.terminate()); this.workers = []; this.idle = []; }
  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), job = this.queue.shift();
      this.pending.set(job.id, job);
      w.postMessage({ id: job.id, name: job.name, args: job.args });
    }
  }
  run(name, args, onProgress) { return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, name, args, resolve, reject, onProgress }); this.pump(); }); }
  /** the same message to every helper (open or close the scratch file), once none is busy */
  all(msg) {
    return Promise.all(this.workers.map(w => new Promise((resolve, reject) => {
      const id = ++this.seq; this.pending.set(id, { resolve, reject, broadcast: true });
      w.postMessage(Object.assign({ id }, msg));
    })));
  }
}
let pool = null;
cvReady.then(() => { try { pool = HELPERS ? new HelperPool(HELPERS) : null; } catch (e) { pool = null; } });

cvReady.then(() => postMessage({ type: 'ready', simd: SIMD }));

const cantOpen = f => new Error(`Could not open ${f.name}. If it is a HEIC photo, set the camera to save JPEG.`);

/** Width and height as displayed (EXIF orientation applied), from the file's header;
    falls back to decoding it once. */
async function imageSize(file) {
  try {
    const u8 = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
    const s = headerSize(u8);
    if (s) return s;
  } catch (e) { /* fall through */ }
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { throw cantOpen(file); }
  const s = { width: bmp.width, height: bmp.height }; bmp.close();
  return s;
}
function headerSize(u8) {
  const be16 = p => (u8[p] << 8) | u8[p + 1], be32 = p => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  const le16 = p => u8[p] | (u8[p + 1] << 8), le24 = p => u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
  if (u8[0] === 0xFF && u8[1] === 0xD8) {                       // JPEG: the frame header, then EXIF orientation
    let p = 2, size = null;
    while (p + 9 < u8.length) {
      if (u8[p] !== 0xFF) return null;
      const m = u8[p + 1];
      if (m === 0xFF) { p++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      if (m === 0xDA || m === 0xD9) break;
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { size = { height: be16(p + 5), width: be16(p + 7) }; break; }
      p += 2 + be16(p + 2);
    }
    if (!size || !size.width || !size.height) return null;
    const o = self.SpoodExif ? SpoodExif.describe(SpoodExif.readExif(u8)).orientation : 1;
    return o >= 5 && o <= 8 ? { width: size.height, height: size.width } : size;
  }
  if (be32(0) === 0x89504E47 && be32(12) === 0x49484452) return { width: be32(16), height: be32(20) };   // PNG IHDR
  if (be32(0) === 0x52494646 && be32(8) === 0x57454250) {         // WebP
    const k = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (k === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 };   // (EXIF rotation in WebP is rare; ignored)
    if (k === 'VP8 ') return { width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF };
    if (k === 'VP8L') { const b = u8[21] | (u8[22] << 8) | (u8[23] << 16) | (u8[24] << 24); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
  }
  return null;
}


/** Where the engine parks its big per-photo images while it isn't using them: a scratch file
    in the site's private storage on the phone (OPFS), read and written in place, so they cost
    no RAM. Falls back to memory, image by image, if the file can't be used or fills up. */
async function scratchStore(shared) {
  let root, name, ah;
  try {
    if (!(self.navigator && navigator.storage && navigator.storage.getDirectory)) return null;
    root = await navigator.storage.getDirectory();
    // a run that was cut short (app closed mid-stack) leaves its file behind
    try { for await (const k of root.keys()) if (k.startsWith('spood-scratch-')) await root.removeEntry(k).catch(() => {}); } catch (e) { /* ignore */ }
    name = 'spood-scratch-' + Date.now();
    const fh = await root.getFileHandle(name, { create: true });
    if (!fh.createSyncAccessHandle) return null;
    // shared: the helpers open the same file (each its own handle); otherwise this worker alone
    try { ah = shared ? await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' }) : null; } catch (e) { ah = null; }
    if (!ah) ah = await fh.createSyncAccessHandle();
  } catch (e) { return null; }
  let end = 0, onDisk = 0, inMemory = 0;
  const free = new Map();                                        // size -> offsets of dropped images
  return {
    name, shareable: ah.mode === 'readwrite-unsafe',
    sync() { ah.flush(); },
    put(u, temp) {                                               // temp: a view into the WASM heap
      const len = u.length, spare = free.get(len);
      const at = spare && spare.length ? spare.pop() : end;
      try {
        if (ah.write(u, { at }) !== len) throw new Error('short write');
        if (at === end) end += len;
        onDisk += len;
        return { at, len };
      } catch (e) {
        if (at !== end) spare.push(at);
        inMemory += len;
        return { mem: temp ? u.slice() : u, len };               // storage full: keep this one in memory
      }
    },
    /** room for an image that will be written a band at a time (set) */
    alloc(len) {
      const spare = free.get(len);
      if (spare && spare.length) { onDisk += len; return { at: spare.pop(), len }; }
      try { ah.truncate(end + len); } catch (e) { inMemory += len; return { mem: new Uint8Array(len), len }; }   // storage full
      const at = end; end += len; onDisk += len;
      return { at, len };
    },
    get(h, off = 0, len = h.len - off) {
      if (h.mem) return h.mem.subarray(off, off + len);
      const b = new Uint8Array(len);
      if (ah.read(b, { at: h.at + off }) !== len) throw new Error('Could not read back a photo from scratch storage.');
      return b;
    },
    read(h, off, dst) {
      if (h.mem) { dst.set(h.mem.subarray(off, off + dst.length)); return; }
      if (ah.read(dst, { at: h.at + off }) !== dst.length) throw new Error('Could not read back a photo from scratch storage.');
    },
    set(h, off, u) {
      if (h.mem) { if (u.buffer !== h.mem.buffer || u.byteOffset !== h.mem.byteOffset + off) h.mem.set(u, off); return; }
      ah.write(u, { at: h.at + off });
    },
    drop(h) {
      if (!h || h.dropped) return;
      h.dropped = true;
      if (h.mem) { h.mem = null; return; }
      if (!free.has(h.len)) free.set(h.len, []);
      free.get(h.len).push(h.at); onDisk -= h.len;
    },
    stats: () => ({ fileMiB: Math.round(end / 1048576), inMemoryMiB: Math.round(inMemory / 1048576) }),
    async close() {
      try { ah.truncate(0); ah.close(); } catch (e) { /* ignore */ }
      try { await root.removeEntry(name); } catch (e) { /* ignore */ }
    }
  };
}

self.onmessage = async ev => {
  const cv = await cvReady;
  const { files, taken, opts } = ev.data;
  if (pool && !opts.noHelpers) await pool.ready;
  const wantHelpers = pool && pool.size > 0 && !opts.noHelpers;
  const maxHelpers = opts.maxHelpers === undefined ? Infinity : opts.maxHelpers;
  const store = await scratchStore(wantHelpers);
  const helpers = wantHelpers && store && store.shareable ? Math.min(pool.size, maxHelpers) : 0;
  try {
    const native = [];
    for (const f of files) native.push(await imageSize(f));
    // the largest working size whose memory need fits (the engine knows its own appetite)
    const plan = self.SalticidStacker.planSize(native, { maxSide: opts.maxSide, lowMemory: opts.lowMemory, heapCapMiB: CV_BUILD.heapCapMiB, helpers });
    postMessage({ type: 'plan', plan });
    postMessage({ type: 'log', m: store ? 'parking photos in scratch storage on the phone' : 'parking photos in memory' });
    postMessage({ type: 'log', m: helpers ? `working on ${helpers} cores at once` : 'working on one core' });
    if (helpers) await pool.all({ type: 'open', name: store.name });
    const frames = files.map((file, i) => {
      const s = Math.min(1, plan.side / Math.max(native[i].width, native[i].height));
      const width = Math.max(1, Math.round(native[i].width * s)), height = Math.max(1, Math.round(native[i].height * s));
      // the file itself: the engine (or a helper) decodes it when it gets to it
      return { width, height, srcPixels: native[i].width * native[i].height, taken: taken[i], file };
    });
    const out = await self.SalticidStacker.stackFrames(cv, frames, Object.assign({}, opts, {
      maxSide: plan.side, stripRows: plan.stripRows, store: store || undefined,
      pool: helpers ? { size: helpers, limits: plan.limits, cores: navigator.hardwareConcurrency || 0, run: (name, args, onProgress) => pool.run(name, args, onProgress) } : undefined,
      onProgress: (p, s) => postMessage({ type: 'progress', p, s }),
      onLog: m => postMessage({ type: 'log', m }),
      onSelection: sel => postMessage({ type: 'selection', sel }),
      // lined-up photos for the retouch brush, sent as JPEGs to keep the page's memory down
      onFrame: opts.retouch && typeof OffscreenCanvas !== 'undefined' ? async f => {
        const frame = f.blob ? f : await encodeFrame(f);              // a helper may have encoded it already
        postMessage({ type: 'frame', frame }, [frame.focus.data.buffer]);
      } : null, encodeFrames: true
    }));
    if (helpers) postMessage({ type: 'log', m: `memory: main ${Math.round(cv.HEAP8.length / 1048576)} MB, helpers ${[...pool.heaps.values()].map(h => Math.round(h / 1048576)).join(' + ')} MB` });
    if (store) { const st = store.stats(); postMessage({ type: 'log', m: `scratch storage used: ${st.fileMiB} MB` + (st.inMemoryMiB ? ` (+${st.inMemoryMiB} MB kept in memory)` : '') }); }
    postMessage({ type: 'done', out }, [out.data.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: errText(cv, e) });
  } finally {
    if (helpers) await pool.all({ type: 'close' }).catch(() => {});
    if (store) await store.close();
    // fresh helpers for the next stack: a WebAssembly heap never shrinks, so this hands their
    // memory back now (to the retouch brush, the rest of the phone) instead of holding it
    if (pool) { pool.stop(); pool = new HelperPool(HELPERS); }
  }
};
