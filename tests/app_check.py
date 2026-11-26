#!/usr/bin/env python3
"""
Drives the real app in headless Chromium at phone size: stack a burst and check the
saved JPEG keeps its EXIF.

    python -m http.server 8765 --bind 127.0.0.1     # from the repo root, in another window
    python tests/app_check.py tests/bursts/legs [out folder]
"""
import glob, json, os, sys, time
import piexif
from playwright.sync_api import sync_playwright

burst = sys.argv[1] if len(sys.argv) > 1 else 'tests/bursts/legs'
out = sys.argv[2] if len(sys.argv) > 2 else 'app-check-out'
os.makedirs(out, exist_ok=True)
photos = sorted(f for f in glob.glob(os.path.join(burst, '*.jpg')))
URL = os.environ.get('APP_URL', 'http://127.0.0.1:8765/')


def exif_summary(path):
    d = piexif.load(path)
    return {'orientation': d['0th'].get(274), 'w': d['Exif'].get(40962), 'h': d['Exif'].get(40963),
            'date': (d['Exif'].get(36867) or b'').decode(), 'gps': bool(d['GPS'].get(2)),
            'make': (d['0th'].get(271) or b'').decode(), 'thumbnail': len(d['thumbnail'] or b'')}


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2, is_mobile=True,
                        has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(URL)
    page.wait_for_function("document.getElementById('engine').textContent.includes('ready')", timeout=120000)
    page.set_input_files('#file', photos)
    page.screenshot(path=f'{out}/1-chosen.png')
    t0 = time.time()
    with page.expect_download(timeout=900000) as dl:
        page.click('#go')
    d = dl.value
    first = os.path.join(out, d.suggested_filename); d.save_as(first)
    print(f'stacked in {time.time() - t0:.0f}s -> {d.suggested_filename}')
    page.wait_for_timeout(500)
    page.screenshot(path=f'{out}/2-done.png', full_page=True)
    print('meta note:', page.inner_text('#metaNote'))
    print('exif:', json.dumps(exif_summary(first)))
    print('no Retouch left on the page:', page.locator('#retouchBtn, #retouch').count() == 0)
    print('page errors:', errors or 'none')
    b.close()
