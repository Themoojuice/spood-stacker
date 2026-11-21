#!/usr/bin/env python3
"""
Checks "Clear temporary memory" in the real app (headless Chromium, phone size): stacks a burst,
changes the sharpening (so the version on screen isn't saved), plants a leftover scratch file and
a photo waiting from the share sheet, then taps Clear temporary memory. Checks that the unsaved
version was saved first, the page started afresh with a note saying what was cleared, the
scratch file and the waiting photo are gone, the record of stacks cut short is gone, the
settings are kept, and the engine is ready again.

    python -m http.server 8765 --bind 127.0.0.1     # from the repo root, in another window
    python tests/clear_check.py tests/bursts/legs [out folder]
    ONE_CORE=1 python tests/clear_check.py ...       # stack on one core first: the engine's own memory
                                                     # then grows, and the fresh one must hold less
"""
import glob, os, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

burst = sys.argv[1] if len(sys.argv) > 1 else 'tests/bursts/legs'
out = sys.argv[2] if len(sys.argv) > 2 else 'clear-check-out'
os.makedirs(out, exist_ok=True)
photos = sorted(glob.glob(os.path.join(burst, '*.jpg')))
URL = os.environ.get('APP_URL', 'http://127.0.0.1:8765/')
ok = True
def check(cond, what):
    global ok
    print(('ok   ' if cond else 'FAIL ') + what); ok = ok and cond

with sync_playwright() as p:
    prof = tempfile.mkdtemp(prefix='spood-prof-')
    ctx = p.chromium.launch_persistent_context(prof, viewport={'width': 412, 'height': 880}, device_scale_factor=2,
                                               is_mobile=True, has_touch=True, accept_downloads=True)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(URL)
    page.evaluate("localStorage.setItem('spood-maths', '0'); localStorage.setItem('spood-sharpen', '70'); localStorage.setItem('spood-full-detail', '0')")
    if os.environ.get('ONE_CORE'): page.evaluate("localStorage.setItem('spood-cut-short', '2')")
    page.reload()
    page.wait_for_function("document.getElementById('engine').textContent.includes('ready')", timeout=120000)
    page.set_input_files('#file', photos)
    with page.expect_download(timeout=900000) as dl:
        page.click('#go')
    dl.value.save_as(os.path.join(out, 'auto-' + dl.value.suggested_filename))
    page.wait_for_selector('#done:not([hidden])', timeout=60000)
    check(page.is_visible('#clearMem'), 'the button is on the result screen')
    # the sharpening changed: the version on screen isn't saved
    page.evaluate("const s = document.getElementById('sharp'); s.value = 110; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'))")
    page.wait_for_function("document.getElementById('savedNote').textContent.includes('Save again')", timeout=60000)
    # leftovers: a scratch file from a stack that was cut off, a photo waiting from the share sheet,
    # the record of a stack cut short
    page.evaluate("""async () => {
      const d = await navigator.storage.getDirectory(), f = await d.getFileHandle('spood-scratch-123', { create: true });
      const w = await f.createWritable(); await w.write(new Uint8Array(5 * 1048576)); await w.close();
      const c = await caches.open('spood-shared'); await c.put('/shared/0', new Response(new Blob([new Uint8Array(1000)], { type: 'image/jpeg' })));
      localStorage.setItem('spood-cut-short', '1');
    }""")
    with page.expect_download(timeout=30000) as dl2:
        page.click('#clearMem')
    name2 = dl2.value.suggested_filename; dl2.value.save_as(os.path.join(out, 'before-clear-' + name2))
    check(True, f'the unsaved version was saved first ({name2})')
    page.wait_for_selector('#clearedNote:not([hidden])', timeout=30000)
    page.wait_for_function("document.getElementById('engine').textContent.includes('ready')", timeout=120000)
    page.wait_for_function("/fresh one holds/.test(document.getElementById('clearedNote').textContent)", timeout=20000)
    note = page.inner_text('#clearedNote'); print('note:', note)
    check('leftover scratch file' in note and 'share sheet' in note and 'page was holding' in note and 'engine was restarted' in note, 'the note says what was cleared')
    import re
    held = re.search(r'it held (\d+) MB, a fresh one holds (\d+) MB', note)
    if os.environ.get('ONE_CORE'): check(bool(held) and int(held.group(1)) > int(held.group(2)), 'the fresh engine holds less than the one that stacked on one core')
    st = page.evaluate("""async () => {
      const d = await navigator.storage.getDirectory(), names = []; for await (const k of d.keys()) names.push(k);
      return { scratch: names.filter(k => k.startsWith('spood-scratch-')), shared: await caches.has('spood-shared'),
        cut: localStorage.getItem('spood-cut-short'), sharpen: localStorage.getItem('spood-sharpen'), full: localStorage.getItem('spood-full-detail'),
        maths: localStorage.getItem('spood-maths'), app: (await caches.keys()).filter(k => k.startsWith('spood-app-')),
        pick: !document.getElementById('pick').hidden, done: !document.getElementById('done').hidden };
    }""")
    print(st)
    check(not st['scratch'], 'no scratch files left')
    check(not st['shared'], 'no photos waiting from the share sheet')
    check(st['cut'] in (None, '0'), 'the record of stacks cut short is gone (all cores again)')
    check(st['sharpen'] == '110' and st['full'] == '0' and st['maths'] == '0', 'settings kept')
    check(len(st['app']) >= 1, 'the app itself kept (offline)')
    check(st['pick'] and not st['done'], 'back on the start screen')
    page.screenshot(path=os.path.join(out, 'after-clear.png'), full_page=True)
    # and it still stacks
    page.set_input_files('#file', photos[:3])
    with page.expect_download(timeout=900000) as dl3:
        page.click('#go')
    check(True, 'stacks again after clearing')
    check(not errors, 'no page errors' + ('' if not errors else ': ' + '; '.join(errors)))
    ctx.close(); shutil.rmtree(prof, ignore_errors=True)
print('ALL OK' if ok else 'SOME CHECKS FAILED')
sys.exit(0 if ok else 1)
