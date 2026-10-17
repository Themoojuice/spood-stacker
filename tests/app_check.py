#!/usr/bin/env python3
"""
Drives the real app in headless Chromium at phone size: stack a burst, check the
saved JPEG keeps its EXIF, open Retouch, pick and paint, save, and check the
retouched JPEG.

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
    print('retouch button visible:', page.is_visible('#retouchBtn'))

    # ---- retouch ----
    page.click('#retouchBtn')
    page.wait_for_timeout(500)
    page.go_back(); page.wait_for_timeout(300)          # Android back gesture
    print('back closes retouch:', page.is_hidden('#retouch'), '· still on the app:', page.is_visible('#done'))
    page.click('#retouchBtn')
    page.wait_for_timeout(800)
    page.screenshot(path=f'{out}/3-retouch-open.png')
    info = page.evaluate("""() => { const c = document.querySelector('[data-rt=src]'); return [...c.children].map(b => b.textContent + (b.classList.contains('unused') ? '*' : '')); }""")
    print('source chips:', info)
    box = page.locator('[data-rt=view]').bounding_box()
    # tap twice on one spot (pick, then cycle), using real touch
    cx, cy = box['x'] + box['width'] * 0.45, box['y'] + box['height'] * 0.40
    page.touchscreen.tap(cx, cy); page.wait_for_timeout(700)
    t1 = page.inner_text('[data-rt=toast]')
    page.screenshot(path=f'{out}/4-picked.png')
    page.touchscreen.tap(cx, cy); page.wait_for_timeout(700)
    t2 = page.inner_text('[data-rt=toast]')
    print('pick:', t1); print('cycle:', t2)
    # paint with the mouse (pointer events), then undo, then paint again
    page.click('[data-mode=paint]')
    def stroke(y):
        page.mouse.move(box['x'] + box['width'] * 0.25, box['y'] + box['height'] * y)
        page.mouse.down()
        for k in range(1, 21):
            page.mouse.move(box['x'] + box['width'] * (0.25 + 0.025 * k), box['y'] + box['height'] * y, steps=2)
        page.mouse.up()
    stroke(0.5); page.wait_for_timeout(300)
    n1 = page.evaluate('window.spoodRetouchSession.strokes')
    page.click('[data-rt=undo]'); page.wait_for_timeout(200)
    n2 = page.evaluate('window.spoodRetouchSession.strokes')
    stroke(0.55); page.wait_for_timeout(300)
    print(f'strokes after paint {n1}, after undo {n2}, after repaint', page.evaluate('window.spoodRetouchSession.strokes'))
    page.screenshot(path=f'{out}/5-painted.png')
    # pinch-free zoom check (wheel) and peek
    page.mouse.move(cx, cy); page.mouse.wheel(0, -600); page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/6-zoomed.png')
    pk = page.locator('[data-rt=peek]').bounding_box()
    page.mouse.move(pk['x'] + 10, pk['y'] + 10); page.mouse.down(); page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/7-peek.png'); page.mouse.up()
    with page.expect_download(timeout=60000) as dl2:
        page.click('[data-rt=done]')
    d2 = dl2.value
    second = os.path.join(out, d2.suggested_filename); d2.save_as(second)
    page.wait_for_timeout(500)
    page.screenshot(path=f'{out}/8-after.png', full_page=True)
    print('retouched ->', d2.suggested_filename, json.dumps(exif_summary(second)))
    print('page errors:', errors or 'none')
    b.close()
