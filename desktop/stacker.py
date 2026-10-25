#!/usr/bin/env python3
"""
Salticid stacker: handheld lean-in focus stacking for phone macro bursts.

Pipeline
  1. load + vignette mask (the dark clamp/lens-barrel edge: dark at the frame
     edge, nearly black, and in the same place in most photos)
  2. order frames by focus similarity (no reliance on filenames/EXIF)
  3. global alignment: SIFT + RANSAC homography to a mid-stack reference,
     refined with ECC (enhanced correlation coefficient)
  4. local alignment: dense optical flow on defocus-equalised images,
     chained through focus-neighbours, smoothed so it only corrects
     parallax / body shifts, never invents hair-scale motion. Worked out
     both ways; used only where there-and-back agrees (not at occlusions or
     on repeating mesh), decided pixel by pixel
  5. ghost mask: down-weight a frame wherever it still disagrees with
     the reference at low frequency (spider moved, flow failed)
  5b. photo selection: leave out a photo whose subject moved (judged where
     the photos are sharp, not over the whole frame), more strictly for a
     photo taken more than 2 s apart from the rest (another burst)
  6. fusion: 'pmax' (pyramid max), 'dmap' (depth map), 'wpyr'
     (weighted pyramid), 'hybrid' (weighted pyramid at coarse levels; at fine
     levels where the stack is confidently textured, the detail of every photo
     nearly as sharp as the best is merged, minus any that disagree)
     Each photo counts only where it has pixels of its own (coverage).
  7. crop to the area at least one used photo saw, mild finishing
  8. save PNG + high-quality JPEG, both carrying the reference photo's
     EXIF (date, GPS, camera) and colour profile
"""
import argparse, calendar, glob, os, re, struct, time, zlib
import cv2
import numpy as np

cv2.setNumThreads(os.cpu_count() or 2)


# ---------- helpers ----------
def to_gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def focus_measure(gray, sigma=4.0):
    """Local Laplacian energy - the per-pixel sharpness score."""
    lap = cv2.Laplacian(cv2.GaussianBlur(gray, (0, 0), 0.8), cv2.CV_32F, ksize=3)
    return cv2.GaussianBlur(lap * lap, (0, 0), sigma)


def guided_filter(I, p, r, eps):
    """Plain grey-guide guided filter (He et al.)."""
    k = (2 * r + 1, 2 * r + 1)
    mI = cv2.boxFilter(I, -1, k)
    mp = cv2.boxFilter(p, -1, k)
    cIp = cv2.boxFilter(I * p, -1, k) - mI * mp
    vI = cv2.boxFilter(I * I, -1, k) - mI * mI
    a = cIp / (vI + eps)
    b = mp - a * mI
    return cv2.boxFilter(a, -1, k) * I + cv2.boxFilter(b, -1, k)


def vignette_masks(grays, thresh=0.12):
    """Where each photo has usable pixels (1) vs the black clamp edge of a
    clip-on lens (0). A dark region touching the frame edge is the clamp only if
    it is nearly black inside and, with enough photos, sits in the same place in
    most of them: the clamp moves with the camera, a dark subject (a black
    caterpillar crossing the frame edge) does not."""
    n = len(grays); h, w = grays[0].shape
    q = 4; qw, qh = max(8, round(w / q)), max(8, round(h / q))
    labs, vals, edges = [], [], []
    frac = np.zeros((qh, qw), np.float32)
    for g in grays:
        s = cv2.resize(g, (qw, qh), interpolation=cv2.INTER_AREA)
        dark = (cv2.GaussianBlur(s, (0, 0), 15 / q) <= thresh).astype(np.uint8)
        nl, lab = cv2.connectedComponents(dark)
        edge = np.zeros(nl, bool)
        edge[np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))] = True
        edge[0] = False
        frac += edge[lab] / n
        labs.append(lab); vals.append(s); edges.append(edge)
    out = []
    for lab, s, edge in zip(labs, vals, edges):
        clamp = np.zeros(len(edge), bool)
        for c in np.nonzero(edge)[0]:
            m = lab == c
            med, steady = float(np.median(s[m])), float(frac[m].mean())
            clamp[c] = med < 0.035 or (med < 0.06 and (n < 4 or steady >= 0.6))
            if n >= 4 and steady < 0.6:
                clamp[c] = False
        m = cv2.resize((~clamp[lab]).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
        r = max(31, round(0.025 * max(h, w))) | 1        # keep clear of the clamp's soft edge
        out.append(cv2.erode(m, np.ones((r, r), np.uint8)))
    return out


def fill_uncovered(warped, wmask, ref):
    """Fill each lined-up photo outside its own pixels with the average of the
    photos that have pixels there (the reference where none does), so pyramids
    see no false edges at its border. Returns each photo's share of the
    reference's view."""
    M = np.stack([m > 0 for m in wmask]).astype(np.float32)
    cnt = M.sum(0)
    avg = sum(w * m[..., None] for w, m in zip(warped, M)) / np.maximum(cnt, 1)[..., None]
    fill = np.where((cnt > 0)[..., None], avg, warped[ref])
    share = []
    for i in range(len(warped)):
        own = M[i] > 0
        warped[i] = np.where(own[..., None], warped[i], fill).astype(np.float32)
        share.append(float((own & (M[ref] > 0)).sum() / max(1, (M[ref] > 0).sum())))
    return share


def cover_map(mask, band_frac=0.015):
    """1 well inside a photo's own pixels, easing to 0 over a band of ~1.5% of
    the frame at its border (the frame edge itself is not a border)."""
    m = cv2.copyMakeBorder((mask > 0).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_REPLICATE)
    d = cv2.distanceTransform(m, cv2.DIST_L2, 3)[1:-1, 1:-1]
    t = np.clip(d / max(4.0, band_frac * max(mask.shape)), 0, 1)
    return (t * t * (3 - 2 * t)).astype(np.float32)


# ---------- 1. load ----------
def load(paths, max_side=None):
    imgs = []
    for p in paths:
        im = cv2.imread(p, cv2.IMREAD_COLOR)
        if im is None:
            raise SystemExit(f"cannot read {p}")
        if max_side and max(im.shape[:2]) > max_side:
            s = max_side / max(im.shape[:2])
            im = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        imgs.append(im.astype(np.float32) / 255.0)
    # mixed resolutions (e.g. an edited copy): bring everything to the largest size;
    # alignment then corrects any crop/scale difference
    H = max(i.shape[0] for i in imgs); W = max(i.shape[1] for i in imgs)
    for k, im in enumerate(imgs):
        if im.shape[:2] != (H, W):
            print(f"note: frame {k + 1} is {im.shape[1]}x{im.shape[0]}, resized to {W}x{H}")
            imgs[k] = cv2.resize(im, (W, H), interpolation=cv2.INTER_CUBIC)
    return imgs


# ---------- 2. order ----------
def order_frames(grays):
    """Spectral ordering of frames by similarity of their focus maps.
    Neighbours in focus depth have similar sharpness maps."""
    n = len(grays)
    if n < 3:
        return list(range(n))
    V = []
    for g in grays:
        f = focus_measure(cv2.resize(g, (512, 384), interpolation=cv2.INTER_AREA), sigma=6)
        v = np.log(f.ravel() + 1e-7)
        V.append((v - v.mean()) / v.std())
    V = np.array(V)
    C = np.clip(V @ V.T / V.shape[1], 0, 1)
    L = np.diag(C.sum(1)) - C
    w, vecs = np.linalg.eigh(L)
    return [int(i) for i in np.argsort(vecs[:, 1])]


# ---------- 3. global alignment ----------
_FEATS = {}


def features(g, mask, key=None):
    """SIFT features of one photo, found once per photo when a key is given."""
    if key is not None and key in _FEATS:
        return _FEATS[key]
    sift = cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.01)
    k, d = sift.detectAndCompute((np.clip(g, 0, 1) * 255).astype(np.uint8), mask)
    f = (np.float32([p.pt for p in k]).reshape(-1, 2), d)
    if key is not None:
        _FEATS[key] = f
    return f


def homography(src_g, dst_g, mask_src, mask_dst, k_src=None, k_dst=None):
    """H mapping src -> dst coordinates. Sets homography.pairs (the inlier matches,
    for checking the fine-tune) and homography.rough (True when only a rough
    turn-shift-zoom was found: a photo framed far from the rest)."""
    homography.pairs, homography.rough = None, False
    (q1, d1), (q2, d2) = features(src_g, mask_src, k_src), features(dst_g, mask_dst, k_dst)
    if d1 is None or d2 is None or len(q1) < 20 or len(q2) < 20:
        return np.eye(3, dtype=np.float32), 0
    m = cv2.BFMatcher(cv2.NORM_L2).knnMatch(d1, d2, k=2)
    good = [a for a, b in (x for x in m if len(x) == 2) if a.distance < 0.75 * b.distance]
    if len(good) < 20:
        return np.eye(3, dtype=np.float32), len(good)
    p1 = q1[[g.queryIdx for g in good]]
    p2 = q2[[g.trainIdx for g in good]]
    H, inl = cv2.findHomography(p1, p2, cv2.USAC_MAGSAC, 3.0, maxIters=5000, confidence=0.999)
    n = int(inl.sum()) if H is not None else 0
    if n < 40:
        # A photo framed far from the rest (turned, zoomed, shot from a step to the side)
        # with a 3D subject: few matches fit one exact plane. Find the rough
        # turn-shift-zoom, which tolerates parallax, and let the fine-tune decide.
        thr = 8 * min(1.0, 1600 / max(src_g.shape)) + 1
        thr /= min(1.0, 1600 / max(src_g.shape))
        A, ia = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=thr, maxIters=5000, confidence=0.999)
        k = ia.ravel() > 0 if A is not None else None
        if k is not None and k.sum() >= 12 and k.sum() > n:
            Hl, il = cv2.findHomography(p1[k], p2[k], cv2.RANSAC, thr) if k.sum() >= 16 else (None, None)
            if Hl is not None and il.sum() >= 0.7 * k.sum():
                H, keep = Hl, np.flatnonzero(k)[il.ravel() > 0]
            else:
                H, keep = np.vstack([A, [0, 0, 1]]), np.flatnonzero(k)
            homography.pairs, homography.rough = (p1[keep], p2[keep]), True
            return H.astype(np.float32), len(keep)
    if H is None:
        return np.eye(3, dtype=np.float32), 0
    m = inl.ravel() > 0
    homography.pairs = (p1[m], p2[m])
    return H.astype(np.float32), n


def pair_error(H, pairs):
    """Median distance between where a line-up puts matched features and where they matched."""
    if pairs is None or not len(pairs[0]):
        return 0.0
    p = cv2.perspectiveTransform(pairs[0].reshape(-1, 1, 2).astype(np.float32), H.astype(np.float32)).reshape(-1, 2)
    return float(np.median(np.hypot(*(p - pairs[1]).T)))


def repeat_score(gray):
    """How strongly fine detail repeats (an insect screen, woven fabric), 0 = not at all.
    The autocorrelation of fine detail falls away from zero shift; a repeating pattern
    makes it come back up at the repeat distance. The score is how far it rebounds."""
    s = min(1.0, 1024 / max(gray.shape))
    r = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA).astype(np.float32)
    hp = r - cv2.GaussianBlur(r, (0, 0), 6)
    F = np.fft.rfft2(hp)
    A = np.fft.irfft2(F * np.conj(F), s=hp.shape)
    A = A / (A[0, 0] or 1e-12)
    H, W = A.shape
    rmax = min(W, H) // 4
    val = lambda dx, dy: A[dy % H, dx % W]
    best = 0.0
    for dy in range(-rmax, rmax + 1):
        for dx in range(0, rmax + 1):
            rr = dx * dx + dy * dy
            if rr < 9 or rr > rmax * rmax:
                continue
            v = val(dx, dy)
            if v < 0.15:
                continue
            if any(val(dx + i, dy + j) > v for j in (-1, 0, 1) for i in (-1, 0, 1) if i or j):
                continue
            steps = int(np.ceil(np.sqrt(rr) * 2))
            lo = min([v] + [val(round(dx * t / steps), round(dy * t / steps)) for t in range(1, steps)])
            best = max(best, v - lo)
    return float(best)


REPEAT = 0.4    # repeat score above this: a mesh-like pattern is in view


def ecc_refine(src_g, dst_g, H, mask, scale=0.5, pairs=None, repeating=False, rough=False):
    """Refine H with ECC on gradient magnitude (focus-insensitive-ish). The result must
    still agree with the matched features. With repeating texture in view (an insect
    screen) ECC locks onto whichever cells are nearest and shears the background, and
    two photos fine-tuned that way end up a fraction of a cell apart: there the
    features' line-up is kept and the flow does the rest."""
    if repeating:
        return H, False
    big = max(src_g.shape)

    def stage(H, scale, sigma, iters):
        # shrink first, then gradients at that size (blur scaled to match)
        sg = max(0.5, sigma * scale)
        def grad(g):
            g = cv2.GaussianBlur(cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), (0, 0), sg)
            gx = cv2.Sobel(g, cv2.CV_32F, 1, 0); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
            return cv2.GaussianBlur(np.sqrt(gx * gx + gy * gy), (0, 0), sg)
        s, d = grad(src_g), grad(dst_g)
        m = cv2.resize(mask, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_NEAREST)
        S = np.diag([scale, scale, 1]).astype(np.float32)
        # ECC wants warp from template(dst) coords to input(src) coords
        W = (S @ np.linalg.inv(H) @ np.linalg.inv(S)).astype(np.float32)
        try:
            _, W = cv2.findTransformECC(d, s, W, cv2.MOTION_HOMOGRAPHY,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, iters, 1e-5), m, 5)
        except cv2.error:
            return None
        Hn = (np.linalg.inv(np.linalg.inv(S) @ W @ S)).astype(np.float32)
        return Hn if np.isfinite(Hn).all() else None

    if rough:
        # a rough start: first line up the overall shapes, blurred enough that focus
        # differences don't matter
        c = stage(H, min(0.25, 500 / big), 0.006 * big, 100)
        if c is None or pair_error(c, pairs) >= max(12, 0.012 * big):
            return H, False
        H = c
    # half the working size first (most of the steps), then a few at the working size
    h = stage(H, scale / 2, 2.0, 100)
    Hn = stage(h if h is not None else H, scale, 2.0, 25)
    if Hn is None:
        return H, False
    # the fine-tune must still agree with the matched features: on repeating texture (an
    # insect screen) it can lock onto the wrong cells and shear the whole photo
    e0, e1 = pair_error(H, pairs), pair_error(Hn, pairs)
    if not e1 < max(4.0, 0.004 * max(src_g.shape), 2 * e0):
        return H, False
    return Hn, True


# ---------- 4. local alignment ----------
def dense_flow(ref_g, mov_g, mask=None, blur=2.5, smooth=4.0, max_px=None):
    """Flow field: for each ref pixel, where to sample in mov.
    Both images blurred to equalise defocus; flow smoothed with
    normalised convolution inside the valid mask, then clamped."""
    a = (np.clip(cv2.GaussianBlur(ref_g, (0, 0), blur), 0, 1) * 255).astype(np.uint8)
    b = (np.clip(cv2.GaussianBlur(mov_g, (0, 0), blur), 0, 1) * 255).astype(np.uint8)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(1)
    flow = dis.calc(a, b, None)                   # reference -> photo
    back = dis.calc(b, a, None)                   # photo -> reference
    # two-way check: following the flow there and back should land where it
    # started (within ~0.2% of the frame); it fails at occlusions, and there the
    # plain line-up is kept. DIS flow is noisy pixel to pixel, so the check runs
    # on smoothed copies.
    big = max(ref_g.shape)
    sm = lambda f: cv2.GaussianBlur(f, (0, 0), 0.004 * big)
    fs_, bs_ = sm(flow), sm(back)
    tau = 0.002 * big
    e = np.sqrt(((fs_ + remap(bs_, fs_, cv2.INTER_LINEAR)) ** 2).sum(-1))
    fb = cv2.GaussianBlur(np.clip(1 - (e - tau) / (2 * tau), 0, 1).astype(np.float32), (0, 0), tau)
    m = np.ones(ref_g.shape, np.float32) if mask is None else mask.astype(np.float32)
    # confidence: low where the blurred images still disagree after warping (occlusion / failure)
    warped_b = remap(b.astype(np.float32), flow)
    conf = np.exp(-np.abs(warped_b - a.astype(np.float32)) / 12.0) * m * fb
    den = cv2.GaussianBlur(conf, (0, 0), smooth) + 1e-4
    for c in range(2):
        flow[..., c] = cv2.GaussianBlur(flow[..., c] * conf, (0, 0), smooth) / den
    flow *= fb[..., None]
    if max_px is None:
        max_px = 0.04 * max(ref_g.shape)          # parallax/body shift, not teleportation
    mag = np.sqrt((flow ** 2).sum(-1, keepdims=True))
    flow *= np.minimum(1.0, max_px / (mag + 1e-6))
    return flow, fb


def remap(img, flow, interp=cv2.INTER_LANCZOS4):
    h, w = flow.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + flow[..., 0], gy + flow[..., 1], interp,
                     borderMode=cv2.BORDER_REFLECT)


def flow_ripple(flow):
    """How fast a flow field changes from pixel to pixel (px per px, smoothed)."""
    r = 0
    for c in range(2):
        f = cv2.GaussianBlur(flow[..., c], (0, 0), 2)
        r = r + np.abs(cv2.Sobel(f, cv2.CV_32F, 1, 0, ksize=3, scale=0.125)) + np.abs(cv2.Sobel(f, cv2.CV_32F, 0, 1, ksize=3, scale=0.125))
    return cv2.GaussianBlur(r, (0, 0), 6)


def gate_flow(flow, ref_g, mov_g, gain=FLOW_GATE_GAIN if 'FLOW_GATE_GAIN' in globals() else 3.0):
    """Keep the local warp only where it measurably improves agreement with
    the target. On repetitive or featureless texture (mesh, smooth blur)
    optical flow aliases and paints squiggles; there the global warp wins."""
    b = lambda g: cv2.GaussianBlur(g, (0, 0), 3)
    r = b(ref_g)
    e_glob = cv2.GaussianBlur(np.abs(b(mov_g) - r), (0, 0), 15)
    e_flow = cv2.GaussianBlur(np.abs(b(remap(mov_g, flow)) - r), (0, 0), 15)
    # absolute floor: in flat areas both errors are tiny and the ratio is noise
    alpha = np.clip((e_glob - e_flow - 0.002) / (e_glob + 0.01) * gain, 0, 1)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 15)[..., None]
    return flow * alpha


# ---------- full alignment ----------
def align(imgs, local='chain', ref=None, log=print, avoid=()):
    _FEATS.clear()
    n = len(imgs)
    grays = [to_gray(i) for i in imgs]
    masks = vignette_masks(grays)
    order = order_frames(grays)
    if ref is None:
        # reference = frame sharpest in the centre of the frame (where the
        # subject's face usually is). The master inherits this frame's
        # geometry, so if the subject moved, its sharpest view wins.
        h0, w0 = grays[0].shape
        cy, cx = slice(int(h0 * .3), int(h0 * .7)), slice(int(w0 * .3), int(w0 * .7))
        score = [focus_measure(g[cy, cx]).mean() for g in grays]
        ref = int(np.argmax([-1 if i in avoid else v for i, v in enumerate(score)]))
    ref_pos = order.index(ref)
    log(f"focus order: {[int(o) + 1 for o in order]}  reference: frame {int(ref) + 1}")
    repeating = any(repeat_score(g) > REPEAT for g in grays)
    if repeating:
        log("repeating texture in view (a mesh?): lined up from features only")
    h, w = grays[0].shape
    Hs = {ref: np.eye(3, dtype=np.float32)}
    # chain outward from the reference through focus-neighbours
    for direction in (-1, 1):
        prev = ref
        pos = ref_pos + direction
        while 0 <= pos < n:
            cur = order[pos]
            Hn, inl = homography(grays[cur], grays[prev], masks[cur], masks[prev], cur, prev)
            H, rough = Hs[prev] @ Hn, homography.rough
            # the matched features in reference coordinates: the fine-tune must still agree with them
            pr = homography.pairs
            pairs = (pr[0], cv2.perspectiveTransform(pr[1].reshape(-1, 1, 2), Hs[prev]).reshape(-1, 2)) if pr is not None else None
            Hd, inl_direct = homography(grays[cur], grays[ref], masks[cur], masks[ref], cur, ref)
            if inl_direct > 1.5 * inl or (rough and not homography.rough and inl_direct >= 20):   # direct match clearly better
                H, pairs, rough = Hd, homography.pairs, homography.rough
            H, ok = ecc_refine(grays[cur], grays[ref], H, masks[ref], pairs=pairs, repeating=repeating, rough=rough)
            Hs[cur] = H
            log(f"  frame {cur + 1}: inliers neighbour={inl} direct={inl_direct} ecc={'ok' if ok else ('off' if repeating else 'fail')}"
                + (" (framed well apart: lined up by its overall shape first)" if rough and ok else ""))
            prev, pos = cur, pos + direction

    warped, wmask = [None] * n, [None] * n
    for i in range(n):
        warped[i] = cv2.warpPerspective(imgs[i], Hs[i], (w, h), flags=cv2.INTER_LANCZOS4,
                                        borderMode=cv2.BORDER_REFLECT)
        wmask[i] = cv2.warpPerspective(masks[i], Hs[i], (w, h), flags=cv2.INTER_NEAREST)
    # a photo framed differently covers only part of the reference's view
    for i, c in enumerate(fill_uncovered(warped, wmask, ref)):
        if i != ref and c < 0.97:
            log(f"  frame {i + 1}: covers {round(c * 100)}% of the reference's view")
    trust = [np.ones((h, w), np.float32) for _ in range(n)]

    if local in ('chain', 'direct'):
        # chain: each frame aligned to its already-aligned focus-neighbour
        # direct: each frame aligned straight to the reference
        aligned = {ref: warped[ref]}
        for direction in (-1, 1):
            prev = ref
            pos = ref_pos + direction
            while 0 <= pos < n:
                cur = order[pos]
                tgt = prev if local == 'chain' else ref
                fm_mask = (wmask[tgt] > 0) & (wmask[cur] > 0)
                tg, cg = to_gray(aligned[tgt]), to_gray(warped[cur])
                plain = ghost_map(cv2.GaussianBlur(tg, (0, 0), 6.0), cg)   # agreement of the plain line-up
                flow, fb = dense_flow(tg, cg, fm_mask)
                flow = gate_flow(flow, tg, cg)
                # smoothness check on the flow that would be applied: real parallax and body
                # shifts change gently; flow that ripples (locked onto different cells of a
                # repeating mesh from place to place) bends straight threads into waves
                smooth_ok = cv2.GaussianBlur(np.clip(1 - (flow_ripple(flow) - 0.08) / 0.12, 0, 1).astype(np.float32), (0, 0), 4)
                flow = flow * smooth_ok[..., None]
                fb = fb * smooth_ok
                cand = remap(warped[cur], flow)
                # the warp is decided pixel by pixel (two-way check, gate); as a last
                # check it must not make whole-frame agreement worse
                band = lambda g: cv2.GaussianBlur(g, (0, 0), 2) - cv2.GaussianBlur(g, (0, 0), 10)
                T = band(tg)[fm_mask]
                ncc_g = np.corrcoef(T, band(cg)[fm_mask])[0, 1]
                ncc_f = np.corrcoef(T, band(to_gray(cand))[fm_mask])[0, 1]
                mag = np.sqrt((flow ** 2).sum(-1))
                share = float((mag[fm_mask] > 0.5).mean()) if fm_mask.any() else 0.0
                if share > 0 and ncc_f >= ncc_g + 0.002:
                    aligned[cur] = cand
                    wmask[cur] = (remap(wmask[cur].astype(np.float32), flow, cv2.INTER_LINEAR) > 0.5).astype(np.uint8)
                    verdict = f'used on {max(1, round(share * 100))}% of it'
                else:
                    aligned[cur] = warped[cur]
                    verdict = 'not needed'
                # trust: the two-way check passed, or the plain line-up already agreed
                trust[cur] = np.maximum(fb, plain)
                log(f"  frame {cur + 1}: local flow {verdict}, "
                    f"agreement {ncc_g:.3f} -> {ncc_f:.3f}")
                prev, pos = cur, pos + direction
        warped = [aligned[i] for i in range(n)]

    return warped, order, ref, wmask, trust


# ---------- 5. ghost weights ----------
def ghost_map(ref_blur, gray, sigma=6.0, tol=0.06):
    d = np.abs(cv2.GaussianBlur(gray, (0, 0), sigma) - ref_blur)
    return cv2.GaussianBlur(np.clip(1.0 - (d - tol) / tol, 0, 1).astype(np.float32), (0, 0), 4)


def ghost_weights(aligned, ref, sigma=6.0, tol=0.06):
    """1 where a frame agrees with the reference at low frequency, ->0 where not."""
    R = cv2.GaussianBlur(to_gray(aligned[ref]), (0, 0), sigma)
    return [ghost_map(R, to_gray(a), sigma, tol) for a in aligned]


# ---------- 5b. photo selection ----------
MOMENT_GAP = 2.0           # s between consecutive photos that starts a new "moment"
SUBJECT_MOVED = 0.65       # subject agreement below this: moved (real bursts 0.96+, a photo shot from a step to the side 0.76, weevil 0.38)
SUBJECT_MOVED_APART = 0.95  # stricter for a photo from a different moment


def taken_time(path):
    """Capture time in s (local clock), from EXIF DateTimeOriginal (+ sub-seconds),
    else a camera file name like IMG_20260828_155557_3.jpg; None if neither."""
    tiff, _ = read_meta(path)
    if tiff and len(tiff) >= 8 and tiff[:2] in (b'II', b'MM'):
        e = '<' if tiff[:2] == b'II' else '>'
        u16 = lambda o: struct.unpack(e + 'H', tiff[o:o + 2])[0]
        u32 = lambda o: struct.unpack(e + 'I', tiff[o:o + 4])[0]
        found = {}
        def ifd(off, name, seen):
            if not off or off + 2 > len(tiff) or off in seen:
                return
            seen.add(off)
            n = u16(off)
            for i in range(n):
                p = off + 2 + i * 12
                if p + 12 > len(tiff):
                    return
                tag, typ, cnt = u16(p), u16(p + 2), u32(p + 4)
                if typ == 2 and (name, tag) in (('exif', 0x9003), ('ifd0', 0x0132), ('exif', 0x9291)):
                    o = p + 8 if cnt <= 4 else u32(p + 8)
                    found[tag] = tiff[o:o + cnt].split(b'\0')[0].decode('ascii', 'ignore').strip()
                if tag == 0x8769:
                    ifd(u32(p + 8), 'exif', seen)
        try:
            ifd(u32(4), 'ifd0', set())
        except struct.error:
            pass
        d = found.get(0x9003) or found.get(0x0132)
        m = d and re.match(r'(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)', d)
        if m:
            sub = found.get(0x9291, '')
            return calendar.timegm(tuple(int(x) for x in m.groups())) + (float('0.' + sub) if sub.isdigit() else 0)
    m = re.search(r'(?:^|\D)(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)(\d{3})?(?!\d)', os.path.basename(path))
    if m:
        g = [int(x) for x in m.groups()[:6]]
        return calendar.timegm(tuple(g)) + (int(m.group(7)) / 1000 if m.group(7) else 0)
    return None


def moments(times):
    """Signed gap (s) from each photo to the main moment (the largest group of
    photos no more than MOMENT_GAP apart); 0 for photos in it or without a time."""
    apart = [0.0] * len(times)
    timed = sorted((t, i) for i, t in enumerate(times) if t is not None)
    if len(timed) < 2:
        return apart
    groups = [[timed[0]]]
    for a, b in zip(timed, timed[1:]):
        if b[0] - a[0] > MOMENT_GAP:
            groups.append([])
        groups[-1].append(b)
    main = max(groups, key=len)                  # ties go to the earlier group
    t0, t1 = main[0][0], main[-1][0]
    for g in groups:
        if g is not main:
            for t, i in g:
                apart[i] = t - t1 if t > t1 else t - t0
    return apart


def gap_text(s):
    d = f"{round(abs(s) / 60)} min" if abs(s) >= 120 else f"{max(1, round(abs(s)))} s"
    return f"{d} {'after' if s > 0 else 'before'}"


def subject_agreement(ref_img, cur_img, ghost, cover=None):
    """How well a photo agrees with the reference where either is sharp (0..1),
    only where the photo has pixels of its own. The frame-wide mean is dominated
    by background, so a small subject that walked off barely moves it; this
    weights by sharpness."""
    h, w = ghost.shape
    sz = ((w + 1) // 2, (h + 1) // 2)
    half = lambda im: focus_measure(cv2.resize(to_gray(im), sz, interpolation=cv2.INTER_AREA), 3)
    mx = np.maximum(half(ref_img), half(cur_img))
    if cover is not None:
        mx[cv2.resize(cover, sz, interpolation=cv2.INTER_AREA) < 0.5] = 0
    g = cv2.resize(ghost, sz, interpolation=cv2.INTER_AREA)
    pos = mx[::5, ::5]; pos = pos[pos > 0]
    top = (np.percentile(pos, 99) if pos.size else 0) or 1e-9
    wgt = np.minimum(1, mx / top)
    wgt[wgt < 0.1] = 0
    return float((wgt * g).sum() / wgt.sum()) if wgt.sum() > 0 else 1.0


def select_photos(aligned, ghosts, ref, apart, log=print, covers=None):
    """Indices of the photos to keep (the reference always stays)."""
    keep = []
    for i in range(len(aligned)):
        if i == ref:
            keep.append(i); continue
        sm = subject_agreement(aligned[ref], aligned[i], ghosts[i], covers[i] if covers else None)
        gap = apart[i]
        if sm < SUBJECT_MOVED:
            log(f"frame {i + 1} left out: " + (f"taken {gap_text(gap)} the others, and the subject had moved" if gap
                                              else "the subject moved between photos") + f" (agreement {sm:.2f})")
        elif gap and sm < SUBJECT_MOVED_APART:
            log(f"frame {i + 1} left out: taken {gap_text(gap)} the others, and the subject had moved a little (agreement {sm:.2f})")
        else:
            if gap:
                log(f"frame {i + 1}: taken {gap_text(gap)} the others but lines up well, kept")
            keep.append(i)
    return keep


# ---------- 6. fusion ----------
def lap_pyr(img, levels):
    gp = [img]
    for _ in range(levels):
        gp.append(cv2.pyrDown(gp[-1]))
    lp = [gp[i] - cv2.pyrUp(gp[i + 1], dstsize=(gp[i].shape[1], gp[i].shape[0])) for i in range(levels)]
    return lp + [gp[-1]]


def gauss_pyr(img, levels):
    gp = [img]
    for _ in range(levels):
        gp.append(cv2.pyrDown(gp[-1]))
    return gp


def collapse(lp):
    img = lp[-1]
    for l in reversed(lp[:-1]):
        img = cv2.pyrUp(img, dstsize=(l.shape[1], l.shape[0])) + l
    return img


def soft_weights(aligned, ghosts, power=4.0, sigma=4.0, refine=True):
    F = np.stack([focus_measure(to_gray(a), sigma) for a in aligned])
    G = np.stack(ghosts)
    # relative sharpness, against the sharpest photo that has pixels there
    F = np.minimum(1, F / (np.where(G > 0.02, F, 0).max(0, keepdims=True) + 1e-9))
    W = (F ** power) * G + 1e-6
    W /= W.sum(0, keepdims=True)
    if refine:
        guide = to_gray(np.mean(aligned, 0))
        W = np.stack([guided_filter(guide, w, 8, 1e-4) for w in W])
        W = np.clip(W, 0, None) + 1e-6
        W /= W.sum(0, keepdims=True)
    return W, F


def fuse_dmap(aligned, ghosts):
    W, _ = soft_weights(aligned, ghosts, power=8.0)
    return np.einsum('nhw,nhwc->hwc', W, np.stack(aligned)), W


def fuse_wpyr(aligned, ghosts, levels=6):
    W, _ = soft_weights(aligned, ghosts, power=4.0)
    acc = None
    for a, w in zip(aligned, W):
        lp = lap_pyr(a, levels); gp = gauss_pyr(w, levels)
        c = [l * g[..., None] for l, g in zip(lp, gp)]
        acc = c if acc is None else [x + y for x, y in zip(acc, c)]
    return collapse(acc), W


def fuse_pmax(aligned, ghosts, levels=6):
    lps = [lap_pyr(a, levels) for a in aligned]
    gh = [gauss_pyr(g, levels) for g in ghosts]
    out = []
    for L in range(levels + 1):
        stack = np.stack([lp[L] for lp in lps])              # n,h,w,c
        if L == levels:                                      # base: average
            out.append(stack.mean(0)); continue
        e = np.abs(stack).sum(-1)
        e = np.stack([cv2.GaussianBlur(x, (0, 0), 1.0) for x in e]) * np.stack([g[L] for g in gh])
        k = e.argmax(0)
        out.append(np.take_along_axis(stack, k[None, ..., None], 0)[0])
    return collapse(out), None


def fuse_hybrid(aligned, ghosts, levels=6, fine_levels=3, sel_sigma=None, valid=None):
    """Weighted pyramid everywhere; at the finest levels, where the stack has
    strong, confident texture (setae), the detail comes from the sharpest photos:
    every photo at least MERGE_FROM as sharp as the best at a spot is merged in,
    as far as its detail agrees with the best photo's (ROBUST x the band's noise)."""
    W, F = soft_weights(aligned, ghosts, power=4.0)
    lps = [lap_pyr(a, levels) for a in aligned]
    gws = [gauss_pyr(w, levels) for w in W]
    gh = [gauss_pyr(g, levels) for g in ghosts]
    # texture mask: high max focus relative to local median focus -> hairy
    Fm = np.stack([focus_measure(to_gray(a), 2.0) for a in aligned])
    if valid is not None:                           # only where a photo has pixels of its own
        Fm = Fm * np.stack([v > 0 for v in valid])
    tex = Fm.max(0)
    tex = tex / (cv2.GaussianBlur(tex, (0, 0), 25) + 1e-6)
    t0, t1 = TEX
    tex_mask = np.clip((tex - t0) / t1, 0, 1)
    # gate by absolute sharpness: where no frame is sharp (never-focused
    # background) max-selection only stitches blur-disc edges into contour
    # artefacts, so fall back to the smooth weighted blend there
    fa = Fm.max(0)
    lo, hi = np.percentile(fa, 35), np.percentile(fa, 65)
    gate = np.clip((fa - lo) / (hi - lo + 1e-9), 0, 1)
    tex_mask = cv2.GaussianBlur((tex_mask * gate).astype(np.float32), (0, 0), 3)
    tp = gauss_pyr(tex_mask.astype(np.float32), levels)
    out = []
    for L in range(levels + 1):
        stack = np.stack([lp[L] for lp in lps])
        wts = np.stack([g[L] for g in gws])
        blend = np.einsum('nhw,nhwc->hwc', wts, stack)
        if L < fine_levels:
            raw = np.abs(stack).sum(-1)
            G = np.stack([g[L] for g in gh])
            e = np.stack([cv2.GaussianBlur(x, (0, 0), SEL_SIGMA if sel_sigma is None else sel_sigma) for x in raw]) * G
            k = e.argmax(0)
            mx = np.take_along_axis(stack, k[None, ..., None], 0)[0]
            if MERGE:
                # noise of this band: the typical detail where photos are out of focus
                noise = min((np.percentile(r[::6, ::6][g[::6, ::6] > 0.5], 25) for r, g in zip(raw, G)
                             if (g[::6, ::6] > 0.5).sum() > 100), default=0.01)
                lim = ROBUST * max(noise, 1e-4)
                be = e.max(0) + 1e-12
                num, den = np.zeros_like(mx), np.zeros(mx.shape[:2], np.float32)
                for i in range(len(stack)):                  # one photo at a time (memory)
                    w = np.clip((e[i] / be - MERGE_FROM) / (MERGE_FULL - MERGE_FROM), 0, 1) ** 2
                    d = np.abs(stack[i] - mx).sum(-1) / lim
                    w = w / (1 + d * d)
                    w[w < 1e-3] = 0
                    num += w[..., None] * stack[i]; den += w
                mx = num / np.maximum(den, 1e-9)[..., None]
            a = tp[L][..., None]
            blend = a * mx + (1 - a) * blend
        out.append(blend)
    return collapse(out), W


SEL_SIGMA = 1.0     # smoothing of the per-pixel 'which frame is sharpest' choice at fine levels
MERGE = True        # merge fine detail from every photo nearly as sharp as the best (else: the best only)
MERGE_FROM, MERGE_FULL, ROBUST = 0.55, 0.9, 2.5
TEX = (0.0, 0.5)   # texture-mask threshold/softness for hybrid max-selection
METHODS = {'dmap': fuse_dmap, 'wpyr': fuse_wpyr, 'pmax': fuse_pmax, 'hybrid': fuse_hybrid}


# ---------- 7. finishing ----------
def crop_valid(img, common, f=4):
    """Largest axis-aligned rectangle containing only valid pixels whose shape stays
    within 15% of the frame's own (so a landscape burst isn't cropped to a portrait
    strip), from the maximal rectangles of a 1/f-scale mask."""
    m = common.astype(np.uint8)
    h, w = m.shape
    ar = w / h
    # a coarse cell counts as valid only if all its pixels are valid
    small = cv2.erode(m, np.ones((f, f), np.uint8))[::f, ::f]
    H, W = small.shape
    heights = np.zeros(W, int)
    best = (0, 0, 0, 0, 0)                     # area, x0, y0, x1, y1 in coarse units
    for r in range(H):
        heights = np.where(small[r] > 0, heights + 1, 0)
        stack = []
        for c in range(W + 1):
            cur = heights[c] if c < W else 0
            start = c
            while stack and stack[-1][1] >= cur:
                st, ht = stack.pop()
                if ht > 0:
                    cw, ch = c - st, ht
                    if cw / ch > ar * 1.15:
                        cw = int(ch * ar * 1.15)
                    elif cw / ch < ar / 1.15:
                        ch = int(cw * 1.15 / ar)
                    if cw * ch > best[0]:
                        x0c, y0c = st + (c - st - cw) // 2, (r - ht + 1) + (ht - ch) // 2
                        best = (cw * ch, x0c, y0c, x0c + cw - 1, y0c + ch - 1)
                start = st
            stack.append((start, cur))
    if best[0] == 0:
        return img, (0, 0, w - 1, h - 1)
    _, x0, y0, x1, y1 = best
    x0, y0 = x0 * f + f, y0 * f + f                       # 1-cell safety margin
    x1, y1 = min(w - 1, (x1 + 1) * f - 1 - f), min(h - 1, (y1 + 1) * f - 1 - f)
    return img[y0:y1 + 1, x0:x1 + 1], (x0, y0, x1, y1)


def finish(img, sharpen=0.35):
    """Gentle unsharp mask + clip. Kept mild: stacking already boosts contrast."""
    if sharpen > 0:
        b = cv2.GaussianBlur(img, (0, 0), 1.2)
        img = img + sharpen * (img - b)
    return np.clip(img, 0, 1)


def depth_map(W, order):
    """Pseudo-depth: weighted focus rank (near = warm, far = cool)."""
    n = W.shape[0]
    rank = np.empty(n); rank[np.asarray(order)] = np.arange(n)
    d = 1.0 - (W * rank[:, None, None]).sum(0) / max(n - 1, 1)
    return cv2.applyColorMap((d * 255).astype(np.uint8), cv2.COLORMAP_TURBO)


# ---------- 8. metadata (EXIF + colour profile) ----------
# cv2.imwrite drops all metadata. iNaturalist reads the date and location from
# EXIF, so the reference photo's EXIF is copied into the outputs. The block is
# copied byte for byte and patched in place: Orientation -> 1 (cv2.imread already
# turned the pixels upright), pixel dimensions -> the stack's size, and the
# embedded thumbnail (IFD1) is unlinked. The colour profile is copied as is:
# OpenCV never converts colour, so the pixels are still in the photo's space.
EXIF_ID = b'Exif\x00\x00'
ICC_ID = b'ICC_PROFILE\x00'


def jpeg_segments(b):
    """(marker, start, end, body) for each segment up to the start of scan."""
    if b[:2] != b'\xff\xd8':
        return None
    out, p = [], 2
    while p + 4 <= len(b):
        if b[p] != 0xFF:
            return None
        m = b[p + 1]
        if m == 0xFF:
            p += 1; continue
        if m in (0xDA, 0xD9):
            out.append((m, p, len(b), p)); break
        ln = struct.unpack('>H', b[p + 2:p + 4])[0]
        out.append((m, p, p + 2 + ln, p + 4))
        p += 2 + ln
    return out


def read_meta(path):
    """(EXIF TIFF block or None, list of raw ICC APP2 segments) of a JPEG."""
    try:
        with open(path, 'rb') as f:
            b = f.read(1 << 20)                  # metadata sits at the front
    except OSError:
        return None, []
    segs = jpeg_segments(b) or []
    exif, icc = None, []
    for m, s, e, body in segs:
        if m == 0xE1 and b[body:body + 6] == EXIF_ID and exif is None:
            exif = b[body + 6:e]
        elif m == 0xE2 and b[body:body + 12] == ICC_ID:
            icc.append(b[s:e])
    return exif, icc


def patch_exif(tiff, width, height):
    """Copy of the TIFF block with orientation, dimensions and thumbnail fixed."""
    t = bytearray(tiff)
    if len(t) < 8 or t[:2] not in (b'II', b'MM'):
        return None
    E = '<' if t[:2] == b'II' else '>'
    u16 = lambda o: struct.unpack_from(E + 'H', t, o)[0]
    u32 = lambda o: struct.unpack_from(E + 'I', t, o)[0]

    def set_int(e, typ, v):
        if typ == 3:
            struct.pack_into(E + 'H', t, e + 8, min(65535, v))
        elif typ == 4:
            struct.pack_into(E + 'I', t, e + 8, v)

    def ifd(off, name, seen):
        if not off or off + 2 > len(t) or off in seen:
            return None
        seen.add(off)
        n = u16(off)
        if off + 2 + n * 12 + 4 > len(t):
            return None
        for i in range(n):
            e = off + 2 + i * 12
            tag, typ, cnt = u16(e), u16(e + 2), u32(e + 4)
            if cnt == 1:
                if name == 'ifd0' and tag == 0x0112: set_int(e, typ, 1)          # Orientation
                if name == 'ifd0' and tag == 0x0100: set_int(e, typ, width)      # ImageWidth
                if name == 'ifd0' and tag == 0x0101: set_int(e, typ, height)     # ImageLength
                if name == 'exif' and tag == 0xA002: set_int(e, typ, width)      # PixelXDimension
                if name == 'exif' and tag == 0xA003: set_int(e, typ, height)     # PixelYDimension
            if tag == 0x8769:
                ifd(u32(e + 8), 'exif', seen)
        return off + 2 + n * 12

    nxt = ifd(u32(4), 'ifd0', set())
    if nxt is not None:
        struct.pack_into(E + 'I', t, nxt, 0)                                     # drop IFD1 (thumbnail)
    return bytes(t)


def jpeg_with_meta(jpeg, tiff, icc_segs):
    segs = jpeg_segments(jpeg)
    if not segs:
        return jpeg
    head = [b'\xff\xd8']
    if tiff and len(tiff) + 8 <= 65535:
        head.append(b'\xff\xe1' + struct.pack('>H', len(tiff) + 8) + EXIF_ID + tiff)
    head += icc_segs
    # drop what the encoder wrote (JFIF APP0, any EXIF/ICC) and keep the rest
    rest = [jpeg[s:e] for m, s, e, body in segs
            if not (m == 0xE0 or (m == 0xE1 and jpeg[body:body + 6] == EXIF_ID) or m == 0xE2)]
    return b''.join(head + rest)


def png_with_meta(png, tiff, icc_segs):
    """PNG with an eXIf chunk (EXIF) and an iCCP chunk (colour profile)."""
    chunk = lambda typ, data: struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    extra = b''
    if icc_segs:
        parts = sorted(icc_segs, key=lambda s: s[4 + 12])                         # by sequence number
        prof = b''.join(s[4 + 14:] for s in parts)
        extra += chunk(b'iCCP', b'ICC profile\x00\x00' + zlib.compress(prof))
    if tiff:
        extra += chunk(b'eXIf', tiff)
    ihdr_end = 8 + 8 + 13 + 4
    return png[:ihdr_end] + extra + png[ihdr_end:]


def save_outputs(path, img8, meta_src=None, jpeg_quality=95):
    """Write the PNG (and a JPEG beside it) carrying the source photo's metadata.
    Uses imencode + plain file writes, which also copes with non-ASCII paths."""
    h, w = img8.shape[:2]
    tiff, icc = read_meta(meta_src) if meta_src else (None, [])
    tiff = patch_exif(tiff, w, h) if tiff else None
    ok, png = cv2.imencode('.png', img8)
    with open(path, 'wb') as f:
        f.write(png_with_meta(png.tobytes(), tiff, icc) if (tiff or icc) else png.tobytes())
    outs = [path]
    if jpeg_quality > 0:
        jp = os.path.splitext(path)[0] + '.jpg'
        ok, jpg = cv2.imencode('.jpg', img8, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality,
                                              cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444])
        with open(jp, 'wb') as f:
            f.write(jpeg_with_meta(jpg.tobytes(), tiff, icc))
        outs.append(jp)
    return outs, tiff is not None


IMG_EXT = ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp')
VID_EXT = ('.mp4', '.mov', '.mkv')


def expand_inputs(inputs):
    """Folders -> their photos (skipping our own outputs); files kept as given."""
    paths = []
    for p in inputs:
        p = p.strip().strip('"').strip("'")
        if not p:
            continue
        if os.path.isdir(p):
            paths += [f for f in sorted(glob.glob(os.path.join(p, '*')))
                      if f.lower().endswith(IMG_EXT + VID_EXT)
                      and not any(t in os.path.basename(f).lower() for t in ('stacked', '_depth', '_aligned'))]
        elif os.path.isfile(p):
            paths.append(p)
        else:
            print(f"  skipped (not found): {p}")
    return paths


def default_out(inputs, paths):
    """Folder dropped -> <folder>_stacked.png beside it.
    Loose files -> a 'stacked' folder beside them, named after the first photo."""
    first = inputs[0].strip().strip('"')
    taken = lambda o: os.path.exists(o) or os.path.exists(os.path.splitext(o)[0] + '.jpg')
    if len(inputs) == 1 and os.path.isdir(first):
        base = first.rstrip('\\/') + '_stacked'
        out, k = base + '.png', 2
        while taken(out):
            out = f"{base}_{k}.png"; k += 1
        return out
    d = os.path.join(os.path.dirname(os.path.abspath(paths[0])), 'stacked')
    os.makedirs(d, exist_ok=True)
    stem = os.path.splitext(os.path.basename(paths[0]))[0]
    out = os.path.join(d, f"{stem}_stacked.png")
    k = 2
    while taken(out):                                # never overwrite an earlier stack
        out = os.path.join(d, f"{stem}_stacked_{k}.png"); k += 1
    return out


def stack_paths(inputs, a, out=None):
    paths = expand_inputs(inputs)
    vids = [p for p in paths if p.lower().endswith(VID_EXT)]
    imgs_p = [p for p in paths if p.lower().endswith(IMG_EXT)]
    if not vids and len(imgs_p) < 2:
        print("  Need at least 2 photos (or 1 video). Nothing stacked.")
        return None
    out = out or default_out(inputs, paths)
    t0 = time.time()
    print(f"  Reading {len(vids) and 'video' or str(len(imgs_p)) + ' photos'}...", flush=True)
    imgs = video_frames(vids[0], a.every) if vids else load(imgs_p, max_side=a.max_side or None)
    print(f"  {len(imgs)} frames, {imgs[0].shape[1]}x{imgs[0].shape[0]}")
    print("  Lining up photos (the slow part)...", flush=True)
    local = a.local if a.local != 'auto' else ('direct' if len(imgs) <= 15 else 'chain')
    apart = [0.0] * len(imgs) if vids else moments([taken_time(p) for p in imgs_p])
    if any(apart):
        print("   photos were taken at different moments (more than 2 s apart)", flush=True)
    aligned, order, ref, wmask, trust = align(imgs, local=local, ref=(a.ref - 1) if a.ref > 0 else None,
                                              log=lambda m: print('   ' + m, flush=True),
                                              avoid={i for i, g in enumerate(apart) if g})
    covers = [cover_map(m) for m in wmask]
    gw = None if (a.no_ghost and a.keep_all) else ghost_weights(aligned, ref)
    ghosts = [np.ones(wmask[0].shape, np.float32)] * len(aligned) if a.no_ghost else gw
    # what each photo may contribute: it has pixels there, agrees with the reference, can be trusted
    ghosts = [g * c * t for g, c, t in zip(ghosts, covers, trust)]
    meta_ref = ref
    keep = list(range(len(aligned)))
    if not a.keep_all:
        keep = select_photos(aligned, gw, ref, apart, log=lambda m: print('   ' + m, flush=True), covers=covers)
        if len(keep) < len(aligned):
            aligned, ghosts = [aligned[i] for i in keep], [ghosts[i] for i in keep]
            order = [keep.index(o) for o in order if o in keep]
            ref = keep.index(ref)
            print(f"   using {len(keep)} of {len(imgs)} photos", flush=True)
    valid = [wmask[i] for i in keep]
    # crop: everything at least one used photo really saw (not just what all of them saw)
    seen = np.logical_or.reduce([v > 0 for v in valid])
    print(f"  Lined up in {time.time() - t0:.0f}s. Merging...", flush=True)
    base, ext = os.path.splitext(out)
    if a.save_aligned:
        for i, im in enumerate(aligned):
            cv2.imwrite(f"{base}_aligned_{i + 1}.jpg", (np.clip(im, 0, 1) * 255).astype(np.uint8))
    # metadata comes from the reference photo (its geometry is the stack's geometry)
    meta_src = None if (vids or a.no_exif) else imgs_p[meta_ref]
    methods = list(METHODS) if a.method == 'all' else [a.method]
    for m in methods:
        fused, W = METHODS[m](aligned, ghosts, valid=valid) if m == 'hybrid' else METHODS[m](aligned, ghosts)
        fused, box = crop_valid(finish(fused, a.sharpen), seen)
        o = out if len(methods) == 1 else f"{base}_{m}{ext}"
        if not o.lower().endswith('.png'):
            o = os.path.splitext(o)[0] + '.png'
        written, kept = save_outputs(o, (fused * 255 + 0.5).astype(np.uint8), meta_src, a.jpeg_quality)
        if W is not None and m == methods[-1] and a.depth:
            cv2.imwrite(f"{base}_depth.png", depth_map(W, order)[box[1]:box[3] + 1, box[0]:box[2] + 1])
    note = ('date/location/camera kept from ' + os.path.basename(meta_src)) if (meta_src and kept) else 'no EXIF to keep'
    print(f"  Done in {time.time() - t0:.0f}s ->  {', '.join(written)}  ({note})", flush=True)
    return written[0]


def split_dropped(line):
    """Explorer drops paths as  "C:\\a b\\x.jpg" C:\\c\\y.jpg  -> list of paths."""
    import re
    return [q or u for q, u in re.findall(r'"([^"]+)"|(\S+)', line)]


def open_file(path):
    try:
        if hasattr(os, 'startfile'):
            os.startfile(path)                      # Windows: open in the default viewer
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='*', help='photos, folders, or a video file')
    ap.add_argument('-o', '--out', default=None, help='output .png (a .jpg is written beside it; default: beside the photos)')
    ap.add_argument('-m', '--method', default='hybrid', choices=list(METHODS) + ['all'])
    ap.add_argument('--local', default='auto', choices=['auto', 'chain', 'direct', 'none'],
                    help='optical-flow alignment mode')
    ap.add_argument('--no-ghost', action='store_true', help='skip moving-subject masking')
    ap.add_argument('--keep-all', action='store_true', help="use every photo, even one whose subject moved")
    ap.add_argument('--every', type=int, default=0, help='video: take every Nth frame (0=auto)')
    ap.add_argument('--sharpen', type=float, default=0.35)
    ap.add_argument('--ref', type=int, default=0, help='reference frame number (1-based); 0 = auto')
    ap.add_argument('--max-side', type=int, default=0, help='shrink photos to this many pixels on the long side (0 = full size)')
    ap.add_argument('--jpeg-quality', type=int, default=95, help='quality of the JPEG saved beside the PNG (0 = no JPEG)')
    ap.add_argument('--no-exif', action='store_true', help="don't copy the photo's date, location and camera into the output")
    ap.add_argument('--depth', action='store_true', help='also save a depth map')
    ap.add_argument('--save-aligned', action='store_true')
    ap.add_argument('--loop', action='store_true', help='keep the window open and stack each batch dropped into it')
    ap.add_argument('--open', action='store_true', help='open each result when done')
    a = ap.parse_args()

    def one(batch, out=None):
        try:
            o = stack_paths(batch, a, out)
            if o and a.open:
                open_file(o)
        except Exception as e:                       # keep the loop alive on a bad batch
            print(f"  Stacking failed: {e}")

    if a.inputs:
        one(a.inputs, a.out)
    if not a.loop:
        return
    while True:
        print("\n Drag photos (one or many) or a folder into this window, then press Enter."
              "\n (Close the window when you're finished.)")
        try:
            line = input("> ")
        except (EOFError, KeyboardInterrupt):
            break
        batch = split_dropped(line)
        if batch:
            one(batch)


def video_frames(path, every=0):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    if not frames:
        raise SystemExit(f"no frames in {path}")
    g = [cv2.cvtColor(cv2.resize(f, None, fx=0.25, fy=0.25), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255 for f in frames]
    sharp = np.array([focus_measure(x, 4).mean() for x in g])
    # drop motion-blurred frames: keep those above 40th percentile of their local neighbourhood
    keep = [i for i in range(len(frames))
            if sharp[i] >= np.percentile(sharp[max(0, i - 5):i + 6], 40)]
    if every <= 0:
        every = max(1, len(keep) // 40)          # aim for ~40 slices
    keep = keep[::every]
    print(f"video: {len(frames)} frames, kept {len(keep)}")
    return [frames[i].astype(np.float32) / 255 for i in keep]


if __name__ == '__main__':
    main()
