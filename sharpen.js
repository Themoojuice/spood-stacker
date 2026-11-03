/* The finished stack's sharpening, shared by the page, the retouch editor and the tests.

   An unsharp mask with three changes from the plain kind:
   - brightness only: the same lift is added to red, green and blue, so coloured edges get
     no coloured fringes;
   - overshoot limited: a pixel may end up only OVER levels brighter than the brightest of its
     8 neighbours, or darker than the darkest. Edges get steeper, without the light and dark
     rims (halos) a plain unsharp mask paints beside them;
   - faint detail (under about CORE levels: JPEG noise, sensor grain) is mostly left alone,
     so smooth backgrounds don't turn gritty.
   Works on 8-bit RGBA, any rectangle at a time (each output pixel only reads RADIUS + 1
   pixels around it), so the retouch editor can sharpen just what a brush stroke changed. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.SpoodSharpen = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SIGMA = 1.0;                  // blur radius of the mask: the scale of detail it lifts
  const RADIUS = 3;                   // kernel half-width, 3 sigma
  const CORE = 1.0;                   // detail of about this many levels is lifted half as much
  const OVER = 2;                     // levels of overshoot allowed past the neighbours
  const DEFAULT = 0.7;                // the app's starting amount: about as crisp as the old fixed 35% plain mask
  const BAND = 192;                   // rows per pass when sharpening a whole image
  const K = (() => {
    const k = new Float32Array(2 * RADIUS + 1); let s = 0;
    for (let i = -RADIUS; i <= RADIUS; i++) { k[i + RADIUS] = Math.exp(-i * i / (2 * SIGMA * SIGMA)); s += k[i + RADIUS]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  })();

  let pool = null;                    // scratch buffers, reused from one call to the next
  function scratch(n) {
    if (!pool || pool.n < n) pool = { n, Y: new Float32Array(n), T: new Float32Array(n), lo: new Float32Array(n), hi: new Float32Array(n) };
    return pool;
  }
  const k0 = K[RADIUS], k1 = K[RADIUS + 1], k2 = K[RADIUS + 2], k3 = K[RADIUS + 3];

  /** Columns x0..x1, rows y0..y1 of src (RGBA, W x H) sharpened into the same place in dst
      (another RGBA buffer of the same size; never src itself). */
  function rect(src, dst, W, H, amount, x0 = 0, y0 = 0, x1 = W, y1 = H) { return core(src, W, H, amount, x0, y0, x1, y1, dst, W, 0, 0); }
  /** The same area as a buffer of its own ((x1 - x0) x (y1 - y0) RGBA), e.g. one tile of a view. */
  function tile(src, W, H, amount, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    return core(src, W, H, amount, x0, y0, x1, y1, new Uint8ClampedArray(Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * 4), x1 - x0, x0, y0);
  }
  // dst pixel (x, y) is at ((y - dy) * dW + x - dx) * 4
  function core(src, W, H, amount, x0, y0, x1, y1, dst, dW, dx, dy) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    if (x0 >= x1 || y0 >= y1) return dst;
    if (!(amount > 0)) {
      for (let y = y0; y < y1; y++) dst.set(src.subarray((y * W + x0) * 4, (y * W + x1) * 4), ((y - dy) * dW + x0 - dx) * 4);
      return dst;
    }
    const M = RADIUS + 1;
    const ex0 = Math.max(0, x0 - M), ex1 = Math.min(W, x1 + M), ey0 = Math.max(0, y0 - M), ey1 = Math.min(H, y1 + M);
    const w = ex1 - ex0, h = ey1 - ey0, n = w * h;
    const { Y, T, lo, hi } = scratch(n);
    for (let y = 0, i = 0; y < h; y++) {
      let p = ((ey0 + y) * W + ex0) * 4;
      for (let x = 0; x < w; x++, i++, p += 4) Y[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
    }
    // blur across (edges of the area repeat its last pixel; the margin keeps that out of the
    // pixels written, except at the image's own edges, where it is what we want), and the
    // brightest and darkest of each pixel and its left and right neighbours
    const at = (r, x) => Y[r + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const i = r + x;
        if (x >= RADIUS && x < w - RADIUS) T[i] = k0 * Y[i] + k1 * (Y[i - 1] + Y[i + 1]) + k2 * (Y[i - 2] + Y[i + 2]) + k3 * (Y[i - 3] + Y[i + 3]);
        else T[i] = k0 * Y[i] + k1 * (at(r, x - 1) + at(r, x + 1)) + k2 * (at(r, x - 2) + at(r, x + 2)) + k3 * (at(r, x - 3) + at(r, x + 3));
        const a = x > 0 ? Y[i - 1] : Y[i], b = Y[i], c = x < w - 1 ? Y[i + 1] : Y[i];
        let mn = a < b ? a : b, mx = a < b ? b : a;
        if (c < mn) mn = c; else if (c > mx) mx = c;
        lo[i] = mn; hi[i] = mx;
      }
    }
    // blur down, then the lift, limited by the 3 x 3 neighbourhood's range
    const row = yy => (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w;
    for (let y = y0 - ey0; y < y1 - ey0; y++) {
      const r0 = y * w, rm1 = row(y - 1), rp1 = row(y + 1), rm2 = row(y - 2), rp2 = row(y + 2), rm3 = row(y - 3), rp3 = row(y + 3);
      let p = ((ey0 + y) * W + x0) * 4, q = ((ey0 + y - dy) * dW + x0 - dx) * 4;
      for (let x = x0 - ex0; x < x1 - ex0; x++, p += 4, q += 4) {
        const v0 = Y[r0 + x];
        const bl = k0 * T[r0 + x] + k1 * (T[rm1 + x] + T[rp1 + x]) + k2 * (T[rm2 + x] + T[rp2 + x]) + k3 * (T[rm3 + x] + T[rp3 + x]);
        const d = v0 - bl, a = d < 0 ? -d : d;
        let v = v0 + amount * d * a / (a + CORE);
        let l = lo[r0 + x], u = hi[r0 + x];
        const l1 = lo[rm1 + x], l2 = lo[rp1 + x], u1 = hi[rm1 + x], u2 = hi[rp1 + x];
        if (l1 < l) l = l1; if (l2 < l) l = l2; if (u1 > u) u = u1; if (u2 > u) u = u2;
        l -= OVER; u += OVER;
        v = v < l ? l : v > u ? u : v;
        const dv = v - v0;
        dst[q] = src[p] + dv; dst[q + 1] = src[p + 1] + dv; dst[q + 2] = src[p + 2] + dv; dst[q + 3] = src[p + 3];
      }
    }
    return dst;
  }

  /** The whole image, a band of rows at a time. src: RGBA pixels; returns a new
      Uint8ClampedArray, or fills dst, which may be src itself (sharpened in place, holding only
      a band's worth of the original at a time: what a 50 MP image needs). */
  function image(src, W, H, amount, dst = new Uint8ClampedArray(src.length)) {
    if (dst !== src) {
      for (let y = 0; y < H; y += BAND) rect(src, dst, W, H, amount, 0, y, W, Math.min(H, y + BAND));
      return dst;
    }
    if (!(amount > 0)) return dst;
    const M = RADIUS + 1, row = W * 4;
    let tail = null;                                          // the last M rows above, as they were
    for (let y = 0; y < H; y += BAND) {
      const y1 = Math.min(H, y + BAND), a = Math.max(0, y - M), b = Math.min(H, y1 + M);
      const copy = new Uint8ClampedArray((b - a) * row);     // the band and its margin, unsharpened
      if (tail) copy.set(tail, 0);
      copy.set(src.subarray(y * row, b * row), (y - a) * row);
      tail = copy.slice(Math.max(0, y1 - M - a) * row, (y1 - a) * row);
      core(copy, W, b - a, amount, 0, y - a, W, y1 - a, dst, W, 0, -a);
    }
    return dst;
  }

  return { rect, tile, image, DEFAULT, MARGIN: RADIUS + 1, version: 1 };
});
