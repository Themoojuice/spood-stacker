/* Runs the stacking engine off the main thread so the screen stays responsive.
   The page hands over the photo files themselves; each is decoded here only when the
   engine reaches it, so a long burst never sits in memory as full-size pixels at once. */
importScripts('vendor/opencv-4.10.0.js', 'exif.js', 'engine.js');

const cvReady = new Promise(resolve => {
  const c = self.cv;
  // OpenCV.js is "thenable"; resolving a promise with it loops forever unless .then is removed
  const fin = () => { try { delete c.then; } catch (e) { /* ignore */ } resolve(c); };
  if (c && c.Mat) fin(); else c.onRuntimeInitialized = fin;
});

const errText = (cv, e) => (typeof e === 'number' && cv && cv.exceptionFromPtr)
  ? cv.exceptionFromPtr(e).msg : (e && e.message) || String(e);

cvReady.then(() => postMessage({ type: 'ready' }));

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

/** The photo's pixels at w x h (RGBA), drawn the way the page always did. */
async function decode(file, w, h) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { throw cantOpen(file); }
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); bmp.close();
  const d = g.getImageData(0, 0, w, h).data;
  c.width = c.height = 1;                                         // let the canvas memory go now
  return d;
}

self.onmessage = async ev => {
  const cv = await cvReady;
  const { files, taken, opts } = ev.data;
  try {
    const native = [];
    for (const f of files) native.push(await imageSize(f));
    // the largest working size whose memory need fits (the engine knows its own appetite)
    const plan = self.SalticidStacker.planSize(native, { maxSide: opts.maxSide, lowMemory: opts.lowMemory });
    postMessage({ type: 'plan', plan });
    const frames = files.map((file, i) => {
      const s = Math.min(1, plan.side / Math.max(native[i].width, native[i].height));
      const width = Math.max(1, Math.round(native[i].width * s)), height = Math.max(1, Math.round(native[i].height * s));
      return { width, height, srcPixels: native[i].width * native[i].height, taken: taken[i], read: () => decode(file, width, height) };
    });
    const out = await self.SalticidStacker.stackFrames(cv, frames, Object.assign({}, opts, {
      maxSide: plan.side,
      onProgress: (p, s) => postMessage({ type: 'progress', p, s }),
      onLog: m => postMessage({ type: 'log', m }),
      onSelection: sel => postMessage({ type: 'selection', sel }),
      // lined-up photos for the retouch brush, sent as JPEGs to keep the page's memory down
      onFrame: opts.retouch && typeof OffscreenCanvas !== 'undefined' ? async f => {
        const c = new OffscreenCanvas(f.width, f.height);
        c.getContext('2d').putImageData(new ImageData(f.data, f.width, f.height), 0, 0);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
        c.width = c.height = 1;
        postMessage({ type: 'frame', frame: { photo: f.photo, used: f.used, why: f.why, ref: f.ref,
          width: f.width, height: f.height, blob, focus: f.focus } }, [f.focus.data.buffer]);
      } : null
    }));
    postMessage({ type: 'done', out }, [out.data.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: errText(cv, e) });
  }
};
