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
    no RAM. Falls back to memory, image by image, if the file can't be used or fills up.
    The file is sized once, up front (reserve), before any helper opens it, and keeps that size
    while they have it open (lock). Chrome bills every handle on the file for any growth that
    happens while it is open: helpers that opened an empty file and then wrote into it as it grew
    were each billed for the whole file (about 2 GB each for 21 photos at 12 MP), so a stack
    needed several times its real size in free storage, and the bills stayed until Chrome was
    closed. Measured in Chrome 153: 4 helpers, a 1.4 GB file -> 5.8 GB still counted as used after
    the file was deleted; sized up front -> nothing left over. */
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
  let end = 0, size = 0, cap = Infinity, reserved = 0, onDisk = 0, inMemory = 0;
  const free = new Map();                                        // size -> offsets of dropped images
  const keep = (len, u) => { inMemory += len; return { mem: u, len }; };   // in memory instead (tasks with these run here, not on helpers)
  // make the file at least `to` bytes long. A private (incognito) window keeps the file in memory
  // and ignores truncate past the end, and its helpers only see what was in the file when they
  // opened it: there the length is made by writing the last byte instead.
  const grow = to => {
    ah.truncate(to);
    if (ah.getSize() < to) { if (ah.write(new Uint8Array(1), { at: to - 1 }) !== 1) throw new Error('short write'); }
    if (ah.getSize() < to) throw new Error('could not size the scratch file');
  };
  return {
    name, shareable: ah.mode === 'readwrite-unsafe',
    sync() { ah.flush(); },
    /** make the file this big now (false if the phone hasn't the room) */
    reserve(bytes) {
      if (bytes <= size) return true;
      try { grow(bytes); ah.flush(); size = reserved = bytes; return true; } catch (e) { try { ah.truncate(size); } catch (e2) { /* ignore */ } return false; }
    },
    /** helpers are about to open the file: it keeps its size from now on (what doesn't fit stays in memory) */
    lock() { cap = size; },
    put(u, temp) {                                               // temp: a view into the WASM heap
      const len = u.length, spare = free.get(len);
      const at = spare && spare.length ? spare.pop() : end;
      if (at === end && end + len > cap) return keep(len, temp ? u.slice() : u);
      try {
        if (ah.write(u, { at }) !== len) throw new Error('short write');
        if (at === end) { end += len; size = Math.max(size, end); }
        onDisk += len;
        return { at, len };
      } catch (e) {
        if (at !== end) spare.push(at);
        return keep(len, temp ? u.slice() : u);                  // storage full: keep this one in memory
      }
    },
    /** room for an image that will be written a band at a time (set) */
    alloc(len) {
      const spare = free.get(len);
      if (spare && spare.length) { onDisk += len; return { at: spare.pop(), len }; }
      if (end + len > cap) return keep(len, new Uint8Array(len));
      // (never shrink a file that was sized up front)
      if (end + len > size) { try { grow(end + len); size = end + len; } catch (e) { return keep(len, new Uint8Array(len)); } }   // storage full
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
    stats: () => ({ fileMiB: Math.round(end / 1048576), reservedMiB: Math.round(reserved / 1048576), inMemoryMiB: Math.round(inMemory / 1048576) }),
    async close() {
      try { ah.truncate(0); ah.close(); } catch (e) { /* ignore */ }
      try { await root.removeEntry(name); } catch (e) { /* ignore */ }
    }
  };
}

/** room left for this site's storage on the phone, MiB (null if the browser won't say) */
async function storageRoomMiB() {
  try { const e = await navigator.storage.estimate(); return Math.max(0, Math.floor((e.quota - e.usage) / 1048576)); } catch (e) { return null; }
}
const gb = mib => (mib / 1024).toFixed(1) + ' GB';

self.onmessage = async ev => {
  const cv = await cvReady;
  // how much memory the engine holds (its WebAssembly heap only ever grows while it lives), for
  // the page's "Clear temporary memory"
  if (ev.data && ev.data.type === 'mem') { postMessage({ type: 'mem', heap: cv.HEAP8.length }); return; }
  const { files, taken, opts } = ev.data;
  if (pool && !opts.noHelpers) await pool.ready;
  const wantHelpers = pool && pool.size > 0 && !opts.noHelpers;
  const maxHelpers = opts.maxHelpers === undefined ? Infinity : opts.maxHelpers;
  const store = await scratchStore(wantHelpers);
  let helpers = wantHelpers && store && store.shareable ? Math.min(pool.size, maxHelpers) : 0;
  try {
    const native = [];
    for (const f of files) native.push(await imageSize(f));
    // the largest working size whose memory need fits (the engine knows its own appetite)
    const planFor = (maxSide, k) => self.SalticidStacker.planSize(native, { maxSide, lowMemory: opts.lowMemory, heapCapMiB: CV_BUILD.heapCapMiB, helpers: k });
    let plan = planFor(opts.maxSide, helpers);
    if (store) {
      // the scratch file, sized before any helper opens it (see scratchStore)
      const needFor = p => self.SalticidStacker.scratchNeedMiB(files.length, p.width, p.height);
      let need = needFor(plan);
      const room = await storageRoomMiB();
      if (!store.reserve(need * 1048576)) {
        // not enough room on the phone: the largest working size whose file Chrome will set aside.
        // A first guess from the room Chrome reports (the need goes with the pixels), then smaller
        // steps; asking is quick, and a refusal costs nothing.
        const full = need;
        let f = Math.min(0.94, room ? Math.sqrt(Math.max(0, room * 0.9 - 96) / Math.max(1, need - 96)) : 1);
        while (plan.side * f >= 1200) {
          const smaller = planFor(Math.floor(plan.side * f), helpers);
          if (store.reserve(needFor(smaller) * 1048576)) {
            plan = Object.assign(smaller, { shrunk: true, storageShrunk: true, storageNeedMiB: full });
            need = needFor(plan);
            break;
          }
          f *= 0.85;
        }
        if (plan.storageShrunk) postMessage({ type: 'log', m: `phone storage nearly full: full size needs about ${gb(full)} for a moment, ${gb(need)} could be set aside, so stacking at ${plan.width}×${plan.height}` });
        else {
          // still no room: one core, the file grows as it goes, and what doesn't fit is kept in memory
          postMessage({ type: 'log', m: `phone storage nearly full (about ${gb(full)} needed): one core, some photos kept in memory` });
          if (helpers) { helpers = 0; plan = planFor(opts.maxSide, 0); }
          plan.storageLow = true; plan.storageNeedMiB = full;
        }
      }
      if (helpers) store.lock();
      if (store.stats().reservedMiB) postMessage({ type: 'log', m: `scratch storage: ${gb(store.stats().reservedMiB)} set aside` + (room !== null ? ` (Chrome reports ${gb(room)} free for the app)` : '') });
    }
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
      sharpen: 0,                     // the page sharpens the result (and the retouch copies) itself, at the slider's amount
      pool: helpers ? { size: helpers, limits: plan.limits, cores: navigator.hardwareConcurrency || 0, run: (name, args, onProgress) => pool.run(name, args, onProgress) } : undefined,
      onProgress: (p, s) => postMessage({ type: 'progress', p, s }),
      onLog: m => postMessage({ type: 'log', m }),
      onSelection: sel => postMessage({ type: 'selection', sel }),
      // "watch the maths": small previews of each stage for the page's animation
      onPeek: opts.peek ? (name, d) => postMessage({ type: 'peek', name, d }) : undefined,
      // lined-up photos for the retouch brush, sent as JPEGs to keep the page's memory down
      onFrame: opts.retouch && typeof OffscreenCanvas !== 'undefined' ? async f => {
        const frame = f.blob ? f : await encodeFrame(f);              // a helper may have encoded it already
        postMessage({ type: 'frame', frame }, [frame.focus.data.buffer]);
      } : null, encodeFrames: true
    }));
    if (helpers) postMessage({ type: 'log', m: `memory: main ${Math.round(cv.HEAP8.length / 1048576)} MB, helpers ${[...pool.heaps.values()].map(h => Math.round(h / 1048576)).join(' + ')} MB` });
    if (store) { const st = store.stats(); postMessage({ type: 'log', m: `scratch storage used: ${st.fileMiB} MB of ${st.reservedMiB} MB set aside` + (st.inMemoryMiB ? ` (+${st.inMemoryMiB} MB kept in memory)` : '') }); }
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
