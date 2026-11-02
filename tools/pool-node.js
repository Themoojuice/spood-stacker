/* A pool of helper threads for the engine in Node (the app uses Web Workers, worker.js): each
   thread has its own OpenCV and runs engine tasks on parked images in a disk store whose handles
   carry file descriptors (shared by all threads of the process).
   const pool = await makePool(n, enginePath); ... stackFrames(cv, frames, { pool, store }); pool.close() */
'use strict';
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

function transferables(o, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (ArrayBuffer.isView(o)) { if (!out.includes(o.buffer)) out.push(o.buffer); return out; }
  for (const k in o) transferables(o[k], out);
  return out;
}

if (isMainThread) {
  module.exports.makePool = async function makePool(n, enginePath) {
    const workers = [], idle = [], queue = [], pending = new Map();
    let seq = 0;
    const pump = () => {
      while (idle.length && queue.length) {
        const w = idle.pop(), job = queue.shift();
        pending.set(job.id, job); w.job = job.id;
        w.postMessage({ id: job.id, name: job.name, args: job.args });
      }
    };
    await Promise.all([...Array(n)].map(() => new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { enginePath: path.resolve(enginePath) } });
      w.on('message', m => {
        if (m.ready) { workers.push(w); idle.push(w); resolve(); return; }
        if ('progress' in m) { const job = pending.get(m.id); if (job && job.onProgress) job.onProgress(m.progress); return; }
        const job = pending.get(m.id); pending.delete(m.id); idle.push(w);
        if (m.error) job.reject(new Error(m.error)); else job.resolve(m.result);
        pump();
      });
      w.on('error', reject);
    })));
    return {
      size: n,
      run(name, args, onProgress) { return new Promise((resolve, reject) => { queue.push({ id: ++seq, name, args, resolve, reject, onProgress }); pump(); }); },
      close() { workers.forEach(w => w.terminate()); }
    };
  };
  module.exports.transferables = transferables;
} else {
  const fs = require('fs'), vm = require('vm');
  const L = require('./lib');
  const mod = { exports: {} };
  vm.runInThisContext('(function (module, exports) {' + fs.readFileSync(workerData.enginePath, 'utf8') + '\n})', { filename: workerData.enginePath }).call({}, mod, mod.exports);
  const engine = mod.exports;
  // the disk store's handles carry file descriptors, which every thread of the process can use
  engine.useStore({
    shareable: true,
    get: (h, off = 0, len = h.len - off) => { const b = Buffer.allocUnsafe(len); fs.readSync(h.fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); },
    read: (h, off, dst) => { fs.readSync(h.fd, dst, 0, dst.length, off); },
    set: (h, off, u) => { fs.writeSync(h.fd, u, 0, u.length, off); }
  });
  L.loadCv().then(cv => {
    parentPort.on('message', async m => {
      try {
        const result = await engine.tasks[m.name](cv, m.args, f => parentPort.postMessage({ id: m.id, progress: f }));
        parentPort.postMessage({ id: m.id, result }, transferables(result));
      } catch (e) {
        parentPort.postMessage({ id: m.id, error: typeof e === 'number' && cv.exceptionFromPtr ? cv.exceptionFromPtr(e).msg : (e && e.stack) || String(e) });
      }
    });
    parentPort.postMessage({ ready: true });
  });
}
