/* A helper for the stacking engine (started by worker.js): its own OpenCV, running the heavy
   per-photo and per-strip steps the engine hands it (warp, local correction, merge strips,
   retouch copies), side by side with the other helpers, on parked images in the shared
   scratch file. */
importScripts('cvload.js', 'engine.js');

let ah = null;
const store = {
  shareable: true,
  get(h, off = 0, len = h.len - off) { const b = new Uint8Array(len); if (ah.read(b, { at: h.at + off }) !== len) throw new Error('Could not read back a photo from scratch storage.'); return b; },
  read(h, off, dst) { if (ah.read(dst, { at: h.at + off }) !== dst.length) throw new Error('Could not read back a photo from scratch storage.'); },
  set(h, off, u) { ah.write(u, { at: h.at + off }); }
};

onmessage = async e => {
  const m = e.data, cv = await cvReady;
  try {
    let result = true;
    if (m.type === 'open') {                      // the scratch file of the stack about to run
      if (ah) { try { ah.close(); } catch (err) { /* ignore */ } ah = null; }
      const root = await navigator.storage.getDirectory();
      ah = await (await root.getFileHandle(m.name)).createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      self.SalticidStacker.useStore(store);
    } else if (m.type === 'close') {
      if (ah) { try { ah.close(); } catch (err) { /* ignore */ } ah = null; }
      self.SalticidStacker.refCacheFree();
    } else {
      result = await self.SalticidStacker.tasks[m.name](cv, m.args, f => postMessage({ id: m.id, progress: f }));
      if (m.name === 'warp') ah.flush();          // written straight into the scratch file
      if (m.name === 'exportFrame' && m.args.encode && typeof OffscreenCanvas !== 'undefined') result = await encodeFrame(result);
    }
    postMessage({ id: m.id, result, heap: cv.HEAP8.length }, transferables(result));
  } catch (err) {
    postMessage({ id: m.id, error: errText(cv, err) });
  }
};
cvReady.then(() => postMessage({ ready: true }));
