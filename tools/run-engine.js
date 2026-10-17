/* Runs one copy of engine.js on one burst, exactly as the app would.
   node run-engine.js <engine.js> <burst folder> <maxSide> <out prefix>
   Writes <out prefix>.png and <out prefix>.json (time, log, selection, reference). */
'use strict';
const fs = require('fs');
const vm = require('vm');
const { loadCv, burstPhotos, decodeLikeApp, writeRGBA } = require('./lib');

async function main() {
  const [enginePath, burst, maxSideArg, outPrefix] = process.argv.slice(2);
  const maxSide = +maxSideArg || 3000;
  // each engine version runs in its own process, so two versions never share state
  const mod = { exports: {} };
  const wrap = vm.runInThisContext('(function (module, exports) {' + fs.readFileSync(enginePath, 'utf8') + '\n})', { filename: enginePath });
  wrap.call({}, mod, mod.exports);
  const engine = mod.exports;
  if (!engine || typeof engine.stackFrames !== 'function') throw new Error(`${enginePath} does not export stackFrames`);

  const cv = await loadCv();
  const photos = burstPhotos(burst);
  const frames = [];
  for (const p of photos) frames.push(await decodeLikeApp(p, maxSide));
  let selection = null;
  const t0 = Date.now();
  const out = await engine.stackFrames(cv, frames, { maxSide, onSelection: s => { selection = s; } });
  const secs = (Date.now() - t0) / 1000;
  await writeRGBA(outPrefix + '.png', out);
  const refLine = (out.log || []).find(l => /reference photo \d+/.test(l)) || '';
  const ref = +((refLine.match(/reference photo (\d+)/) || [])[1] || 0);
  // optional extras from newer engines (retouch frames) are ignored here
  fs.writeFileSync(outPrefix + '.json', JSON.stringify({
    photos: photos.map(p => require('path').basename(p)), secs, width: out.width, height: out.height,
    ref, selection, log: out.log || []
  }, null, 1));
}

main().catch(e => {
  console.error(typeof e === 'number' ? `OpenCV error ${e}` : (e && e.stack) || String(e));
  process.exit(1);
});
