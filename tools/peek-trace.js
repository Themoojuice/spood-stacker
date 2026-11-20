/* Records what the "watch the maths" view would be shown for one burst: every onPeek preview,
   progress update and log line, with its time, so the view can be replayed and tested away from
   the phone. Also checks that watching changes nothing: the stack is made twice, with and
   without onPeek, and the two must be identical.
   node tools/peek-trace.js <burst folder> <maxSide> <out.json> [--no-check] */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadCv, burstPhotos, decodeLikeApp } = require('./lib');

const enc = v => {
  if (ArrayBuffer.isView(v)) return { $t: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; }
  return v;
};

async function main() {
  const args = process.argv.slice(2), check = !args.includes('--no-check');
  const [burst, maxSideArg, outFile] = args.filter(a => !a.startsWith('--'));
  const maxSide = +maxSideArg || 3000;
  const engine = require(path.resolve(__dirname, '..', 'engine.js'));
  const cv = await loadCv();
  const photos = burstPhotos(burst);
  const load = async () => { const f = []; for (const p of photos) f.push(await decodeLikeApp(p, maxSide)); return f; };

  const events = [], t0 = Date.now(), at = () => Date.now() - t0;
  const out = await engine.stackFrames(cv, await load(), {
    maxSide, sharpen: 0,
    onPeek: (name, d) => events.push({ t: at(), kind: 'peek', name, d: enc(d) }),
    onProgress: (p, s) => events.push({ t: at(), kind: 'progress', p, s }),
    onLog: m => events.push({ t: at(), kind: 'log', m }),
    stripRows: process.env.STRIP_ROWS ? +process.env.STRIP_ROWS : undefined
  });
  const secs = (Date.now() - t0) / 1000;
  const names = {}; let bytes = 0;
  for (const e of events) if (e.kind === 'peek') { names[e.name] = (names[e.name] || 0) + 1; bytes += JSON.stringify(e.d).length; }
  fs.writeFileSync(outFile, JSON.stringify({ burst: path.basename(burst), photos: photos.map(p => path.basename(p)), secs, width: out.width, height: out.height, events }));
  console.log(`stacked in ${secs.toFixed(1)} s, ${out.width}x${out.height}; peeks: ${JSON.stringify(names)}; ~${(bytes / 1024).toFixed(0)} KiB of previews`);

  if (check) {
    const ref = await engine.stackFrames(cv, await load(), { maxSide, sharpen: 0, stripRows: process.env.STRIP_ROWS ? +process.env.STRIP_ROWS : undefined });
    const same = ref.width === out.width && ref.height === out.height && Buffer.compare(Buffer.from(ref.data.buffer), Buffer.from(out.data.buffer)) === 0;
    console.log(same ? 'watching changes nothing: identical stack with and without previews' : 'DIFFERENT stack with previews on!');
    if (!same) process.exitCode = 1;
  }
}
main().catch(e => { console.error(typeof e === 'number' ? `OpenCV error ${e}` : (e && e.stack) || String(e)); process.exit(1); });
