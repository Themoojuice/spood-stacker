#!/usr/bin/env python3
"""
How much can the retouch brush fix? Stacks a synthetic burst in the real app,
pulls out the photos the app offers for retouching, then, in the windows where
the stack is furthest from the truth, compares the error of:
  - the automatic stack
  - the photo the app's "Pick" suggests (sharpest there)
  - the best single photo (oracle: what a patient human could find by cycling)
    python tests/retouch_effect.py tests/bursts/bark [out folder]
"""
import base64, glob, json, os, sys
import cv2
import numpy as np
from playwright.sync_api import sync_playwright

burst = sys.argv[1] if len(sys.argv) > 1 else 'tests/bursts/bark'
out = sys.argv[2] if len(sys.argv) > 2 else 'retouch-effect-out'
os.makedirs(out, exist_ok=True)
photos = sorted(glob.glob(os.path.join(burst, '*.jpg')))
URL = os.environ.get('APP_URL', 'http://127.0.0.1:8765/')
RADIUS = int(os.environ.get('PICK_RADIUS', '1'))

cached = os.path.join(out, 'frames.json')
if os.path.exists(cached) and os.path.exists(os.path.join(out, 'stack.jpg')):
    log, frames = json.load(open(cached))
else:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2, accept_downloads=True)
        page = ctx.new_page()
        page.goto(URL)
        page.wait_for_function("document.getElementById('engine').textContent.includes('ready')", timeout=120000)
        page.set_input_files('#file', photos)
        with page.expect_download(timeout=900000) as dl:
            page.click('#go')
        dl.value.save_as(os.path.join(out, 'stack.jpg'))
        page.wait_for_timeout(500)
        log = page.inner_text('#log')
        frames = page.evaluate("""async () => {
          // reach into the page: the frames the app keeps for retouching
          const r = [];
          for (const f of window.__rtFramesForTest()) {
            const buf = new Uint8Array(await f.blob.arrayBuffer());
            let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            r.push({ photo: f.photo, used: f.used, ref: f.ref, jpeg: btoa(s), fw: f.focus.width, fh: f.focus.height, focus: Array.from(f.focus.data) });
          }
          return r;
        }""")
        b.close()
    json.dump([log, frames], open(cached, 'w'))

ref = int(next(l for l in log.split('\n') if 'reference photo' in l).split('reference photo ')[1].split()[0])
stack = cv2.imread(os.path.join(out, 'stack.jpg')).astype(np.float32)
H, W = stack.shape[:2]
imgs = {f['photo']: cv2.imdecode(np.frombuffer(base64.b64decode(f['jpeg']), np.uint8), 1).astype(np.float32) for f in frames}
focus = {f['photo']: np.array(f['focus'], np.float32).reshape(f['fh'], f['fw']) for f in frames}

# truth in the stack's geometry (same reference frame; only the crop differs)
truth = cv2.imread(os.path.join(burst, 'truth', f'{ref:02d}.png')).astype(np.float32)
g = lambda x: cv2.cvtColor(x.astype(np.uint8), cv2.COLOR_BGR2GRAY)
res = cv2.matchTemplate(g(truth), g(stack), cv2.TM_CCOEFF_NORMED)
_, _, _, (x0, y0) = cv2.minMaxLoc(res)
T = truth[y0:y0 + H, x0:x0 + W]
err = lambda img: cv2.GaussianBlur(np.abs(img - T).mean(2), (0, 0), 2)
E = err(stack)
print(f'reference photo {ref}; crop offset in truth ({x0},{y0}); stack mean abs error {np.abs(stack - T).mean():.2f}/255')

# windows where the stack is worst, non-overlapping
win, K = 48, 10
Eb = cv2.boxFilter(E, -1, (win, win))
picks, Ew = [], Eb.copy()
for _ in range(K):
    y, x = np.unravel_index(np.argmax(Ew), Ew.shape)
    picks.append((x, y)); Ew[max(0, y - win):y + win, max(0, x - win):x + win] = 0

rows, tot = [], {'stack': 0, 'pick': 0, 'oracle': 0}
for x, y in picks:
    sl = (slice(max(0, y - win // 2), y + win // 2), slice(max(0, x - win // 2), x + win // 2))
    e_stack = float(np.abs(stack[sl] - T[sl]).mean())
    per = {ph: float(np.abs(im[sl] - T[sl]).mean()) for ph, im in imgs.items()}
    # what Pick would choose: the photo whose focus map peaks highest near the tap,
    # looking RADIUS map cells around it (1 cell = 8 px)
    def fval(ph):
        F = focus[ph]; fx, fy = int(x / W * F.shape[1]), int(y / H * F.shape[0])
        return F[max(0, fy - RADIUS):fy + RADIUS + 1, max(0, fx - RADIUS):fx + RADIUS + 1].max()
    picked = max(imgs, key=fval)
    oracle = min(per, key=per.get)
    rows.append((x, y, e_stack, picked, per[picked], oracle, per[oracle]))
    tot['stack'] += e_stack; tot['pick'] += min(per[picked], e_stack); tot['oracle'] += min(per[oracle], e_stack)
    # (min(..., stack): you'd press Undo if painting made it worse)

print(f'\n{"window":>12} {"stack":>7} {"Pick→":>8} {"err":>6} {"best→":>7} {"err":>6}')
for x, y, es, pk, ep, orc, eo in rows:
    print(f'{f"({x},{y})":>12} {es:7.2f} {"photo " + str(pk):>8} {ep:6.2f} {"photo " + str(orc):>7} {eo:6.2f}')
n = len(rows)
print(f'\nmean error in the {n} worst windows: stack {tot["stack"] / n:.2f}, after Pick+paint {tot["pick"] / n:.2f}, '
      f'best single photo {tot["oracle"] / n:.2f}  (/255)')
json.dump({'ref': ref, 'rows': rows, 'totals': {k: v / n for k, v in tot.items()}}, open(os.path.join(out, 'effect.json'), 'w'), default=float)

# visual: worst windows, stack | picked photo | truth, 3x
tiles = []
for x, y, es, pk, ep, orc, eo in rows[:6]:
    sl = (slice(max(0, y - 40), y + 40), slice(max(0, x - 40), x + 40))
    row = [cv2.resize(a[sl], None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST) for a in (stack, imgs[pk], T)]
    tiles.append(np.hstack([np.pad(r, ((4, 4), (4, 4), (0, 0))) for r in row]))
h = max(t.shape[0] for t in tiles); w = max(t.shape[1] for t in tiles)
cv2.imwrite(os.path.join(out, 'windows.jpg'), np.vstack([np.pad(t, ((0, h - t.shape[0]), (0, w - t.shape[1]), (0, 0))) for t in tiles]))
