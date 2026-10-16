/* Runs the stacking engine off the main thread so the screen stays responsive. */
importScripts('vendor/opencv-4.10.0.js', 'engine.js');

const cvReady = new Promise(resolve => {
  const c = self.cv;
  // OpenCV.js is "thenable"; resolving a promise with it loops forever unless .then is removed
  const fin = () => { try { delete c.then; } catch (e) { /* ignore */ } resolve(c); };
  if (c && c.Mat) fin(); else c.onRuntimeInitialized = fin;
});

const errText = (cv, e) => (typeof e === 'number' && cv && cv.exceptionFromPtr)
  ? cv.exceptionFromPtr(e).msg : (e && e.message) || String(e);

cvReady.then(() => postMessage({ type: 'ready' }));

self.onmessage = async ev => {
  const cv = await cvReady;
  try {
    const out = await self.SalticidStacker.stackFrames(cv, ev.data.frames, Object.assign({}, ev.data.opts, {
      onProgress: (p, s) => postMessage({ type: 'progress', p, s }),
      onLog: m => postMessage({ type: 'log', m }),
      onSelection: sel => postMessage({ type: 'selection', sel })
    }));
    postMessage({ type: 'done', out }, [out.data.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: errText(cv, e) });
  }
};
