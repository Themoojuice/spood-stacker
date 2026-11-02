/* Loads OpenCV.js into a worker (the engine's worker and its helpers).
   The build made for this app (.github/workflows/opencv-js.yml) has WebAssembly SIMD and a 4 GiB
   memory ceiling; a browser without SIMD gets the stock build with its ceiling raised to 2 GiB. */
const SIMD = (() => {
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
  catch (e) { return false; }
})();
const CV_BUILD = SIMD ? { file: 'vendor/opencv-4.10.0-simd.js', heapCapMiB: 4095 } : { file: 'vendor/opencv-4.10.0-2g.js', heapCapMiB: 2047 };
importScripts(CV_BUILD.file);

const cvReady = new Promise(resolve => {
  const c = self.cv;
  // OpenCV.js may be the module itself, a "thenable" module (resolving a promise with it loops
  // forever unless .then is removed) or a promise of the module (newer builds)
  const fin = m => { try { delete m.then; } catch (e) { /* ignore */ } self.cv = m; resolve(m); };
  if (c && c.Mat) fin(c);
  else if (c && typeof c.then === 'function') c.then(m => fin(m && m.Mat ? m : c));
  else c.onRuntimeInitialized = () => fin(c);
});

const errText = (cv, e) => (typeof e === 'number' && cv && cv.exceptionFromPtr)
  ? cv.exceptionFromPtr(e).msg : (e && e.message) || String(e);

/** the ArrayBuffers in a result, to hand over without copying */
function transferables(o, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (ArrayBuffer.isView(o)) { if (!out.includes(o.buffer)) out.push(o.buffer); return out; }
  for (const k in o) transferables(o[k], out);
  return out;
}

/** a lined-up photo for the retouch brush, as a JPEG (keeps the page's memory down) */
async function encodeFrame(f) {
  const c = new OffscreenCanvas(f.width, f.height);
  c.getContext('2d').putImageData(new ImageData(f.data, f.width, f.height), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  c.width = c.height = 1;
  return { photo: f.photo, used: f.used, why: f.why, ref: f.ref, width: f.width, height: f.height, blob, focus: f.focus };
}

/** The photo's pixels at w x h (RGBA), drawn the way the page always did. */
async function decodeImage(file, w, h) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { throw new Error(`Could not open ${file.name}. If it is a HEIC photo, set the camera to save JPEG.`); }
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); bmp.close();
  const d = g.getImageData(0, 0, w, h).data;
  c.width = c.height = 1;                                         // let the canvas memory go now
  return d;
}
