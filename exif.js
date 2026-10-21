/* Carries a source photo's EXIF (date, GPS, camera) over to the stacked JPEG.
   No dependencies; works in the page, a worker and Node.

   The EXIF block is copied byte for byte and patched in place:
   - Orientation -> 1 (the pixels were already turned upright when decoded)
   - pixel dimensions -> the stack's size
   - the embedded thumbnail (IFD1) is unlinked, so viewers don't show the
     reference photo's preview instead of the stack
   The colour profile is NOT copied here: the browser converts pixels to sRGB
   while decoding, and an untagged JPEG is read as sRGB. */
(function (root) {
  'use strict';

  /** Split a JPEG into its marker segments up to the start of scan. */
  function segments(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    const out = [];
    let p = 2;
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xFF) return null;
      const m = u8[p + 1];
      if (m === 0xFF) { p++; continue; }                    // fill byte
      if (m === 0xDA || m === 0xD9) { out.push({ marker: m, start: p, end: u8.length, body: p }); break; }
      const len = (u8[p + 2] << 8) | u8[p + 3];
      out.push({ marker: m, start: p, end: p + 2 + len, body: p + 4 });
      p += 2 + len;
    }
    return out;
  }

  const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0, 0];             // "Exif\0\0"
  const startsWith = (u8, at, sig) => sig.every((b, i) => u8[at + i] === b);

  /** The raw TIFF block of a JPEG's EXIF (a copy), or null. */
  function readExif(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const segs = segments(u8);
    if (!segs) return null;
    for (const s of segs) {
      if (s.marker === 0xE1 && startsWith(u8, s.body, EXIF_ID)) return u8.slice(s.body + 6, s.end);
    }
    return null;
  }

  /** Walk a TIFF/EXIF block. Calls visit(tag, entryOffset, type, count, ifdName). */
  function walk(t, visit) {
    if (!t || t.length < 8) return false;
    const le = t[0] === 0x49;                               // "II" little-endian, "MM" big-endian
    if (!le && t[0] !== 0x4D) return false;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    const ifd = (off, name, seen) => {
      if (!off || off + 2 > t.length || seen.has(off)) return null;
      seen.add(off);
      const n = u16(off);
      if (off + 2 + n * 12 + 4 > t.length) return null;
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        visit(tag, e, type, count, name);
        if (tag === 0x8769) ifd(u32(e + 8), 'exif', seen);
        if (tag === 0x8825) ifd(u32(e + 8), 'gps', seen);
      }
      return off + 2 + n * 12;                              // where the next-IFD pointer lives
    };
    const seen = new Set();
    const next0 = ifd(u32(4), 'ifd0', seen);
    return { le, dv, u16, u32, next0 };
  }

  function setInt(w, e, type, value) {
    // SHORT (3) or LONG (4), single value stored inline
    if (type === 3) w.dv.setUint16(e + 8, Math.min(65535, value), w.le);
    else if (type === 4) w.dv.setUint32(e + 8, value, w.le);
  }

  /** A patched copy of the TIFF block, ready for the stacked image. */
  function patchExif(tiff, width, height) {
    const t = tiff.slice();
    const edits = [];
    const w = walk(t, (tag, e, type, count, name) => edits.push({ tag, e, type, count, name }));
    if (!w) return null;
    for (const x of edits) {
      if (x.count !== 1) continue;
      if (x.name === 'ifd0' && x.tag === 0x0112) setInt(w, x.e, x.type, 1);                       // Orientation
      if (x.name === 'ifd0' && x.tag === 0x0100) setInt(w, x.e, x.type, width);                   // ImageWidth
      if (x.name === 'ifd0' && x.tag === 0x0101) setInt(w, x.e, x.type, height);                  // ImageLength
      if (x.name === 'exif' && x.tag === 0xA002) setInt(w, x.e, x.type, width);                   // PixelXDimension
      if (x.name === 'exif' && x.tag === 0xA003) setInt(w, x.e, x.type, height);                  // PixelYDimension
    }
    if (w.next0 && w.next0 + 4 <= t.length) w.dv.setUint32(w.next0, 0, w.le);                    // drop IFD1 (thumbnail)
    return t;
  }

  /** What the block holds, for telling the user (date, GPS present, camera). */
  function describe(tiff) {
    const info = { date: null, gps: false, camera: null, orientation: 1 };
    if (!tiff) return info;
    const ascii = (w, e, count) => {
      const off = count <= 4 ? e + 8 : w.u32(e + 8);
      let s = ''; for (let i = 0; i < count && off + i < tiff.length; i++) { const c = tiff[off + i]; if (!c) break; s += String.fromCharCode(c); }
      return s.trim();
    };
    let make = '', model = '';
    const entries = [];
    const w = walk(tiff, (tag, e, type, count, name) => entries.push({ tag, e, type, count, name }));
    if (!w) return info;
    for (const x of entries) {
      if (x.name === 'exif' && x.tag === 0x9003 && x.type === 2) info.date = ascii(w, x.e, x.count);
      if (x.name === 'ifd0' && x.tag === 0x0132 && x.type === 2 && !info.date) info.date = ascii(w, x.e, x.count);
      if (x.name === 'ifd0' && x.tag === 0x010F && x.type === 2) make = ascii(w, x.e, x.count);
      if (x.name === 'ifd0' && x.tag === 0x0110 && x.type === 2) model = ascii(w, x.e, x.count);
      if (x.name === 'ifd0' && x.tag === 0x0112 && x.type === 3) info.orientation = w.u16(x.e + 8);
      if (x.name === 'gps' && (x.tag === 0x0002 || x.tag === 0x0004) && x.count >= 3) info.gps = true;
    }
    info.camera = [make, model].filter(Boolean).join(' ') || null;
    return info;
  }

  /** Capture time in ms (local clock read as UTC: only differences matter), from
      DateTimeOriginal plus SubSecTimeOriginal, or null. */
  function takenTime(tiff) {
    if (!tiff) return null;
    const entries = [];
    const w = walk(tiff, (tag, e, type, count, name) => entries.push({ tag, e, type, count, name }));
    if (!w) return null;
    const ascii = (e, count) => {
      const off = count <= 4 ? e + 8 : w.u32(e + 8);
      let s = ''; for (let i = 0; i < count && off + i < tiff.length; i++) { const c = tiff[off + i]; if (!c) break; s += String.fromCharCode(c); }
      return s.trim();
    };
    let date = null, sub = '';
    for (const x of entries) {
      if (x.type !== 2) continue;
      if (x.name === 'exif' && x.tag === 0x9003) date = ascii(x.e, x.count);
      if (x.name === 'ifd0' && x.tag === 0x0132 && !date) date = ascii(x.e, x.count);
      if (x.name === 'exif' && x.tag === 0x9291) sub = ascii(x.e, x.count);
    }
    const m = date && date.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const f = /^\d+$/.test(sub) ? +('0.' + sub) * 1000 : 0;
    return Number.isFinite(t) ? t + f : null;
  }

  /** Capture time from a camera file name such as IMG_20260828_155557_3.jpg,
      PXL_20260828_055557123.jpg or 20260828_155557.jpg (ms, as above), or null. */
  function timeFromName(name) {
    const m = String(name || '').match(/(?:^|[^\d])(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)(\d{3})?(?!\d)/);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7] : 0);
    return Number.isFinite(t) ? t : null;
  }

  /** JPEG bytes with the given TIFF block inserted as EXIF (replacing any
      APP0/APP1 the encoder wrote). */
  function insertExif(jpeg, tiff) {
    const u8 = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
    const segs = segments(u8);
    if (!segs || !tiff || tiff.length + 8 > 65535) return u8;
    const keep = segs.filter(s => !(s.marker === 0xE0 || (s.marker === 0xE1 && startsWith(u8, s.body, EXIF_ID))));
    const len = 2 + 6 + tiff.length;
    const app1 = new Uint8Array(2 + len);
    app1.set([0xFF, 0xE1, len >> 8, len & 255, ...EXIF_ID]);
    app1.set(tiff, 10);
    const parts = [u8.subarray(0, 2), app1].concat(keep.map(s => u8.subarray(s.start, s.end)));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const api = { readExif, patchExif, insertExif, describe, takenTime, timeFromName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpoodExif = api;
})(typeof self !== 'undefined' ? self : this);
