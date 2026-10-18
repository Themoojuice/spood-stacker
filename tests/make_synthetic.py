#!/usr/bin/env python3
"""
Synthetic handheld focus bursts with a known all-in-focus answer.

Each burst is a procedural 'spider' (setae-covered body, glossy eyes, eight
legs running through depth) on a tilted bark plane, photographed as a
lean-in burst: the focal plane steps through the subject while the camera
drifts, rotates a little and magnifies (near parts magnify more than far
ones, so there is real parallax). Defocus is rendered per depth layer with
occlusion, so defocused legs bleed over the background the way real ones do;
that is what makes halos at depth edges.

Writes, per burst:
  tests/bursts/<name>/IMG_00NN.jpg   the burst (EXIF: date, GPS, camera; ICC)
  tests/bursts/<name>/truth/NN.png   best-achievable result in frame NN's geometry: sharp
                                     wherever some frame was in focus, background as blurred
                                     as in the nearest frame (the stack inherits the reference
                                     frame's geometry)

    python tests/make_synthetic.py            # all scenes
    python tests/make_synthetic.py legs       # one scene
    (scenes: bark, legs, still, moved, and dup = bark plus an edited duplicate)
"""
import io, math, os, sys
import cv2
import numpy as np
import piexif
from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'bursts')

W, H = 2000, 1500
BLUR_PER_DEPTH = 22.0          # Gaussian sigma (px) per unit of depth away from the focal plane


def fractal(rng, h, w, octaves=6, base=4):
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        s = base * 2 ** o
        n = rng.standard_normal((max(2, h * s // w), s)).astype(np.float32)
        out += amp * cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
        tot += amp; amp *= 0.55
    out /= tot
    return (out - out.mean()) / (out.std() + 1e-6)


class Part:
    """One occluding piece of the scene: colour, coverage, depth (all full-frame)."""
    def __init__(self, color, alpha, depth):
        self.color, self.alpha, self.depth = color, alpha, depth


def bark(rng):
    t = fractal(rng, H, W, 7, 3)
    streak = cv2.resize(rng.standard_normal((H // 6, 24)).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    fine = cv2.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 1.0)
    v = 0.36 + 0.10 * t + 0.07 * streak + 0.06 * fine
    col = np.dstack([v * 0.78, v * 0.92, v * 1.05]).clip(0, 1)            # RGB, greyish-brown
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None] * np.ones((1, W), np.float32)
    depth = 0.62 + 0.38 * (1 - yy)                                           # near at the bottom, far at the top
    return Part(col.astype(np.float32), np.ones((H, W), np.float32), depth.astype(np.float32))


def setae(rng, mask, base, n, length, shade):
    """Hairy texture: many short thin antialiased strokes inside the mask."""
    img = np.zeros((H, W, 3), np.float32)
    ys, xs = np.nonzero(mask > 0.5)
    if not len(xs):
        return img
    pick = rng.integers(0, len(xs), n)
    for k in pick:
        x, y = int(xs[k]), int(ys[k])
        a = rng.uniform(0, math.pi)
        L = rng.uniform(0.5, 1.0) * length
        x2, y2 = int(x + L * math.cos(a)), int(y + L * math.sin(a))
        c = shade[rng.integers(0, len(shade))]
        cv2.line(img, (x, y), (x2, y2), c, 1, cv2.LINE_AA)
    return img


def spider(rng, cx, cy, size, leg_depths, body_depth=(0.18, 0.42), shift=(0, 0)):
    parts = []
    # legs first (they are under the body); each leg is a chain of short segments
    angles = [-150, -125, -100, -70, 70, 100, 125, 150]
    for k, ang in enumerate(angles):
        a0 = math.radians(ang + rng.uniform(-6, 6))
        d0, d1 = leg_depths[k]
        pts = []
        L = size * rng.uniform(1.5, 2.1)
        bend = rng.uniform(-0.6, 0.6)
        for s in np.linspace(0, 1, 26):
            a = a0 + bend * s * s
            r = size * 0.35 + L * s
            pts.append((cx + r * math.sin(a), cy - r * math.cos(a), d0 + (d1 - d0) * s))
        col = np.zeros((H, W, 3), np.float32); al = np.zeros((H, W), np.float32); dep = np.zeros((H, W), np.float32)
        for i in range(len(pts) - 1):
            (x0, y0, z0), (x1, y1, z1) = pts[i], pts[i + 1]
            wdt = int(round(size * 0.075 * (1.0 - 0.45 * i / len(pts))))
            seg = np.zeros((H, W), np.float32)
            cv2.line(seg, (int(x0), int(y0)), (int(x1), int(y1)), 1.0, wdt, cv2.LINE_AA)
            # segment colour: banded leg (tibia rings)
            band = 0.10 if (i // 3) % 2 else 0.22
            new = seg > al
            dep[new] = (z0 + z1) / 2
            al = np.maximum(al, seg)
            col[new] = (band * 1.1, band, band * 0.85)
        hair = setae(rng, al, None, 900, size * 0.10, [(0.75, 0.7, 0.6), (0.02, 0.02, 0.02)])
        m = hair.sum(2) > 0
        col[m & (al > 0.5)] = hair[m & (al > 0.5)]
        parts.append(Part(col, al, dep))

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # abdomen (behind), then cephalothorax with eyes
    for (abd, oy, rx, ry, dz, tint, nh) in [
            (True, size * 0.95, size * 0.62, size * 0.85, (body_depth[1], body_depth[1] + 0.12), (0.30, 0.22, 0.12), 26000),
            (False, 0, size * 0.55, size * 0.50, body_depth, (0.16, 0.14, 0.12), 20000)]:
        ex, ey = cx + (shift[0] if abd else 0), cy + oy + (shift[1] if abd else 0)   # a moved abdomen = pose change
        r2 = ((xx - ex) / rx) ** 2 + ((yy - ey) / ry) ** 2
        al = np.clip((1 - r2) * min(rx, ry) / 2.0, 0, 1).astype(np.float32)          # ~2 px antialiased rim
        dep = (dz[0] + (dz[1] - dz[0]) * np.clip((yy - (ey - ry)) / (2 * ry), 0, 1) + 0.03 * r2).astype(np.float32)
        shade = 0.6 + 0.4 * np.sqrt(np.clip(1 - r2, 0, 1))
        col = (np.array(tint, np.float32)[None, None] * shade[..., None]).astype(np.float32)
        hair = setae(rng, al, None, nh, size * 0.09,
                     [(0.92, 0.88, 0.80), (0.85, 0.55, 0.20), (0.03, 0.03, 0.03), (0.6, 0.6, 0.6)])
        m = hair.sum(2) > 0
        col[m] = hair[m]
        parts.append(Part(col, al, dep))
    # anterior median eyes: big, dark, glossy, nearest point of the subject
    for sx in (-1, 1):
        ex, ey, r = cx + sx * size * 0.18, cy - size * 0.30, size * 0.15
        d2 = (xx - ex) ** 2 + (yy - ey) ** 2
        al = np.clip(r - np.sqrt(d2), 0, 1).astype(np.float32)
        col = np.zeros((H, W, 3), np.float32) + 0.03
        hx, hy = ex - r * 0.35, ey - r * 0.35
        col[(xx - hx) ** 2 + (yy - hy) ** 2 < (r * 0.18) ** 2] = 0.97        # specular highlight
        ring = np.abs(np.sqrt(d2) - r * 0.92) < 2
        col[ring] = (0.55, 0.45, 0.25)
        dep = np.full((H, W), body_depth[0] - 0.02, np.float32)
        parts.append(Part(col, al, dep))
    return parts


def warp_part(p, Hm):
    f = dict(flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    col = cv2.warpPerspective(p.color, Hm, (W, H), **f)
    al = cv2.warpPerspective(p.alpha, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    dep = cv2.warpPerspective(p.depth, Hm, (W, H), **f)
    return Part(col, al, dep)


def render(parts, focus, sigma_of=None):
    """Layered defocus with occlusion. Within one part, each depth layer also
    covers that part's nearer pixels, so a continuous surface has no seams.
    sigma_of(depth) overrides the blur (used for the best-achievable truth)."""
    sigma_of = sigma_of or (lambda d: BLUR_PER_DEPTH * abs(d - focus))
    acc = np.zeros((H, W, 3), np.float32)
    for p in parts:
        ys, xs = np.nonzero(p.alpha > 0.002)
        if not len(xs):
            continue
        dmin, dmax = float(p.depth[ys, xs].min()), float(p.depth[ys, xs].max())
        nb = max(1, int(math.ceil((dmax - dmin) / 0.012)))
        edges = np.linspace(dmin, dmax, nb + 1)
        pad = int(3 * max(sigma_of(dmin), sigma_of(dmax), sigma_of(0.5 * (dmin + dmax)))) + 4
        x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)
        y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad + 1)
        sl = (slice(y0, y1), slice(x0, x1))
        C, A, D = p.color[sl], p.alpha[sl], p.depth[sl]
        out = acc[sl]
        for b in range(nb - 1, -1, -1):                    # far to near
            m = A * (D <= edges[b + 1] + 1e-6)
            if b < nb - 1 and not m.any():
                continue
            sig = sigma_of(0.5 * (edges[b] + edges[b + 1]))
            Cm = C * m[..., None]
            if sig > 0.3:
                m = cv2.GaussianBlur(m, (0, 0), sig)
                Cm = cv2.GaussianBlur(Cm, (0, 0), sig)
            out = out * (1 - m[..., None]) + Cm
        acc[sl] = out
    return acc


def achievable(parts, f0, f1):
    """The best any stacker could do: everything inside the swept focus range
    sharp, everything outside it as blurred as in the nearest frame."""
    return render(parts, 0, lambda d: BLUR_PER_DEPTH * max(0.0, d - f1, f0 - d))


def vignette(img):
    """The black clamp edge of a clip-on macro lens."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.sqrt(((xx - W / 2) / (W * 0.62)) ** 2 + ((yy - H / 2) / (H * 0.62)) ** 2)
    v = np.clip((1.0 - r) / 0.06, 0, 1) ** 1.5
    return img * v[..., None]


def cam_motion(rng, k, n, lean):
    """Homography for frame k: drift, tilt, and lean-in magnification."""
    s = 1 + lean * k / max(1, n - 1)
    a = math.radians(rng.normal(0, 0.5))
    tx, ty = rng.normal(0, 18), rng.normal(0, 18)
    c, si = math.cos(a) * s, math.sin(a) * s
    T = np.array([[c, -si, 0], [si, c, 0], [0, 0, 1]], np.float64)
    C = np.array([[1, 0, W / 2], [0, 1, H / 2], [0, 0, 1]], np.float64)
    Ci = np.linalg.inv(C)
    P = np.eye(3); P[2, 0] = rng.normal(0, 4e-6); P[2, 1] = rng.normal(0, 4e-6)
    M = np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]]) @ C @ T @ P @ Ci
    return M


def parallax(depth, k, n, amount):
    """Near things magnify more as you lean in (scale about the frame centre)."""
    s = 1 + amount * (1 - depth) * k / max(1, n - 1)
    C = np.array([[1, 0, W / 2], [0, 1, H / 2], [0, 0, 1]], np.float64)
    return C @ np.diag([s, s, 1]) @ np.linalg.inv(C)


def srgb_icc():
    return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


def exif_bytes(k, w, h, orientation):
    def dms(v):
        v = abs(v); d = int(v); m = int((v - d) * 60); s = round(((v - d) * 60 - m) * 60 * 100)
        return ((d, 1), (m, 1), (s, 100))
    lat, lon = -16.9186, 145.7781
    zeroth = {piexif.ImageIFD.Make: b'samsung', piexif.ImageIFD.Model: b'SM-S938B',
              piexif.ImageIFD.Orientation: orientation, piexif.ImageIFD.Software: b'S938BXXU1AXXX',
              piexif.ImageIFD.DateTime: b'2026:10:12 09:41:%02d' % (10 + k)}
    exif = {piexif.ExifIFD.DateTimeOriginal: b'2026:10:12 09:41:%02d' % (10 + k),
            piexif.ExifIFD.OffsetTimeOriginal: b'+10:00',
            piexif.ExifIFD.PixelXDimension: w, piexif.ExifIFD.PixelYDimension: h,
            piexif.ExifIFD.FocalLength: (630, 100), piexif.ExifIFD.FNumber: (17, 10),
            piexif.ExifIFD.ExposureTime: (1, 500), piexif.ExifIFD.ISOSpeedRatings: 200}
    gps = {piexif.GPSIFD.GPSLatitudeRef: b'S', piexif.GPSIFD.GPSLatitude: dms(lat),
           piexif.GPSIFD.GPSLongitudeRef: b'E', piexif.GPSIFD.GPSLongitude: dms(lon),
           piexif.GPSIFD.GPSAltitudeRef: 0, piexif.GPSIFD.GPSAltitude: (12, 1)}
    # a thumbnail in IFD1, like a real phone photo (the stacker must not carry it over)
    th = io.BytesIO(); Image.new('RGB', (160, 120), (200, 30, 30)).save(th, 'JPEG', quality=70)
    first = {piexif.ImageIFD.Compression: 6, piexif.ImageIFD.XResolution: (72, 1),
             piexif.ImageIFD.YResolution: (72, 1), piexif.ImageIFD.ResolutionUnit: 2}
    return piexif.dump({'0th': zeroth, 'Exif': exif, 'GPS': gps, '1st': first, 'thumbnail': th.getvalue()})


SCENES = {
    # name: frames, focus range, lean-in, parallax, leg depths, orientation, seed, subject shift in the last frames
    'bark':  dict(n=9, f=(0.16, 0.66), lean=0.04, par=0.05, orient=1, seed=3, moved=None,
                  legs=[(0.35, 0.55)] * 4 + [(0.30, 0.20)] * 4),
    'legs':  dict(n=7, f=(0.10, 0.70), lean=0.05, par=0.08, orient=6, seed=11, moved=None,
                  legs=[(0.30, 0.10), (0.35, 0.70), (0.30, 0.15), (0.40, 0.75),
                        (0.30, 0.08), (0.35, 0.68), (0.32, 0.12), (0.40, 0.72)]),
    # tripod-still: no drift, lean or parallax, so the truth lines up exactly and
    # what remains is pure fusion error (halos at depth edges)
    'still': dict(n=9, f=(0.16, 0.66), lean=0.0, par=0.0, orient=1, seed=3, moved=None, still=True,
                  legs=[(0.35, 0.55)] * 4 + [(0.30, 0.20)] * 4),
    'moved': dict(n=8, f=(0.14, 0.64), lean=0.03, par=0.04, orient=1, seed=7, moved=(-40, 25),
                  legs=[(0.32, 0.50)] * 8),
}


def make(name):
    sc = SCENES[name]
    rng = np.random.default_rng(sc['seed'])
    bg = bark(rng)
    base = spider(np.random.default_rng(sc['seed'] + 100), W * 0.47, H * 0.42, 210, sc['legs'])
    moved = spider(np.random.default_rng(sc['seed'] + 100), W * 0.47, H * 0.42, 210, sc['legs'],
                   shift=sc['moved']) if sc['moved'] else None
    d = os.path.join(OUT, name); os.makedirs(os.path.join(d, 'truth'), exist_ok=True)
    for f in os.listdir(d):
        if f.endswith('.jpg'):
            os.remove(os.path.join(d, f))
    icc = srgb_icc()
    n = sc['n']
    for k in range(n):
        focus = sc['f'][1] - (sc['f'][1] - sc['f'][0]) * k / (n - 1)       # lean in: far first, near last
        Mc = np.eye(3) if sc.get('still') else cam_motion(rng, k, n, sc['lean'])
        src = moved if (moved is not None and k >= n - 2) else base
        parts = [warp_part(bg, Mc @ parallax(np.float32(bg.depth.mean()), k, n, sc['par']))]
        for p in src:
            dm = float(p.depth[p.alpha > 0.5].mean()) if (p.alpha > 0.5).any() else 0.4
            parts.append(warp_part(p, Mc @ parallax(dm, k, n, sc['par'])))
        img = vignette(render(parts, focus))
        truth = vignette(achievable(parts, *sc['f']))
        img = img + rng.normal(0, 1.6 / 255, img.shape).astype(np.float32)
        u8 = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
        t8 = (np.clip(truth, 0, 1) * 255 + 0.5).astype(np.uint8)
        cv2.imwrite(os.path.join(d, 'truth', f'{k + 1:02d}.png'), cv2.cvtColor(t8, cv2.COLOR_RGB2BGR))
        pil = Image.fromarray(u8)
        o = sc['orient']
        if o == 6:                          # stored sideways; viewers rotate 90° clockwise
            pil = pil.transpose(Image.Transpose.ROTATE_90)
        pil.save(os.path.join(d, f'IMG_{k + 1:04d}.jpg'), 'JPEG', quality=93,
                 exif=exif_bytes(k, pil.width, pil.height, o), icc_profile=icc)
        print(f'{name}: frame {k + 1}/{n}  focus {focus:.2f}', flush=True)


def make_dup():
    """The bark burst plus a smaller, re-saved copy of one photo (like an edited
    duplicate sent through a messaging app): the stacker should drop the copy."""
    import shutil
    src, d = os.path.join(OUT, 'bark'), os.path.join(OUT, 'dup')
    os.makedirs(d, exist_ok=True)
    for f in sorted(os.listdir(src)):
        if f.endswith('.jpg'):
            shutil.copy2(os.path.join(src, f), d)
    im = Image.open(os.path.join(src, 'IMG_0005.jpg'))
    im.resize((im.width * 3 // 5, im.height * 3 // 5), Image.LANCZOS).save(
        os.path.join(d, 'IMG_0005-edited.jpg'), quality=85, exif=im.info['exif'])
    print('dup: bark + IMG_0005-edited.jpg')


if __name__ == '__main__':
    for nm in (sys.argv[1:] or list(SCENES) + ['dup']):
        make_dup() if nm == 'dup' else make(nm)
