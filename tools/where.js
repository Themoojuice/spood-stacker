/* node tools/where.js <engine.js> <burst folder> <out folder> [maxSide]
   Writes result.png plus where.png: each used photo, lined up, with the parts the stack took from it lit. */
const path = require('path'), fs = require('fs');
const L = require('./lib');
const sharp = require('sharp');
(async () => {
  const [eng, dir, out, ms] = process.argv.slice(2); const maxSide = +ms || 3000;
  fs.mkdirSync(out, { recursive: true });
  const engine = require(path.resolve(eng)); const cv = await L.loadCv();
  const photos = L.burstPhotos(dir); const frames = [];
  for (const p of photos) frames.push(await L.decodeLikeApp(p, maxSide));
  const lined = {}; const dbg = {};
  const t0 = Date.now();
  const res = await engine.stackFrames(cv, frames, { maxSide, keepAll: !!process.env.KEEPALL,
    onFrame: f => { lined[f.photo] = f; }, onDebug: (n, d) => { dbg[n] = d; } });
  console.log('secs', (Date.now() - t0) / 1000, res.width, res.height);
  fs.writeFileSync(path.join(out, 'log.txt'), res.log.join('\n'));
  await L.writeRGBA(path.join(out, 'result.png'), res);
  const w = dbg.weights; if (!w) return;
  const box = w.box, tw = 520, th = Math.round(tw * box.h / box.w);
  const tiles = [];
  for (let k = 0; k < w.photos.length; k++) {
    const ph = w.photos[k], f = lined[ph]; if (!f) continue;
    // weight map cropped to box (half size) -> tile size
    const m = w.maps[k], x0 = Math.floor(box.x / 2), y0 = Math.floor(box.y / 2), cw = Math.floor(box.w / 2), ch = Math.floor(box.h / 2);
    const wm = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) wm[y * cw + x] = m[(y + y0) * w.width + x + x0];
    const wbuf = Buffer.from(Uint8Array.from(wm, v => Math.min(255, v * 255)));
    const wsm = await sharp(wbuf, { raw: { width: cw, height: ch, channels: 1 } }).resize(tw, th).extractChannel(0).raw().toBuffer();
    const img = await sharp(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.length), { raw: { width: f.width, height: f.height, channels: 4 } }).resize(tw, th).removeAlpha().raw().toBuffer();
    const o = Buffer.alloc(tw * th * 3);
    for (let i = 0; i < tw * th; i++) {
      const a = Math.min(1, wsm[i] / 255 * 2.5);
      for (let c = 0; c < 3; c++) {
        const v = img[i * 3 + c];
        o[i * 3 + c] = Math.min(255, v * (0.12 + 1.6 * a));
      }
    }
    let sum = 0; for (const v of wm) sum += v;
    tiles.push({ buf: o, label: `photo ${ph}${f.ref ? ' (reference)' : ''}: ${Math.round(sum / wm.length * 100)}% of the stack` });
  }
  const cols = 3, rows = Math.ceil(tiles.length / cols), pad = 30;
  const W2 = cols * tw, H2 = rows * (th + pad);
  const comp = tiles.map((t, k) => ({ input: t.buf, raw: { width: tw, height: th, channels: 3 }, left: (k % cols) * tw, top: Math.floor(k / cols) * (th + pad) + pad }));
  const svg = `<svg width="${W2}" height="${H2}">${tiles.map((t, k) => `<text x="${(k % cols) * tw + 8}" y="${Math.floor(k / cols) * (th + pad) + 21}" font-family="sans-serif" font-size="18" fill="#ddd">${t.label}</text>`).join('')}</svg>`;
  await sharp({ create: { width: W2, height: H2, channels: 3, background: '#111' } }).composite([...comp, { input: Buffer.from(svg), left: 0, top: 0 }]).png().toFile(path.join(out, 'where.png'));
  if (dbg.merged) {
    const m = dbg.merged, cw = Math.floor(box.w / 2), ch = Math.floor(box.h / 2), x0 = Math.floor(box.x / 2), y0 = Math.floor(box.y / 2);
    const hist = {}; const o = Buffer.alloc(cw * ch * 3);
    const pal = [[20, 20, 20], [70, 70, 160], [60, 170, 90], [230, 200, 60], [240, 120, 40], [240, 60, 60], [255, 255, 255]];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const v = m.count[(y + y0) * m.width + x + x0]; hist[v] = (hist[v] || 0) + 1;
      const c = pal[Math.min(6, v)]; o.set(c, (y * cw + x) * 3);
    }
    console.log('photos merged per spot (share of frame):', Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, (v / (cw * ch)).toFixed(3)])));
    await sharp(o, { raw: { width: cw, height: ch, channels: 3 } }).png().toFile(path.join(out, 'merged.png'));
  }
})().catch(e => { console.error(e); process.exit(1); });
