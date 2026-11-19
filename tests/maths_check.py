#!/usr/bin/env python3
"""
Drives the real app in headless Chromium at phone size with "watch the maths" on: stacks a burst,
takes a picture of the stacking screen every couple of seconds, records a video of the run, and
checks there were no page errors. Then stacks the same burst with the maths hidden and checks the
two saved stacks are identical (watching must never change the result).

    python -m http.server 8765 --bind 127.0.0.1     # from the repo root, in another window
    python tests/maths_check.py tests/bursts/moved [out folder]
"""
import glob, hashlib, os, shutil, sys, tempfile, time
from playwright.sync_api import sync_playwright

burst = sys.argv[1] if len(sys.argv) > 1 else 'tests/bursts/legs'
out = sys.argv[2] if len(sys.argv) > 2 else 'maths-check-out'
os.makedirs(out, exist_ok=True)
photos = sorted(glob.glob(os.path.join(burst, '*.jpg')))
URL = os.environ.get('APP_URL', 'http://127.0.0.1:8765/')


def run(p, maths_on, video):
    prof = tempfile.mkdtemp(prefix='spood-prof-')          # persistent: the scratch file needs real OPFS quota
    ctx = p.chromium.launch_persistent_context(prof, viewport={'width': 412, 'height': 880}, device_scale_factor=2,
                                               is_mobile=True, has_touch=True, accept_downloads=True,
                                               record_video_dir=(out if video else None), record_video_size={'width': 412, 'height': 880})
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(URL)
    page.evaluate(f"localStorage.setItem('spood-maths', '{1 if maths_on else 0}')")
    page.reload()
    page.wait_for_function("document.getElementById('engine').textContent.includes('ready')", timeout=120000)
    page.set_input_files('#file', photos)
    t0 = time.time(); shots = 0
    with page.expect_download(timeout=900000) as dl:
        page.click('#go')
        if maths_on:
            page.wait_for_selector('#maths:not([hidden])', timeout=10000)
            while page.is_visible('#work'):
                page.locator('#work').screenshot(path=f'{out}/work-{shots:02d}.png'); shots += 1
                page.wait_for_timeout(1800)
    d = dl.value
    path = os.path.join(out, ('maths-' if maths_on else 'plain-') + d.suggested_filename); d.save_as(path)
    secs = time.time() - t0
    log = page.inner_text('#log')
    vid = page.video.path() if video else None
    ctx.close(); shutil.rmtree(prof, ignore_errors=True)
    return path, secs, errors, shots, log, vid


with sync_playwright() as p:
    a, sa, ea, shots, log, vid = run(p, True, True)
    print(f'maths on: {sa:.0f}s, {shots} screenshots, page errors: {ea or "none"}')
    print('\n'.join(l for l in log.splitlines() if 'cores' in l or 'memory' in l))
    if vid: shutil.move(vid, os.path.join(out, 'run.webm')); print('video:', os.path.join(out, 'run.webm'))
    b, sb, eb, _, _, _ = run(p, False, False)
    print(f'maths off: {sb:.0f}s, page errors: {eb or "none"}')
    # the saved JPEGs carry a time stamp in EXIF? compare pixels, not bytes
    from PIL import Image
    import numpy as np
    A, B = np.asarray(Image.open(a)), np.asarray(Image.open(b))
    same = A.shape == B.shape and np.array_equal(A, B)
    print('same stack with and without the maths:', same, A.shape)
